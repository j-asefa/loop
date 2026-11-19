import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";
import { resolve } from "node:path";

const root = testDirectory();
const { db } = await import("../src/server/db");
const { OWNER } = await import("../src/server/workspace-identity");
const { ownedConnection } = await import("../src/server/domain");
const { nativeSessions } = await import("../src/server/native-sessions");
const { runtimeList, runtimeRefresh } =
  await import("../src/server/execution-runtime-actions");

const fixture = resolve("test/fixtures/fake-antigravity.mjs");

afterAll(async () => {
  delete process.env.LOOP_TEST_AGY_VERSION;
  await nativeSessions.close();
  db.close();
});

it("runtimeList surfaces version drift and runtimeRefresh rediscovers upgraded Antigravity with workspace tools", async () => {
  process.env.LOOP_TEST_AGY_VERSION = "1.5.2";
  await nativeSessions.projects.enable({
    harness: "antigravity",
    executable: fixture,
    version: "1.5.2",
    project: root,
    billing: "existing",
  });
  expect(
    ownedConnection("native-antigravity", OWNER).metadata.capabilities
      ?.workspaceTools,
  ).toBe(false);

  // Binary upgrades externally while Loop keeps the earlier registration.
  process.env.LOOP_TEST_AGY_VERSION = "1.5.12";
  const stale = await runtimeList({ fresh: true });
  expect(stale.runtimes.find((r) => r.name === "antigravity")).toMatchObject({
    installed: true,
    available: true,
    enabled: true,
    version: "1.5.12",
    registeredVersion: "1.5.2",
    workspaceTools: false,
  });

  // Refreshing the connection rediscovers the installed binary version and
  // upgrades saved capabilities to enable workspace tools.
  const refreshed = await runtimeRefresh({
    connectionId: "native-antigravity",
  });
  expect(refreshed.capabilities.workspaceTools).toBe(true);
  expect(
    nativeSessions.projects.savedRegistration("antigravity")?.version,
  ).toBe("1.5.12");
  expect(
    ownedConnection("native-antigravity", OWNER).metadata.capabilities
      ?.workspaceTools,
  ).toBe(true);
  expect(() => ownedConnection("native-antigravity", "other-owner")).toThrow();

  const updated = await runtimeList({ fresh: true });
  expect(updated.runtimes.find((r) => r.name === "antigravity")).toMatchObject({
    installed: true,
    available: true,
    enabled: true,
    version: "1.5.12",
    registeredVersion: "1.5.12",
    workspaceTools: true,
  });
});

it("runtimeRefresh preserves legacy 1.4.9 Antigravity registrations whose binary has not upgraded", async () => {
  process.env.LOOP_TEST_AGY_VERSION = "1.4.9";
  await nativeSessions.projects.enable({
    harness: "antigravity",
    executable: fixture,
    version: "1.4.9",
    project: root,
    billing: "existing",
  });
  const refreshed = await runtimeRefresh({
    connectionId: "native-antigravity",
  });
  expect(refreshed.capabilities.workspaceTools).toBe(false);
  expect(
    nativeSessions.projects.savedRegistration("antigravity")?.version,
  ).toBe("1.4.9");
});

it("runtimeRefresh refuses an unsupported downgraded binary without overwriting the saved registration", async () => {
  process.env.LOOP_TEST_AGY_VERSION = "1.5.12";
  await nativeSessions.projects.enable({
    harness: "antigravity",
    executable: fixture,
    version: "1.5.12",
    project: root,
    billing: "existing",
  });
  process.env.LOOP_TEST_AGY_VERSION = "1.4.9";
  await expect(
    runtimeRefresh({ connectionId: "native-antigravity" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    nativeSessions.projects.savedRegistration("antigravity")?.version,
  ).toBe("1.5.12");
  expect(
    ownedConnection("native-antigravity", OWNER).metadata.capabilities
      ?.workspaceTools,
  ).toBe(true);
});
