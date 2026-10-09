import { isNativeConnection } from "./native-connections.js";
import { companionMode } from "./profile.js";
import { invokeTool, toolBindings, type ToolBinding } from "./mcp/broker.js";
import { agentPermissionMode } from "./mcp/approval-policy.js";
import type { PermissionMode } from "../shared/permission-modes.js";
import {
  nativeBindings,
  invokeNative,
  runtimeInstructions,
} from "./native-tools.js";
import type { ChatMessage, ToolCall } from "./providers.js";
import { db, emit, id, now } from "./db.js";
import { enqueue, type Run, transition } from "./queue.js";
import { owned, Problem } from "./domain.js";
import {
  streamConnection,
  isSubscription,
  runtimeWorkspaceKey,
} from "./subscriptions.js";
import { saveArtifact } from "./artifacts.js";
import { recordTrace } from "./traces.js";
import { applyActivity, setActivityCapabilities } from "./activities.js";
import { runtimeActivityMapper } from "./runtime-activities.js";
import type { ActivityUpdate } from "../agent-activities.js";
import { attachedFiles, attachmentPrompt } from "./uploads.js";
import { toolErrorMessage } from "./mcp/results.js";
import { messageReplyContext } from "./message-replies.js";
import { replyPrompt, type ReplyContext } from "../shared/replies.js";
import {
  activeRun,
  saveSteering,
  steeringReceipt,
  SteeringInbox,
} from "./steering.js";
import type { Agent, Connection, Message } from "../shared/types.js";
import type { Automation } from "../shared/agent-mail.js";
import { connectionSelection, type NativeSelection } from "./hapi/contracts.js";
import { executeHapi } from "./hapi/adapter.js";
export type Snapshot = {
  agentId: string;
  name: string;
  provider: Agent["provider"];
  connectionId: string;
  model: string;
  effort?: string | null;
  /** The workspace's native harness approval level when the run was sent. */
  permissionMode?: PermissionMode;
  instructions: string;
  folderId: string | null;
  maxTokens?: number;
  maxSeconds?: number;
  source?: { url: string; title: string; excerpt: string };
  teamId?: string;
  execution?: NativeSelection;
  attachmentIds?: string[];
  replyTo?: ReplyContext;
};
// The connection a conversation's next turn runs on: a managed conversation
// keeps its HAPI connection, any other follows the agent's current one.
// Shared by submit and command discovery so the catalog matches the turn.
export function nextTurnConnection(
  owner: string,
  agent: Pick<Agent, "connection_id">,
  conversation?: {
    execution_backend?: string | null;
    execution_connection_id?: string | null;
  },
) {
  if (!agent.connection_id)
    throw new Problem(409, "Connect a provider to this agent first");
  let connection = owned<Connection>("connections", agent.connection_id, owner);
  if (
    conversation?.execution_backend === "hapi" &&
    conversation.execution_connection_id
  )
    connection = owned<Connection>(
      "connections",
      conversation.execution_connection_id,
      owner,
    );
  else if (
    conversation?.execution_backend === "legacy" &&
    connectionSelection(connection)
  )
    throw new Problem(
      409,
      "This conversation belongs to its original backend. Start a new native conversation.",
    );
  const execution = connectionSelection(connection);
  if (!execution && (isNativeConnection(connection) || isSubscription(connection)))
    throw new Problem(409, "This connection used direct harness execution, which is no longer supported. Choose its HAPI connection and start a new conversation; existing history is preserved.");
  if (connection.status !== "connected" && !execution)
    throw new Problem(409, "Reconnect the provider to run this agent");
  return { connection, execution };
}

