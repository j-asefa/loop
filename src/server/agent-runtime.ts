import { invokeTool, toolBindings, type ToolBinding } from "./mcp/broker.js";
import { nativeBindings, invokeNative } from "./native-tools.js";
import type { ChatMessage, ToolCall } from "./providers.js";
import { db, emit, id, now } from "./db.js";
import { enqueue, type Run, transition } from "./queue.js";
import { owned, Problem } from "./domain.js";
import { streamConnection, isSubscription } from "./subscriptions.js";
import { saveArtifact } from "./artifacts.js";
import { recordTrace } from "./traces.js";
import { toolErrorMessage } from "./mcp/results.js";
import type { Agent, Connection, Message } from "../shared/types.js";
export type Snapshot = {
  agentId: string;
  name: string;
  provider: Agent["provider"];
  connectionId: string;
  model: string;
  instructions: string;
  folderId: string | null;
  maxTokens?: number;
  maxSeconds?: number;
  source?: { url: string; title: string; excerpt: string };
  teamId?: string;
};
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
  },
) {
  return db
    .transaction(() => {
      const agent = owned<Agent>("agents", data.agentId, owner);
      if (!agent.connection_id)
        throw new Problem(409, "Connect a provider to this agent first");
      const connection = owned<Connection>(
        "connections",
        agent.connection_id,
        owner,
      );
      if (connection.status !== "connected")
        throw new Problem(409, "Reconnect the provider to run this agent");
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
            JSON.parse(prior.payload).folderId !== data.folderId)
        )
          throw new Problem(409, "This request key belongs to different work");
        return prior;
      }
      let conversation = data.conversationId,
        teamId = data.teamId;
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
        teamId = c.team_id || undefined;
        if (data.folderId === undefined) {
          const previous = db
            .prepare(
              "SELECT payload FROM runs WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(owner, conversation) as { payload: string } | undefined;
          if (previous)
            folderId = JSON.parse(previous.payload).folderId ?? null;
        }
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
      }
      const snapshot: Snapshot = {
        agentId: agent.id,
        name: agent.name,
        provider: agent.provider,
        connectionId: connection.id,
        model: agent.model,
        instructions: agent.instructions,
        folderId,
        source: data.source,
        teamId,
      };
      const run = enqueue(owner, data.input, data.idempotencyKey, {
        agent: agent.id,
        conversation,
        payload: snapshot,
      });
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id(), owner, conversation, run.id, "user", data.input, now());
      return run;
    })
    .immediate();
}
export async function executeAgent(run: Run): Promise<boolean> {
  const snapshot = JSON.parse(run.payload) as Snapshot & {
    workflowRun?: string;
  };
  const connection = owned<Connection>(
    "connections",
    snapshot.connectionId,
    run.owner_id,
  );
  if (connection.status !== "connected")
    throw new Problem(409, "Reconnect this provider before continuing.");
  let cp = db
    .prepare("SELECT * FROM agent_checkpoints WHERE run_id=?")
    .get(run.id) as any;
  if (!cp) {
    const turns = db
      .prepare(
        "SELECT m.* FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND m.owner_id=? AND m.role IN ('user','assistant') AND (m.run_id IS NULL OR r.rowid <= (SELECT rowid FROM runs WHERE id=?)) ORDER BY COALESCE(r.created_at,m.created_at),r.rowid,CASE m.role WHEN 'user' THEN 0 ELSE 1 END,m.rowid",
      )
      .all(run.conversation_id, run.owner_id, run.id) as Message[];
    const history: ChatMessage[] = turns.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
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
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(
      snapshot.maxSeconds || (isSubscription(connection) ? 1800 : 180),
      1800,
    ) * 1000,
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
    if (state === "cancelled" || current.status !== "connected")
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
          const outcome = await (
            invocation.binding.connectionId === "__loop__"
              ? invokeNative
              : invokeTool
          )(
            run,
            invocation.binding,
            invocation.call.id,
            invocation.call.arguments,
          );
          if ("pending" in outcome) {
            recordTrace(run, traceKey, {
              ...trace,
              metadata: { state: "waiting" },
            });
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
          const modelContent = JSON.stringify({
            isError: outcome.result.isError === true,
            structuredContent: outcome.result.structuredContent,
            content: outcome.result.content?.filter(
              (x: any) => x.type === "text",
            ),
          }).slice(0, 30000);
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
            ...nativeBindings(run),
          ];
      const calls: ToolCall[] = [];
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
      for await (const chunk of streamConnection(currentConnection, {
        model: snapshot.model,
        instructions: snapshot.instructions,
        messages: structuredClone(history),
        signal: controller.signal,
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
