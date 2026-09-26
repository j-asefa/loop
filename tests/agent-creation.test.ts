import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop-agent-creation-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { core } = await import("../src/server/core-routes");
const { Problem, createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const calls: any[] = [];
const restore = withTestAdapter("openai", {
  async models() {
    return [];
  },
  async *stream(_key, input) {
    calls.push(input);
    yield { text: "Initial task completed." };
  },
});
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-test-owner") || "alice";
  next();
});
app.use(core);
app.use((error: Error, _req: any, res: any, _next: any) =>
  res
    .status(error instanceof Problem ? error.status : 400)
    .json({ error: error.message }),
);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = "http://127.0.0.1:" + (server.address() as any).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function create(body: object, owner = "alice") {
  const response = await fetch(origin + "/agents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-owner": owner },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
function connection(owner = "alice") {
  const value = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    value,
    owner,
    seal("fixture-key", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return value;
}
function folder(owner = "alice") {
  const value = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Initial work',?)",
  ).run(value, owner, now());
  return value;
}
function counts(owner: string) {
  return Object.fromEntries(
    ["agents", "runs", "conversations", "messages", "agent_creations"].map(
      (table) => [
        table,
        (
          db
            .prepare(`SELECT count(*) n FROM ${table} WHERE owner_id=?`)
            .get(owner) as any
        ).n,
      ],
    ),
  );
}

it("creates a first message, queues work, and keeps standing instructions for future tasks", async () => {
  const project = folder();
  const input = {
    name: "initial-researcher",
    connectionId: connection(),
    model: "fixture",
    effort: "high",
    instructions: "Cite sources and keep answers concise.",
    initialPrompt: "  Compare three research ideas.  ",
    folderId: project,
    idempotencyKey: id(),
  };
  const result = await create(input);
  expect(result.status).toBe(201);
  expect(result.data.instructions).toBe(input.instructions);
  expect(result.data.effort).toBe("high");
  expect(result.data.initialRun.conversation_id).toEqual(expect.any(String));
  const run = claim("initial-worker")!;
  expect(run.id).toBe(result.data.initialRun.id);
  expect(run.input).toBe("Compare three research ideas.");
  expect(JSON.parse(run.payload)).toMatchObject({
    instructions: input.instructions,
    effort: "high",
    folderId: project,
  });
  expect(
    db.prepare("SELECT role,content FROM messages WHERE run_id=?").all(run.id),
  ).toEqual([{ role: "user", content: "Compare three research ideas." }]);
  await executeAgent(run);
  transition(run, "completed");
  expect(calls.at(-1).instructions).toBe(input.instructions);
  expect(calls.at(-1).effort).toBe("high");
  expect(calls.at(-1).messages).toEqual([
    { role: "user", content: "Compare three research ideas." },
  ]);
  expect(
    db.prepare("SELECT folder_id FROM artifacts WHERE run_id=?").get(run.id),
  ).toEqual({ folder_id: project });
  const followup = submit("alice", {
    agentId: result.data.id,
    input: "A separate task.",
    idempotencyKey: id(),
  });
  const next = claim("initial-worker")!;
  expect(next.id).toBe(followup.id);
  await executeAgent(next);
  transition(next, "completed");
  expect(calls.at(-1).instructions).toBe(input.instructions);
  expect(calls.at(-1).messages).toEqual([
    { role: "user", content: "A separate task." },
  ]);
});

it.each([undefined, "  \n  "])(
  "creates an idle agent when the initial prompt is blank (%s)",
  async (initialPrompt) => {
    const owner = "idle-" + id(),
      before = counts(owner);
    const input = {
      name: "idle-" + id().slice(0, 8),
      connectionId: connection(owner),
      model: "fixture",
      instructions: "Cite sources.",
      initialPrompt,
      idempotencyKey: id(),
    };
    const result = await create(input, owner);
    expect(result.status).toBe(201);
    expect(result.data.initialRun).toBeUndefined();
    const retry = await create(input, owner);
    expect(retry.data.id).toBe(result.data.id);
    expect(counts(owner)).toEqual({ ...before, agents: 1, agent_creations: 1 });
  },
);

it("replays a lost create response without duplicating work and rejects changed details for that request", async () => {
  const owner = "retry",
    input = {
      name: "retry-initial",
      connectionId: connection(owner),
      model: "fixture",
      instructions: "Be precise.",
      initialPrompt: "Start this task once.",
      folderId: folder(owner),
      idempotencyKey: id(),
    };
  const responses = await Promise.all([
    create(input, owner),
    create(input, owner),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  expect(responses[0].data).toEqual(responses[1].data);
  expect(counts(owner)).toEqual({
    agents: 1,
    runs: 1,
    conversations: 1,
    messages: 1,
    agent_creations: 1,
  });
  for (const change of [
    { initialPrompt: "Different task" },
    { instructions: "Different guidance" },
    { folderId: "" },
    { name: "another-agent" },
  ])
    expect((await create({ ...input, ...change }, owner)).status).toBe(409);
  // A retry is a receipt lookup, even if the provider disconnected afterwards.
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    input.connectionId,
  );
  expect((await create(input, owner)).data).toEqual(responses[0].data);
  expect(counts(owner).runs).toBe(1);
});

it("validates ownership and prompt length before leaving an agent or reserved name behind", async () => {
  const input = {
    name: "invalid-initial",
    connectionId: connection("validation"),
    model: "fixture",
    initialPrompt: "Start",
    idempotencyKey: id(),
  };
  const before = counts("validation");
  for (const [change, status] of [
    [{ folderId: folder("someone-else") }, 404],
    [{ connectionId: connection("someone-else") }, 404],
    [{ model: "missing-model" }, 400],
    [{ initialPrompt: "x".repeat(30001) }, 400],
  ] as const) {
    expect((await create({ ...input, ...change }, "validation")).status).toBe(
      status,
    );
    expect(counts("validation")).toEqual(before);
    expect(
      db.prepare("SELECT 1 FROM handles WHERE name=?").get(input.name),
    ).toBeUndefined();
  }
});

it("keeps creation receipts private to each workspace", async () => {
  const key = id();
  const alice = await create({
    name: "receipt-alice",
    connectionId: connection(),
    model: "fixture",
    idempotencyKey: key,
  });
  const bob = await create(
    {
      name: "receipt-bob",
      connectionId: connection("bob"),
      model: "fixture",
      idempotencyKey: key,
    },
    "bob",
  );
  expect(alice.status).toBe(201);
  expect(bob.status).toBe(201);
  expect(bob.data.id).not.toBe(alice.data.id);
  expect(bob.data.owner_id).toBe("bob");
});

it("rolls back the new agent, handle and conversation when its initial run cannot be queued", async () => {
  const owner = "full-queue",
    connectionId = connection(owner);
  const existing = createAgent(owner, {
    name: "existing-queue-agent",
    connectionId,
    model: "fixture",
  });
  for (let i = 0; i < 100; i++)
    submit(owner, {
      agentId: existing.id,
      input: "Pending task",
      idempotencyKey: id(),
    });
  const before = counts(owner);
  const result = await create(
    {
      name: "queue-full-initial",
      connectionId,
      model: "fixture",
      initialPrompt: "Cannot start yet",
      idempotencyKey: id(),
    },
    owner,
  );
  expect(result.status).toBe(429);
  expect(counts(owner)).toEqual(before);
  expect(
    db.prepare("SELECT 1 FROM handles WHERE name='queue-full-initial'").get(),
  ).toBeUndefined();
});
