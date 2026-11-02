import { afterAll, beforeAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { RunState } from "../src/shared/run-state";

const directory = mkdtempSync(join(tmpdir(), "loop55-row-recovery-"));
process.env.LOOP55_DATA_DIR = directory;
process.env.LOOP55_PROFILE = "server";
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { enqueue } = await import("../src/server/queue");
const { requestApproval } = await import("../src/server/approvals");
const { core } = await import("../src/server/core-routes");
const { mobile } = await import("../src/server/mobile-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { errorHandler } = await import("../src/server/error-handler");

const agents = new Map<string, string>();
function make(state: RunState = "queued", owner = "alice", kind = "agent") {
  let agentId = agents.get(owner);
  if (!agentId) {
    const connection = id();
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
    ).run(
      connection,
      owner,
      seal("fixture", owner),
      JSON.stringify([{ id: "fixture", name: "Fixture" }]),
      now(),
    );
    agentId = createAgent(owner, {
      name: "recovery-" + owner,
      connectionId: connection,
      model: "fixture",
    }).id;
    agents.set(owner, agentId);
  }
  const run =
    kind === "agent"
      ? submit(owner, {
          agentId,
          input: "Recovery fixture",
          idempotencyKey: id(),
        })
      : enqueue(owner, "Recovery fixture", id(), { kind, agent: agentId });
  db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, run.id);
  return run;
}
function corrupt(run: { id: string; payload: object }) {
  const payload = JSON.stringify({ ...run.payload, reviewId: null });
  db.prepare("UPDATE runs SET payload=? WHERE id=?").run(payload, run.id);
  return payload;
}
const record = (run: { id: string }) =>
  db
    .prepare("SELECT state,payload,attention_dismissed_at FROM runs WHERE id=?")
    .get(run.id);
const link = (parent: string, child: string, background = false) =>
  db
    .prepare(
      "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,'{}',?)",
    )
    .run(parent, id(), child, Number(background));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-test-owner") || "alice";
  next();
});
app.use("/api", mobile, core, workspace);
app.use(errorHandler);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
const post = (path: string, body: unknown = {}, owner = "alice") =>
  fetch(origin + "/api" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-owner": owner },
    body: JSON.stringify(body),
  });

it.each(["queued", "running", "awaiting_approval", "paused"] as const)(
  "cancels a malformed %s root without changing its saved payload",
  async (state) => {
    const run = make(state),
      payload = corrupt(run);
    expect((await post(`/runs/${run.id}/cancel`, {}, "bob")).status).toBe(404);
    expect(record(run)).toMatchObject({ state, payload });
    expect((await post(`/runs/${run.id}/cancel`)).status).toBe(200);
    expect(record(run)).toMatchObject({ state: "cancelled", payload });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
    ).toBeUndefined();
  },
);

it.each(["delegation", "background result"])(
  "cancels malformed and healthy %s children together",
  async (kind) => {
    const parent = make("running", "alice", "agent");
    const bad = make(),
      healthy = make(),
      grandchild = make(),
      foreign = make("queued", "bob");
    const payload = corrupt(bad);
    if (kind === "background result") {
      const sender = make("completed");
      link(parent.id, sender.id, true);
      const thread = id();
      db.prepare(
        "INSERT INTO agent_threads(id,owner_id,scope,subject,created_by,created_at,updated_at) VALUES(?,'alice','direct','Fixture',?,?,?)",
      ).run(thread, sender.agent_id, now(), now());
      for (const child of [bad, healthy, foreign])
        db.prepare(
          "INSERT INTO agent_mail(id,owner_id,thread_id,kind,sender_agent_id,sender_run_id,recipient_agent_id,body,idempotency_key,request,state,run_id,created_at) VALUES(?,'alice',?,'result',?,?,?,'Result',?,'{}','sent',?,?)",
        ).run(
          id(),
          thread,
          sender.agent_id,
          sender.id,
          child.agent_id,
          id(),
          child.id,
          now(),
        );
    } else {
      for (const child of [bad, healthy, foreign]) link(parent.id, child.id);
    }
    link(bad.id, grandchild.id);
    expect((await post(`/runs/${parent.id}/cancel`)).status).toBe(200);
    for (const run of [parent, bad, healthy, grandchild])
      expect(record(run)).toMatchObject({ state: "cancelled" });
    expect(record(bad)).toMatchObject({ payload });
    expect(record(foreign)).toMatchObject({ state: "queued" });
  },
);

