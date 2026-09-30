import { afterAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChatMessage } from "../src/server/providers";

const dir = mkdtempSync(join(tmpdir(), "loop-steering-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { SteeringInbox } = await import("../src/server/steering");
const { recordTrace } = await import("../src/server/traces");
const { conversationMessages } =
  await import("../src/server/conversation-messages");
const { uploadFile, readRunFile } = await import("../src/server/uploads");
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
await new Promise<void>((resolve) => server.once("listening", resolve));
async function send(body: object, owner = "alice") {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner": owner },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, data: await response.json() };
}
function start() {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    seal("fixture", "alice"),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  const agent = createAgent("alice", {
    name: "steer-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const submitted = submit("alice", {
    agentId: agent.id,
    input: "Investigate",
    idempotencyKey: id(),
  });
  const run = claim("steering-worker")!;
  expect(run.id).toBe(submitted.id);
  return { agent, run };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("steers an active API response without creating a second run and keeps the selected quote in history", async () => {
  const { agent, run } = start();
  const received: ChatMessage[][] = [];
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      received.push(input.messages);
      if (received.length === 1) {
        yield { text: "I will investigate the shared table." };
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        input.signal.throwIfAborted();
      }
      yield { text: "I will inspect only the local database." };
    },
  });
  try {
    const executing = executeAgent(run);
    await expect
      .poll(() =>
        db
          .prepare(
            "SELECT content FROM run_traces WHERE run_id=? AND trace_key='turn:0'",
          )
          .get(run.id),
      )
      .toMatchObject({ content: "I will investigate the shared table." });
    const trace = db
      .prepare(
        "SELECT id FROM run_traces WHERE run_id=? AND trace_key='turn:0'",
      )
      .get(run.id) as { id: number };
    const body = {
      agentId: agent.id,
      conversationId: run.conversation_id,
      replyToMessageId: "trace:" + trace.id,
      input: "Keep it local",
      idempotencyKey: id(),
    };
    const response = await send(body);
    expect(response.status).toBe(202);
    expect(response.data).toMatchObject({
      id: run.id,
      state: "running",
      steeringId: expect.any(String),
    });
    expect(await executeWithDeadline(executing)).toBe(true);
    transition(run, "completed");
    expect(received).toHaveLength(2);
    expect(received[1].at(-1)?.content).toContain(
      "> I will investigate the shared table.",
    );
    expect(received[1].at(-1)?.content).toContain("Keep it local");
    expect(
      db.prepare("SELECT count(*) n FROM runs WHERE agent_id=?").get(agent.id),
    ).toEqual({ n: 1 });
    expect((await send(body)).data.steeringId).toBe(response.data.steeringId);
    expect((await send({ ...body, input: "Different request" })).status).toBe(
      409,
    );
    expect((await send(body, "bob")).status).toBe(404);
    const messages = conversationMessages(
      "alice",
      run.conversation_id!,
    ).messages;
    expect(messages.map((message) => message.content)).toEqual([
      "Investigate",
      "I will investigate the shared table.",
      "Keep it local",
      "I will inspect only the local database.",
    ]);
    expect(JSON.parse(messages[2].metadata).delivery).toBe("delivered");
  } finally {
    restore();
  }
});

it("routes a composer follow-up to the active conversation and exposes native delivery and failure receipts", async () => {
  const { agent, run } = start();
  const file = uploadFile(
    "alice",
    {
      originalname: "notes.txt",
      mimetype: "text/plain",
      buffer: Buffer.from("Local fixture"),
    },
    {},
  );
  const first = await send({
    agentId: agent.id,
    input: "Use these notes",
    attachmentIds: [file.id],
    idempotencyKey: id(),
  });
  expect(first.data.id).toBe(run.id);
  const values: ChatMessage[] = [];
  const inbox = new SteeringInbox(run);
  let stop = inbox.listen(async (message) => {
    values.push(message);
  });
  await expect.poll(() => values.length).toBe(1);
  await stop();
  expect(values[0].content).toContain(file.id);
  expect(readRunFile(run, file.id, 0, 100, "utf8").content).toBe(
    "Local fixture",
  );
  const second = await send({
    agentId: agent.id,
    input: "Another thought",
    idempotencyKey: id(),
  });
  stop = inbox.listen(async () => {
    throw new Error("Turn already ended");
  });
  await expect
    .poll(() =>
      db
        .prepare("SELECT state FROM run_steering WHERE id=?")
        .get(second.data.steeringId),
    )
    .toEqual({ state: "failed" });
  await stop();
  const third = await send({
    agentId: agent.id,
    input: "Follow up",
    idempotencyKey: id(),
  });
  transition(run, "interrupted");
  expect(
    db
      .prepare("SELECT state,error FROM run_steering WHERE id=?")
      .get(third.data.steeringId),
  ).toMatchObject({
    state: "failed",
    error: expect.stringContaining("ended before"),
  });
  const transcript = conversationMessages(
    "alice",
    run.conversation_id!,
  ).messages;
  expect(
    JSON.parse(
      transcript.find((m) => m.content === "Another thought")!.metadata,
    ).delivery,
  ).toBe("failed");
  expect(
    db.prepare("SELECT count(*) n FROM runs WHERE agent_id=?").get(agent.id),
  ).toEqual({ n: 1 });
});

