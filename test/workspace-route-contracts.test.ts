import { afterAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import { workspaceApi, PublicConnection } from "../src/shared/workspace-api";
import { Problem, ExecutionProblem } from "../src/shared/problem";
import { registrar, mountedRoute } from "../src/server/registrar";
import { integrationTokenRequest } from "../src/shared/card-access";

const directory = mkdtempSync(join(tmpdir(), "loop-route-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { createTeam } = await import("../src/server/teams");
const { submit } = await import("../src/server/agent-runtime");
const { requestApproval } = await import("../src/server/approvals");
const { saveArtifact } = await import("../src/server/artifacts");
const { errorHandler } = await import("../src/server/error-handler");
const { app } = await import("../src/server/index");
const { closeExecution } = await import("../src/server/execution-client");
const owner = "local-workspace";
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
it("resolves nested production registrars without invoking native history or diagnostic handlers", () => {
  expect(mountedRoute(app, "POST", "/api/ui/viewport-diagnostics")).toBe(
    workspaceApi.viewportDiagnostics,
  );
  for (const method of ["GET", "HEAD"]) {
    expect(mountedRoute(app, method, "/api/native/history?discover=1")).toBe(
      workspaceApi.nativeHistoryList,
    );
    expect(mountedRoute(app, method, "/api/native/history/fixture")).toBe(
      workspaceApi.nativeHistoryDetail,
    );
  }
});
it("does not mount the retired subscription action route", () => {
  expect(
    mountedRoute(app, "POST", "/api/subscriptions/fixture/status"),
  ).toBeUndefined();
});
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    data: await response.json(),
  };
}
function fixture(who = owner) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    who,
    seal("fixture-only-key", who),
    JSON.stringify([{ id: "fixture", name: "Fixture" }]),
    now(),
  );
  const agent = createAgent(who, {
    name: "route-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const run = submit(who, {
    agentId: agent.id,
    input: "Fixture task",
    idempotencyKey: id(),
  });
  return { connection, agent, run };
}

