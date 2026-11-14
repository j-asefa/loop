import { readRoute } from "../src/client/api";
import { RunId } from "../src/shared/contract-ids.js";
import { afterAll, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-agent-contracts-"));
const project = join(directory, "project"),
  piHome = join(directory, "pi");
mkdirSync(join(project, ".pi", "prompts"), { recursive: true });
mkdirSync(join(project, ".pi", "local-package", "skills"), { recursive: true });
mkdirSync(piHome);
writeFileSync(
  join(project, ".pi", "prompts", "review.md"),
  "Review $1 carefully.",
);
writeFileSync(
  join(project, ".pi", "local-package", "package.json"),
  JSON.stringify({ name: "contract-fixture", description: "Local fixture" }),
);
writeFileSync(
  join(project, ".pi", "local-package", "skills", "review.md"),
  "Fixture skill",
);
writeFileSync(join(project, ".pi", "settings.json"), "{}");
writeFileSync(
  join(piHome, "settings.json"),
  JSON.stringify({ packages: ["npm:fixture"] }),
);
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.PI_CODING_AGENT_DIR = piHome;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { withTestAdapter } = await import("../src/server/providers");
const { nativeSessions } = await import("../src/server/native-sessions");
const { closeExecution } = await import("../src/server/execution-client");
const { submit } = await import("../src/server/agent-runtime");
const { recordTrace } = await import("../src/server/traces");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
const owner = "local-workspace";
const restore = withTestAdapter("openai", {
  async models() {
    return [
      { id: "fixture", name: "Fixture", capabilities: "Isolated fixture" },
    ];
  },
  async *stream() {
    yield { text: "Fixture response" };
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json(), headers: r.headers };
}
async function invalid(path: string, method: string, malformed = false) {
  const payload = malformed ? "{" : "{}";
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
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
function valid(
  contract: RouteContract,
  result: Awaited<ReturnType<typeof request>>,
) {
  expect(result.status, JSON.stringify(result.data)).toBe(
    contract.status ?? 200,
  );
  expect(
    contract.response.safeParse(result.data).success,
    JSON.stringify(result.data),
  ).toBe(true);
}
async function apiConnection() {
  const result = await request("/connections", {
    provider: "openai",
    label: "Contract fixture",
    secret: "fixture-private-key",
  });
  valid(workspaceApi.connectionCreate, result);
  return result.data.id as string;
}
async function agent(connectionId: string, model = "fixture") {
  const result = await request("/agents", {
    name: "contract-" + id().slice(0, 8),
    connectionId,
    model,
  });
  valid(workspaceApi.agentCreate, result);
  return workspaceApi.agentCreate.response.parse(result.data);
}
await nativeSessions.projects.enable({
  harness: "pi",
  executable: resolve("test/fixtures/contract-pi.mjs"),
  project,
  version: "fixture",
  billing: "existing",
});
const piAgent = await agent("native-pi", "native-default");
const connection = await apiConnection(),
  apiAgent = await agent(connection);
const run = submit(owner, {
  agentId: apiAgent.id,
  input: "Contract fixture task",
  idempotencyKey: id(),
});
recordTrace(run, "contract-tool", {
  kind: "tool",
  title: "Fixture tool",
  content: "Recorded trace",
  metadata: { fixture: true },
});
recordConversationUpdate(run, "contract-message", {
  content: "Recorded output",
});
// Extra stored columns simulate a future connection row accidentally passed to a response.
db.exec(
  "ALTER TABLE connections ADD COLUMN token TEXT; ALTER TABLE connections ADD COLUMN apiKey TEXT;",
);
db.prepare(
  "UPDATE connections SET token='private-token',apiKey='private-key'",
).run();
function credentialFree(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["secret", "token", "apiKey"]).not.toContain(key);
    credentialFree(child);
  }
}
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  restore();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("connectionCreate validates inbound credentials and exposes only id/models from production creation", async () => {
  const result = await request("/connections", {
    provider: "openai",
    label: "Created",
    secret: "private-input-key",
  });
  valid(workspaceApi.connectionCreate, result);
  credentialFree(result.data);
  expect(
    db.prepare("SELECT secret FROM connections WHERE id=?").get(result.data.id),
  ).toMatchObject({ secret: expect.any(String) });
  expect(
    await request("/connections", {
      provider: "openai",
      label: "Bad",
      secret: "short",
    }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("connectionRefresh retains API and native shapes without credentials", async () => {
  for (const target of [connection, "native-pi"]) {
    const result = await request(`/connections/${target}/refresh`, {});
    valid(workspaceApi.connectionRefresh, result);
    credentialFree(result.data);
    if (target === "native-pi")
      expect(result.data).toMatchObject({
        name: "pi",
        billing: { mode: "existing" },
        capabilities: expect.any(Object),
      });
  }
  expect(
    await invalid(`/connections/${connection}/refresh`, "POST", true),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("connectionModels projects refreshed catalogs from private connection rows", async () => {
  const row = db
    .prepare("SELECT secret,token,apiKey FROM connections WHERE id=?")
    .get(connection);
  expect(row).toMatchObject({
    secret: expect.any(String),
    token: "private-token",
    apiKey: "private-key",
  });
  const result = await request(`/connections/${connection}/models`);
  valid(workspaceApi.connectionModels, result);
  credentialFree(result.data);
  expect(result.data.models).toHaveLength(1);
  expect(
    await invalid(`/connections/${connection}/models`, "GET"),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("connectionReconnect validates the key and returns only the existing acknowledgement", async () => {
  const result = await request(`/connections/${connection}/reconnect`, {
    secret: "replacement-private-key",
  });
  valid(workspaceApi.connectionReconnect, result);
  credentialFree(result.data);
  expect(
    await request(`/connections/${connection}/reconnect`, { secret: 42 }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("connectionDisconnect preserves revocation and refuses malformed JSON before changing the row", async () => {
  const target = await apiConnection();
  expect(await invalid(`/connections/${target}`, "DELETE", true)).toMatchObject(
    { status: 400, data: { error: expect.any(String) } },
  );
  expect(
    db.prepare("SELECT status FROM connections WHERE id=?").get(target),
  ).toEqual({ status: "connected" });
  const result = await request(`/connections/${target}`, {}, "DELETE");
  valid(workspaceApi.connectionDisconnect, result);
  credentialFree(result.data);
  expect(
    db.prepare("SELECT status,secret FROM connections WHERE id=?").get(target),
  ).toEqual({ status: "disconnected", secret: "" });
});
it("agentSuggestName returns an available production name and enforces NoBody", async () => {
  const result = await request("/agents/suggest-name");
  valid(workspaceApi.agentSuggestName, result);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await invalid("/agents/suggest-name", "GET")).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
});
it("agentCreate preserves initial-run receipts and rejects invalid input before creation", async () => {
  const body = {
    name: "initial-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
    initialPrompt: " Initial task ",
    idempotencyKey: id(),
  };
  const result = await request("/agents", body);
  valid(workspaceApi.agentCreate, result);
  expect(result.data.initialRun.conversation_id).toEqual(expect.any(String));
  expect((await request("/agents", body)).data).toEqual(result.data);
  expect(
    await request("/agents", { ...body, name: "invalid name" }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentUpdate keeps the full public agent and rolls back invalid changes", async () => {
  const result = await request(
    `/agents/${apiAgent.id}`,
    { instructions: "Updated instructions" },
    "PATCH",
  );
  valid(workspaceApi.agentUpdate, result);
  expect(result.data.instructions).toBe("Updated instructions");
  const unchanged = await request(
    `/agents/${apiAgent.id}`,
    { model: null, connectionId: null },
    "PATCH",
  );
  valid(workspaceApi.agentUpdate, unchanged);
  expect(unchanged.data).toEqual(result.data);
  expect(
    await request(`/agents/${apiAgent.id}`, { instructions: 42 }, "PATCH"),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentDetail retains production runs and conversations as opaque wire records", async () => {
  const result = await request(`/agents/${apiAgent.id}`);
  valid(workspaceApi.agentDetail, result);
  expect(
    result.data.runs.find((r: { id: string }) => r.id === run.id).payload,
  ).toEqual(expect.any(String));
  expect(
    result.data.conversations.some(
      (c: { id: string }) => c.id === run.conversation_id,
    ),
  ).toBe(true);
  expect(await invalid(`/agents/${apiAgent.id}`, "GET")).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
});
it("agentHarness retains API unavailability and real Pi catalog/inventory metadata", async () => {
  const unavailable = await request(`/agents/${apiAgent.id}/harness`);
  valid(workspaceApi.agentHarness, unavailable);
  expect(unavailable.data.available).toBe(false);
  const native = await request(`/agents/${piAgent.id}/harness`);
  valid(workspaceApi.agentHarness, native);
  expect(native.data.commands[0].sourceInfo.packageId).toBe("fixture");
  expect(native.data.inventory.resources[0].name).toBe("review");
  expect(
    await request(`/agents/${apiAgent.id}/harness?conversation=bad`),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentMessages projects real recorded output and rejects invalid cursors", async () => {
  const result = await request(`/agents/${apiAgent.id}/messages`);
  valid(workspaceApi.agentMessages, result);
  expect(result.data.items[0].content).toBe("Recorded output");
  expect(
    await request(`/agents/${apiAgent.id}/messages?before=bad`),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentTraces preserves production trace fields and rejects invalid page boundaries", async () => {
  const result = await request(`/agents/${apiAgent.id}/traces`);
  valid(workspaceApi.agentTraces, result);
  expect(result.data.items[0]).toMatchObject({
    title: "Fixture tool",
    trace_key: "contract-tool",
    run_error: null,
    server: null,
    invocation_state: null,
    metadata: '{"fixture":true}',
    owner_id: owner,
  });
  for (const field of [
    "trace_key",
    "run_error",
    "server",
    "invocation_state",
  ]) {
    const incomplete = { ...result.data.items[0] };
    delete incomplete[field];
    expect(
      workspaceApi.agentTraces.response.safeParse({
        ...result.data,
        items: [incomplete],
      }).success,
    ).toBe(false);
  }
  expect(await request(`/agents/${apiAgent.id}/traces?before=0`)).toMatchObject(
    { status: 400, data: { error: expect.any(String) } },
  );
});
it("agentTracesExport keeps its attachment writer and returns a Blob through the production typed client", async () => {
  const result = await request(
    `/agents/${apiAgent.id}/traces/export?run=${run.id}`,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("content-disposition")).toContain(
    `loop-run-${run.id}-traces.json`,
  );
  expect(result.data.traces[0].metadata).toEqual({ fixture: true });
  expect(
    result.data.messages.some(
      (m: { content: string }) => m.content === "Recorded output",
    ),
  ).toBe(true);
  expect(await request(`/agents/${apiAgent.id}/traces/export`)).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    realFetch(new URL(path, origin), init),
  );
  try {
    const blob = await readRoute(
      workspaceApi.agentTracesExport,
      { params: { id: apiAgent.id }, query: { run: RunId.parse(run.id) } },
      "",
      new AbortController().signal,
      undefined,
      "once",
    );
    expect(blob).toBeInstanceOf(Blob);
    expect(JSON.parse(await blob.text())).toMatchObject({
      run: { id: run.id },
      truncated: false,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("agentPiPackages reads production configuration including trust metadata", async () => {
  const result = await request(`/agents/${piAgent.id}/pi-packages`);
  valid(workspaceApi.agentPiPackages, result);
  expect(result.data.packages[0].source).toBe("npm:fixture");
  expect(
    result.data.trust.paths.some((p: { kind: string }) => p.kind === "file"),
  ).toBe(true);
  expect(
    await invalid(`/agents/${piAgent.id}/pi-packages`, "GET"),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentPiTrust persists a generation-bound decision and rejects extra input fields", async () => {
  const before = await request(`/agents/${piAgent.id}/pi-packages`);
  const body = { trusted: true, fingerprint: before.data.trust.fingerprint };
  expect(
    await request(`/agents/${piAgent.id}/pi-trust`, { ...body, extra: true }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
  const result = await request(`/agents/${piAgent.id}/pi-trust`, body);
  valid(workspaceApi.agentPiTrust, result);
  expect(result.data.trust).toMatchObject({ trusted: true, override: true });
});
it("agentPiFilters preserves configuration readback after a production settings write", async () => {
  const before = await request(`/agents/${piAgent.id}/pi-packages`);
  const pkg = before.data.packages[0];
  const body = {
    source: pkg.source,
    scope: pkg.scope,
    settingsHash: pkg.settingsHash,
    filters: { skills: ["review"] },
  };
  expect(
    await request(`/agents/${piAgent.id}/pi-package-filters`, {
      ...body,
      settingsHash: "bad",
    }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
  const result = await request(
    `/agents/${piAgent.id}/pi-package-filters`,
    body,
  );
  valid(workspaceApi.agentPiFilters, result);
  expect(result.data.packages[0].filters.skills).toEqual(["review"]);
  expect(
    JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8")).packages[0]
      .skills,
  ).toEqual(["review"]);
});
it("agentPiPreview expands the production prompt from the native catalog", async () => {
  const result = await request(`/agents/${piAgent.id}/pi-prompt-preview`, {
    name: "review",
    args: "contracts",
  });
  valid(workspaceApi.agentPiPreview, result);
  expect(result.data).toEqual({
    token: "/review contracts",
    expanded: "Review contracts carefully.",
  });
  expect(
    await request(`/agents/${piAgent.id}/pi-prompt-preview`, {
      name: "review",
      args: 42,
    }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentPiInspect describes a local package without installing it", async () => {
  const result = await request(`/agents/${piAgent.id}/pi-package-inspect`, {
    source: "./local-package",
  });
  valid(workspaceApi.agentPiInspect, result);
  expect(result.data).toMatchObject({
    inspected: true,
    name: "contract-fixture",
    resources: { skills: ["skills/review.md"] },
  });
  expect(
    await request(`/agents/${piAgent.id}/pi-package-inspect`, { source: "" }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
});
it("agentPiRollback retains configuration and consumes its production recovery receipt", async () => {
  db.prepare(
    "INSERT INTO pi_package_recovery(owner_id,project,scope,source,previous_source,saved_at) VALUES(?,?,?,?,?,?)",
  ).run(owner, project, "user", "npm:fixture", "npm:fixture@1.0.0", now());
  expect(
    await request(`/agents/${piAgent.id}/pi-package-rollback`, {
      source: "npm:fixture",
      scope: "invalid",
    }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
  const result = await request(`/agents/${piAgent.id}/pi-package-rollback`, {
    source: "npm:fixture",
    scope: "user",
  });
  valid(workspaceApi.agentPiRollback, result);
  expect(result.data.packages[0].source).toBe("npm:fixture@1.0.0");
  expect(
    db.prepare("SELECT 1 FROM pi_package_recovery WHERE owner_id=?").get(owner),
  ).toBeUndefined();
});
it("agentPiAction returns the configuration written by the isolated Pi CLI", async () => {
  expect(
    await request(`/agents/${piAgent.id}/pi-packages`, {
      action: "bad",
      source: "npm:second",
      scope: "user",
    }),
  ).toMatchObject({ status: 400, data: { error: expect.any(String) } });
  const result = await request(`/agents/${piAgent.id}/pi-packages`, {
    action: "install",
    source: "npm:second",
    scope: "user",
  });
  valid(workspaceApi.agentPiAction, result);
  expect(
    result.data.packages.some(
      (p: { source: string }) => p.source === "npm:second",
    ),
  ).toBe(true);
});

it("validates create and update selections before persisting agent changes", async () => {
  const connections = await import("../src/server/sql/connections");
  const targetConnection = await apiConnection();
  const target = await agent(targetConnection);
  const catalog = JSON.stringify([
    { id: "fixture", name: "Fixture", effortLevels: [{ value: "low" }] },
    { id: "other", name: "Other", effortLevels: [{ value: "high" }] },
    { id: "unrestricted", name: "Unrestricted" },
  ]);
  const foreignConnection = id();
  connections.insert(
    db,
    foreignConnection,
    "another-owner",
    "openai",
    "Foreign",
    "",
    "connected",
    catalog,
    "{}",
    now(),
  );
  const count = () => db.prepare("SELECT count(*) n FROM agents").get();
  const before = count();
  const saved = () =>
    db.prepare("SELECT * FROM agents WHERE id=?").get(target.id);
  const original = saved();
  for (const scenario of [
    {
      connectionId: targetConnection,
      disconnected: true,
      model: "missing",
      effort: "invalid",
      status: 409,
      createError: "Reconnect this provider first",
      updateError: "Reconnect this provider first",
    },
    {
      connectionId: foreignConnection,
      disconnected: false,
      model: "fixture",
      effort: "low",
      status: 404,
      createError: "Item not found",
      updateError: "Item not found",
    },
    {
      connectionId: targetConnection,
      disconnected: false,
      model: "missing",
      effort: "invalid",
      status: 400,
      createError: "Choose an available model from this connection",
      updateError: "Model unavailable on this connection",
    },
    {
      connectionId: targetConnection,
      disconnected: false,
      model: "fixture",
      effort: "invalid",
      status: 400,
      createError: "Choose an effort level reported by this model",
      updateError: "Choose an effort level reported by this model",
    },
  ]) {
    connections.connectedModels(db, catalog, targetConnection);
    if (scenario.disconnected) connections.needsReconnect(db, targetConnection);
    const selection = {
      connectionId: scenario.connectionId,
      model: scenario.model,
      effort: scenario.effort,
    };
    expect(
      await request("/agents", {
        name: "rejected-" + id().slice(0, 8),
        ...selection,
      }),
    ).toMatchObject({
      status: scenario.status,
      data: { error: scenario.createError },
    });
    expect(
      await request(
        `/agents/${target.id}`,
        { instructions: "Must roll back", ...selection },
        "PATCH",
      ),
    ).toMatchObject({
      status: scenario.status,
      data: { error: scenario.updateError },
    });
    expect(count()).toEqual(before);
    expect(saved()).toEqual(original);
  }
  connections.connectedModels(db, catalog, targetConnection);
  const created = await request("/agents", {
    name: "selected-" + id().slice(0, 8),
    connectionId: targetConnection,
    model: "fixture",
    effort: "low",
  });
  valid(workspaceApi.agentCreate, created);
  expect(created.data.effort).toBe("low");
  for (const [patch, effort] of [
    [{ model: "fixture", effort: "low" }, "low"],
    [{ model: "fixture" }, "low"],
    [{ model: "other" }, null],
    [{ effort: "high" }, "high"],
    [{ effort: null }, null],
    [{ model: "unrestricted", effort: "custom" }, "custom"],
  ] as const) {
    const updated = await request(`/agents/${target.id}`, patch, "PATCH");
    valid(workspaceApi.agentUpdate, updated);
    expect(updated.data.effort).toBe(effort);
  }
});

it("rolls back agent creation and its receipt when initial attachments are refused", async () => {
  const body = {
    name: "retry-create-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
    initialPrompt: "Use this attachment",
    idempotencyKey: id(),
  };
  const count = () =>
    db.prepare("SELECT count(*) n FROM agents WHERE owner_id=?").get(owner);
  const before = count();
  const refused = await request("/agents", { ...body, attachmentIds: [id()] });
  expect(refused.status).toBe(404);
  expect(count()).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT 1 FROM agent_creations WHERE owner_id=? AND request_key=?",
      )
      .get(owner, body.idempotencyKey),
  ).toBeUndefined();
  const created = await request("/agents", body);
  valid(workspaceApi.agentCreate, created);
  const replay = await request("/agents", { ...body, attachmentIds: [] });
  expect(replay.data).toEqual(created.data);
  expect(
    await request("/agents", { ...body, initialPrompt: "Different intent" }),
  ).toMatchObject({ status: 409 });
});
