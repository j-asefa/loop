import { queuePrWatchRegistration } from "./pr-watch-registrations.js";
import { selectedContext } from "../carried-context.js";
import { randomBytes } from "node:crypto";
import { db, id, now, emit } from "../db.js";
import { owned, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { recordTrace } from "../traces.js";
import { applyActivity } from "../activities.js";
import { ACTIVITY_LIMITS, ACTIVITY_VERSION } from "../../agent-activities.js";
import { saveArtifact } from "../artifacts.js";
import { requestApproval } from "../approvals.js";
import { transition, type Run } from "../queue.js";
import {
  digest,
  verifyAuth,
  type NativeSession,
  type NativeDispatch,
} from "./contracts.js";
import { environment, hub, workerRequest } from "./environments.js";
import { environmentUpgrades } from "../harness-upgrades.js";
import { RunDeferred } from "../run-deferred.js";
import { InactiveSessionError } from "./client.js";
import { attachedFiles, attachmentPrompt } from "../uploads.js";
import { replyPrompt } from "../../shared/replies.js";
import { launchPermissionMode } from "../../shared/permission-modes.js";
import { hapiAutoApproval } from "./permission-policy.js";
import { recallForRun } from "../memory.js";

export const sessionFor = (conversation: string) =>
  db
    .prepare("SELECT * FROM native_sessions WHERE conversation_id=?")
    .get(conversation) as NativeSession | undefined;
export const dispatchFor = (run: string) =>
  db.prepare("SELECT * FROM native_dispatches WHERE run_id=?").get(run) as
    NativeDispatch | undefined;
const terminal = ["completed", "failed", "cancelled"];
function state(d: NativeDispatch, value: string, error: string | null = null) {
  db.prepare(
    "UPDATE native_dispatches SET state=CASE WHEN cancel_requested=1 AND ? NOT IN ('completed','failed','cancelled') THEN 'cancellation-requested' ELSE ? END,error=?,updated_at=? WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')",
  ).run(value, value, error, now(), d.run_id);
}
export function ensureSession(run: Run): NativeSession {
  const p = JSON.parse(run.payload),
    selection = p.execution;
  if (!selection || !run.conversation_id)
    throw new Problem(409, "Native run has no execution binding");
  const e = environment(run.owner_id, selection.environmentId);
  const s = sessionFor(run.conversation_id);
  if (s) {
    if (
      s.environment_id !== e.host_id ||
      s.flavor !== selection.flavor ||
      s.billing !== JSON.stringify(selection.billing) ||
      s.generation !== e.generation
    )
      throw new Problem(
        409,
        "Native session identity is fenced; explicit recovery is required",
      );
    return s;
  }
  const gateway = randomBytes(32).toString("base64url");
  db.prepare(
    "INSERT INTO native_sessions(conversation_id,owner_id,environment_id,generation,flavor,billing,launch_id,gateway_secret,gateway_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    run.conversation_id,
    run.owner_id,
    e.host_id,
    e.generation,
    selection.flavor,
    JSON.stringify(selection.billing),
    id(),
    seal(gateway, run.owner_id),
    digest(gateway),
    now(),
  );
  db.prepare(
    "UPDATE conversations SET execution_backend='hapi',execution_connection_id=?,project_id=? WHERE id=?",
  ).run(p.connectionId, p.folderId, run.conversation_id);
  return sessionFor(run.conversation_id)!;
}
export async function executeHapi(run: Run): Promise<false> {
  const s = ensureSession(run),
    e = environment(run.owner_id, s.environment_id),
    p = JSON.parse(run.payload);
  let d = dispatchFor(run.id);
  if (d) {
    await reconcile(s);
    return false;
  }
  // The run is already claimed: an upgrade request checks active runs only
  // after taking this hold, and the runner refuses sessions once it starts.
  if (environmentUpgrades.has(e.host_id + ":" + s.flavor))
    throw new RunDeferred("Wait for the runtime upgrade to finish before starting a run.");
  const mapping = db
    .prepare(
      "SELECT canonical_path FROM environment_projects WHERE environment_id=? AND project_id=?",
    )
    .get(e.host_id, p.folderId) as any;
  if (!mapping)
    throw new Problem(
      409,
      "Map this project to an approved directory in the execution environment first",
    );
  const localId = id();
  const envelope = attachmentPrompt(
    replyPrompt(await recallForRun(run), p.replyTo),
    attachedFiles(run.owner_id, p.attachmentIds || []),
  );
  // Receipt precedes every external operation; the original user text stays separate.
  db.prepare(
    "INSERT INTO native_dispatches(run_id,conversation_id,local_id,payload_hash,envelope,billing,environment_id,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    run.id,
    s.conversation_id,
    localId,
    digest(envelope),
    envelope,
    s.billing,
    e.host_id,
    e.generation,
    now(),
    now(),
  );
  d = dispatchFor(run.id)!;
  try {
    const prepared = await workerRequest(e, "/prepare", {
      launchId: s.launch_id,
      conversationId: s.conversation_id,
      directory: mapping.canonical_path,
      flavor: s.flavor,
      billing: JSON.parse(s.billing),
      // A new native session starts from copied turns (fork/continue), if any.
      instructions: s.hub_session_id
        ? p.instructions
        : (p.instructions || "") + selectedContext(s.conversation_id),
      gatewayUrl:
        JSON.parse(e.health || "{}").gatewayUrl ||
        process.env.LOOP_NATIVE_GATEWAY_URL,
      gatewayToken: unseal(s.gateway_secret, s.owner_id),
      generation: s.generation,
    });
    if (prepared.deferred === 'runtime-maintenance')
      throw new RunDeferred('The runtime is held for maintenance.');
    verifyAuth(s.flavor, prepared.auth);
    db.prepare(
      "UPDATE native_dispatches SET auth_evidence=? WHERE run_id=?",
    ).run(JSON.stringify(prepared.auth), run.id);
    if (!s.hub_session_id) {
      // Claim spawn ownership before the external request, competing with Cancel.
      if (
        !db
          .prepare(
            "UPDATE native_dispatches SET state='spawning',updated_at=? WHERE run_id=? AND state='prepared' AND cancel_requested=0",
          )
          .run(now(), run.id).changes
      )
        return false;
      db.prepare(
        "UPDATE native_sessions SET state='spawning' WHERE conversation_id=?",
      ).run(s.conversation_id);
      const spawned = await hub(e).request(
        "/api/machines/" + encodeURIComponent(e.machine_id) + "/spawn",
        {
          directory: mapping.canonical_path,
          agent: s.flavor,
          model: p.model,
          // Spawn accepts optional strings, unlike the nullable settings endpoints.
          // Omit the default so the runner can choose its native effort.
          ...(p.effort == null ? {} : ["claude", "pi"].includes(s.flavor)
            ? { effort: p.effort }
            : { modelReasoningEffort: p.effort }),
          permissionMode: launchPermissionMode(s.flavor, p.permissionMode),
          startingMode: "remote",
          loopLaunchId: s.launch_id,
        },
      );
      if (spawned.type !== "success" || !spawned.sessionId)
        throw new Error("Unconfirmed spawn");
      if (!attachSession(s, spawned.sessionId)) return false;
      if (dispatchFor(run.id)?.cancel_requested) {
        await deliverCancellation(s, run.id);
        return false;
      }
    }
    await sendPrepared(s, d, e);
  } catch (error) {
    if (error instanceof RunDeferred) {
      // /prepare refused before writing a launch or spawning/sending anything.
      // Keep all other receipts: an uncertain external operation is never queued.
      const removed = db.prepare("DELETE FROM native_dispatches WHERE run_id=? AND state='prepared' AND send_started_at IS NULL")
        .run(run.id).changes;
      if (removed) throw error;
    }
    const current = dispatchFor(run.id)!;
    state(
      d,
      ["spawning", "sending"].includes(current.state)
        ? "delivery-unknown"
        : "blocked",
      error instanceof Problem
        ? error.message
        : "Native delivery is unresolved. Reconcile this environment before retrying.",
    );
    db.prepare(
      "UPDATE runs SET worker_id=NULL,heartbeat=NULL,error=? WHERE id=?",
    ).run(
      (
        db
          .prepare("SELECT error FROM native_dispatches WHERE run_id=?")
          .get(run.id) as any
      ).error,
      run.id,
    );
    emit(run.owner_id, run.id, "native.waiting", {
      state: dispatchFor(run.id)!.state,
    });
  }
  return false;
}
function attachSession(s: NativeSession, sessionId: string) {
  const lineage = JSON.parse(s.lineage);
  if (s.hub_session_id && s.hub_session_id !== sessionId)
    lineage.push(s.hub_session_id);
  const attached = db
    .prepare(
      "UPDATE native_sessions SET hub_session_id=?,lineage=?,state='attached' WHERE conversation_id=? AND launch_id=? AND generation=? AND hub_session_id IS ?",
    )
    .run(
      sessionId,
      JSON.stringify(lineage),
      s.conversation_id,
      s.launch_id,
      s.generation,
      s.hub_session_id,
    );
  // A late response must not replace a binding advanced by another observer.
  if (!attached.changes) return false;
  s.hub_session_id = sessionId;
  return true;
}
function currentEnvironment(s: NativeSession) {
  const e = environment(s.owner_id, s.environment_id);
  const current = sessionFor(s.conversation_id);
  if (e.generation !== s.generation || current?.generation !== s.generation ||
      current.owner_id !== s.owner_id || current.environment_id !== s.environment_id ||
      current.launch_id !== s.launch_id || current.hub_session_id !== s.hub_session_id)
    throw new Problem(409, "Native session identity is fenced; reconcile the current environment");
  return e;
}
async function sendPrepared(s: NativeSession, d: NativeDispatch, e: any) {
  if (process.env.LOOP_NATIVE_ADMISSION === "0")
    throw new Problem(409, "Native admission is disabled for maintenance");
  const connection = db
    .prepare(
      "SELECT c.status FROM conversations v JOIN connections c ON c.id=v.execution_connection_id WHERE v.id=?",
    )
    .get(s.conversation_id) as any;
  if (connection?.status !== "connected")
    throw new Problem(
      409,
      "Reconnect the selected native provider before sending work",
    );
  const detail = await hub(e).request("/api/sessions/" + s.hub_session_id);
  const live = detail.session || detail;
  if (!live.active) throw new InactiveSessionError();
  const pendingRun = db.prepare("SELECT payload FROM runs WHERE id=? AND owner_id=?").get(d.run_id, s.owner_id) as Pick<Run, "payload"> | undefined;
  if (!pendingRun) throw new Problem(409, "Native run no longer exists");
  const snapshot = JSON.parse(pendingRun.payload);
  const client = hub(e);
  const permissionMode = launchPermissionMode(s.flavor, snapshot.permissionMode);
  if (s.flavor === "claude" && (live.permissionMode ?? "default") !== permissionMode) {
    const result = await client.request(`/api/sessions/${s.hub_session_id}/permission-mode`, { mode: permissionMode });
    if (result.ok !== true) throw new Error("Unconfirmed permission setting");
  }
  const previous = db.prepare(`SELECT r.payload FROM native_dispatches d JOIN runs r ON r.id=d.run_id
    WHERE d.conversation_id=? AND d.environment_id=? AND d.generation=? AND d.run_id<>?
      AND d.send_started_at IS NOT NULL ORDER BY d.created_at DESC LIMIT 1`)
    .get(s.conversation_id, s.environment_id, s.generation, d.run_id) as { payload: string } | undefined;
  const normalizeModel = (model: unknown) => !model || model === "native-default" || model === "default" ? "default" : model;
  const desired = normalizeModel(snapshot.model);
  const priorModel = previous && normalizeModel(JSON.parse(previous.payload).model);
  // Native defaults resolve to concrete IDs, and some session snapshots omit
  // model entirely. Only a reported explicit mismatch or a changed Loop
  // selection needs the settings endpoint. Resetting an explicit choice to
  // default remains a real settings change.
  if ((priorModel !== undefined && priorModel !== desired) ||
      (desired !== "default" && typeof live.model === "string" && normalizeModel(live.model) !== desired)) {
    const result = await client.request(`/api/sessions/${s.hub_session_id}/model`, { model: desired });
    if (result.ok !== true) throw new Error("Unconfirmed model setting");
  }
  if (["claude", "pi"].includes(s.flavor) && (live.effort ?? null) !== (snapshot.effort ?? null)) {
    const result = await client.request(`/api/sessions/${s.hub_session_id}/effort`, { effort: snapshot.effort ?? null });
    if (result.ok !== true) throw new Error("Unconfirmed effort setting");
  }
  if (["codex", "opencode"].includes(s.flavor) && (live.modelReasoningEffort ?? null) !== (snapshot.effort ?? null)) {
    const result = await client.request(`/api/sessions/${s.hub_session_id}/model-reasoning-effort`, { modelReasoningEffort: snapshot.effort ?? null });
    if (result.ok !== true) throw new Error("Unconfirmed effort setting");
  }
  const auth = await workerRequest(e, "/verify", {
    launchId: s.launch_id,
    generation: s.generation,
    flavor: s.flavor,
  });
  verifyAuth(s.flavor, auth);
  currentEnvironment(s);
  // CAS is the durable send lease. A crash after this point is uncertain,
  // including a crash before HTTP; neither another process nor a retry sends it.
  const claimed = db
    .prepare(
      "UPDATE native_dispatches SET state='sending',send_started_at=COALESCE(send_started_at,?),auth_evidence=?,updated_at=? WHERE run_id=? AND state IN ('prepared','blocked','spawning') AND cancel_requested=0",
    )
    .run(now(), JSON.stringify(auth), now(), d.run_id);
  if (!claimed.changes) return;
  let response;
  try {
    response = await hub(e).request(
      "/api/sessions/" + s.hub_session_id + "/messages",
      { text: d.envelope, localId: d.local_id },
    );
  } catch (error) {
    // This specific Hub rejection occurs before acceptance. Transport errors
    // retain the lease because delivery may already have happened.
    if (error instanceof InactiveSessionError) {
      db.transaction(() => {
        db.prepare(
          "UPDATE native_dispatches SET state=CASE WHEN cancel_requested=1 THEN 'cancellation-requested' ELSE 'blocked' END,send_started_at=NULL,updated_at=? WHERE run_id=? AND state IN ('sending','cancellation-requested')",
        ).run(now(), d.run_id);
        settleUnsentCancellation(d.run_id);
      }).immediate();
    }
    throw error;
  }
  if (response.ok !== true) throw new Error("Unconfirmed message");
  db.prepare(
    "UPDATE native_dispatches SET state='accepted',updated_at=? WHERE run_id=? AND state='sending'",
  ).run(now(), d.run_id);
  db.prepare(
    "UPDATE runs SET worker_id=NULL,heartbeat=NULL,error=NULL WHERE id=?",
  ).run(d.run_id);
}
export function normalizeMessage(message: any): {
  role: string;
  content: string;
  body: any;
  origin: string;
  unrecognized?: boolean;
} {
  const c = message?.content?.data ?? message?.content;
  const raw = c?.content ?? c?.body ?? c ?? {};
  const payload = raw.data && typeof raw.data === "object" ? raw.data : raw;
  const body =
    payload && typeof payload === "object" ? payload : { value: payload };
  if (c?.role === "user")
    return {
      role: "user",
      content: body.text || "",
      body,
      origin: message.localId ? "loop" : "terminal",
    };
  if (body.type === "message" && typeof body.message === "string")
    return {
      role: "assistant",
      content: body.message || "",
      body,
      origin: "native",
    };
  if (raw.type === "output" && body.type === "assistant")
    return {
      role: "assistant",
      content: (body.message?.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n"),
      body,
      origin: "native",
    };
  const recognized = [
    "reasoning",
    "token_count",
    "tool-call",
    "tool-call-result",
    "plan",
    "error",
    "generated-image",
    "output",
    "event",
    "loop-turn",
    "loop-command",
    "loop-delivery-unknown",
    "loop-interrupted",
  ].includes(body.type);
  return {
    role: "tool",
    content:
      (recognized ? "" : "Unrecognized native activity: ") +
      JSON.stringify(body).slice(0, 64000),
    body,
    origin: "native",
    ...(!recognized ? { unrecognized: true } : {}),
  };
}
// Native tool rows outside a Loop turn that the Tool activity sheet keeps.
// Lifecycle bookkeeping is not worth showing, and failure or uncertain
// delivery notices already appear in the transcript.
const notInspectable = new Set([
  "ready",
  "loop-turn",
  "loop-command",
  "token_count",
  "event",
  "error",
  "loop-delivery-unknown",
  "loop-interrupted",
]);
function inspectable(n: ReturnType<typeof normalizeMessage>) {
  return !notInspectable.has(n.body.type);
}
export function projectMessages(
  s: NativeSession,
  messages: any[],
  epoch: number,
  cursor: { seq: number | null; at: number | null },
  checkpoint = true,
) {
  const currentSession = () => {
    const current = sessionFor(s.conversation_id);
    return current?.owner_id === s.owner_id &&
      current.environment_id === s.environment_id && current.generation === s.generation;
  };
  db.transaction(() => {
    for (const m of messages) {
      const external = String(m.id),
        serialized = JSON.stringify(m),
        revision = digest(serialized);
      const prior = db
        .prepare(
          "SELECT * FROM native_projection WHERE conversation_id=? AND external_id=?",
        )
        .get(s.conversation_id, external) as any;
      if (prior?.revision === revision) {
        if (prior.message_id)
          db.prepare(
            "UPDATE messages SET metadata=json_remove(metadata,'$.superseded') WHERE id=?",
          ).run(prior.message_id);
        continue;
      }
      const n = normalizeMessage(m);
      // Other managed harnesses emit the same completed-command envelope with
      // the accepted local dispatch id, supplied by Loop's native bridge.
      if (n.role === "tool" && n.body.type === "loop-command" &&
          (m.content?.data ?? m.content)?.meta?.isTranscriptEcho !== true && !m.truncated &&
          typeof n.body.localId === "string" && typeof n.body.command === "string" && typeof n.body.output === "string" && !/\[hapi: truncated \d+ chars\]/.test(n.body.output) && currentSession()) {
        const dispatch = db.prepare(
          "SELECT run_id FROM native_dispatches WHERE conversation_id=? AND environment_id=? AND generation=? AND local_id=?",
        ).get(s.conversation_id, s.environment_id, s.generation, n.body.localId) as { run_id: string } | undefined;
        if (dispatch)
          queuePrWatchRegistration(s, owned<Run>("runs", dispatch.run_id, s.owner_id), external, n.body.command, n.body.output);
      }
      // Codex's completed shell result carries its native turn identity even
      // when the display envelope has no loop.turnId. Bind it to the durable
      // dispatch; terminal/history-only work must never nominate an agent.
      const result = n.body.type === "tool-call-result" ? n.body.output : null;
      if (s.flavor === "codex" && (m.content?.data ?? m.content)?.meta?.isTranscriptEcho !== true && !m.truncated && result?.type === "exec_command_end" &&
          result.exit_code === 0 && result.status === "completed" &&
          typeof result.turn_id === "string" && typeof result.command === "string" && typeof result.output === "string" &&
          !/\[hapi: truncated \d+ chars\]/.test(result.output)) {
        const dispatch = db.prepare(
          "SELECT run_id FROM native_dispatches WHERE conversation_id=? AND environment_id=? AND generation=? AND native_turn_id=?",
        ).get(s.conversation_id, s.environment_id, s.generation, result.turn_id) as { run_id: string } | undefined;
        if (dispatch && currentSession())
          queuePrWatchRegistration(s, owned<Run>("runs", dispatch.run_id, s.owner_id), external, result.command, result.output);
      }
      // Log no native payload: it can contain private tool output.
      if (n.unrecognized)
        console.warn("[hapi] Unrecognized native activity projected");
      const transcriptEcho =
        (m.content?.data ?? m.content)?.meta?.isTranscriptEcho === true;
      const dispatch = db
        .prepare(
          "SELECT * FROM native_dispatches WHERE conversation_id=? AND local_id=?",
        )
        .get(s.conversation_id, typeof m.localId === "string" ? m.localId : "") as NativeDispatch | undefined;
      if (dispatch && m.invokedAt && !terminal.includes(dispatch.state))
        state(dispatch, "running");
      let messageId = prior?.message_id;
      if (!(dispatch && n.role === "user") && !transcriptEcho) {
        messageId ||= id();
        const turnId = n.body.loop?.turnId;

        const turn = typeof turnId === "string" && turnId
          ? (db
              .prepare(
                "SELECT run_id FROM native_dispatches WHERE conversation_id=? AND native_turn_id=?",
              )
              .get(s.conversation_id, turnId) as any)
          : null;
        if (turn && n.role !== "user") {
          recordTrace(
            owned<Run>("runs", turn.run_id, s.owner_id),
            "hapi:" + external,
            {
              kind: n.role === "assistant" ? "message" : "tool",
              title:
                n.role === "assistant"
                  ? "Native update"
                  : n.body.name || n.body.type || "Native activity",
              content: n.content,
              metadata: { backend: "hapi", externalId: external, final: false },
            },
          );
          messageId = null;
        } else {
          const meta = JSON.stringify({
            backend: "hapi",
            origin: n.origin,
            externalId: external,
            epoch,
            native: n.body,
            partial: false,
            truncated:
              !!m.truncated || /\[hapi: truncated \d+ chars\]/.test(n.content),
          });
          db.prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,metadata=excluded.metadata",
          ).run(
            messageId,
            s.owner_id,
            s.conversation_id,
            turn?.run_id || null,
            n.role,
            n.content,
            meta,
            m.createdAt || now(),
          );
          // Transcripts hide native tool rows. Activity that arrived outside
          // a Loop turn has no run trace, so keep it inspectable from the
          // conversation's Tool activity sheet.
          if (n.role === "tool" && !turn && inspectable(n))
            applyActivity(
              { owner: s.owner_id, conversation: s.conversation_id },
              {
                v: ACTIVITY_VERSION,
                id: "hapi:" + external,
                // Display-only, keyed as history: it never belonged to a turn.
                replay: true,
                kind: "tool",
                source: { transport: "native", harness: s.flavor, origin: "hapi" },
                patch: {
                  title: String(
                    n.body.name || n.body.type || "Native activity",
                  ).slice(0, ACTIVITY_LIMITS.title),
                  status: n.body.type === "error" ? "failed" : "completed",
                  content: [
                    {
                      type: "text",
                      text: n.content.slice(0, ACTIVITY_LIMITS.text),
                    },
                  ],
                },
              },
            );
        }
      }
      db.prepare(
        "INSERT INTO native_projection VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,external_id) DO UPDATE SET revision=excluded.revision,message_id=excluded.message_id,payload=excluded.payload",
      ).run(
        s.conversation_id,
        external,
        revision,
        messageId || null,
        serialized,
      );
      if (n.body.type === "loop-turn") settleTurn(s, n.body);
      if (typeof n.body.localId === "string" && ["loop-delivery-unknown", "loop-interrupted"].includes(n.body.type)) {
        const d = db
          .prepare(
            "SELECT * FROM native_dispatches WHERE conversation_id=? AND local_id=?",
          )
          .get(s.conversation_id, n.body.localId) as NativeDispatch | undefined;
        if (d && !terminal.includes(d.state)) {
          if (n.body.type === "loop-interrupted" && d.cancel_requested) {
            transition(owned<Run>("runs", d.run_id, s.owner_id), "cancelled");
            state(d, "cancelled");
          } else {
            state(
              d,
              "outcome-unknown",
              "Native delivery ended without a confirmed turn result; automatic replay is disabled",
            );
          }
        }
      }
    }
    if (checkpoint)
      db.prepare(
        "UPDATE native_sessions SET history_epoch=?,cursor_seq=?,cursor_at=? WHERE conversation_id=?",
      ).run(epoch, cursor.seq, cursor.at, s.conversation_id);
  }).immediate();
  // The worker drains verification independently; projection never waits on GitHub.
}
function settleTurn(s: NativeSession, event: any) {
  if (![event.localId, event.turnId, event.threadId].every(value => typeof value === "string" && value)) return;
  const d = db
    .prepare(
      "SELECT * FROM native_dispatches WHERE conversation_id=? AND local_id=?",
    )
    .get(s.conversation_id, event.localId) as NativeDispatch | undefined;
  if (!d || terminal.includes(d.state)) return;
  if (s.native_thread_id && s.native_thread_id !== event.threadId)
    throw new Error("Native thread identity changed");
  db.prepare(
    "UPDATE native_sessions SET native_thread_id=? WHERE conversation_id=?",
  ).run(event.threadId, s.conversation_id);
  db.prepare(
    "UPDATE native_dispatches SET native_turn_id=? WHERE run_id=?",
  ).run(event.turnId, d.run_id);
  if (!terminal.includes(event.status)) {
    state(d, "running");
    return;
  }
  const run = owned<Run>("runs", d.run_id, s.owner_id),
    output = typeof event.output === "string" ? event.output : "";
  if (
    output &&
    !db
      .prepare("SELECT 1 FROM messages WHERE run_id=? AND role='assistant'")
      .get(run.id)
  ) {
    const messageId = "native-result:" + d.run_id;
    db.prepare(
      "INSERT OR IGNORE INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,?,?)",
    ).run(
      messageId,
      s.owner_id,
      s.conversation_id,
      run.id,
      output,
      JSON.stringify({
        backend: "hapi",
        origin: "native",
        threadId: event.threadId,
        turnId: event.turnId,
        final: true,
      }),
      now(),
    );
  }
  recordTrace(run, "hapi:final:" + event.turnId, {
    kind: "message",
    title: "Final answer",
    content: output,
    metadata: {
      backend: "hapi",
      final: true,
      threadId: event.threadId,
      turnId: event.turnId,
    },
  });
  db.prepare(
    "UPDATE runs SET result=?,error=?,worker_id=NULL,heartbeat=NULL WHERE id=?",
  ).run(
    output,
    event.status === "failed" ? "Native turn failed; inspect its output" : null,
    run.id,
  );
  if (event.status === "completed")
    saveArtifact(s.owner_id, {
      title: run.input.slice(0, 85),
      content: output,
      agent: run.agent_id,
      conversation: s.conversation_id,
      run: run.id,
      folder: JSON.parse(run.payload).folderId,
      metadata: {
        backend: "hapi",
        threadId: event.threadId,
        turnId: event.turnId,
      },
    });
  if (run.state === "awaiting_approval")
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  transition(run, event.status);
  state(d, event.status);
}
export async function reconcile(s: NativeSession) {
  const e = environment(s.owner_id, s.environment_id),
    client = hub(e);
  if (e.generation !== s.generation)
    throw new Problem(409, "Environment generation is fenced");
  if (!s.hub_session_id) {
    const { sessions } = await client.request("/api/sessions");
    const matches = sessions.filter(
      (x: any) => x.metadata?.loopLaunchId === s.launch_id,
    );
    if (matches.length === 1) {
      if (!attachSession(s, matches[0].id)) return;
    } else return; // An absent launch is unresolved, never permission to spawn again.
  }
  const detail = await client.request("/api/sessions/" + s.hub_session_id),
    session = detail.session || detail;
  if (session.metadata?.supersededBySessionId) {
    const replacement = await client.request(
        "/api/sessions/" + session.metadata.supersededBySessionId,
      ),
      next = replacement.session || replacement;
    if (next.metadata?.loopLaunchId !== s.launch_id)
      throw new Error("Unverified session lineage");
    attachSession(s, next.id);
    return;
  }
  let query =
    s.cursor_seq === null
      ? ""
      : `&afterSeq=${s.cursor_seq}&afterAt=${s.cursor_at}&epoch=${s.history_epoch}`;
  let page, head: { seq: number | null; at: number | null } | undefined;
  // Do not checkpoint the snapshot head until every page has been committed.
  // Re-reading an interrupted page is idempotent; skipping it loses history.
  db.prepare(
    "UPDATE native_sessions SET coherent=0 WHERE conversation_id=?",
  ).run(s.conversation_id);
  do {
    const result = await client.request(
      "/api/sessions/" + s.hub_session_id + "/messages?limit=200" + query,
    );
    page = result.page;
    head ||= { seq: page.snapshotHeadSeq, at: page.snapshotHeadAt };
    if (page.reset) {
      // Retain history for audit, but suppress stale revisions from recall.
      db.prepare(
        "UPDATE native_sessions SET coherent=0 WHERE conversation_id=?",
      ).run(s.conversation_id);
      db.prepare(
        "UPDATE messages SET metadata=json_set(metadata,'$.superseded',json('true')) WHERE id IN (SELECT message_id FROM native_projection WHERE conversation_id=?)",
      ).run(s.conversation_id);
    }
    projectMessages(
      s,
      result.messages,
      page.epoch,
      { seq: s.cursor_seq, at: s.cursor_at },
      false,
    );
    query =
      page.direction === "after"
        ? `&afterSeq=${page.nextAfterSeq}&afterAt=${page.nextAfterAt}&epoch=${page.epoch}&untilSeq=${head!.seq}&untilAt=${head!.at}`
        : `&beforeSeq=${page.nextBeforeSeq}&beforeAt=${page.nextBeforeAt}`;
  } while (page.hasMore);
  db.prepare(
    "UPDATE native_sessions SET coherent=1,history_epoch=?,cursor_seq=?,cursor_at=?,state=? WHERE conversation_id=?",
  ).run(
    page.epoch,
    head!.seq,
    head!.at,
    session.active
      ? "attached"
      : s.state === "resuming"
        ? "resuming"
        : "inactive",
    s.conversation_id,
  );
  await syncPermissions(s, session);
  const dispatches = db
    .prepare(
      "SELECT * FROM native_dispatches WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled')",
    )
    .all(s.conversation_id) as NativeDispatch[];
  if (dispatches.length) {
    const queued = await client.request(
      "/api/sessions/" + s.hub_session_id + "/messages/queued-state",
      { localIds: dispatches.map((d) => d.local_id) },
    );
    for (const d of dispatches) {
      if (d.cancel_requested) {
        await deliverCancellation(s, d.run_id);
        continue;
      }
      if (d.state === "outcome-unknown") continue;
      if (
        queued.invokedLocalMessages.some((m: any) => m.localId === d.local_id)
      )
        state(d, d.cancel_requested ? "cancellation-requested" : "running");
      else if (queued.queuedLocalIds.includes(d.local_id))
        state(d, d.cancel_requested ? "cancellation-requested" : "accepted");
      else if (!d.send_started_at && !d.cancel_requested && session.active) {
        db.prepare(
          "UPDATE native_dispatches SET state='prepared' WHERE run_id=? AND send_started_at IS NULL",
        ).run(d.run_id);
        await sendPrepared(s, d, e);
      }
    }
  }
}
// Longer than HapiClient's 10s authentication + 35s request deadlines. Shared
// SQLite state fences observers in other API/worker processes as well.
const DECISION_DELIVERY_MS = 60_000;
function unconfirmedDecision(active: Run, approvalId: string, expiredOnly = false) {
  if (!db.prepare("UPDATE native_permissions SET state='unknown',delivery_expires_at=0 WHERE approval_id=? AND state='auto-submitted' AND (?=0 OR delivery_expires_at<=?)").run(approvalId, Number(expiredOnly), now()).changes) return;
  const approval = db.prepare("SELECT request FROM approvals WHERE id=?").get(approvalId) as any;
  const recovery = { ...JSON.parse(approval.request), deliveryUnknown: true };
  db.prepare("UPDATE approvals SET state='pending',request=?,result=? WHERE id=?").run(
    JSON.stringify(recovery), JSON.stringify({ error: "Automatic approval delivery is unconfirmed. Check the native session before explicitly retrying." }), approvalId);
  emit(active.owner_id, active.id, "approval.requested", { approvalId, request: recovery });
  transition(active, "awaiting_approval");
}
async function deliverAutomatic(s: NativeSession, p: any, active: Run) {
  // A confirmed acknowledgement permits idempotent reconciliation, but an
  // interrupted or failed redelivery must again require explicit recovery.
  if (p.state === "auto-confirmed" && !db.prepare("UPDATE native_permissions SET state='auto-submitted',delivery_expires_at=? WHERE approval_id=? AND state='auto-confirmed'").run(now() + DECISION_DELIVERY_MS, p.approval_id).changes)
    return;
  try {
    await deliverDecision(s, p);
    db.prepare("UPDATE native_permissions SET state='auto-confirmed',delivery_expires_at=0 WHERE approval_id=? AND state='auto-submitted'").run(p.approval_id);
  } catch { unconfirmedDecision(active, p.approval_id); }
}
async function syncPermissions(s: NativeSession, session: any) {
  currentEnvironment(s);
  const active = db
    .prepare(
      "SELECT r.* FROM native_dispatches d JOIN runs r ON r.id=d.run_id WHERE d.conversation_id=? AND d.environment_id=? AND d.generation=? AND r.owner_id=? AND r.state IN ('running','awaiting_approval') AND d.state IN ('accepted','running','cancellation-requested') ORDER BY r.created_at LIMIT 1",
    )
    .get(s.conversation_id, s.environment_id, s.generation, s.owner_id) as Run | undefined;
  for (const [requestId, request] of Object.entries(
    session.agentState?.requests || {},
  )) {
    if (!active || session.agentState?.completedRequests?.[requestId]) continue;
    const old = db
      .prepare(
        "SELECT * FROM native_permissions WHERE conversation_id=? AND hub_session_id=? AND request_id=?",
      )
      .get(s.conversation_id, s.hub_session_id, requestId) as any;
    if (
      old?.state === "submitted" &&
      !session.agentState?.completedRequests?.[requestId]
    )
      await deliverDecision(s, old);
    if (old?.state === "auto-confirmed") await deliverAutomatic(s, old, active);
    if (old?.state === "auto-submitted") unconfirmedDecision(active, old.approval_id, true);
    if (old?.state === "pending") {
      const expiry = db
        .prepare("SELECT expires_at FROM approvals WHERE id=?")
        .get(old.approval_id) as any;
      if (
        expiry?.expires_at < now() &&
        db
          .prepare(
            "UPDATE native_permissions SET state='submitted',decision='reject' WHERE approval_id=? AND state='pending'",
          )
          .run(old.approval_id).changes
      ) {
        await deliverDecision(s, { ...old, decision: "reject", answers: null });
      }
    }
    if (!old) {
      const automatic = !dispatchFor(active.id)?.cancel_requested &&
        hapiAutoApproval(JSON.parse(active.payload).permissionMode, request);
      const approval = requestApproval(active, {
        ...(request as any),
        type: "hapi_native",
        origin: "native",
        sessionId: s.hub_session_id,
        requestId,
      }, automatic);
      // Persist the one-shot decision before contacting the harness. An
      // unconfirmed automatic answer is never retried by reconciliation.
      db.prepare(
        "INSERT INTO native_permissions(approval_id,conversation_id,hub_session_id,request_id,state,decision,delivery_expires_at) VALUES(?,?,?,?,?,?,?)",
      ).run(approval.id, s.conversation_id, s.hub_session_id, requestId,
        automatic ? "auto-submitted" : "pending", automatic ? "approve" : null, automatic ? now() + DECISION_DELIVERY_MS : 0);
      if (automatic) {
        await deliverAutomatic(s, { approval_id: approval.id, hub_session_id: s.hub_session_id, request_id: requestId, decision: "approve" }, active);
      } else transition(active, "awaiting_approval");
    }
  }
  for (const [requestId, completion] of Object.entries(
    session.agentState?.completedRequests || {},
  )) {
    const a = db
      .prepare(
        "SELECT p.*,a.run_id FROM native_permissions p JOIN approvals a ON a.id=p.approval_id WHERE p.conversation_id=? AND p.hub_session_id=? AND p.request_id=?",
      )
      .get(s.conversation_id, s.hub_session_id, requestId) as any;
    if (!a || a.state === "resolved") continue;
    db.prepare(
      "UPDATE native_permissions SET state='resolved' WHERE approval_id=?",
    ).run(a.approval_id);
    db.prepare(
      "UPDATE approvals SET state='completed',result=? WHERE id=?",
    ).run(JSON.stringify(completion), a.approval_id);
  }
  // Derive state only after applying the entire snapshot: a completion may
  // coexist with other pending requests (including newly arrived ones).
  if (active) {
    const unresolved = db
      .prepare(
        "SELECT 1 FROM native_permissions p JOIN approvals a ON a.id=p.approval_id WHERE a.run_id=? AND p.state NOT IN ('resolved','auto-submitted','auto-confirmed') LIMIT 1",
      )
      .get(active.id);
    db.prepare(
      "UPDATE runs SET state=? WHERE id=? AND state IN ('running','awaiting_approval')",
    ).run(unresolved ? "awaiting_approval" : "running", active.id);
  }
}
async function deliverDecision(s: NativeSession, p: any) {
  const e = currentEnvironment(s);
  if (s.hub_session_id !== p.hub_session_id)
    throw new Problem(409, "Native decision identity is fenced; reconcile the current session");
  await hub(e).request(
    `/api/sessions/${p.hub_session_id}/permissions/${encodeURIComponent(p.request_id)}/${p.decision === "approve" ? "approve" : "deny"}`,
    {
      decision: p.decision === "approve" ? "approved" : "denied",
      ...(p.answers ? { answers: JSON.parse(p.answers) } : {}),
    },
  );
}
export async function nativeDecision(
  owner: string,
  approvalId: string,
  decision: "approve" | "reject",
  answers?: Record<string, string[] | { answers: string[] }>,
  confirmUnknown = false,
) {
  const a = owned<any>("approvals", approvalId, owner),
    p = db
      .prepare("SELECT * FROM native_permissions WHERE approval_id=?")
      .get(approvalId) as any;
  if (!p) return false;
  if (p.state === "unknown" && confirmUnknown) {
    if (a.expires_at < now()) throw new Problem(409, "Native approval expired");
    const s = sessionFor(p.conversation_id)!;
    const e = currentEnvironment(s);
    if (s.hub_session_id !== p.hub_session_id) throw new Problem(409, "Native decision identity is fenced");
    const detail = await hub(e).request("/api/sessions/" + s.hub_session_id);
    const live = detail.session || detail;
    await syncPermissions(s, live);
    if (live.agentState?.completedRequests?.[p.request_id]) return true;
    if (!live.active || !live.agentState?.requests?.[p.request_id])
      throw new Problem(409, "The native session has not confirmed this request is still pending. Check its outcome before retrying.");
    // This explicit, informed retry is one shot too. Reconciliation must not
    // resend it if its acknowledgement is lost.
    if (!db.prepare("UPDATE native_permissions SET state='auto-submitted',decision=?,answers=?,delivery_expires_at=? WHERE approval_id=? AND state='unknown'")
      .run(decision, answers ? JSON.stringify(answers) : null, now() + DECISION_DELIVERY_MS, approvalId).changes)
      throw new Problem(409, "Native decision already changed");
    try {
      await deliverDecision(s, { ...p, decision, answers: answers ? JSON.stringify(answers) : null });
      db.prepare("UPDATE native_permissions SET state='auto-confirmed',delivery_expires_at=0 WHERE approval_id=? AND state='auto-submitted'").run(approvalId);
    } catch (error) {
      db.prepare("UPDATE native_permissions SET state='unknown',delivery_expires_at=0 WHERE approval_id=? AND state='auto-submitted'").run(approvalId);
      throw error;
    }
    return true;
  }
  if (["unknown", "auto-submitted", "auto-confirmed"].includes(p.state))
    throw new Problem(409, "An automatic decision was already sent. Check its outcome in HAPI before explicitly retrying.");
  if (p.state === "resolved" || (p.state === "pending" && a.expires_at < now()))
    throw new Problem(409, "Native approval is no longer pending");
  const serialized = answers ? JSON.stringify(answers) : null;
  if (
    p.state === "submitted" &&
    (p.decision !== decision || p.answers !== serialized)
  )
    throw new Problem(
      409,
      "Native decision already submitted with different answers",
    );
  const s = sessionFor(p.conversation_id)!;
  if (
    p.state === "pending" &&
    !db
      .prepare(
        "UPDATE native_permissions SET state='submitted',decision=?,answers=? WHERE approval_id=? AND state='pending'",
      )
      .run(decision, serialized, approvalId).changes
  )
    throw new Problem(409, "Native decision already submitted");
  await deliverDecision(s, { ...p, decision, answers: serialized });
  return true;
}
function settleUnsentCancellation(runId: string) {
  return db
    .transaction(() => {
      const settled = db
        .prepare(
          "UPDATE native_dispatches SET state='cancelled',error=NULL,updated_at=? WHERE run_id=? AND state='cancellation-requested' AND cancel_requested=1 AND send_started_at IS NULL",
        )
        .run(now(), runId);
      if (settled.changes) {
        const run = db
          .prepare("SELECT * FROM runs WHERE id=?")
          .get(runId) as Run;
        transition(run, "cancelled");
      }
      return !!settled.changes;
    })
    .immediate();
}
async function deliverCancellation(s: NativeSession, runId: string) {
  // Recheck durable ownership on every retry. A terminal dispatch must never
  // abort the next turn on this session. Unresolved dispatches block new turns.
  const d = db
    .prepare(
      "SELECT * FROM native_dispatches WHERE run_id=? AND conversation_id=? AND cancel_requested=1 AND state='cancellation-requested'",
    )
    .get(runId, s.conversation_id) as NativeDispatch | undefined;
  if (!d || !s.hub_session_id) return;
  // An attached session confirms the spawn has been reconciled. With no send
  // lease, no prompt can have been accepted, and cancellation needs no abort.
  if (settleUnsentCancellation(runId)) return;
  await hub(environment(s.owner_id, s.environment_id)).request(
    "/api/sessions/" + s.hub_session_id + "/abort",
    {},
  );
}
export async function nativeCancel(run: Run) {
  const d = dispatchFor(run.id);
  if (!d) return false;
  // This CAS competes directly with the send lease across API/queue processes.
  // Never decide that work is unsent using a previously read dispatch state.
  const unsent = db
    .prepare(
      "UPDATE native_dispatches SET cancel_requested=1,state='cancelled' WHERE run_id=? AND state IN ('prepared','blocked') AND send_started_at IS NULL",
    )
    .run(run.id);
  if (unsent.changes) {
    transition(run, "cancelled");
    return true;
  }
  const claimed = db
    .prepare(
      "UPDATE native_dispatches SET cancel_requested=1,state='cancellation-requested' WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')",
    )
    .run(run.id);
  if (!claimed.changes) return true;
  emit(run.owner_id, run.id, "native.cancellation-requested", {});
  await deliverCancellation(sessionFor(d.conversation_id)!, run.id);
  return true;
}
let reconciling = false;
export async function reconcileNative() {
  if (reconciling) return;
  reconciling = true;
  try {
    const sessions = db
      .prepare(
        "SELECT s.* FROM native_sessions s JOIN execution_environments e ON e.host_id=s.environment_id WHERE e.revoked_at IS NULL",
      )
      .all() as NativeSession[];
    await Promise.allSettled(sessions.map((s) => reconcile(s)));
  } finally {
    reconciling = false;
  }
}
