import { selectedContext } from "../carried-context.js";
import { randomBytes } from "node:crypto";
import { db, id, now, emit } from "../db.js";
import { owned, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { recordTrace } from "../traces.js";
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
import { InactiveSessionError } from "./client.js";
import { attachedFiles, attachmentPrompt } from "../uploads.js";
import { replyPrompt } from "../../shared/replies.js";
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
    throw new Problem(409, "Wait for the runtime upgrade to finish before starting a run.");
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
          permissionMode: "default",
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
  if (!(detail.session || detail).active) throw new InactiveSessionError();
  const auth = await workerRequest(e, "/verify", {
    launchId: s.launch_id,
    generation: s.generation,
    flavor: s.flavor,
  });
  verifyAuth(s.flavor, auth);
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
export function projectMessages(
  s: NativeSession,
  messages: any[],
  epoch: number,
  cursor: { seq: number | null; at: number | null },
  checkpoint = true,
) {
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
      // Log no native payload: it can contain private tool output.
      if (n.unrecognized)
        console.warn("[hapi] Unrecognized native activity projected");
      const transcriptEcho =
        (m.content?.data ?? m.content)?.meta?.isTranscriptEcho === true;
      const dispatch = db
        .prepare(
          "SELECT * FROM native_dispatches WHERE conversation_id=? AND local_id=?",
        )
        .get(s.conversation_id, m.localId || "") as NativeDispatch | undefined;
      if (dispatch && m.invokedAt && !terminal.includes(dispatch.state))
        state(dispatch, "running");
      let messageId = prior?.message_id;
      if (!(dispatch && n.role === "user") && !transcriptEcho) {
        messageId ||= id();
        const turnId = n.body.loop?.turnId;

        const turn = turnId
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
      if (["loop-delivery-unknown", "loop-interrupted"].includes(n.body.type)) {
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
}
function settleTurn(s: NativeSession, event: any) {
  if (!event.localId || !event.turnId || !event.threadId) return;
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
async function syncPermissions(s: NativeSession, session: any) {
  const active = db
    .prepare(
      "SELECT r.* FROM native_dispatches d JOIN runs r ON r.id=d.run_id WHERE d.conversation_id=? AND d.state IN ('accepted','running','cancellation-requested') ORDER BY r.created_at LIMIT 1",
    )
    .get(s.conversation_id) as Run | undefined;
  for (const [requestId, request] of Object.entries(
    session.agentState?.requests || {},
  )) {
    if (!active) continue;
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
      const approval = requestApproval(active, {
        ...(request as any),
        type: "hapi_native",
        origin: "native",
        sessionId: s.hub_session_id,
        requestId,
      });
      db.prepare(
        "INSERT INTO native_permissions(approval_id,conversation_id,hub_session_id,request_id) VALUES(?,?,?,?)",
      ).run(approval.id, s.conversation_id, s.hub_session_id, requestId);
      transition(active, "awaiting_approval");
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
        "SELECT 1 FROM native_permissions p JOIN approvals a ON a.id=p.approval_id WHERE a.run_id=? AND p.state != 'resolved' LIMIT 1",
      )
      .get(active.id);
    db.prepare(
      "UPDATE runs SET state=? WHERE id=? AND state IN ('running','awaiting_approval')",
    ).run(unresolved ? "awaiting_approval" : "running", active.id);
  }
}
async function deliverDecision(s: NativeSession, p: any) {
  await hub(environment(s.owner_id, s.environment_id)).request(
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
) {
  const a = owned<any>("approvals", approvalId, owner),
    p = db
      .prepare("SELECT * FROM native_permissions WHERE approval_id=?")
      .get(approvalId) as any;
  if (!p) return false;
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
