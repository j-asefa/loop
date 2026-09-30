import { afterAll, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "managed-workspace-http-"));
process.env.LOOP_DATA_DIR = dir;
const fixture = vi.hoisted(() => ({
  state: "online",
  worker: vi.fn(),
  connect: vi.fn(async (_environment: unknown, flavor: string) => ({ id: `hapi-${flavor}` })),
  direct: vi.fn(async (options: { harness: string }) => ({ id: `native-${options.harness}` })),
  discover: vi.fn(async (name: string) => ({ installed: true, supported: true, executable: `/host/${name}`, version: "fixture" })),
  registrations: [{ name: "pi", billing: "existing", project: "/project" }],
}));
vi.mock("../src/server/hapi/environments.js", () => ({
  environment: (owner: string, host: string) => ({ owner_id: owner, host_id: host, state: fixture.state, generation: 1 }),
  workerRequest: fixture.worker,
}));
vi.mock("../src/server/hapi/routes.js", () => ({ connectProvider: fixture.connect }));
vi.mock("../src/host-control.js", () => ({ discover: fixture.discover }));
vi.mock("../src/server/native-sessions.js", () => ({
  OWNER: "owner",
  nativeSessions: {
    registrations: () => fixture.registrations,
    registration: () => fixture.registrations[0],
    enable: fixture.direct,
  },
}));
vi.mock("../src/server/native-auth.js", () => ({ nativeSignIns: { inProgress: () => false } }));
const { db } = await import("../src/server/db.js");
const { bindManagedWorkspace } = await import("../src/server/managed-workspace.js");
const { companion } = await import("../src/server/companion-routes.js");
db.pragma("foreign_keys = OFF");
db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('project','owner','project','Project',0),('foreign','other','project','Other',0)").run();
db.prepare("INSERT INTO project_paths VALUES('project','/project'),('foreign','/foreign')").run();
const app = express();
app.use(express.json(), companion);
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message });
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const release = bindManagedWorkspace("owner", "local-runner");
afterAll(async () => {
  release();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const enable = (name: string, body: unknown) => fetch(`${origin}/workspace/runtimes/${name}/enable`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

it("routes HTTP inventory and four Enable choices to the bound runner without changing direct registrations", async () => {
  fixture.worker.mockImplementation(async (_e, path) => path === "/runtimes"
    ? { runtimes: ["codex", "claude", "opencode", "pi"].map((flavor) => ({ flavor, installed: true, authentication: "signed_in", executable: "/private/path" })) }
    : { path: "/project" });
  const before = structuredClone(fixture.registrations);
  const inventory = await fetch(`${origin}/workspace/runtimes`).then((r) => r.json());
  expect(inventory.runtimes).toHaveLength(4);
  expect(inventory.runtimes.every((r: any) => r.backend === "hapi" && r.environmentId === "local-runner")).toBe(true);
  expect(JSON.stringify(inventory)).not.toContain("/private/path");
  for (const flavor of ["codex", "claude", "opencode", "pi"]) {
    const response = await enable(flavor, { projectId: "project", billing: flavor === "pi" ? "existing" : "subscription" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: `hapi-${flavor}`, backend: "hapi" });
  }
  expect(fixture.direct).not.toHaveBeenCalled();
  expect(fixture.discover).not.toHaveBeenCalled();
  expect(fixture.registrations).toEqual(before);
});

it("rejects executable overrides, foreign projects and billing mismatch before registration", async () => {
  fixture.connect.mockClear();
  for (const body of [
    { projectId: "project", billing: "subscription", executable: "/client/program" },
    { projectId: "foreign", billing: "subscription" },
    { projectId: "project", billing: "existing" },
  ]) {
    const response = await enable("codex", body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.body?.cancel();
  }
  expect(fixture.connect).not.toHaveBeenCalled();
  expect(fixture.direct).not.toHaveBeenCalled();
});

it("does not fall back after a managed worker failure but retains direct Enable when offline", async () => {
  fixture.worker.mockRejectedValueOnce(new Error("runner unavailable"));
  const failure = await enable("pi", { projectId: "project", billing: "existing" });
  expect(failure.status).toBe(500);
  await failure.body?.cancel();
  expect(fixture.direct).not.toHaveBeenCalled();
  fixture.state = "offline";
  const response = await enable("pi", { projectId: "project", billing: "existing" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "native-pi" });
  expect(fixture.direct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ executable: "/host/pi", project: "/project", billing: "existing" }));
});

it("combines an online runner with direct runtimes it does not serve without billing fallback", async () => {
  fixture.state = "online";
  fixture.direct.mockClear(); fixture.discover.mockClear(); fixture.connect.mockClear();
  fixture.worker.mockImplementation(async (_e, path) => path === "/runtimes"
    ? { runtimes: [{ flavor: "codex", installed: true, authentication: "signed_in" }] }
    : { path: "/project" });
  const inventory = await fetch(`${origin}/workspace/runtimes`).then((r) => r.json());
  expect(inventory.runtimes.find((r: any) => r.name === "codex")).toMatchObject({ backend: "hapi", available: true });
  expect(inventory.runtimes.find((r: any) => r.name === "opencode")).toMatchObject({ backend: "direct", available: true });
  const direct = await enable("opencode", { projectId: "project", billing: "existing" });
  expect(direct.status).toBe(200);
  expect(await direct.json()).toEqual({ id: "native-opencode" });
  expect(fixture.direct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: "opencode", executable: "/host/opencode", billing: "existing" }));
  for (const name of ["codex", "opencode"]) {
    const rejected = await enable(name, { projectId: "project", billing: name === "codex" ? "existing" : "subscription" });
    expect(rejected.status).toBe(422);
    await rejected.body?.cancel();
  }
  expect(fixture.direct).toHaveBeenCalledTimes(1);
  expect(fixture.connect).not.toHaveBeenCalled();
});

it("does not substitute direct execution when the online runner returns malformed inventory", async () => {
  fixture.direct.mockClear();
  fixture.worker.mockResolvedValueOnce({});
  const rejected = await enable("opencode", { projectId: "project", billing: "existing" });
  expect(rejected.status).toBe(502);
  await rejected.body?.cancel();
  expect(fixture.direct).not.toHaveBeenCalled();
});
