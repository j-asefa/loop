import { afterAll, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Live } from "../src/server/native-sessions";
import type { Run } from "../src/server/queue";
import { NativeOutput } from "../src/server/native-output";
import { replyPrompt } from "../src/shared/replies";

const dir = mkdtempSync(join(tmpdir(), "loop-replies-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { recordTrace } = await import("../src/server/traces");
const { nativeSessions } = await import("../src/server/native-sessions");
const { core } = await import("../src/server/core-routes");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(core);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = "http://127.0.0.1:" + (server.address() as any).port;
async function request(path: string, body?: unknown, owner = "alice") {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
function source(provider = "openai", owner = "alice") {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,?,'Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    provider,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  const agent = createAgent(owner, {
    name: "reply-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const run = submit(owner, {
    agentId: agent.id,
    input: "Investigate the collision",
    idempotencyKey: id(),
  });
  const message = trace(
    run,
    "selected",
    "I am separating the session tables.\n\nBoth backends will retain their history.",
  );
  const later = trace(run, "later", "Newer update that was not selected.");
  transition(run, "cancelled");
  return { agent, run, message, later };
}
function trace(
  run: Run,
  key: string,
  content: string,
  kind: "message" | "tool" = "message",
) {
  recordTrace(run, key, { kind, title: "Agent update", content });
  return (
    "trace:" +
    (
      db
        .prepare("SELECT id FROM run_traces WHERE run_id=? AND trace_key=?")
        .get(run.id, key) as { id: number }
    ).id
  );
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(["openai", "anthropic"] as const)(
  "sends the selected public update as context to %s and saves it with the reply",
  async (provider) => {
    const { agent, run, message } = source(provider);
    const accepted = await request("/runs", {
      agentId: agent.id,
      conversationId: run.conversation_id,
      replyToMessageId: message,
      input: "Why do the two tables need different names?",
      idempotencyKey: id(),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.data.input).toBe(
      "Why do the two tables need different names?",
    );
    const transcript = await request("/conversations/" + run.conversation_id);
    const sent = transcript.data.messages.find(
      (m: any) => m.run_id === accepted.data.id,
    );
    expect(sent.content).toBe(accepted.data.input);
    expect(JSON.parse(sent.metadata).replyTo).toMatchObject({
      id: message,
      name: agent.name,
      content: expect.stringContaining("separating the session tables"),
    });
    let received = "";
    let history: { role: string; content: string }[] = [];
    const restore = withTestAdapter(provider, {
      async models() {
        return [];
      },
      async *stream(_secret, input) {
        history = input.messages;
        received = input.messages.at(-1)!.content;
        yield { text: "They store different session formats." };
      },
    });
    try {
      const claimed = claim("reply-worker")!;
      expect(claimed.id).toBe(accepted.data.id);
      expect(await executeAgent(claimed)).toBe(true);
      transition(claimed, "completed");
      expect(received).toContain("@" + agent.name);
      expect(received).toContain("> I am separating the session tables.");
      expect(received).toContain("> Both backends will retain their history.");
      expect(received).toContain(accepted.data.input);
      expect(received).not.toContain("Newer update that was not selected");
      const followup = submit("alice", {
        agentId: agent.id,
        conversationId: run.conversation_id!,
        input: "Continue with the migration",
        idempotencyKey: id(),
      });
      const next = claim("reply-worker")!;
      expect(next.id).toBe(followup.id);
      expect(await executeAgent(next)).toBe(true);
      transition(next, "completed");
      expect(
        history
          .filter((m) => m.content.includes("separating the session tables"))
          .map((m) => m.role),
      ).toEqual(["user"]);
      expect(history.find((m) => m.role === "assistant")?.content).toBe(
        "They store different session formats.",
      );
    } finally {
      restore();
    }
  },
);

it("quotes your own prompts and rejects tool logs and messages from another owner, agent or conversation", async () => {
  const a = source(),
    other = source(),
    foreign = source("openai", "bob");
  const differentConversation = submit("alice", {
    agentId: a.agent.id,
    input: "Different conversation",
    idempotencyKey: id(),
  });
  const otherMessage = trace(
    differentConversation,
    "other",
    "Other conversation update",
  );
  transition(differentConversation, "cancelled");
  const tool = trace(a.run, "tool", "Command output", "tool");
  const prompt = (
    db
      .prepare("SELECT id FROM messages WHERE run_id=? AND role='user'")
      .get(a.run.id) as { id: string }
  ).id;
  // Your own prompt is a valid target, quoted as yours rather than the agent's.
  const own = await request("/runs", {
    agentId: a.agent.id,
    conversationId: a.run.conversation_id,
    replyToMessageId: prompt,
    input: "Expand on what I asked",
    idempotencyKey: id(),
  });
  expect(own.status).toBe(202);
  const quoted = JSON.parse(own.data.payload).replyTo;
  expect(quoted).toMatchObject({
    id: prompt,
    mine: true,
    content: "Investigate the collision",
  });
  expect(replyPrompt("Expand on what I asked", quoted)).toBe(
    "Replying to my earlier message:\n\n> Investigate the collision\n\nExpand on what I asked",
  );
  transition(own.data, "cancelled");
  for (const target of [
    tool,
    other.message,
    foreign.message,
    otherMessage,
    "trace:999999999",
  ]) {
    const response = await request("/runs", {
      agentId: a.agent.id,
      conversationId: a.run.conversation_id,
      replyToMessageId: target,
      input: "Explain this",
      idempotencyKey: id(),
    });
    expect(response.status).toBe(404);
    expect(response.data.error).toBe("Message not found");
  }
  const missingConversation = await request("/runs", {
    agentId: a.agent.id,
    replyToMessageId: a.message,
    input: "Explain this",
    idempotencyKey: id(),
  });
  expect(missingConversation.status).toBe(400);
  expect(
    (
      db.prepare("SELECT count(*) n FROM runs WHERE state='queued'").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
});

it("retains the original quote across uncertain sends and explicit retries", async () => {
  const { agent, run, message, later } = source();
  const body = {
    agentId: agent.id,
    conversationId: run.conversation_id,
    replyToMessageId: message,
    input: "Explain the separation",
    idempotencyKey: id(),
  };
  const first = await request("/runs", body);
  const quote = JSON.parse(first.data.payload).replyTo;
  trace(run, "selected", "The source changed after the reply was accepted.");
  const repeated = await request("/runs", body);
  expect(repeated.data.id).toBe(first.data.id);
  expect(JSON.parse(repeated.data.payload).replyTo).toEqual(quote);
  expect(
    (await request("/runs", { ...body, replyToMessageId: later })).status,
  ).toBe(409);
  const claimed = claim("reply-retry-worker")!;
  expect(claimed.id).toBe(first.data.id);
  transition(claimed, "failed");
  const retryBody = { idempotencyKey: id() };
  const retry = await request(`/runs/${first.data.id}/retry`, retryBody);
  expect(retry.status).toBe(200);
  expect(JSON.parse(retry.data.payload).replyTo).toEqual(quote);
  expect(
    (await request(`/runs/${first.data.id}/retry`, retryBody)).data.id,
  ).toBe(retry.data.id);
  transition(retry.data, "cancelled");
});

it("supports saved final messages and carries their quote into native harness prompts", async () => {
  const { agent, run } = source();
  const answer = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,'assistant','The migration is ready.','{}',?)",
  ).run(answer, run.conversation_id, run.id, now());
  const reply = submit("alice", {
    agentId: agent.id,
    conversationId: run.conversation_id!,
    replyToMessageId: answer,
    input: "Explain the compatibility risk",
    idempotencyKey: id(),
  });
  const claimed = claim("native-reply-worker")!;
  expect(claimed.id).toBe(reply.id);
  let prompt = "";
  const live = {
    generation: id(),
    items: new NativeOutput(),
    requests: new Map(),
    adapter: {
      async prompt(input: string) {
        prompt = input;
        live.finish!("completed");
      },
    },
  } as unknown as Live;
  const session = vi.spyOn(nativeSessions, "session").mockResolvedValue(live);
  try {
    expect(await nativeSessions.execute(claimed)).toBe(true);
    expect(prompt).toContain("> The migration is ready.");
    expect(prompt).toContain("Explain the compatibility risk");
    transition(claimed, "completed");
  } finally {
    clearTimeout(live.idle);
    session.mockRestore();
  }
});