// The project folder of a conversation's next turn when the sender picks
// none: the previous run's, which may be none, else the agent's.
export function nextTurnFolder(
  owner: string,
  agent: Pick<Agent, "folder_id">,
  conversation?: string,
): string | null {
  const previous = conversation
    ? (db
        .prepare(
          "SELECT payload FROM runs WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(owner, conversation) as { payload: string } | undefined)
    : undefined;
  return previous
    ? (JSON.parse(previous.payload).folderId ?? null)
    : agent.folder_id || null;
}

export function submit(
  owner: string,
  data: {
    agentId: string;
    conversationId?: string;
    input: string;
    idempotencyKey: string;
    folderId?: string | null;
    source?: { url: string; title: string; excerpt: string };
    teamId?: string;
    attachmentIds?: string[];
    replyToMessageId?: string;
    /** The highlighted part of the replied-to message to quote. */
    replyExcerpt?: string;
    // Internal retries preserve the original quote, even if the source changed.
    replyTo?: ReplyContext;
    // User follow-ups steer active work. Internal delegation/retry creates work.
    steer?: boolean;
    personal?: boolean;
    // Sent by Loop on your behalf (a watched pull request or a teammate
    // agent's message), not typed by you.
    automation?: Automation;
  },
) {
  return db
    .transaction(() => {
      const request = JSON.stringify({
        agentId: data.agentId,
        conversationId: data.conversationId,
        input: data.input,
        folderId: data.folderId,
        attachmentIds: data.attachmentIds || [],
        replyToMessageId: data.replyToMessageId,
        replyExcerpt: data.replyExcerpt,
      });
      const steered = steeringReceipt(owner, data.idempotencyKey, request);
      if (steered) return steered;
      const agent = owned<Agent>("agents", data.agentId, owner);
      let conversation = data.conversationId,
        teamId = data.teamId;
      if (data.steer && !conversation) {
        const active = db
          .prepare(
            "SELECT r.* FROM runs r WHERE owner_id=? AND agent_id=? AND kind='agent' AND state IN ('running','awaiting_approval') AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=r.id AND c.stage='done') ORDER BY created_at DESC",
          )
          .all(owner, agent.id) as Run[];
        if (active.length > 1)
          throw new Problem(
            409,
            "This agent has several active conversations. Open the one you want to steer and reply there.",
          );
        conversation = active[0]?.conversation_id || undefined;
      }
      const attachments = attachedFiles(owner, data.attachmentIds || []);
      const live = data.steer && conversation ? activeRun(owner, conversation, agent.id) : undefined;
      // Steering belongs to the running task, even if its agent now selects
      // another provider for future conversations.
      const steeringConnection = live?.liveInput ? JSON.parse(live.run.payload).connectionId : undefined;
      const { connection, execution } = nextTurnConnection(
        owner,
        steeringConnection ? { connection_id: steeringConnection } : agent,
        conversation && !steeringConnection
          ? owned<any>("conversations", conversation, owner)
          : undefined,
      );
      if (data.folderId) owned("folders", data.folderId, owner);
      const prior = db
        .prepare("SELECT * FROM runs WHERE owner_id=? AND idempotency_key=?")
        .get(owner, data.idempotencyKey) as Run | undefined;
      if (prior) {
        if (
          prior.input !== data.input ||
          prior.agent_id !== agent.id ||
          (data.conversationId &&
            prior.conversation_id !== data.conversationId) ||
          (data.folderId !== undefined &&
            JSON.parse(prior.payload).folderId !== data.folderId) ||
          JSON.stringify(JSON.parse(prior.payload).attachmentIds || []) !==
            JSON.stringify(attachments.map((file) => file.id)) ||
          JSON.parse(prior.payload).replyTo?.id !==
            (data.replyToMessageId || data.replyTo?.id) ||
          (!data.replyTo &&
            data.replyExcerpt?.trim() &&
            JSON.parse(prior.payload).replyTo?.content?.trim() !==
              data.replyExcerpt.trim())
        )
          throw new Problem(409, "This request key belongs to different work");
        return prior;
      }
      const replyTo =
        data.replyTo ||
        (data.replyToMessageId
          ? messageReplyContext(
              owner,
              agent.id,
              data.conversationId,
              data.replyToMessageId,
              data.replyExcerpt,
            )
          : undefined);
      if (agent.retired_at)
        throw new Problem(409, "This agent is retired. Restore it from its profile before sending new work.");
      if (!conversation && !teamId) {
        const managerTeam = db
          .prepare(
            "SELECT conversation_id,id FROM teams WHERE owner_id=? AND manager_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
          )
          .get(owner, agent.id) as
          { conversation_id: string; id: string } | undefined;
        if (managerTeam) {
          conversation = managerTeam.conversation_id || undefined;
          teamId = managerTeam.id;
        }
      }
      let folderId =
        data.folderId === undefined ? agent.folder_id || null : data.folderId;
      if (conversation) {
        const c = owned<{ agent_id: string; team_id: string | null }>(
          "conversations",
          conversation,
          owner,
        );
        if (c.agent_id !== agent.id)
          throw new Problem(400, "This conversation belongs to another agent");
        if (teamId && c.team_id !== teamId)
          throw new Problem(400, "Conversation belongs to another team");
        // Loop owns the transcript, so a changed provider or model simply
        // handles the next turn; active work keeps its original snapshot.
        teamId = c.team_id || undefined;
        if (data.folderId === undefined)
          folderId = nextTurnFolder(owner, agent, conversation);
      } else {
        if (teamId) {
          const team = owned<any>("teams", teamId, owner);
          if (
            team.manager_id !== agent.id &&
            !db
              .prepare(
                "SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?",
              )
              .get(teamId, agent.id)
          )
            throw new Problem(403, "Agent is not a member of this team");
        }
        conversation = id();
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at,team_id) VALUES(?,?,?,?,?,?)",
        ).run(
          conversation,
          owner,
          agent.id,
          data.input.slice(0, 100),
          now(),
          teamId || null,
        );
        if (teamId)
          db.prepare(
            "UPDATE teams SET conversation_id=? WHERE id=? AND owner_id=? AND manager_id=? AND conversation_id IS NULL AND deleted_at IS NULL",
          ).run(conversation, teamId, owner, agent.id);
      }
      const snapshot: Snapshot = {
        agentId: agent.id,
        name: agent.name,
        provider: connection.provider,
        connectionId: connection.id,
        model:
          connection.id === agent.connection_id
            ? agent.model
            : (
                db
                  .prepare(
                    "SELECT json_extract(payload,'$.model') model FROM runs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
                  )
                  .get(conversation) as { model?: string } | undefined
              )?.model || agent.model,
        effort: agent.effort,
        permissionMode: agentPermissionMode(owner),
        instructions: agent.instructions,
        folderId,
        source: data.source,
        teamId,
        execution,
        attachmentIds: attachments.map((file) => file.id),
        replyTo,
      };
      // HAPI has no SteeringInbox consumer, and OpenCode and ACP turns cannot
      // take live input; preserve durable queued follow-ups for both.
      // The active run's own connection decides, not the agent's current one.
      if (data.steer && !execution) {
        const found = activeRun(owner, conversation, agent.id);
        const active = found?.liveInput ? found.run : undefined;
        if (active) {
          if (
            data.folderId !== undefined &&
            (JSON.parse(active.payload).folderId || null) !== data.folderId
          )
            throw new Problem(
              409,
              "This agent is working in another project. Reply in its active conversation or wait for it to finish.",
            );
          return saveSteering(
            active,
            data.idempotencyKey,
            request,
            data.input,
            {
              attachments,
              replyTo,
              personal: data.personal === true,
              ...(data.automation ? { automation: data.automation } : {}),
            },
          );
        }
      }
      db.prepare(
        "UPDATE conversations SET execution_backend=?,execution_connection_id=COALESCE(execution_connection_id,?),project_id=COALESCE(project_id,?) WHERE id=?",
      ).run(
        execution ? "hapi" : "legacy",
        connection.id,
        folderId,
        conversation,
      );
      const run = enqueue(owner, data.input, data.idempotencyKey, {
        agent: agent.id,
        conversation,
        payload: snapshot,
      });
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id(),
        owner,
        conversation,
        run.id,
        "user",
        data.input,
        JSON.stringify({
          attachments,
          replyTo,
          personal: data.personal === true,
          ...(data.automation ? { automation: data.automation } : {}),
        }),
        now(),
      );
      return run;
    })
    .immediate();
}
// API-provider activities come from Loop's own broker and runtime, never from
// model prose. Display records must not fail a run, so rejections are dropped.
function apiToolActivity(
  run: Run,
  callId: string,
  patch: Extract<ActivityUpdate, { kind: "tool" }>["patch"],
) {
  applyActivity(
    { owner: run.owner_id, conversation: run.conversation_id, run: run.id },
    {
      v: 1,
      kind: "tool",
      id: callId,
      source: { transport: "api", origin: "broker" },
      patch: { ...patch, links: { broker: callId, trace: "tool:" + callId } },
    },
  );
}
function apiSessionActivities(
  run: Run,
  snapshot: Snapshot,
  tools: boolean,
  runtime: "codex" | "claude" | undefined,
  reported: ReadonlySet<string>,
) {
  const scope = { owner: run.owner_id, conversation: run.conversation_id };
  const source = { transport: "api" as const, origin: "loop" };
  const reason =
    "Set in this agent's settings. Loop applies it at the start of each run.";
  applyActivity(scope, {
    v: 1,
    kind: "settings",
    id: "session",
    source,
    patch: {
      options: [
        {
          id: "model",
          label: "Model",
          type: "select",
          confirmed: snapshot.model,
          application: "next-turn",
          mutable: false,
          reason,
          provenance: "loop",
        },
        snapshot.effort
          ? {
              id: "effort",
              label: "Effort",
              type: "select",
              confirmed: snapshot.effort,
              application: "next-turn",
              mutable: false,
              reason,
              provenance: "loop",
            }
          : { id: "effort", confirmed: null },
      ],
    },
  });
  apiCapabilities(run, tools, runtime, reported);
}
// Structured features this conversation's runtime already reported, so a new
// run does not reset them to undiscovered before its first result.
function reportedFeatures(run: Run, runtime: "codex" | "claude" | undefined) {
  if (!runtime || !run.conversation_id) return [];
  const row = db
    .prepare(
      "SELECT record FROM agent_activities WHERE owner_id=? AND scope=? AND activity_key=?",
    )
    .get(run.owner_id, run.conversation_id, `capabilities:api:${runtime}`) as
    | { record: string }
    | undefined;
  const capabilities = row ? JSON.parse(row.record).capabilities || {} : {};
  return (["output", "diffs"] as const).filter(
    (feature) => capabilities[feature]?.state === "supported",
  );
}
// Capabilities of an API-runtime run. Provider-key runs execute only Loop's
// tool broker, whose MCP results carry no trusted file-change or command
// metadata, and have no command catalog. Subscription runs execute in a Codex
// or Claude Code runtime whose own executor reports structured command and
// file results; those become supported once this run has received one, since
// runtimes older than this build do not send them.
function apiCapabilities(
  run: Run,
  tools: boolean,
  runtime: "codex" | "claude" | undefined,
  reported: ReadonlySet<string> = new Set(),
) {
  const scope = { owner: run.owner_id, conversation: run.conversation_id };
  const unavailable = (reason: string) =>
    ({ state: "unsupported", source: "loop", reason }) as const;
  const label = runtime === "codex" ? "Codex runtime" : "Claude Code runtime";
  const structured = (feature: string, what: string) =>
    reported.has(feature)
      ? ({ state: "supported", source: `${label} structured results` } as const)
      : ({
          state: "undiscovered",
          source: label,
          reason: `Shown when the runtime reports its first structured ${what}. Runtimes older than this Loop version report only text traces.`,
        } as const);
  setActivityCapabilities(scope, { transport: "api", harness: runtime }, {
    plans: tools
      ? {
          state: "supported",
          source: runtime ? `loop_plan tool and ${label}` : "loop_plan tool",
        }
      : unavailable("Workflow runs do not receive workspace tools."),
    tools: tools
      ? { state: "supported", source: "loop tool broker" }
      : unavailable("Workflow runs do not receive workspace tools."),
    diffs: runtime
      ? structured("diffs", "file change")
      : unavailable(
          "Provider-key runs execute only Loop's tool broker; MCP tool results carry no trusted file-change data.",
        ),
    output: runtime
      ? structured("output", "command result")
      : unavailable(
          "Provider-key runs execute only Loop's tool broker; MCP tool results carry no structured command output.",
        ),
    settings: { state: "supported", source: "loop agent settings" },
    commands: runtime
      ? { state: "supported", source: `${label} catalog (command picker)` }
      : unavailable(
          "Commands and skills come from a Codex or Claude Code runtime. This agent uses a provider API key.",
        ),
  });
}
export async function executeAgent(run: Run): Promise<boolean> {
  const snapshot = JSON.parse(run.payload) as Snapshot & {
    workflowRun?: string;
  };
  if (snapshot.execution?.backend === "hapi") return executeHapi(run);
  const connection = owned<Connection>(
    "connections",
    snapshot.connectionId,
    run.owner_id,
  );
  if (connection.status !== "connected")
    throw new Problem(409, "Reconnect this provider before continuing.");
  if (isNativeConnection(connection) || isSubscription(connection))
    throw new Problem(409, "Harness execution requires HAPI. This old run was not dispatched; choose a HAPI connection and start a new conversation.");
  let cp = db
    .prepare("SELECT * FROM agent_checkpoints WHERE run_id=?")
    .get(run.id) as any;
  if (!cp) {
    const turns = db
      .prepare(
        "SELECT m.* FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND m.owner_id=? AND m.role IN ('user','assistant') AND (m.run_id IS NULL OR r.rowid <= (SELECT rowid FROM runs WHERE id=?)) AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.message_id=m.id AND (s.run_id=? OR s.state<>'delivered')) ORDER BY COALESCE(r.created_at,m.created_at),r.rowid,CASE m.role WHEN 'user' THEN 0 ELSE 1 END,m.rowid",
      )
      .all(run.conversation_id, run.owner_id, run.id, run.id) as Message[];
    const history: ChatMessage[] = turns.map((m) => ({
      role: m.role as "user" | "assistant",
      content: attachmentPrompt(
        replyPrompt(
          m.content,
          m.role === "user" ? JSON.parse(m.metadata).replyTo : undefined,
        ),
        JSON.parse(m.metadata).attachments || [],
      ),
      ...(JSON.parse(m.metadata).attachments?.length
        ? { attachments: JSON.parse(m.metadata).attachments }
        : {}),
    }));
    // Bound total context explicitly; oversized histories require an intentional continuation.
    if (Buffer.byteLength(JSON.stringify(history)) > 500000)
      throw new Problem(
        413,
        "This conversation is too large for this run. Select messages and create a focused continuation.",
      );
    const messageId = id();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','',?,?)",
      ).run(
        messageId,
        run.owner_id,
        run.conversation_id,
        run.id,
        JSON.stringify({ ...snapshot, partial: true }),
        now(),
      );
      const artifactId = saveArtifact(run.owner_id, {
        title: run.input.slice(0, 85),
        content: "",
        agent: run.agent_id,
        conversation: run.conversation_id,
        run: run.id,
        folder: snapshot.folderId,
        metadata: { ...snapshot, messageId, partial: true },
      });
      db.prepare(
        "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,?,?,?)",
      ).run(run.id, messageId, artifactId, JSON.stringify(history));
    }).immediate();
    cp = db
      .prepare("SELECT * FROM agent_checkpoints WHERE run_id=?")
      .get(run.id);
  }
  let history = JSON.parse(cp.history) as ChatMessage[],
    output = cp.output as string,
    round = cp.round as number;
  if (cp.stage === "done") return true;
  const runtime = isSubscription(connection)
    ? connection.provider === "codex"
      ? ("codex" as const)
      : ("claude" as const)
    : undefined;
  const structured = runtimeActivityMapper(run, reportedFeatures(run, runtime));
  apiSessionActivities(
    run,
    snapshot,
    !snapshot.workflowRun,
    runtime,
    structured.reported,
  );
  const steering = new SteeringInbox(run, (message) => {
    history.push(message);
    db.prepare("UPDATE agent_checkpoints SET history=? WHERE run_id=?").run(
      JSON.stringify(history),
      run.id,
    );
  });
  const persist = db.transaction((partial: boolean) => {
    const metadata = JSON.stringify({
      ...snapshot,
      messageId: cp.message_id,
      partial,
    });
    db.prepare("UPDATE messages SET content=?,metadata=? WHERE id=?").run(
      output,
      metadata,
      cp.message_id,
    );
    db.prepare(
      // Version 1 belongs to the generator. A saved user content revision
      // becomes the current artifact and must never be replaced by a chunk.
      "UPDATE artifacts SET content=?,metadata=?,updated_at=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM artifact_versions WHERE artifact_id=artifacts.id AND version>1)",
    ).run(output, metadata, now(), cp.artifact_id);
    db.prepare(
      "UPDATE artifact_versions SET content=? WHERE artifact_id=? AND version=1",
    ).run(output, cp.artifact_id);
    db.prepare("UPDATE agent_checkpoints SET output=? WHERE run_id=?").run(
      output,
      run.id,
    );
  }).immediate;
  const controller = new AbortController();
  // Native harnesses own their turns. Only an explicit workflow budget should
  // impose a wall-clock deadline on a subscription run.
  const maxSeconds =
    (snapshot.maxSeconds && snapshot.maxSeconds > 0
      ? snapshot.maxSeconds
      : undefined) ?? (isSubscription(connection) ? undefined : 180);
  const timeout =
    maxSeconds === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new Problem(
                408,
                `This run reached its configured ${maxSeconds}-second execution limit. Partial work is saved; review it before retrying.`,
              ),
            ),
          maxSeconds * 1000,
        );
  const monitor = setInterval(() => {
    const state = (
      db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
        state: string;
      }
    ).state;
    const current = owned<Connection>(
      "connections",
      snapshot.connectionId,
      run.owner_id,
    );
    if (
      ["cancelled", "interrupted"].includes(state) ||
      current.status !== "connected"
    )
      controller.abort();
  }, 300);
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const boundary = (
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
          state: string;
        }
      ).state;
      if (boundary === "cancelled") {
        persist(true);
        return false;
      }
      if (boundary === "pausing") {
        persist(true);
        transition(run, "paused");
        return false;
      }
      let pending = JSON.parse(cp.pending) as {
        call: ToolCall;
        binding: ToolBinding;
        done?: boolean;
      }[];
      if (cp.stage === "tools") {
        for (const invocation of pending) {
          if (invocation.done) continue;
          const traceKey = "tool:" + invocation.call.id;
          const trace = {
            kind: "tool" as const,
            title: invocation.binding.tool,
          };
          recordTrace(run, traceKey, {
            ...trace,
            metadata: { state: "running" },
          });
          // A plan is its own activity; a second tool card would duplicate it.
          const toolActivity =
            invocation.binding.tool === "loop_plan" &&
            invocation.binding.connectionId === "__loop__"
              ? () => {}
              : (patch: Parameters<typeof apiToolActivity>[2]) =>
                  apiToolActivity(run, invocation.call.id, patch);
          toolActivity({
            title: invocation.binding.tool,
            status: "running",
            input: JSON.stringify(invocation.call.arguments ?? {}).slice(
              0,
              16000,
            ),
          });
          let outcome: Awaited<ReturnType<typeof invokeTool>>;
          try {
            outcome =
              invocation.binding.connectionId === "__loop__"
                ? await invokeNative(
                    run,
                    invocation.binding,
                    invocation.call.id,
                    invocation.call.arguments,
                    { plans: true },
                  )
                : await invokeTool(
                    run,
                    invocation.binding,
                    invocation.call.id,
                    invocation.call.arguments,
                  );
          } catch (error) {
            // The broker marks calls whose external outcome is uncertain.
            const unknown = (
              db
                .prepare(
                  "SELECT 1 FROM tool_invocations WHERE run_id=? AND call_id=? AND state='unknown'",
                )
                .get(run.id, invocation.call.id) as unknown
            )
              ? true
              : false;
            toolActivity({
              status: unknown ? "unknown" : "failed",
              error: String((error as Error)?.message || error).slice(0, 16000),
            });
            throw error;
          }
          if ("pending" in outcome) {
            recordTrace(run, traceKey, {
              ...trace,
              metadata: { state: "waiting" },
            });
            toolActivity({ status: "waiting" });
            persist(true);
            // Release the lease only after the checkpoint is saved. A fast
            // worker must not resume this manager while it still persists.
            if (
              invocation.binding.tool === "loop_delegate" &&
              invocation.binding.connectionId === "__loop__"
            ) {
              db.transaction(() => {
                const state = owned<Run>("runs", run.id, run.owner_id).state;
                if (state === "running" || state === "pausing") {
                  db.prepare(
                    "UPDATE runs SET worker_id=NULL,heartbeat=NULL,active_ms=active_ms+CASE WHEN active_since IS NOT NULL THEN max(0,?-active_since) ELSE 0 END,active_since=NULL WHERE id=?",
                  ).run(now(), run.id);
                  if (state === "pausing") transition(run, "paused");
                  else emit(run.owner_id, run.id, "waiting_children", {});
                }
              }).immediate();
            }
            return false;
          }
          recordTrace(run, traceKey, {
            ...trace,
            content:
              outcome.result.isError === true
                ? toolErrorMessage(outcome.result)
                : outcome.artifactId
                  ? ""
                  : JSON.stringify(outcome.result.content || []).slice(
                      0,
                      30000,
                    ),
            artifactId: outcome.artifactId,
            metadata: {
              state: outcome.result.isError === true ? "failed" : "completed",
              isError: outcome.result.isError === true,
            },
          });
          toolActivity({
            status: outcome.result.isError === true ? "failed" : "completed",
            ...(outcome.result.isError === true && {
              error: toolErrorMessage(outcome.result).slice(0, 16000),
            }),
            content: [
              ...(outcome.artifactId
                ? [{ type: "artifact" as const, artifactId: outcome.artifactId }]
                : []),
              ...(outcome.result.content || [])
                .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                .slice(0, 8)
                .map((c: any) => ({
                  type: "text" as const,
                  text: String(c.text).slice(0, 16000),
                })),
            ],
          });
          const toolContent = JSON.stringify({
            isError: outcome.result.isError === true,
            structuredContent: outcome.result.structuredContent,
            content: outcome.result.content?.filter(
              (x: any) => x.type === "text",
            ),
          });
          // File chunks are already bounded by bytes. Truncating the JSON
          // would corrupt escaped text or base64 needed to recover the file.
          const modelContent =
            invocation.binding.connectionId === "__loop__" &&
            invocation.call.name === "loop_read_file"
              ? toolContent
              : toolContent.slice(0, 30000);
          history.push({
            role: "tool",
            toolCallId: invocation.call.id,
            content: modelContent,
            isError: outcome.result.isError === true,
          });
          invocation.done = true;
          db.prepare(
            "UPDATE agent_checkpoints SET history=?,pending=? WHERE run_id=?",
          ).run(JSON.stringify(history), JSON.stringify(pending), run.id);
        }
        cp.stage = "model";
        cp.pending = "[]";
        db.prepare(
          "UPDATE agent_checkpoints SET stage='model',pending='[]' WHERE run_id=?",
        ).run(run.id);
      }
      const state = (
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
          state: string;
        }
      ).state;
      if (state === "cancelled") {
        persist(true);
        return false;
      }
      if (state === "pausing") {
        persist(true);
        transition(run, "paused", {
          message: "Paused at a provider/tool boundary.",
        });
        return false;
      }
      const currentConnection = owned<Connection>(
        "connections",
        snapshot.connectionId,
        run.owner_id,
      );
      if (currentConnection.status !== "connected")
        throw new Problem(409, "Provider was disconnected.");
      const bindings = snapshot.workflowRun
        ? []
        : [
            ...toolBindings(run.owner_id, run.agent_id!),
            ...nativeBindings(run, { plans: true }),
          ];
      const calls: ToolCall[] = [];
      db.transaction(() => {
        steering.appendPending(history);
        db.prepare("UPDATE agent_checkpoints SET history=? WHERE run_id=?").run(
          JSON.stringify(history),
          run.id,
        );
      }).immediate();
      let turnText = "";
      // Each provider round is a trace. Only the round with no tool calls
      // becomes the saved answer; earlier commentary must not accumulate in it.
      output = "";
      const traceKey = "turn:" + round;
      const saveTurn = (final = false) =>
        recordTrace(run, traceKey, {
          kind: "message",
          title: final ? "Final answer" : "Agent update",
          content: turnText,
          metadata: { final, round },
        });
      saveTurn();
      emit(run.owner_id, run.id, "message.started", {
        messageId: cp.message_id,
        round,
        snapshot,
      });
      const generation = new AbortController();
      const redirected = new Error("Input added to the active run");
      const stopSteering = !isSubscription(currentConnection)
        ? steering.listen(async () => {
            generation.abort(redirected);
          })
        : undefined;
      try {
        for await (const chunk of streamConnection(currentConnection, {
          workspaceKey: runtimeWorkspaceKey(run.owner_id, run.agent_id!),
          model: snapshot.model,
          effort: snapshot.effort || undefined,
          instructions: runtimeInstructions(
            snapshot.instructions,
            bindings,
            history.findLast((m) => m.role === "user")?.content,
          ),
          messages: structuredClone(history),
          signal: AbortSignal.any([controller.signal, generation.signal]),
          steering,
          maxTokens: snapshot.maxTokens,
          tools: bindings.length ? bindings : undefined,
        })) {
          if (chunk.trace) {
            const trace = chunk.trace;
            recordTrace(run, `runtime:${round}:${trace.id}`, {
              kind: trace.kind,
              title: trace.title,
              content: trace.content,
              metadata: { native: true, state: trace.state },
            });
            emit(run.owner_id, run.id, "trace.updated", { round });
          }
          if (chunk.activity && runtime) {
            const before = structured.reported.size;
            if (structured.apply(chunk.activity))
              emit(run.owner_id, run.id, "trace.updated", { round });
            if (structured.reported.size !== before)
              apiCapabilities(
                run,
                !snapshot.workflowRun,
                runtime,
                structured.reported,
              );
          }
          if (chunk.text) {
            turnText += chunk.text;
            output += chunk.text;
            saveTurn();
            persist(true);
            emit(run.owner_id, run.id, "message.delta", {
              messageId: cp.message_id,
              text: chunk.text,
            });
          }
          if (chunk.toolCall) {
            if (calls.length >= 8)
              throw new Problem(
                422,
                "Provider exceeded the per-turn tool-call limit",
              );
            calls.push(chunk.toolCall);
          }
          if (chunk.usage || chunk.externalId)
            emit(run.owner_id, run.id, "provider.receipt", {
              usage: chunk.usage,
              externalId: chunk.externalId,
            });
        }
      } catch (error) {
        if (
          generation.signal.reason !== redirected ||
          controller.signal.aborted
        )
          throw error;
      } finally {
        await stopSteering?.();
      }
      if (
        generation.signal.reason === redirected &&
        !controller.signal.aborted
      ) {
        round++;
        db.prepare("UPDATE agent_checkpoints SET round=? WHERE run_id=?").run(
          round,
          run.id,
        );
        continue;
      }
      controller.signal.throwIfAborted();
      if (owned<Run>("runs", run.id, run.owner_id).state === "cancelled") {
        persist(true);
        return false;
      }
      if (!calls.length && !turnText.trim())
        throw new Problem(
          422,
          "The provider finished without an answer. Retry this task to request a response.",
        );
      round++;
      history.push({
        role: "assistant",
        content: turnText,
        toolCalls: calls.length ? calls : undefined,
      });
      if (!calls.length) {
        // Serialize the final boundary with submit(): input arriving before
        // completion stays in this run; input arriving afterwards starts work.
        const continuing = db
          .transaction(() => {
            if (steering.appendPending(history)) {
              db.prepare(
                "UPDATE agent_checkpoints SET round=?,history=? WHERE run_id=?",
              ).run(round, JSON.stringify(history), run.id);
              return true;
            }
            db.prepare(
              "UPDATE agent_checkpoints SET round=?,history=?,stage='done' WHERE run_id=?",
            ).run(round, JSON.stringify(history), run.id);
            return false;
          })
          .immediate();
        if (continuing) continue;
        saveTurn(true);
        persist(false);
        db.prepare("UPDATE runs SET result=? WHERE id=?").run(output, run.id);
        db.prepare(
          "UPDATE agent_checkpoints SET round=?,history=?,stage='done' WHERE run_id=?",
        ).run(round, JSON.stringify(history), run.id);
        const current = (
          db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
            state: string;
          }
        ).state;
        if (current === "pausing") {
          transition(run, "paused", {
            message:
              "Response completed and saved. Resume to mark this run complete.",
          });
          return false;
        }
        emit(run.owner_id, run.id, "message.completed", {
          messageId: cp.message_id,
        });
        return true;
      }
      pending = calls.map((call) => {
        const binding = bindings.find((b) => b.name === call.name);
        if (!binding)
          throw new Problem(
            403,
            "Model requested a tool outside its available catalog",
          );
        if (
          !call.arguments ||
          typeof call.arguments !== "object" ||
          Array.isArray(call.arguments)
        )
          throw new Problem(422, "Tool arguments must be an object");
        return { call, binding };
      });
      cp.stage = "tools";
      cp.pending = JSON.stringify(pending);
      db.prepare(
        "UPDATE agent_checkpoints SET round=?,history=?,pending=?,stage='tools' WHERE run_id=?",
      ).run(round, JSON.stringify(history), cp.pending, run.id);
    }
  } catch (error) {
    persist(true);
    if (controller.signal.aborted) {
      const current = owned<Run>("runs", run.id, run.owner_id);
      if (current.state === "cancelled") return false;
      if (controller.signal.reason instanceof Problem)
        throw controller.signal.reason;
      throw new Problem(
        408,
        "The run stopped before an answer was completed. Check the provider connection and review partial work before retrying.",
      );
    }
    throw error;
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
  }
}
