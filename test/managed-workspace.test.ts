import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "managed-workspace-"));
process.env.LOOP_DATA_DIR = dir;
const fixture = vi.hoisted(() => {
  const reply = async (_e: unknown, path: string) => path === "/runtimes"
    ? { runtimes: ["codex", "claude", "opencode", "pi"].map((flavor) => ({ flavor, installed: true })) }
    : { path: "/project" };
  return {
  state: "online", generation: 1,
  reply, verify: vi.fn(reply),
  connect: vi.fn(async () => ({ id: "managed-connection" })),
}; });
vi.mock("../src/server/hapi/environments.js", () => ({
  environment: (owner: string, host: string) => ({ owner_id: owner, host_id: host, state: fixture.state, generation: fixture.generation }),
  workerRequest: fixture.verify,
}));
vi.mock("../src/server/hapi/routes.js", () => ({ connectProvider: fixture.connect }));
const { db } = await import("../src/server/db.js");
const { bindManagedWorkspace, managedWorkspace, enableManagedWorkspace, managedWorkspaceInventory } = await import("../src/server/managed-workspace.js");
db.pragma("foreign_keys = OFF");
let release: (() => void) | undefined;
afterEach(() => {
  release?.(); fixture.state = "online"; fixture.generation = 1;
  fixture.verify.mockReset().mockImplementation(fixture.reply);
  fixture.connect.mockClear();
  db.prepare("DELETE FROM environment_projects").run();
});
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
it("scopes local binding by owner and preserves a newer binding during cleanup", () => {
  release = bindManagedWorkspace("owner", "native");
  expect(managedWorkspace("other")).toBeUndefined();
  const newer = bindManagedWorkspace("owner", "new");
  release();
  expect(managedWorkspace("owner")?.host_id).toBe("new");
  newer();
  expect(managedWorkspace("owner")).toBeUndefined();
});
it("registers four managed flavors with their required billing policy", async () => {
  release = bindManagedWorkspace("owner", "native");
  for (const flavor of ["codex", "claude", "opencode", "pi"] as const) {
    expect(await enableManagedWorkspace("owner", flavor, "project", "/project", flavor === "pi" ? "existing" : "subscription")).toEqual({ id: "managed-connection", backend: "hapi" });
    expect(fixture.connect).toHaveBeenLastCalledWith(expect.objectContaining({ owner_id: "owner", host_id: "native" }), flavor);
  }
  expect(db.prepare("SELECT canonical_path FROM environment_projects").get()).toEqual({ canonical_path: "/project" });
});
it("falls back only without an online binding, never on billing or worker failure", async () => {
  expect(await enableManagedWorkspace("owner", "codex", "project", "/project", "existing")).toBeUndefined();
  release = bindManagedWorkspace("owner", "native");
  fixture.state = "offline";
  expect(await enableManagedWorkspace("owner", "codex", "project", "/project", "existing")).toBeUndefined();
  fixture.state = "online";
  await expect(enableManagedWorkspace("owner", "codex", "project", "/project", "existing")).rejects.toThrow(/billing/);
  fixture.verify.mockRejectedValueOnce(new Error("runner unavailable"));
  await expect(enableManagedWorkspace("owner", "codex", "project", "/project", "subscription")).rejects.toThrow(/unavailable/);
  expect(fixture.connect).not.toHaveBeenCalled();
});
it("refuses a generation change during project verification", async () => {
  release = bindManagedWorkspace("owner", "native");
  fixture.verify.mockImplementation(async (e, path) => {
    if (path === "/runtimes") return fixture.reply(e, path);
    fixture.generation++; return { path: "/project" };
  });
  await expect(enableManagedWorkspace("owner", "pi", "project", "/project", "existing")).rejects.toThrow(/changed/);
  expect(fixture.connect).not.toHaveBeenCalled();
  expect(db.prepare("SELECT * FROM environment_projects").all()).toEqual([]);
});

it("uses only the bound runner inventory and preserves unknown authentication", async () => {
  expect(await managedWorkspaceInventory("owner")).toBeUndefined();
  release = bindManagedWorkspace("owner", "native");
  fixture.verify.mockResolvedValueOnce({ runtimes: [
    { flavor: "opencode", installed: true, authentication: "signed_in", executable: "/private/bin" },
    { flavor: "pi", installed: true, authentication: "unexpected" },
  ] } as any);
  const items = await managedWorkspaceInventory("owner");
  expect(fixture.verify).toHaveBeenLastCalledWith(expect.objectContaining({ host_id: "native" }), "/runtimes");
  expect(items).toHaveLength(2);
  expect(items?.find((r) => r.name === "opencode")).toMatchObject({ backend: "hapi", environmentId: "native", generation: 1, billing: "subscription", authentication: "signed_in" });
  expect(items?.find((r) => r.name === "pi")).toMatchObject({ billing: "existing", authentication: "unknown" });
  expect(items?.find((r) => r.name === "codex")).toBeUndefined();
  expect(JSON.stringify(items)).not.toContain("/private/bin");
});
it("rejects inventory collected across runner replacement", async () => {
  release = bindManagedWorkspace("owner", "native");
  fixture.verify.mockImplementationOnce(async () => { fixture.generation++; return { runtimes: [] } as any; });
  await expect(managedWorkspaceInventory("owner")).rejects.toThrow(/changed/);
});

it("refuses Enable when the local binding is replaced during project verification", async () => {
  release = bindManagedWorkspace("owner", "native");
  const originalRelease = release;
  fixture.verify.mockImplementation(async (e, path) => {
    if (path === "/runtimes") return fixture.reply(e, path);
    release = bindManagedWorkspace("owner", "replacement");
    originalRelease();
    return { path: "/project" };
  });
  await expect(enableManagedWorkspace("owner", "pi", "project", "/project", "existing")).rejects.toThrow(/changed/);
  expect(fixture.connect).not.toHaveBeenCalled();
  expect(db.prepare("SELECT * FROM environment_projects").all()).toEqual([]);
});
it("refuses Enable when the local runner is released during project verification", async () => {
  release = bindManagedWorkspace("owner", "native");
  fixture.verify.mockImplementation(async (e, path) => {
    if (path === "/runtimes") return fixture.reply(e, path);
    release?.();
    return { path: "/project" };
  });
  await expect(enableManagedWorkspace("owner", "pi", "project", "/project", "existing")).rejects.toThrow(/changed/);
  expect(fixture.connect).not.toHaveBeenCalled();
  expect(db.prepare("SELECT * FROM environment_projects").all()).toEqual([]);
});