it.each(["failed", "interrupted", "queued"] as const)(
  "dismisses a malformed %s row while preserving owner isolation",
  async (state) => {
    const run = make(state),
      payload = corrupt(run);
    expect((await post(`/runs/${run.id}/dismiss`, {}, "bob")).status).toBe(404);
    expect((await post(`/runs/${run.id}/dismiss`)).status).toBe(200);
    expect(record(run)).toMatchObject({
      state: state === "queued" ? "cancelled" : state,
      payload,
      attention_dismissed_at: expect.any(Number),
    });
  },
);

it("dismisses a waiting manager with malformed descendants and rejects their approvals", async () => {
  const parent = make("running"),
    child = make("awaiting_approval"),
    sibling = make(),
    foreign = make("queued", "bob");
  for (const run of [child, sibling, foreign]) link(parent.id, run.id);
  const approval = requestApproval(child, { tool: "fixture" });
  const payload = corrupt(child);
  expect((await post(`/runs/${parent.id}/dismiss`)).status).toBe(200);
  for (const run of [parent, child, sibling])
    expect(record(run)).toMatchObject({ state: "cancelled" });
  expect(record(child)).toMatchObject({ payload });
  expect(record(foreign)).toMatchObject({ state: "queued" });
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
  ).toEqual({ state: "rejected" });
});

it("rejects a malformed pending approval while refusing approval and cross-owner decisions", async () => {
  const run = make("awaiting_approval"),
    approval = requestApproval(run, { tool: "fixture" });
  const payload = corrupt(run);
  expect(
    (await post(`/approvals/${approval.id}`, { decision: "reject" }, "bob"))
      .status,
  ).toBe(404);
  const allowed = await post(`/approvals/${approval.id}`, {
    decision: "approve",
  });
  expect(allowed.status).toBe(409);
  expect(await allowed.json()).toEqual({
    error: expect.stringContaining(run.id),
  });
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
  ).toEqual({ state: "pending" });
  expect(
    (await post(`/approvals/${approval.id}`, { decision: "reject" })).status,
  ).toBe(200);
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
  ).toEqual({ state: "rejected" });
  expect(record(run)).toMatchObject({ state: "failed", payload });
  expect(
    db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toBeUndefined();
});

it.each([
  ["resume", "paused"],
  ["retry", "failed"],
] as const)("refuses %s of a malformed saved run", async (action, state) => {
  const run = make(state),
    payload = corrupt(run);
  const count = db.prepare("SELECT count(*) n FROM runs").get();
  const response = await post(`/runs/${run.id}/${action}`, {
    idempotencyKey: id(),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: expect.stringContaining(run.id),
  });
  expect(record(run)).toMatchObject({ state, payload });
  expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual(count);
});

it("opens a conversation with an unavailable active row but refuses to steer it", async () => {
  const run = make("running"),
    payload = corrupt(run);
  const page = await fetch(
    origin + "/api/conversations/" + run.conversation_id,
  );
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    conversation: { id: run.conversation_id },
    steerable_run_id: null,
  });
  const count = db.prepare("SELECT count(*) n FROM runs").get();
  const response = await post("/runs", {
    agentId: run.agent_id,
    conversationId: run.conversation_id,
    input: "Follow up",
    idempotencyKey: id(),
  });
  expect(response.status).toBe(409);
  expect(record(run)).toMatchObject({ state: "running", payload });
  expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual(count);
  expect((await post(`/runs/${run.id}/cancel`)).status).toBe(200);
});

