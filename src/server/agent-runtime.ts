import { invokeTool, toolBindings, type ToolBinding } from "./mcp/broker.js";
import type { ChatMessage, ToolCall } from "./providers.js";
import { db, emit, id, now } from "./db.js";
import { enqueue, type Run, transition } from "./queue.js";
import { owned, Problem } from "./domain.js";
import { streamConnection } from "./subscriptions.js";
import { saveArtifact } from "./artifacts.js";
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
};
export function submit(
  owner: string,
  data: {
    agentId: string;
    conversationId?: string;
    input: string;
    idempotencyKey: string;
    folderId?: string;
    source?: { url: string; title: string; excerpt: string };
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
          JSON.parse(prior.payload).folderId !== (data.folderId || null)
        )
          throw new Problem(409, "This request key belongs to different work");
        return prior;
      }
      let conversation = data.conversationId;
      if (conversation) {
        const c = owned<{ agent_id: string }>(
          "conversations",
          conversation,
          owner,
        );
        if (c.agent_id !== agent.id)
          throw new Problem(400, "This conversation belongs to another agent");
      } else {
        conversation = id();
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
        ).run(conversation, owner, agent.id, data.input.slice(0, 100), now());
      }
      const snapshot: Snapshot = {
        agentId: agent.id,
        name: agent.name,
        provider: agent.provider,
        connectionId: connection.id,
        model: agent.model,
        instructions: agent.instructions,
        folderId: data.folderId || null,
        source: data.source,
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
    Math.min(snapshot.maxSeconds || 180, 1800) * 1000,
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
    while (round < 7) {
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
          const outcome = await invokeTool(
            run,
            invocation.binding,
            invocation.call.id,
            invocation.call.arguments,
          );
          if ("pending" in outcome) {
            persist(true);
            return false;
          }
          const modelContent = JSON.stringify({
            structuredContent: outcome.result.structuredContent,
            content: outcome.result.content?.filter(
              (x: any) => x.type === "text",
            ),
          }).slice(0, 30000);
          history.push({
            role: "tool",
            toolCallId: invocation.call.id,
            content: modelContent,
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
        : toolBindings(run.owner_id, run.agent_id!);
      const calls: ToolCall[] = [];
      let turnText = "";
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
        if (chunk.text) {
          turnText += chunk.text;
          output += chunk.text;
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
      round++;
      history.push({
        role: "assistant",
        content: turnText,
        toolCalls: calls.length ? calls : undefined,
      });
      if (!calls.length) {
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
            "Model requested a tool outside its granted list",
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
    throw new Problem(
      422,
      "Agent reached its seven-turn budget. Start a new task to continue.",
    );
  } catch (error) {
    persist(true);
    throw error;
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
  }
}
