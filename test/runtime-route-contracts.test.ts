import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-runtime-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_PROFILE = "server";
process.env.LOOP_AUTH_MODE = "single-user";
process.env.LOOP_URL = "http://127.0.0.1";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { codexFixture, fixtureToken } = await import(resolve("test/helpers/codex-server.mjs"));
const codex = await codexFixture();
process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = new URL(codex.url).origin;
const { db } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
const owner = (db.prepare("SELECT owner_id FROM installation WHERE id=1").get() as { owner_id: string }).owner_id;
async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + "/api" + path, { method, headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function invalid(path: string, method = "GET") {
  const payload = method === "GET" ? "{}" : "{";
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(origin + "/api" + path, { method, headers: { origin, "content-type": "application/json", "content-length": String(payload.length) } }, res => {
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
const created = await request("/runtime-hosts", { name: "Contract host", url: codex.url, token: fixtureToken, kind: "codex-app-server" });
valid(workspaceApi.runtimeHostCreate, created);

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await codex.close(); db.close(); rmSync(directory, { recursive: true, force: true });
});
it("runtimeHostCreate checks the real Codex transport and returns no sealed access token", async () => {
  valid(workspaceApi.runtimeHostCreate, created);
  expect(codex.calls.some((call: { method: string }) => call.method === "account/read")).toBe(true);
  expect(db.prepare("SELECT id,name,url,kind FROM runtime_hosts WHERE id=? AND owner_id=?").get(created.data.id, owner)).toEqual(created.data);
  expect(created.data).not.toHaveProperty("secret");
  expect(JSON.stringify(created.data)).not.toContain(fixtureToken);
  expect(await request("/runtime-hosts", { name: "Bad", url: codex.url, token: "short" })).toMatchObject(bad);
});
it("runtimeHostList returns owned display rows without access credentials", async () => {
  const result = await request("/runtime-hosts"); valid(workspaceApi.runtimeHostList, result);
  expect(result.data).toEqual([created.data]);
  expect(await invalid("/runtime-hosts")).toMatchObject(bad);
});
it("subscriptionCreate persists a native subscription selection and its id receipt", async () => {
  const result = await request("/subscriptions", { provider: "codex", label: "Contract subscription", runtimeHostId: created.data.id }); valid(workspaceApi.subscriptionCreate, result);
  const row = db.prepare("SELECT provider,status,metadata FROM connections WHERE id=? AND owner_id=?").get(result.data.id, owner) as { provider: string; status: string; metadata: string };
  expect(row).toMatchObject({ provider: "codex", status: "needs_sign_in" });
  expect(JSON.parse(row.metadata)).toMatchObject({ authMode: "subscription", runtimeHostId: created.data.id });
  expect(await request("/subscriptions", { provider: "invalid", label: "Bad" })).toMatchObject(bad);
  expect((await request(`/runtime-hosts/${created.data.id}`, {}, "DELETE")).status).toBe(409);
});
it("runtimeHostDelete removes an unused owned host and preserves missing-id refusal", async () => {
  const extra = await request("/runtime-hosts", { name: "Unused", url: codex.url, token: fixtureToken, kind: "codex-app-server" }); valid(workspaceApi.runtimeHostCreate, extra);
  const path = `/runtime-hosts/${extra.data.id}`;
  const result = await request(path, {}, "DELETE"); valid(workspaceApi.runtimeHostDelete, result);
  expect(db.prepare("SELECT id FROM runtime_hosts WHERE id=?").get(extra.data.id)).toBeUndefined();
  expect((await request(path, {}, "DELETE")).status).toBe(404);
  expect(await invalid(path, "DELETE")).toMatchObject(bad);
});

it("subscriptionAction projects real Codex status, cancellation and disconnected branches", async () => {
  const created = await request("/subscriptions", { provider: "codex", label: "Status contract", runtimeHostId: (await request("/runtime-hosts")).data[0].id });
  const path = `/subscriptions/${created.data.id}`;
  for (const action of ["login", "status"]) {
    const result = await request(path + "/" + action, {}); valid(workspaceApi.subscriptionAction, result);
    expect(result.data).toMatchObject({ authenticated: true, authMode: "subscription", models: expect.any(Array) });
    expect(JSON.stringify(result.data)).not.toContain(fixtureToken);
  }
  valid(workspaceApi.subscriptionAction, await request(path + "/cancel", {}));
  expect(await request(path + "/invalid", {})).toMatchObject(bad);
  expect(await request(path + "/code", { code: "invalid\ncode" })).toMatchObject(bad);
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(created.data.id);
  const disconnected = await request(path + "/status", {}); valid(workspaceApi.subscriptionAction, disconnected);
  expect(disconnected.data).toEqual({ authenticated: false });
});