it("includes a follow-up racing with completion in the same run and starts fresh work after completion", async () => {
  const { agent, run } = start();
  let calls = 0;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      if (++calls === 1) {
        yield { text: "Initial answer" };
        // No timer turn between submission and completion: exercise the final
        // transaction, not the live listener's normal polling path.
        submit("alice", {
          agentId: agent.id,
          input: "Also check tests",
          idempotencyKey: id(),
          steer: true,
        });
      } else {
        expect(input.messages.at(-1)?.content).toBe("Also check tests");
        yield { text: "Tests checked" };
      }
    },
  });
  try {
    expect(await executeAgent(run)).toBe(true);
    expect(calls).toBe(2);
    transition(run, "completed");
    const next = await send({
      agentId: agent.id,
      input: "New task",
      idempotencyKey: id(),
    });
    expect(next.data.id).not.toBe(run.id);
    expect(next.data.state).toBe("queued");
    transition(next.data, "cancelled");
  } finally {
    restore();
  }
});

it("keeps internal delegation and an explicitly different conversation separate", async () => {
  const { agent, run } = start();
  const other = submit("alice", {
    agentId: agent.id,
    input: "Separate task",
    idempotencyKey: id(),
  });
  const result = await send({
    agentId: agent.id,
    conversationId: other.conversation_id,
    input: "Follow up there",
    idempotencyKey: id(),
  });
  expect(result.data.steeringId).toBeUndefined();
  expect(result.data.conversation_id).toBe(other.conversation_id);
  transition(run, "cancelled");
  transition(other, "cancelled");
  transition(result.data, "cancelled");
});

it("steers the current harness after changing the agent's provider for future runs", async () => {
  const { agent, run } = start();
  const nextConnection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) SELECT ?,owner_id,'anthropic','Next provider',secret,status,models,created_at FROM connections WHERE id=?",
  ).run(nextConnection, agent.connection_id);
  db.prepare(
    "UPDATE agents SET connection_id=?,provider='anthropic' WHERE id=?",
  ).run(nextConnection, agent.id);
  const accepted = await send({
    agentId: agent.id,
    input: "Focus here first",
    idempotencyKey: id(),
  });
  expect(accepted.status).toBe(202);
  expect(accepted.data.id).toBe(run.id);
  expect(JSON.parse(accepted.data.payload).connectionId).toBe(
    agent.connection_id,
  );
  transition(run, "cancelled");
  const next = await send({
    agentId: agent.id,
    input: "Start the next task",
    idempotencyKey: id(),
  });
  expect(next.status).toBe(202);
  expect(JSON.parse(next.data.payload).connectionId).toBe(nextConnection);
  transition(next.data, "cancelled");
});

it("continues a conversation on the agent's new provider with Loop's transcript", async () => {
  const { agent, run } = start();
  const restoreOpenAI = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      yield { text: "OpenAI answer" };
    },
  });
  try {
    expect(await executeAgent(run)).toBe(true);
  } finally {
    restoreOpenAI();
  }
  transition(run, "completed");
  const nextConnection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) SELECT ?,owner_id,'anthropic','Next provider',secret,status,models,created_at FROM connections WHERE id=?",
  ).run(nextConnection, agent.connection_id);
  db.prepare(
    "UPDATE agents SET connection_id=?,provider='anthropic',model='next-model' WHERE id=?",
  ).run(nextConnection, agent.id);
  const next = await send({
    agentId: agent.id,
    conversationId: run.conversation_id,
    input: "Keep going",
    idempotencyKey: id(),
  });
  expect(next.status).toBe(202);
  expect(next.data.conversation_id).toBe(run.conversation_id);
  expect(JSON.parse(next.data.payload)).toMatchObject({
    provider: "anthropic",
    connectionId: nextConnection,
    model: "next-model",
  });
  let seen: ChatMessage[] = [];
  const restoreAnthropic = withTestAdapter("anthropic", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      seen = input.messages;
      yield { text: "Anthropic answer" };
    },
  });
  try {
    const claimed = claim("steering-worker")!;
    expect(claimed.id).toBe(next.data.id);
    expect(await executeAgent(claimed)).toBe(true);
    transition(claimed, "completed");
  } finally {
    restoreAnthropic();
  }
  expect(seen.map((m) => [m.role, m.content])).toEqual([
    ["user", "Investigate"],
    ["assistant", "OpenAI answer"],
    ["user", "Keep going"],
  ]);
});

async function executeWithDeadline(work: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Steering never reached the active response")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
