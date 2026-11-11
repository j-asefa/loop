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
const { PLAN_GUIDANCE } = await import("../src/server/native-tools");
const { uploadFile, readRunFile } = await import("../src/server/uploads");
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
  expect(run.payload).toMatchObject({
    instructions: input.instructions,
    effort: "high",
    folderId: project,
  });
  expect(
    db.prepare("SELECT role,content FROM messages WHERE run_id=?").all(run.id),
  ).toEqual([{ role: "user", content: "Compare three research ideas." }]);
  await executeAgent(run);
  transition(run, "completed");
  // The agent's standing instructions reach the provider verbatim, followed by
  // Loop's plan guidance because loop_plan is advertised to this run.
  expect(calls.at(-1).instructions).toBe(
    input.instructions + "\n\n" + PLAN_GUIDANCE,
  );
  expect(calls.at(-1).tools.map((t: any) => t.name)).toContain("loop_plan");
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
  expect(calls.at(-1).instructions).toBe(
    input.instructions + "\n\n" + PLAN_GUIDANCE,
  );
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

it("delivers uploaded files with the initial prompt and preserves them across retries", async () => {
  const owner = "initial-files";
  const text = uploadFile(owner, {
    originalname: "brief.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("A project brief for the first task."),
  });
  const image = uploadFile(owner, {
    originalname: "reference.png",
    mimetype: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const input = {
    name: "first-task-with-files",
    connectionId: connection(owner),
    model: "fixture",
    initialPrompt: "Review this brief and image.",
    attachmentIds: [text.id, image.id],
    idempotencyKey: id(),
  };
  const first = await create(input, owner);
  expect(first.status).toBe(201);
  const retry = await create(input, owner);
  expect(retry.data).toEqual(first.data);
  expect(counts(owner)).toMatchObject({
    agents: 1,
    runs: 1,
    conversations: 1,
    messages: 1,
  });
  const run = claim("initial-files-worker")!;
  expect(run.id).toBe(first.data.initialRun.id);
  expect(run.payload.attachmentIds).toEqual([text.id, image.id]);
  const message = db
    .prepare(
      "SELECT content,metadata FROM messages WHERE run_id=? AND role='user'",
    )
    .get(run.id) as any;
  expect(message.content).toBe(input.initialPrompt);
  expect(JSON.parse(message.metadata).attachments).toEqual([text, image]);
  expect(JSON.parse(message.metadata).personal).toBe(true);
  expect(readRunFile(run, text.id, 0, 1000, "utf8").content).toBe(
    "A project brief for the first task.",
  );
  await executeAgent(run);
  transition(run, "completed");
  const prompt = calls
    .at(-1)
    .messages.find((message: any) => message.role === "user");
  expect(prompt.content).toContain("Review this brief and image.");
  expect(prompt.content).toContain("brief.txt");
  expect(prompt.attachments).toEqual([text, image]);
  for (const attachmentIds of [[], [text.id], [image.id, text.id]])
    expect((await create({ ...input, attachmentIds }, owner)).status).toBe(409);
});

it("rejects missing, foreign, excessive or promptless attachments without creating an agent", async () => {
  const owner = "invalid-files";
  const file = uploadFile(owner, {
    originalname: "brief.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("Brief"),
  });
  const foreign = uploadFile("someone-else", {
    originalname: "private.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("Private"),
  });
  const input = {
    name: "invalid-file-agent",
    connectionId: connection(owner),
    model: "fixture",
    initialPrompt: "Review the files",
    idempotencyKey: id(),
  };
  const before = counts(owner);
  for (const [change, status] of [
    [{ attachmentIds: [id()] }, 404],
    [{ attachmentIds: [foreign.id] }, 404],
    [{ attachmentIds: Array.from({ length: 9 }, () => id()) }, 400],
    [{ attachmentIds: [file.id], initialPrompt: " " }, 400],
  ] as const) {
    expect((await create({ ...input, ...change }, owner)).status).toBe(status);
    expect(counts(owner)).toEqual(before);
    expect(
      db.prepare("SELECT 1 FROM handles WHERE name=?").get(input.name),
    ).toBeUndefined();
  }
});

it("replays a current creation receipt with omitted or empty attachments", async () => {
  const owner = "empty-attachments";
  const input = {
    name: "empty-attachments-agent",
    connectionId: connection(owner),
    model: "fixture",
    instructions: "Be concise.",
    idempotencyKey: id(),
  };
  const first = await create(input, owner);
  expect(first.status).toBe(201);
  const retry = await create({ ...input, attachmentIds: [] }, owner);
  expect(retry.status).toBe(201);
  expect(retry.data.id).toBe(first.data.id);
  expect(counts(owner)).toMatchObject({ agents: 1, runs: 0 });
});

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

it.each(["api", "native"])(
  "rejects stale %s catalog selections at creation",
  async (kind) => {
    const owner = "stale-" + kind;
    const connectionId = connection(owner);
    if (kind === "native")
      db.prepare(
        "UPDATE connections SET provider='codex',metadata=? WHERE id=?",
      ).run(
        JSON.stringify({ loopHarness: "codex", authMode: "subscription" }),
        connectionId,
      );
    const input = {
      name: "stale-catalog-" + kind,
      connectionId,
      model: "fixture",
      effort: "high",
      idempotencyKey: id(),
    };
    const original = [{ id: "fixture", effortLevels: [{ value: "high" }] }];
    const before = counts(owner);
    for (const [models, status, expected] of [
      [[{ id: "replacement" }], "connected", 400],
      [[{ id: "fixture", effortLevels: [{ value: "low" }] }], "connected", 400],
      [original, "needs_reconnect", 409],
    ] as const) {
      db.prepare("UPDATE connections SET models=?,status=? WHERE id=?").run(
        JSON.stringify(models),
        status,
        connectionId,
      );
      expect((await create(input, owner)).status).toBe(expected);
      expect(counts(owner)).toEqual(before);
      expect(
        db.prepare("SELECT 1 FROM handles WHERE name=?").get(input.name),
      ).toBeUndefined();
    }
    db.prepare(
      "UPDATE connections SET models=?,status='connected' WHERE id=?",
    ).run(JSON.stringify(original), connectionId);
    expect((await create(input, "another-owner")).status).toBe(404);
    expect((await create(input, owner)).status).toBe(201);
    expect(counts(owner)).toEqual({ ...before, agents: 1, agent_creations: 1 });
  },
);

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
  // Build the full-queue fixture in one commit before testing the independent
  // HTTP creation transaction and its rollback.
  db.transaction(() => {
    for (let i = 0; i < 100; i++)
      submit(owner, {
        agentId: existing.id,
        input: "Pending task",
        idempotencyKey: id(),
      });
  }).immediate();
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
