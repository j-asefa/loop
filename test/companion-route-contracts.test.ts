import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";
import { gitProject } from "./git-project";
import { until } from "./helpers";

// Enrich an actual execution result to exercise the public HTTP projection,
// without replacing its producer, command identity, sign-in state or driver.
const injection = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/server/execution-client", async importOriginal => {
  const original = await importOriginal<typeof import("../src/server/execution-client")>();
  return { ...original, executionRequest: async (...args: Parameters<typeof original.executionRequest>) => {
    const result = await original.executionRequest(...args);
    if (!injection.enabled || args[0] !== "auth.status") return result;
    const view = result as import("../src/shared/native-auth").NativeAuthView;
    const secrets = { device_code: "private-polling-token", access_token: "private-access-token", refresh_token: "private-refresh-token", api_key: "private-api-key", credentials: "private-file-contents" };
    return { ...view, ...secrets, providers: view.providers.map(provider => ({ ...provider, ...secrets, methods: provider.methods.map(method => ({ ...method, ...secrets })) })), attempt: { ...view.attempt, ...secrets } };
  } };
});

const directory = mkdtempSync(join(tmpdir(), "loop-companion-contracts-"));
const project = join(directory, "project"), bin = join(directory, "bin"), version = join(directory, "version"), audit = join(directory, "upgrades");
mkdirSync(project); mkdirSync(bin); gitProject(project);
const originalPath = process.env.PATH;
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_TEST_HISTORY_PROJECT = project;
for (const name of ["codex", "claude", "pi", "opencode", "gemini", "muse", "grok"]) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexport LOOP_TEST_AUTH_DIR='${directory}'\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`, { mode: 0o755 });
}
writeFileSync(version, "1.18.33");
writeFileSync(join(bin, "opencode"), `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv[2]==='--version') console.log(fs.readFileSync(${JSON.stringify(version)},'utf8')); else if(process.argv[2]==='upgrade') { fs.appendFileSync(${JSON.stringify(audit)},'upgrade\\n'); fs.writeFileSync(${JSON.stringify(version)},'1.18.40'); } else process.exit(91);\n`, { mode: 0o755 });
process.env.PATH = bin + ":" + originalPath;
const interrupted = randomUUID();
writeFileSync(join(directory, "harness-upgrades.json"), JSON.stringify({ [interrupted]: { commandId: interrupted, name: "opencode", state: "unconfirmed", message: "Interrupted fixture installer" } }));
const { db } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { nativeSessions, OWNER: owner } = await import("../src/server/native-sessions");
const { closeExecution } = await import("../src/server/execution-client");
const { harnessUpgrades } = await import("../src/server/harness-upgrades");
const { applyActivity, setActivityCapabilities, listActivities } = await import("../src/server/activities");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + "/api" + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function invalid(path: string, method = "GET") {
  const payload = method === "GET" ? "{}" : "{";
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(origin + "/api" + path, { method, headers: { "content-type": "application/json", "content-length": String(payload.length) } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.end(payload);
  });
}
const bad = { status: 400, data: { error: expect.any(String) } };
function valid(contract: RouteContract, result: Awaited<ReturnType<typeof request>>, status = contract.status ?? 200) {
  expect(result.status, JSON.stringify(result.data)).toBe(status);
  expect(contract.response.parse(result.data)).toEqual(result.data);
}
const created = await request("/workspace/projects", { path: project, name: "Contract project" });
valid(workspaceApi.workspaceProjectCreate, created);
const enabled = await request("/workspace/runtimes/codex/enable", { projectId: created.data.id, billing: "existing", commandId: randomUUID() });
valid(workspaceApi.runtimeEnable, enabled);
const history = await request("/native/history?discover=1"); valid(workspaceApi.nativeHistoryList, history);
const catalogId = history.data.external[0].id, forkCommand = randomUUID();
const forked = await request(`/native/history/${catalogId}/fork`, { commandId: forkCommand }); valid(workspaceApi.nativeHistoryFork, forked, 201);
const conversation = forked.data.id;
const source = { transport: "native" as const, harness: "codex", origin: "contract-fixture" };
const scope = { owner, conversation, generation: "contract-generation" };
for (const [kind, patch] of [
  ["plan", { steps: [{ id: "step", title: "Verify projection", status: "completed" }] }],
  ["tool", { title: "Read fixture", status: "completed", content: [{ type: "text", text: "Read complete" }] }],
  ["file_change", { state: "applied", files: [{ path: "tracked.txt", operation: "modify", patch: "+fixture" }] }],
  ["output", { command: "fixture", append: [{ stream: "stdout", text: "Success", index: 0 }], status: "exited", exitCode: 0 }],
  ["settings", { options: [{ id: "model", confirmed: "fixture" }] }],
  ["commands", { commands: [{ id: "help", token: "/help", name: "Help" }] }],
] as const) expect(applyActivity(scope, { v: 1, kind, id: kind, source, generation: scope.generation, replay: true, patch }).applied).toBe(true);
// Catalogs accumulate across patches; the response must not apply a patch's 50-option limit.
for (let index = 0; index < 51; index++) expect(applyActivity(scope, { v: 1, kind: "settings", id: "settings", source, generation: scope.generation, patch: { options: [{ id: "setting-" + index, confirmed: true }] } }).applied).toBe(true);
expect(setActivityCapabilities(scope, { transport: source.transport, harness: source.harness }, { settings: { state: "supported", source: "fixture" } }).applied).toBe(true);

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeExecution(); await nativeSessions.close(); db.close(); process.env.PATH = originalPath;
  rmSync(directory, { recursive: true, force: true });
});

it("workspace projects registered harnesses and directories from production writers", async () => {
  const result = await request("/workspace"); valid(workspaceApi.workspace, result);
  expect(result.data.harnesses).toEqual(nativeSessions.registrations());
  expect(result.data.projectPaths).toEqual(db.prepare("SELECT * FROM project_paths").all());
  expect(await invalid("/workspace")).toMatchObject(bad);
});
it("runtimeList returns real CLI discovery and setup state", async () => {
  const result = await request("/workspace/runtimes?fresh=1"); valid(workspaceApi.runtimeList, result);
  expect(result.data.runtimes).toHaveLength(7);
  expect(result.data.runtimes.find((runtime: { name: string }) => runtime.name === "codex")).toMatchObject({ installed: true, enabled: true, project });
  expect(await invalid("/workspace/runtimes")).toMatchObject(bad);
});
it("runtimeEnable keeps its durable command identity and native verification receipt", async () => {
  valid(workspaceApi.runtimeEnable, enabled);
  expect(enabled.data.models.length).toBeGreaterThan(0);
  expect(await request("/workspace/runtimes/codex/enable", { projectId: created.data.id, billing: "api" })).toMatchObject(bad);
});
it("workspaceProjectCreate preserves created and existing project branches", async () => {
  valid(workspaceApi.workspaceProjectCreate, created);
  const existing = await request("/workspace/projects", { path: project }); valid(workspaceApi.workspaceProjectCreate, existing);
  expect(existing.data).toEqual({ ...db.prepare("SELECT * FROM folders WHERE id=?").get(created.data.id)!, path: project });
  expect(await request("/workspace/projects", { path: "" })).toMatchObject(bad);
});
it("workspaceProjectUpdate binds an owned project without moving its native conversations", async () => {
  const folder = await request("/folders", { name: "Bound project", kind: "project" });
  const path = join(directory, "second-project"); mkdirSync(path);
  const result = await request(`/workspace/projects/${folder.data.id}`, { path }, "PATCH"); valid(workspaceApi.workspaceProjectUpdate, result);
  expect(db.prepare("SELECT path FROM project_paths WHERE folder_id=?").get(folder.data.id)).toEqual({ path });
  expect(await request(`/workspace/projects/${folder.data.id}`, { path: "" }, "PATCH")).toMatchObject(bad);
});
it("conversationNative returns saved display items and the owned native binding", async () => {
  const path = `/conversations/${conversation}/native`, result = await request(path); valid(workspaceApi.conversationNative, result);
  expect(result.data.binding).toEqual(db.prepare("SELECT harness,project,model,state,updated_at FROM companion_sessions WHERE conversation_id=?").get(conversation));
  expect(result.data.items).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Native saved context" }));
  expect(await invalid(path)).toMatchObject(bad);
  expect((await request("/conversations/not-owned/native")).status).toBe(404);
});
it("nativeHistoryList preserves managed and discovered display projections", async () => {
  valid(workspaceApi.nativeHistoryList, history);
  const managed = await request("/native/history"); valid(workspaceApi.nativeHistoryList, managed);
  expect(managed.data.managed).toContainEqual(expect.objectContaining({ id: conversation }));
  expect(await invalid("/native/history")).toMatchObject(bad);
});
it("nativeHistoryDetail reads saved context without taking over its native thread", async () => {
  const path = `/native/history/${catalogId}`, result = await request(path); valid(workspaceApi.nativeHistoryDetail, result);
  expect(result.data.items).toContainEqual(expect.objectContaining({ text: "Native saved context" }));
  expect(await invalid(path)).toMatchObject(bad);
});
it("nativeHistoryFork keeps the 201 creation and 200 durable replay branches", async () => {
  valid(workspaceApi.nativeHistoryFork, forked, 201);
  const replay = await request(`/native/history/${catalogId}/fork`, { commandId: forkCommand }); valid(workspaceApi.nativeHistoryFork, replay);
  expect(replay.data).toEqual(forked.data);
  expect(await request(`/native/history/${catalogId}/fork`, {})).toMatchObject(bad);
});
it("conversationActivities projects all reducer variants and accumulated catalogs", async () => {
  const path = `/conversations/${conversation}/activities`, result = await request(path + "?view=recent"); valid(workspaceApi.conversationActivities, result);
  expect(result.data).toEqual(listActivities(owner, conversation, { view: "recent" }));
  expect(result.data.items.map((item: { kind: string }) => item.kind).sort()).toEqual(["capabilities", "commands", "file_change", "output", "plan", "settings", "tool"]);
  expect(result.data.items.find((item: { kind: string }) => item.kind === "settings").record.data.options).toHaveLength(52);
  expect(await request(path + "?after=bad")).toMatchObject(bad);
  expect(await invalid(path)).toMatchObject(bad);
});
it("the published runs query selects real file activities using its documented wire shape", async () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  const parameter = spec.paths["/api/conversations/{id}/activities"].get.parameters.find((p: { name: string }) => p.name === "runs");
  const runs = [randomUUID(), randomUUID()];
  for (const run of runs) {
    db.prepare("INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,'agent','Files','completed',?,1,1)").run(run, owner, conversation, run);
    expect(applyActivity({ ...scope, run }, { v: 1, kind: "file_change", id: run, source, generation: scope.generation, patch: { state: "applied", files: [{ path: run + ".txt", operation: "modify" }] } }).applied).toBe(true);
  }
  const query = new URLSearchParams({ view: "files" });
  if (parameter.schema.type === "array") for (const run of runs) query.append("runs", run);
  else query.set("runs", runs.join(","));
  const path = `/conversations/${conversation}/activities`;
  const result = await request(path + "?" + query); valid(workspaceApi.conversationActivities, result);
  expect(result.data.items.map((item: { run: string }) => item.run).sort()).toEqual([...runs].sort());
  expect(parameter.schema.type).toBe("string");
  for (const value of ["", "one,,two", "x".repeat(151), Array(51).fill("run").join(",")])
    expect(await request(path + "?view=files&runs=" + encodeURIComponent(value))).toMatchObject(bad);
  expect(await request(path + "?view=files&runs=one&runs=two")).toMatchObject(bad);
});
it("conversationActivities preserves legacy trace display fields beyond activity-update limits", async () => {
  const { enqueue } = await import("../src/server/queue");
  const { recordTrace } = await import("../src/server/traces");
  const run = enqueue(owner, "Legacy trace", randomUUID(), { conversation });
  const trace = `acp:${randomUUID()}:${"t".repeat(300)}`, title = "Provider trace ".repeat(40);
  recordTrace(run, trace, { kind: "tool", title, content: "Retained trace", metadata: { native: true, state: "completed" } });
  const result = await request(`/conversations/${conversation}/activities?view=legacy`);
  valid(workspaceApi.conversationActivities, result);
  expect(result.data.items).toContainEqual(expect.objectContaining({
    legacy: true, run: run.id,
    record: expect.objectContaining({ id: trace, data: expect.objectContaining({ title, links: { trace } }) }),
  }));
  for (const patch of [{ title }, { links: { trace } }])
    expect(applyActivity(scope, { v: 1, kind: "tool", id: "bounded-update", source, generation: scope.generation, patch }).applied).toBe(false);
});
it("runtimeUpgrade returns interrupted status without installer internals", async () => {
  const result = await request("/workspace/runtimes/opencode/upgrade"); valid(workspaceApi.runtimeUpgrade, result);
  expect(result.data.upgrade).toMatchObject({ state: "unconfirmed", commandId: interrupted });
  expect(await request("/workspace/runtimes/acp/upgrade")).toMatchObject(bad);
});
it("runtimeUpgradeRecover requires the original command and explicit stopped confirmation", async () => {
  const path = "/workspace/runtimes/opencode/upgrade/recover";
  expect(await request(path, { commandId: interrupted, confirmedStopped: false })).toMatchObject(bad);
  expect((await request(path, { commandId: randomUUID(), confirmedStopped: true })).status).toBe(409);
  const result = await request(path, { commandId: interrupted, confirmedStopped: true }); valid(workspaceApi.runtimeUpgradeRecover, result);
  expect(result.data.upgrade).toMatchObject({ commandId: interrupted, state: "failed" });
});
it("runtimeUpgradeStart executes the fixture installer once for a durable command", async () => {
  const path = "/workspace/runtimes/opencode/upgrade", commandId = randomUUID();
  expect(await request(path, {})).toMatchObject(bad);
  const result = await request(path, { commandId }); valid(workspaceApi.runtimeUpgradeStart, result);
  await until(() => harnessUpgrades.status("opencode")?.state === "complete");
  const replay = await request(path, { commandId }); valid(workspaceApi.runtimeUpgradeStart, replay);
  expect(replay.data.upgrade.commandId).toBe(commandId);
  expect(readFileSync(audit, "utf8")).toBe("upgrade\n");
});
it("runtimeUpgradeDismiss removes completed display status without replaying the installer", async () => {
  const result = await request("/workspace/runtimes/opencode/upgrade", {}, "DELETE"); valid(workspaceApi.runtimeUpgradeDismiss, result);
  expect(result.data).toEqual({ upgrade: null });
  expect(await request("/workspace/runtimes/acp/upgrade", {}, "DELETE")).toMatchObject(bad);
});

const authPath = "/workspace/runtimes/claude/auth";
const authBody = { projectId: created.data.id, provider: "anthropic", method: "oauth", commandId: randomUUID() };
let authAttempt: string;
it("runtimeAuthProviders discovers the real CLI catalog without caching auth data", async () => {
  const response = await fetch(origin + "/api" + authPath + "?projectId=" + created.data.id);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = { status: response.status, data: await response.json() }; valid(workspaceApi.runtimeAuthProviders, result);
  expect(result.data.providers[0].id).toBe("anthropic");
  expect(await request(authPath + "?projectId=")).toMatchObject(bad);
});
it("runtimeAuthStart preserves durable replay identity and validates before starting a driver", async () => {
  const result = await request(authPath + "/start", authBody); valid(workspaceApi.runtimeAuthStart, result);
  authAttempt = result.data.attempt.id;
  expect(result.data.attempt.commandId).toBe(authBody.commandId);
  expect((await request(authPath + "/start", authBody)).data.attempt.id).toBe(authAttempt);
  expect(await request(authPath + "/start", { ...authBody, commandId: "not-a-uuid" })).toMatchObject(bad);
});
it("runtimeAuthStatus preserves user_code while stripping polling tokens and credential fields", async () => {
  const grok = "/workspace/runtimes/grok/auth";
  valid(workspaceApi.runtimeAuthStart, await request(grok + "/start", { ...authBody, provider: "xai", commandId: randomUUID() }));
  await until(async () => !!(await request(grok + "/status")).data.attempt?.code);
  const produced = await request(grok + "/status");
  const logs: unknown[][] = [];
  const spies = ["log", "warn", "error"].map(method => vi.spyOn(console, method as "log").mockImplementation((...args) => { logs.push(args); }));
  injection.enabled = true;
  try {
    const result = await request(grok + "/status"); valid(workspaceApi.runtimeAuthStatus, result);
    expect(result.data).toEqual(produced.data);
    expect(result.data.attempt.code).toBe("KSXH-JR4E");
    expect(result.data.attempt.url).toBe("https://accounts.x.ai/oauth2/device?user_code=KSXH-JR4E");
    expect(JSON.stringify(result.data)).not.toMatch(/device_code|access_token|refresh_token|api_key|credentials|private-/);
    expect(JSON.stringify(logs)).not.toMatch(/private-/);
    for (const table of ["events", "run_traces", "messages", "execution_commands"])
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toMatch(/private-polling|private-access|private-refresh|private-api|private-file/);
  } finally { injection.enabled = false; for (const spy of spies) spy.mockRestore(); }
  await request(grok + "/cancel", { attemptId: produced.data.attempt.id });
  expect(await request("/workspace/runtimes/invalid/auth/status")).toMatchObject(bad);
});
it("runtimeAuthInput validates the prompt and never returns the submitted credential", async () => {
  await until(async () => !!(await request(authPath + "/status")).data.attempt?.prompt);
  const prompt = (await request(authPath + "/status")).data.attempt.prompt.id;
  const body = { attemptId: authAttempt, promptId: prompt, value: "fixture-code" };
  expect(await request(authPath + "/input", { ...body, value: "code\ninjected" })).toMatchObject(bad);
  const result = await request(authPath + "/input", body); valid(workspaceApi.runtimeAuthInput, result);
  expect(JSON.stringify(result.data)).not.toContain(body.value);
  await until(async () => (await request(authPath + "/status")).data.attempt?.state === "complete");
});
it("runtimeAuthCancel only cancels the matching live attempt", async () => {
  const started = await request(authPath + "/start", { ...authBody, commandId: randomUUID() }); valid(workspaceApi.runtimeAuthStart, started);
  expect(await request(authPath + "/cancel", { attemptId: "invalid" })).toMatchObject(bad);
  const result = await request(authPath + "/cancel", { attemptId: started.data.attempt.id }); valid(workspaceApi.runtimeAuthCancel, result);
  expect(result.data.attempt.state).toBe("cancelled");
});

it("activity responses cannot synthesize availability from missing recorded fields", async () => {
  for (const kind of ["commands", "file_change"]) {
    const row = db.prepare("SELECT activity_key,record FROM agent_activities WHERE owner_id=? AND conversation_id=? AND kind=?").get(owner, conversation, kind) as { activity_key: string; record: string };
    const malformed = JSON.parse(row.record);
    if (kind === "commands") delete malformed.data.commands[0].available;
    else delete malformed.data.files[0].content;
    db.prepare("UPDATE agent_activities SET record=? WHERE owner_id=? AND activity_key=?").run(JSON.stringify(malformed), owner, row.activity_key);
    try {
      const result = await request(`/conversations/${conversation}/activities?view=recent`);
      expect(result).toEqual({ status: 500, data: { error: "The workspace response is unavailable. Please try again." } });
    } finally { db.prepare("UPDATE agent_activities SET record=? WHERE owner_id=? AND activity_key=?").run(row.record, owner, row.activity_key); }
  }
});
