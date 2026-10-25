import { afterAll, beforeAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ArtifactMetadata } from "../src/server/row-schemas";

const directory = mkdtempSync(join(tmpdir(), "loop-workflow-save-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_PROFILE = "server";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { workflows } = await import("../src/server/workflows/routes");
const { errorHandler } = await import("../src/server/error-handler");

const connectionId = id();
db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)")
  .run(connectionId, seal("fixture", "alice"), JSON.stringify([{ id: "fixture", name: "Fixture" }]), now());
const agent = createAgent("alice", { name: "workflow-save", connectionId, model: "fixture" });
const spec = {
  dsl: "loop.workflow/v1", title: "Saved workflow", inputs: {}, agents: { writer: agent.id },
  steps: [{ id: "draft", type: "agent", agent: "writer", prompt: "Hello" }],
  outputs: { result: "draft" },
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { res.locals.owner = req.get("x-test-owner") || "alice"; next(); });
app.use("/api", workflows);
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
const save = (body: unknown, owner = "alice") => fetch(origin + "/api/workflows", {
  method: "POST", headers: { "content-type": "application/json", "x-test-owner": owner },
  body: JSON.stringify(body),
});

it("creates and updates workflows through HTTP with versioned artifact metadata", async () => {
  const created = await save({ source: JSON.stringify(spec) });
  expect(created.status).toBe(200);
  const workflow = await created.json() as { id: string; version: number };
  expect(workflow.version).toBe(1);
  const revised = { ...spec, title: "Revised workflow" };
  const updated = await save({ id: workflow.id, expectedVersion: 1, source: JSON.stringify(revised) });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ id: workflow.id, title: revised.title, version: 2 });
  expect(db.prepare("SELECT version FROM workflow_versions WHERE workflow_id=? ORDER BY version").all(workflow.id))
    .toEqual([{ version: 1 }, { version: 2 }]);
  const artifacts = db.prepare("SELECT content,metadata FROM artifacts WHERE owner_id='alice' AND kind='workflow' ORDER BY rowid").all() as { content: string; metadata: string }[];
  expect(artifacts.map(row => ArtifactMetadata.parse(JSON.parse(row.metadata)))).toEqual([
    { workflowId: workflow.id, version: 1, dsl: spec.dsl },
    { workflowId: workflow.id, version: 2, dsl: spec.dsl },
  ]);
  expect(artifacts.map(row => JSON.parse(row.content))).toEqual([spec, revised]);
  expect((await save({ id: workflow.id, expectedVersion: 1, source: JSON.stringify(spec) })).status).toBe(409);
  expect((await fetch(origin + "/api/workflows/" + workflow.id, { headers: { "x-test-owner": "bob" } })).status).toBe(404);
  expect((await save({ id: workflow.id, expectedVersion: 2, source: JSON.stringify(spec) }, "bob")).status).toBe(404);
  expect(db.prepare("SELECT version FROM workflows WHERE id=?").get(workflow.id)).toEqual({ version: 2 });
  expect(db.prepare("SELECT count(*) n FROM artifacts WHERE kind='workflow'").get()).toEqual({ n: 2 });
});

it("rejects an unsupported workflow dialect through HTTP without storing a version or artifact", async () => {
  const counts = () => db.prepare("SELECT (SELECT count(*) FROM workflows) workflows,(SELECT count(*) FROM workflow_versions) versions,(SELECT count(*) FROM artifacts) artifacts").get();
  const before = counts();
  expect((await save({ source: JSON.stringify({ ...spec, dsl: "loop.workflow/v2" }) })).status).toBe(400);
  expect(counts()).toEqual(before);
});
