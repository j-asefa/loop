import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-hapi-archive-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { core } = await import("../src/server/core-routes");
const { createTeam } = await import("../src/server/teams");
const { forkConversation } = await import("../src/server/mobile-return");
const { archiveHapiRuns, claim } = await import("../src/server/queue");
const OWNER = "archive";
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.locals.owner = OWNER;
  next();
});
app.use(core);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  origin = "http://127.0.0.1:" + (server.address() as any).port;
});
afterAll(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function post(path: string, body: unknown = {}) {
  const r = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
function connection(metadata: object, status = "connected") {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,?,?,?,?)",
  ).run(
    c,
    OWNER,
    seal("fake-key", OWNER),
    status,
    JSON.stringify([{ id: "fixture-model" }]),
    JSON.stringify(metadata),
    now(),
  );
  return c;
}
const hapi = {
  backend: "hapi",
  environmentId: "env",
  flavor: "codex",
  billing: { mode: "subscription", requiredAuth: "chatgpt", allowApiFallback: false },
};
function hapiRun(agentId: string, state: string, dispatched = false) {
  const conversation = id(),
    run = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,execution_backend,created_at) VALUES(?,?,?,'HAPI','hapi',?)",
  ).run(conversation, OWNER, agentId, now());
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,worker_id,heartbeat,created_at,updated_at) VALUES(?,?,?,?,'agent','Old work',?,?,?,?,?,?,?)",
  ).run(
    run,
    OWNER,
    agentId,
    conversation,
    state,
    id(),
    JSON.stringify({ execution: hapi }),
    state === "queued" ? null : "gone-worker",
    now(),
    now(),
    now(),
  );
  if (dispatched) {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO native_sessions(conversation_id,owner_id,environment_id,generation,flavor,billing,launch_id,gateway_secret,gateway_hash,created_at) VALUES(?,?,'env',1,'codex','{}',?,'s','h',?)",
    ).run(conversation, OWNER, id(), now());
    db.prepare(
      "INSERT INTO native_dispatches(run_id,conversation_id,local_id,payload_hash,envelope,billing,environment_id,generation,state,created_at,updated_at) VALUES(?,?,?,'hash','{}','{}','env',1,'accepted',?,?)",
    ).run(run, conversation, id(), now(), now());
    db.pragma("foreign_keys = ON");
  }
  return { run, conversation };
}

it("stops HAPI runs left active at upgrade without replaying them, then allows cancel and dismiss but not retry", async () => {
  const hapiAgent = createAgent(OWNER, {
    name: "hapi-agent",
    connectionId: connection(hapi),
    model: "fixture-model",
  });
  const queued = hapiRun(hapiAgent.id, "queued");
  const awaiting = hapiRun(hapiAgent.id, "awaiting_approval", true);
  db.prepare(
    "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,?,'d',?,'pending',?,?)",
  ).run(
    "approval-" + awaiting.run,
    OWNER,
    awaiting.run,
    JSON.stringify({ type: "hapi_native" }),
    now(),
    now() + 60000,
  );
  // The same agent, moved to an API connection, is no longer blocked by them.
  db.prepare("UPDATE agents SET connection_id=? WHERE id=?").run(
    connection({}),
    hapiAgent.id,
  );
  const next = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,'agent','New work','queued',?,'{}',?,?)",
  ).run(next, OWNER, hapiAgent.id, id(), now() + 1, now() + 1);
  expect(claim("before")).toBeUndefined();

  archiveHapiRuns();
  for (const { run } of [queued, awaiting])
    expect(
      db.prepare("SELECT state,worker_id,error FROM runs WHERE id=?").get(run),
    ).toMatchObject({
      state: "interrupted",
      worker_id: null,
      error: expect.stringContaining("not replayed"),
    });
  expect(
    db.prepare("SELECT state FROM approvals WHERE run_id=?").get(awaiting.run),
  ).toEqual({ state: "rejected" });
  expect(claim("after")?.id).toBe(next);

  const retry = await post(`/runs/${awaiting.run}/retry`, {
    idempotencyKey: id(),
  });
  expect(retry.status).toBe(409);
  expect(retry.body.error).toMatch(/cannot be replayed/);
  expect((await post(`/runs/${queued.run}/retry`, { idempotencyKey: id() })).status).toBe(409);
  expect((await post(`/runs/${awaiting.run}/dismiss`)).status).toBe(200);
  expect((await post(`/runs/${queued.run}/cancel`)).status).toBe(200);
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(queued.run),
  ).toEqual({ state: "cancelled" });
});

it("refuses to fork to, or build a team around, an agent on an archived HAPI connection", () => {
  const native = createAgent(OWNER, {
    name: "api-agent",
    connectionId: connection({}),
    model: "fixture-model",
  });
  const archived = createAgent(OWNER, {
    name: "archived-agent",
    connectionId: connection(hapi),
    model: "fixture-model",
  });
  const conversation = id(),
    message = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Source',?)",
  ).run(conversation, OWNER, native.id, now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,'user','Hello','{}',?)",
  ).run(message, OWNER, conversation, now());
  expect(() =>
    forkConversation(OWNER, conversation, {
      messageId: message,
      agentId: archived.id,
    }),
  ).toThrow(/archived HAPI connection/);
  expect(
    db
      .prepare("SELECT count(*) n FROM conversations WHERE origin='loop-fork'")
      .get(),
  ).toEqual({ n: 0 });
  expect(() =>
    createTeam(OWNER, {
      name: "Archived",
      managerId: archived.id,
      members: [native.id],
    }),
  ).toThrow(/archived HAPI connection/);
  const fork = forkConversation(OWNER, conversation, { messageId: message });
  expect(
    db
      .prepare("SELECT execution_backend FROM conversations WHERE id=?")
      .get(fork.id),
  ).toEqual({ execution_backend: "legacy" });
});

it("migration 067 marks every retired direct connection so 070 restores it, but not an intentional disconnect", () => {
  const rows = { connected: id(), needs_sign_in: id(), disconnected: id() };
  for (const [status, key] of Object.entries(rows))
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'codex','Native','',?,'[]',?,?)",
    ).run(key, OWNER, status, JSON.stringify({ loopHarness: "codex" }), now());
  for (const migration of [
    "067-hapi-only-harnesses.sql",
    "070-restore-native-harnesses.sql",
  ])
    db.exec(
      readFileSync(
        new URL("../migrations/" + migration, import.meta.url),
        "utf8",
      ).replace(/^INSERT INTO schema_version.*$/m, ""),
    );
  const status = (key: string) =>
    (db.prepare("SELECT status FROM connections WHERE id=?").get(key) as any)
      .status;
  expect(status(rows.connected)).toBe("needs_sign_in");
  expect(status(rows.needs_sign_in)).toBe("needs_sign_in");
  expect(status(rows.disconnected)).toBe("disconnected");
});
