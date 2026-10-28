import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-workflow-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { compile, bind } = await import("../src/server/workflows/compiler");
const { executeWorkflow } = await import("../src/server/workflows/runtime");
const { app } = await import("../src/server/index");
const { closeExecution } = await import("../src/server/execution-client");
const owner = "local-workspace";
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;

async function request(path: string, body?: unknown) {
  const response = await fetch(origin + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function invalidGet(path: string) {
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(
      origin + "/api" + path,
      {
        method: "GET",
        headers: { "content-type": "application/json", "content-length": "2" },
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
    req.end("{}");
  });
}
function valid(
  contract: RouteContract,
  result: Awaited<ReturnType<typeof request>>,
) {
  expect(result.status, JSON.stringify(result.data)).toBe(
    contract.status ?? 200,
  );
  expect(contract.response.parse(result.data)).toEqual(result.data);
}
const bad = { status: 400, data: { error: expect.any(String) } };
function fixture(who = owner) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    who,
    seal("fixture-only-secret", who),
    JSON.stringify([{ id: "fixture", name: "Fixture" }]),
    now(),
  );
  const agent = createAgent(who, {
    name: "workflow-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const spec = {
    dsl: "loop.workflow/v1",
    title: "Contract workflow",
    inputs: { topic: { description: "Topic", default: "evidence" } },
    agents: { writer: agent.id },
    steps: [
      {
        id: "draft",
        type: "agent",
        agent: "writer",
        prompt: "Review {{inputs.topic}}",
      },
    ],
    outputs: { result: "draft" },
  };
  return { agent, source: JSON.stringify(spec), spec };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("validates and saves source text through production HTTP while retaining version conflicts and owner isolation", async () => {
  const { source, spec } = fixture();
  const foreign = fixture(id());
  expect(await request("/workflows/validate", { source: 42 })).toMatchObject(
    bad,
  );
  expect(
    await request("/workflows/validate", { source: "x".repeat(100001) }),
  ).toMatchObject(bad);
  expect(await request("/workflows/validate", { source: "{" })).toMatchObject({
    status: 422,
  });
  const checked = await request("/workflows/validate", {
    source,
    ignored: true,
  });
  valid(workspaceApi.workflowValidate, checked);
  expect(checked.data.spec).toEqual(compile(source));
  expect(checked.data.bindings).toEqual(bind(owner, compile(source)));
  expect(JSON.stringify(checked.data)).not.toContain("fixture-only-secret");
  expect(
    await request("/workflows/validate", { source: foreign.source }),
  ).toMatchObject({ status: 404 });

  const count = () =>
    db
      .prepare(
        "SELECT (SELECT count(*) FROM workflows) workflows,(SELECT count(*) FROM workflow_versions) versions,(SELECT count(*) FROM artifacts) artifacts",
      )
      .get();
  const before = count();
  expect(await request("/workflows", { source: 42 })).toMatchObject(bad);
  expect(
    await request("/workflows", { source: "x".repeat(100001) }),
  ).toMatchObject(bad);
  expect(count()).toEqual(before);
  const saved = await request("/workflows", { source, ignored: true });
  valid(workspaceApi.workflowSave, saved);
  const key = saved.data.id;
  expect(saved.data).toEqual(
    db.prepare("SELECT * FROM workflows WHERE id=?").get(key),
  );
  expect(saved.data.source).toBe(source);
  expect(typeof saved.data.compiled).toBe("string");
  const revised = await request("/workflows", {
    id: key,
    expectedVersion: 1,
    source: JSON.stringify({ ...spec, title: "Revised contract" }),
  });
  valid(workspaceApi.workflowSave, revised);
  expect(revised.data.version).toBe(2);
  expect(
    await request("/workflows", { id: key, expectedVersion: 1, source }),
  ).toMatchObject({ status: 409 });
  expect(
    db
      .prepare("SELECT count(*) n FROM workflow_versions WHERE workflow_id=?")
      .get(key),
  ).toEqual({ n: 2 });

  const detail = await request(`/workflows/${key}?ignored=yes`);
  valid(workspaceApi.workflowDetail, detail);
  expect(detail.data.versions).toEqual(
    db
      .prepare(
        "SELECT version,source,created_at FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC",
      )
      .all(key),
  );
  expect(await invalidGet(`/workflows/${key}`)).toMatchObject(bad);
  const listed = await request("/workflows?ignored=yes");
  valid(workspaceApi.workflowList, listed);
  expect(listed.data).toEqual(
    db
      .prepare(
        "SELECT * FROM workflows WHERE owner_id=? ORDER BY created_at DESC",
      )
      .all(owner),
  );
  expect(await invalidGet("/workflows")).toMatchObject(bad);

  // A real saved row becomes inaccessible to this owner after an ownership change.
  db.prepare("UPDATE workflows SET owner_id=? WHERE id=?").run(
    foreign.agent.owner_id,
    key,
  );
  expect(
    (await request("/workflows")).data.some(
      (row: { id: string }) => row.id === key,
    ),
  ).toBe(false);
  expect(await request(`/workflows/${key}`)).toMatchObject({ status: 404 });
  expect(
    await request("/workflows", { id: key, expectedVersion: 2, source }),
  ).toMatchObject({ status: 404 });
  expect(
    await request(`/workflows/${key}/run`, {
      version: 2,
      inputs: {},
      idempotencyKey: id(),
    }),
  ).toMatchObject({ status: 404 });
});

it("starts once per idempotency key and projects real workflow steps without dispatching a provider", async () => {
  const { source } = fixture();
  const saved = await request("/workflows", { source });
  valid(workspaceApi.workflowSave, saved);
  const path = `/workflows/${saved.data.id}/run`;
  const before = db.prepare("SELECT count(*) n FROM runs").get();
  for (const body of [
    { version: 1, inputs: {} },
    { version: 1, inputs: {}, idempotencyKey: "short" },
    { version: "1", inputs: {}, idempotencyKey: id() },
  ])
    expect(await request(path, body)).toMatchObject(bad);
  expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual(before);
  const body = {
    version: 1,
    inputs: { topic: "evidence" },
    idempotencyKey: id(),
  };
  const started = await request(path, body);
  valid(workspaceApi.workflowRun, started);
  const replayed = await request(path, body);
  valid(workspaceApi.workflowRun, replayed);
  expect(replayed.data.id).toBe(started.data.id);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM runs WHERE owner_id=? AND idempotency_key=?",
      )
      .get(owner, body.idempotencyKey),
  ).toEqual({ n: 1 });
  expect(
    await request(path, { ...body, inputs: { topic: "changed" } }),
  ).toMatchObject({ status: 409 });
  expect(
    await request(path, { ...body, version: 100, idempotencyKey: id() }),
  ).toMatchObject({ status: 404 });
  expect(
    await request(path, {
      ...body,
      inputs: { unexpected: "x" },
      idempotencyKey: id(),
    }),
  ).toMatchObject({ status: 422 });
  expect(typeof started.data.payload).toBe("string");
  expect(started.data).toEqual(
    db.prepare("SELECT * FROM runs WHERE id=?").get(started.data.id),
  );

  const run = ownedRun(started.data.id, owner);
  // Production workflow execution persists its checkpoint and child dispatch identity;
  // no worker executes the child and no model request occurs in this fixture.
  expect(await executeWorkflow(run)).toBe(false);
  const steps = await request(`/runs/${run.id}/steps`);
  valid(workspaceApi.workflowSteps, steps);
  const rows = db
    .prepare(
      "SELECT s.*,r.conversation_id,r.state child_state FROM workflow_steps s LEFT JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=? ORDER BY position",
    )
    .all(run.id);
  expect(steps.data).toEqual(rows);
  expect(steps.data).toHaveLength(1);
  expect(steps.data[0]).toMatchObject({
    step_id: "draft",
    state: "running",
    child_state: "queued",
    conversation_id: expect.any(String),
  });
  expect(await invalidGet(`/runs/${run.id}/steps`)).toMatchObject(bad);
  const detail = await request(`/workflows/${saved.data.id}`);
  valid(workspaceApi.workflowDetail, detail);
  expect(detail.data.runs).toEqual(
    db.prepare("SELECT * FROM runs WHERE id=?").all(run.id),
  );
  db.prepare("UPDATE runs SET owner_id=? WHERE id=?").run(id(), run.id);
  expect(await request(`/runs/${run.id}/steps`)).toMatchObject({ status: 404 });
});