// fetch disallows GET bodies; raw HTTP exercises the NoBody refusal as well.
async function requestWithBody(path: string, method: string, body: unknown) {
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(
      origin + "/api" + path,
      {
        method,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// The helper's error behavior is exercised through Express and the same error
// middleware, including rejected async handlers and bad server output.
const helper = express();
helper.use(express.json());
const contract = {
  method: "POST",
  access: "session",
  path: "/input",
  params: z.object({}),
  query: z.object({}),
  body: z.object({ label: z.string() }),
  response: z.object({ label: z.string() }),
} as const;
const helperRoutes = registrar("test");
helper.use(helperRoutes.mount);
helperRoutes.on(contract, (req, res) => {
  const projection = { label: req.body.label, secret: "must-not-leak" };
  res.json(projection);
});
helper.post("/legacy", (req, res) => res.json(contract.body.parse(req.body)));
helperRoutes.on({ ...contract, path: "/sync" }, () => {
  throw new Problem(409, "Already changed");
});
helperRoutes.on({ ...contract, path: "/async" }, async () => {
  await Promise.resolve();
  throw new ExecutionProblem(409, "Inspect first", "unknown");
});
helperRoutes.on({ ...contract, path: "/invalid-output" }, async (_req, res) => {
  await Promise.resolve();
  // @ts-expect-error The typed response rejects this at compile time too.
  res.status(201).json({ label: 42, secret: "must-not-leak" });
});
helper.use(errorHandler);
const helperServer = helper.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => helperServer.once("listening", resolve));
const helperOrigin =
  "http://127.0.0.1:" + (helperServer.address() as AddressInfo).port;
async function probe(path: string, body: unknown) {
  const r = await fetch(helperOrigin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => helperServer.close(() => resolve())),
  ]);
  await closeExecution();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("keeps input errors identical to existing Zod/Problem handling and strips undeclared response fields", async () => {
  expect(await probe("/input", { label: 2 })).toEqual(
    await probe("/legacy", { label: 2 }),
  );
  expect(await probe("/input", { label: "Visible" })).toEqual({
    status: 200,
    data: { label: "Visible" },
  });
  expect(await probe("/sync", { label: "x" })).toEqual({
    status: 409,
    data: { error: "Already changed" },
  });
  expect(await probe("/async", { label: "x" })).toEqual({
    status: 409,
    data: { error: "Inspect first", executionOutcome: "unknown" },
  });
  expect(await probe("/invalid-output", { label: "x" })).toEqual({
    status: 500,
    data: { error: "The workspace response is unavailable. Please try again." },
  });
});

it("serves a credential-free bootstrap from the production HTTP app and retains serialized catalogs", async () => {
  const f = fixture(),
    foreign = fixture(id());
  const result = await request("/bootstrap");
  expect(result.status).toBe(200);
  const data = workspaceApi.bootstrap.response.parse(result.data);
  const connection = data.connections.find((row) => row.id === f.connection)!;
  expect(connection.models).toBe('[{"id":"fixture","name":"Fixture"}]');
  expect(connection).not.toHaveProperty("secret");
  expect(connection).not.toHaveProperty("owner_id");
  expect(data.agents.some((row) => row.id === foreign.agent.id)).toBe(false);
  expect(
    PublicConnection.parse({
      ...connection,
      secret: "private",
      nativeCredential: "private",
    }),
  ).toEqual(connection);
  expect(result.headers.get("x-loop-change-epoch")).toEqual(expect.any(String));
  const session = await request("/auth/get-session");
  expect(session.data.user.id).toBe(owner);
  expect(session.headers.get("x-loop-change-epoch")).toEqual(
    expect.any(String),
  );
});

it("serves all six Cards contracts from production writes and refuses invalid input before token changes", async () => {
  const f = fixture();
  const artifact = saveArtifact(owner, {
    title: "Contract card",
    content: "Published content",
    agent: f.agent.id,
    conversation: f.run.conversation_id,
    role: "answer",
  });
  const created = await request(
    "/card-tokens",
    integrationTokenRequest("Contract reader", ["read"]),
  );
  expect(created.status).toBe(201);
  const token = workspaceApi.cardTokenCreate.response.parse(created.data).token;
  const listed = await request("/card-tokens?historically-ignored=yes");
  expect(listed.status).toBe(200);
  expect(
    workspaceApi.cardTokens.response
      .parse(listed.data)
      .some((item) => item.id === token.id),
  ).toBe(true);
  const list = await request("/v1/cards");
  expect(list.status).toBe(200);
  const page = workspaceApi.cardList.response.parse(list.data);
  expect(page.items.some((item) => item.card.id === "a:" + artifact)).toBe(
    true,
  );
  const changes = await request(
    "/v1/cards/changes?after=" + encodeURIComponent(page.revision),
  );
  expect(changes.status).toBe(200);
  workspaceApi.cardChanges.response.parse(changes.data);
  const detail = await request("/v1/cards/a%3A" + artifact);
  expect(detail.status).toBe(200);
  expect(workspaceApi.cardDetail.response.parse(detail.data)).toMatchObject({
    id: "a:" + artifact,
    content: "Published content",
  });
  const before = db
    .prepare("SELECT * FROM card_tokens WHERE id=?")
    .get(token.id);
  for (const invalid of [
    await request("/v1/cards?limit=0"),
    await request("/v1/cards/changes"),
    await request("/v1/cards/a%3A" + artifact + "?unknown=1"),
    await requestWithBody("/card-tokens", "GET", {}),
    await request("/card-tokens", {
      ...integrationTokenRequest("Invalid", ["read"]),
      extra: true,
    }),
    await request("/card-tokens/" + token.id, {}, "DELETE"),
  ])
    expect(invalid).toMatchObject({
      status: 400,
      data: { error: expect.any(String) },
    });
  expect(
    db.prepare("SELECT * FROM card_tokens WHERE id=?").get(token.id),
  ).toEqual(before);
  const revoked = await request(
    "/card-tokens/" + token.id + "?historically-ignored=yes",
    undefined,
    "DELETE",
  );
  expect(revoked.status).toBe(200);
  expect(workspaceApi.cardTokenRevoke.response.parse(revoked.data)).toEqual({
    ok: true,
  });
  expect(
    db.prepare("SELECT revoked_at FROM card_tokens WHERE id=?").get(token.id),
  ).toEqual({ revoked_at: expect.any(Number) });
});

it("keeps invalid run inputs side-effect free and preserves submit, replay and cancel wire responses", async () => {
  const f = fixture();
  const before = db.prepare("SELECT count(*) n FROM runs").get();
  const invalid = await request("/runs", {
    agentId: f.agent.id,
    input: "x",
    idempotencyKey: id(),
    attachmentIds: ["not-a-uuid"],
  });
  expect(invalid.status).toBe(400);
  expect(Object.keys(invalid.data)).toEqual(["error"]);
  expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual(before);
  const body = {
    agentId: f.agent.id,
    input: "  New turn  ",
    idempotencyKey: id(),
    queue: true,
  };
  const created = await request("/runs", body),
    replay = await request("/runs", body);
  expect(created.status).toBe(202);
  expect(replay.data.id).toBe(created.data.id);
  const run = workspaceApi.submit.response.parse(created.data);
  expect(typeof run.payload).toBe("string");
  expect(run.input).toBe("New turn");
  expect(await request(`/runs/${run.id}/cancel`, {})).toMatchObject({
    status: 200,
    data: { ok: true },
  });
  const foreign = fixture(id());
  expect((await request(`/runs/${foreign.run.id}/cancel`, {})).status).toBe(
    404,
  );
});

it("keeps unavailable payloads readable in run lists and binds projection bodies to their headers", async () => {
  const f = fixture();
  const payload = JSON.stringify({ ...f.run.payload, reviewId: null });
  db.prepare("UPDATE runs SET state='running',payload=? WHERE id=?").run(
    payload,
    f.run.id,
  );
  const listed = await request("/runs?active=1");
  expect(listed.status).toBe(200);
  expect(
    workspaceApi.runs.response
      .parse(listed.data)
      .find((row) => row.id === f.run.id),
  ).toMatchObject({ state: "waiting_children", payload });
  for (const path of [
    "/feed?filter=working",
    `/conversations/${f.run.conversation_id}`,
    "/results",
    "/results/updates?after=0&through=0",
  ]) {
    const result = await request(path);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect(result.data.projection.cursor).toBe(
      Number(result.headers.get("x-loop-change-cursor")),
    );
    expect(result.data.projection.epoch).toBe(
      result.headers.get("x-loop-change-epoch"),
    );
  }
  const page = await request(
    `/conversations/${f.run.conversation_id}?resume=1`,
  );
  const parsed = workspaceApi.conversation.response.parse(page.data);
  expect(parsed.steerable_run_id).toBeNull();
  expect(parsed.messages[0].metadata).toEqual(expect.any(String));
  const foreign = fixture(id());
  expect(
    (await request(`/conversations/${foreign.run.conversation_id}`)).status,
  ).toBe(404);
});

it("retains nullable author joins, serialized metadata and Results cursor behavior", async () => {
  const artifact = saveArtifact(owner, {
    title: "Unattributed",
    content: "Result",
    role: "answer",
  });
  for (const path of [
    "/results?before=invalid",
    "/results/updates?after=0&through=0",
  ]) {
    const result = await request(path);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const row = result.data.items.find(
      (item: { id: string }) => item.id === artifact,
    );
    expect(row).toMatchObject({ name: null, provider: null, metadata: "{}" });
    expect(row.cursor).toEqual(expect.any(Number));
  }
  expect(
    (await request("/results/updates?after=invalid&through=0")).status,
  ).toBe(400);
});

it("excludes empty team conversations and keeps visible Feed keys and activity times through message insertion and deletion", async () => {
  const manager = fixture(),
    worker = fixture();
  const team = createTeam(owner, {
    name: "Empty team",
    managerId: manager.agent.id,
    members: [worker.agent.id],
  });
  const conversation = team.conversation_id!;
  expect(
    db
      .prepare(
        "SELECT 1 FROM feed_cards WHERE owner_id=? AND conversation_id=?",
      )
      .get(owner, conversation),
  ).toBeUndefined();
  for (const filter of ["all", "done"]) {
    const result = await request("/feed?filter=" + filter);
    expect(result.status).toBe(200);
    expect(
      result.data.items.some(
        (item: { conversation_id: string }) =>
          item.conversation_id === conversation,
      ),
    ).toBe(false);
  }
  const message = id(),
    createdAt = now();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'user','Only a message',?)",
  ).run(message, owner, conversation, createdAt);
  expect(
    db
      .prepare(
        "SELECT card_key,sort_at FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='thread'",
      )
      .get(owner, conversation),
  ).toEqual({ card_key: "message:" + message, sort_at: createdAt });
  const visible = await request("/feed?filter=all");
  expect(visible.status).toBe(200);
  expect(
    visible.data.items.find(
      (item: { conversation_id: string }) =>
        item.conversation_id === conversation,
    ),
  ).toMatchObject({
    conversation_id: conversation,
    last_activity_at: createdAt,
    last_message: { id: message },
  });
  expect((await request("/feed?filter=done")).status).toBe(200);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM feed_cards WHERE owner_id=? AND kind='thread' AND (sort_at IS NULL OR card_key='')",
      )
      .get(owner),
  ).toEqual({ n: 0 });
  db.prepare("DELETE FROM messages WHERE id=?").run(message);
  expect(
    db
      .prepare(
        "SELECT 1 FROM feed_cards WHERE owner_id=? AND conversation_id=?",
      )
      .get(owner, conversation),
  ).toBeUndefined();
  for (const filter of ["all", "done"]) {
    const result = await request("/feed?filter=" + filter);
    expect(result.status).toBe(200);
    expect(
      result.data.items.some(
        (item: { conversation_id: string }) =>
          item.conversation_id === conversation,
      ),
    ).toBe(false);
  }
});