it("starts independent work after cancelling a run with an invalid saved budget", async () => {
  const run = make("running");
  const payload = JSON.stringify({ ...run.payload, maxSeconds: 0 });
  db.prepare("UPDATE runs SET payload=? WHERE id=?").run(payload, run.id);
  expect((await post(`/runs/${run.id}/cancel`)).status).toBe(200);
  const response = await post("/runs", {
    agentId: run.agent_id,
    conversationId: run.conversation_id,
    input: "New work",
    idempotencyKey: id(),
  });
  expect(response.status).toBe(202);
  const follow = await response.json();
  expect(follow).toMatchObject({
    conversation_id: run.conversation_id,
    state: "queued",
  });
  expect(JSON.parse(follow.payload)).toMatchObject({
    folderId: run.payload.folderId,
    connectionId: run.payload.connectionId,
  });
  expect(JSON.parse(follow.payload)).not.toHaveProperty("maxSeconds");
  expect(record(run)).toMatchObject({ state: "cancelled", payload });
  expect((await post(`/runs/${follow.id}/cancel`)).status).toBe(200);
});

it.each([
  ["folderId", false],
  ["reviewId", false],
  ["reviewId", null],
] as const)(
  "refuses an invalid inherited %s after cancellation (%s)",
  async (field, value) => {
    const run = make("cancelled"),
      payload = JSON.stringify({ ...run.payload, [field]: value });
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(payload, run.id);
    const count = db.prepare("SELECT count(*) n FROM runs").get();
    const response = await post("/runs", {
      agentId: run.agent_id,
      conversationId: run.conversation_id,
      input: "New work",
      idempotencyKey: id(),
      ...(field === "reviewId" ? { folderId: null } : {}),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.stringContaining(run.id),
    });
    expect(record(run)).toMatchObject({ state: "cancelled", payload });
    expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual(count);
  },
);

it("cancels import work without interpreting unrelated damaged execution fields", async () => {
  const job = id();
  db.prepare(
    "INSERT INTO imports(id,owner_id,provider,digest,status,created_at) VALUES(?,'alice','openai',?,'queued',?)",
  ).run(job, id(), now());
  const run = enqueue("alice", "Import fixture", id(), {
    kind: "import",
    payload: { importId: job },
  });
  const payload = corrupt(run);
  expect((await post(`/imports/${job}/cancel`, {}, "bob")).status).toBe(404);
  expect((await post(`/imports/${job}/cancel`)).status).toBe(200);
  expect(record(run)).toMatchObject({ state: "cancelled", payload });
  expect(db.prepare("SELECT status FROM imports WHERE id=?").get(job)).toEqual({
    status: "cancelled",
  });
});

it("keeps a malformed queued follow-up visible and cancellable behind active work", async () => {
  const owner = "feed-owner",
    parent = make("running", owner);
  db.prepare("UPDATE runs SET worker_id='active-worker' WHERE id=?").run(
    parent.id,
  );
  const follow = submit(owner, {
    agentId: parent.agent_id!,
    conversationId: parent.conversation_id!,
    input: "Queued follow-up",
    idempotencyKey: id(),
  });
  const payload = corrupt(follow);
  const { claim } = await import("../src/server/queue");
  expect(
    claim("other-worker", (run) => run.owner_id === owner),
  ).toBeUndefined();
  expect(record(follow)).toMatchObject({ state: "queued", payload });
  const page = await fetch(origin + "/api/feed?filter=all", {
    headers: { "x-test-owner": owner },
  });
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    items: [
      expect.objectContaining({
        conversation_id: parent.conversation_id,
        queued_runs: [
          expect.objectContaining({ id: follow.id, input: "Queued follow-up" }),
        ],
      }),
    ],
  });
  expect((await post(`/runs/${follow.id}/cancel`, {}, owner)).status).toBe(200);
  expect(record(follow)).toMatchObject({ state: "cancelled", payload });
  expect(record(parent)).toMatchObject({ state: "running" });
});
