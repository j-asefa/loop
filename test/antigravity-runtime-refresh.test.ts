import { testDirectory } from "./helpers/test-workspace.js";
import { seedConnection } from "./helpers/seed.js";
import { afterAll, expect, it } from "vitest";
import { resolve } from "node:path";

const root = testDirectory();
const { db } = await import("../src/server/db");
const { OWNER } = await import("../src/server/workspace-identity");
const { createAgent, ownedConnection } = await import("../src/server/domain");
const { createPresetTeam } = await import("../src/server/teams");
const { setFeedPreferences } = await import("../src/server/news");
const { nativeBindings } = await import("../src/server/native-tools");
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

it("keeps native Loop MCP tool definitions compact so Antigravity loads them eagerly", () => {
  seedConnection(db, {
    id: "compact-conn",
    owner_id: OWNER,
    provider: "openai",
    label: "Compact fixture",
    secret: "",
    status: "connected",
    models: JSON.stringify([{ id: "m1", name: "M1" }]),
    metadata: "{}",
    created_at: 0,
  });
  const folder = nativeSessions.projects.addProject(root, "Compact").id;
  const agent = createAgent(OWNER, {
    name: "compact-worker",
    connectionId: "compact-conn",
    model: "m1",
  });
  createPresetTeam(OWNER, {
    presetId: "code-review",
    name: "Exhibit review team",
    folderId: folder,
    selection: { connectionId: "compact-conn", model: "m1" },
    idempotencyKey: "compact-review-1",
  });
  createPresetTeam(OWNER, {
    presetId: "code-review",
    name: "Loop review team",
    folderId: folder,
    selection: { connectionId: "compact-conn", model: "m1" },
    idempotencyKey: "compact-review-2",
  });
  setFeedPreferences(OWNER, { agent_access: true });
  const bindings = nativeBindings(
    {
      id: "compact-run",
      owner_id: OWNER,
      agent_id: agent.id,
      payload: {},
    } as any,
    { plans: true },
  );
  const byName = Object.fromEntries(
    bindings.map((b) => [
      b.name,
      Buffer.byteLength(
        JSON.stringify({
          name: b.name,
          description: b.description,
          parameters: b.inputSchema,
        }),
      ),
    ]),
  );
  expect(Object.keys(byName)).toEqual(
    expect.arrayContaining([
      "loop_publish_file",
      "loop_request_review",
      "loop_agents",
      "loop_message",
      "loop_handoff",
      "loop_read_file",
      "loop_reply",
      "loop_feed",
    ]),
  );
  for (const [name, bytes] of Object.entries(byName)) {
    expect(bytes, `${name} serialized to ${bytes} bytes`).toBeLessThan(900);
  }
  for (const binding of bindings) {
    const text = JSON.stringify(binding.inputSchema);
    expect(text).not.toContain('"$schema"');
    expect(text).not.toContain('"additionalProperties"');
    expect(text).not.toContain("ffffffff-ffff-ffff-ffff-ffffffffffff");
  }
});