it("validates approvals before a decision and preserves owner checks", async () => {
  const f = fixture(),
    foreign = fixture(id());
  for (const run of [f.run, foreign.run])
    db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
      run.id,
    );
  const approval = requestApproval(f.run, { tool: "fixture" }),
    other = requestApproval(foreign.run, { tool: "fixture" });
  const listed = await request("/approvals");
  expect(listed.status).toBe(200);
  expect(listed.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: approval.id,
        state: "pending",
        result: null,
        expires_at: approval.expires_at,
      }),
    ]),
  );
  const items = workspaceApi.approvals.response.parse(listed.data);
  expect(items.some((row) => row.id === approval.id)).toBe(true);
  expect(items.some((row) => row.id === other.id)).toBe(false);
  expect(
    (await request(`/approvals/${approval.id}`, { decision: "invalid" }))
      .status,
  ).toBe(400);
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
  ).toEqual({ state: "pending" });
  expect(
    (await request(`/approvals/${other.id}`, { decision: "reject" })).status,
  ).toBe(404);
  expect(
    await request(`/approvals/${approval.id}`, { decision: "reject" }),
  ).toMatchObject({ status: 200, data: { ok: true } });
});

it("keeps native decisions and session controls generation-bound through the production routes", async () => {
  const f = fixture(),
    foreign = fixture(id()),
    generation = id(),
    decision = id();
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,generation,updated_at) VALUES('fixture-agent',?,'codex',?,?,?)",
  ).run(f.run.conversation_id, directory, generation, now());
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES(?,?,?,?,?,'{}',?)",
  ).run(decision, f.run.id, f.run.conversation_id, generation, id(), now());
  const listed = await request(
    `/native/decisions?conversation=${f.run.conversation_id}`,
  );
  expect(listed.status).toBe(200);
  expect(
    workspaceApi.nativeDecisions.response.parse(listed.data)[0],
  ).toMatchObject({ id: decision, generation });
  expect(
    (
      await request(
        `/native/decisions?conversation=${foreign.run.conversation_id}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(`/native/decisions/${decision}`, {
        commandId: "invalid",
        answer: {},
      })
    ).status,
  ).toBe(400);
  expect(
    db
      .prepare("SELECT state,command_id FROM native_decisions WHERE id=?")
      .get(decision),
  ).toEqual({ state: "pending", command_id: null });
  const controls = await request(
    `/conversations/${f.run.conversation_id}/settings`,
  );
  expect(controls.status, JSON.stringify(controls.data)).toBe(200);
  expect(workspaceApi.session.response.parse(controls.data)).toMatchObject({
    generation,
    state: "disconnected",
    settings: { options: [], revision: 0 },
  });
  expect(
    (await request(`/conversations/${foreign.run.conversation_id}/settings`))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `/conversations/${f.run.conversation_id}/settings/model`,
        { value: "fixture", revision: -1, generation },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect(db.prepare("SELECT count(*) n FROM execution_commands").get()).toEqual(
    { n: 0 },
  );
});

it("reads current work beyond an anchored transcript without exposing Feed cache columns", async () => {
  const { agent, run } = fixture();
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
  const insert = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Earlier result',?)",
  );
  const anchor = id();
  insert.run(anchor, owner, run.conversation_id, run.id, 1);
  for (let n = 2; n <= 60; n++)
    insert.run(id(), owner, run.conversation_id, run.id, n);
  const current = submit(owner, {
    agentId: agent.id,
    conversationId: run.conversation_id!,
    input: "Current task",
    idempotencyKey: id(),
  });
  const path = `/conversations/${run.conversation_id}?message=${anchor}`;
  const initial = await request(path);
  expect(initial.status).toBe(200);
  const page = workspaceApi.conversation.response.parse(initial.data);
  expect(page.messages.some((message) => message.run_id === current.id)).toBe(
    false,
  );
  expect(page.working).toBe(true);
  expect(page.conversation).not.toHaveProperty("feed_run_state");
  for (const state of [
    "running",
    "pausing",
    "paused",
    "awaiting_approval",
    "completed",
    "cancelled",
  ]) {
    db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, current.id);
    const result = await request(path);
    expect(result.status).toBe(200);
    expect(result.data.working).toBe(
      !["completed", "cancelled"].includes(state),
    );
  }
  db.prepare(
    "UPDATE runs SET state='queued',owner_id='another-owner' WHERE id=?",
  ).run(current.id);
  expect((await request(path)).data.working).toBe(false);
  expect(
    (
      await request(
        `/conversations/${fixture("another-owner").run.conversation_id}`,
      )
    ).status,
  ).toBe(404);
});

it("returns the API fallback through the shared error boundary", async () => {
  const response = await fetch(origin + "/api/no-such-endpoint");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Endpoint not found" });
});
it("keeps ordinary and import upload limits distinct", async () => {
  for (const [contract, bytes, error] of [
    [
      workspaceApi.uploadCreate,
      25 * 1024 * 1024 + 1,
      "Files can be up to 25 MB each",
    ],
    [
      workspaceApi.importPreview,
      30 * 1024 * 1024 + 1,
      "Request could not be completed. Please try again.",
    ],
  ] as const) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), "oversized.txt");
    const response = await fetch(origin + "/api" + contract.path, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error });
  }
});

it("preserves terminal previews and queue values in the unfiltered run list", async () => {
  const f = fixture();
  db.prepare("UPDATE runs SET state='completed',queue_rank=7 WHERE id=?").run(
    f.run.id,
  );
  const response = await request("/runs");
  expect(response.status).toBe(200);
  const run = workspaceApi.runs.response
    .parse(response.data)
    .find((row) => row.id === f.run.id);
  expect(run).toMatchObject({ state: "completed", queue_rank: 7 });
  expect(run).toHaveProperty("preview");
  expect(run).toHaveProperty("preview_artifact");
  expect(run).toHaveProperty("queue_position");
});

it("preserves native error events in running and subsequently completed HTTP runs", async () => {
  const { NativeSessions } = await import("../src/server/native-sessions");
  const { NativeOutput } = await import("../src/server/native-output");
  const { Codex } = await import("../src/adapters/codex");
  const { ownedRun } = await import("../src/server/domain");
  const { transition } = await import("../src/server/queue");
  const f = fixture();
  const conversation = f.run.conversation_id!;
  const generation = id();
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture-error-worker',heartbeat=?,active_since=? WHERE id=?",
  ).run(now(), now(), f.run.id);
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,generation,updated_at) VALUES(?,?,'codex',?,?,?)",
  ).run(f.agent.id, conversation, directory, generation, now());
  const run = ownedRun(f.run.id, owner);
  const live: import("../src/server/native-sessions").Live = {
    binding: {
      worktree_source: null,
      worktree_agent_id: f.agent.id,
      conversation_id: conversation,
      harness: "codex",
      native_id: null,
      project: directory,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    },
    adapter: new Codex(
      {
        harness: "codex",
        executable: "",
        version: "fixture",
        project: directory,
        billing: "existing",
      },
      () => {},
    ),
    generation,
    ready: Promise.resolve(),
    bootstrapRun: run,
    run,
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
  };
  const sessions = new NativeSessions();
  (sessions as unknown as { live: Map<string, typeof live> }).live.set(
    conversation,
    live,
  );
  sessions.projector.event(live, {
    type: "error",
    message: "Recoverable native error",
  });
  for (const state of ["running", "completed"] as const) {
    if (state === "completed") expect(transition(run, "completed")).toBe(true);
    const response = await request(
      state === "running" ? "/runs?active=1" : "/runs",
    );
    expect(response.status).toBe(200);
    // Assert the actual wire field, without projecting the expected value.
    expect(response.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: run.id,
          state,
          error: "Recoverable native error",
        }),
      ]),
    );
  }
});

it("projects every approval lifecycle result from the production writers without losing expiry", async () => {
  const queries = await import("../src/server/sql/approvals");
  const { approve, decide } = await import("../src/server/approvals");
  const { resumeAfterApproval } = await import("../src/server/sql/runs");
  const { Approval } = await import("../src/shared/approval-contract-schema");
  const make = () => {
    const f = fixture();
    db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
      f.run.id,
    );
    const approval = requestApproval(f.run, { tool: "fixture" });
    const joined = queries
      .pendingTeams(db, owner, [])
      .find((row) => row.id === approval.id)!;
    const project = () => {
      const result = Approval.parse({
        ...joined,
        ...queries.owned(db, approval.id, owner),
      });
      expect(result.expires_at).toBe(approval.expires_at);
      return result;
    };
    const execute = () => {
      approve(owner, approval.id, { by: "user" });
      expect(project()).toMatchObject({ state: "approved", result: null });
      resumeAfterApproval(db, f.run.id);
      queries.startApproved(db, approval.id);
      expect(project()).toMatchObject({ state: "executing", result: null });
    };
    return { approval, project, execute };
  };
  const completed = make();
  expect(completed.project()).toMatchObject({ state: "pending", result: null });
  completed.execute();
  queries.complete(db, "fixture result", completed.approval.id);
  expect(completed.project()).toMatchObject({
    state: "completed",
    result: "fixture result",
  });
  const uncertain = make();
  uncertain.execute();
  queries.unknownExecuting(
    db,
    "uncertain fixture outcome",
    uncertain.approval.id,
  );
  expect(uncertain.project()).toMatchObject({
    state: "unknown",
    result: "uncertain fixture outcome",
  });
  const rejected = make();
  decide(owner, rejected.approval.id, "reject");
  expect(rejected.project()).toMatchObject({ state: "rejected", result: null });
  queries.previewDecision(
    db,
    "rejected",
    "simulated rejection",
    rejected.approval.id,
  );
  expect(rejected.project()).toMatchObject({
    state: "rejected",
    result: "simulated rejection",
  });
});