it("strips an accidental workflow storage column and rejects malformed public output without exposing schema details", async () => {
  const { source } = fixture();
  const saved = await request("/workflows", { source });
  valid(workspaceApi.workflowSave, saved);
  const key = saved.data.id;
  db.exec("ALTER TABLE workflows ADD COLUMN credential TEXT");
  try {
    db.prepare("UPDATE workflows SET credential=? WHERE id=?").run(
      "fixture-private-column",
      key,
    );
    const detail = await request(`/workflows/${key}`);
    valid(workspaceApi.workflowDetail, detail);
    expect(detail.data).not.toHaveProperty("credential");
    expect(JSON.stringify((await request("/workflows")).data)).not.toContain(
      "fixture-private-column",
    );
    db.prepare("UPDATE workflows SET compiled=? WHERE id=?").run(
      "not JSON: retained opaque text",
      key,
    );
    expect((await request(`/workflows/${key}`)).data.compiled).toBe(
      "not JSON: retained opaque text",
    );
    db.prepare("UPDATE workflows SET version=? WHERE id=?").run(
      "invalid-version",
      key,
    );
    // Detail retains the existing typed-row 409; the list reads raw display
    // rows, so its malformed public projection is the registrar's generic 500.
    expect(await request(`/workflows/${key}`)).toEqual({
      status: 409,
      data: {
        error: `Saved workflows record ${key} is unavailable: invalid row.`,
      },
    });
    expect(await request("/workflows")).toEqual({
      status: 500,
      data: {
        error: "The workspace response is unavailable. Please try again.",
      },
    });
  } finally {
    db.exec("ALTER TABLE workflows DROP COLUMN credential");
  }
});
