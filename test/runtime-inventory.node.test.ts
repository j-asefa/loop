import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error native worker module
import { runtimeInventory } from "../native/runtime-inventory.mjs";

test("runner inventory checks only selected executable and redacts native output", async () => {
  const calls: string[] = [];
  const result = await runtimeInventory({
    providers: ["codex"],
    binary: () => process.execPath,
    authStatus: async (flavor: string) => {
      calls.push(flavor);
      return {
        authenticated: true,
        managed: true,
        authMethod: "chatgpt",
        checkedAt: Date.now(),
        secret: "DO_NOT_RETURN",
      };
    },
  });
  assert.deepEqual(calls, ["codex"]);
  assert.equal(result.runtimes[0].installed, true);
  assert.equal(result.runtimes[0].authentication, "signed_in");
  assert.ok(!JSON.stringify(result).includes("DO_NOT_RETURN"));
  assert.ok(!JSON.stringify(result).includes(process.execPath));
});

test("missing executables skip auth and failed or stale checks stay unknown", async () => {
  let called = false;
  const missing = await runtimeInventory({
    providers: ["claude"],
    binary: () => "/missing/loop-fixture",
    authStatus: () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(missing.runtimes[0].installed, false);
  assert.equal(missing.runtimes[0].authentication, "unknown");
  for (const authStatus of [
    async () => {
      throw new Error("private output");
    },
    async () => ({
      authenticated: true,
      managed: true,
      authMethod: "claude",
      checkedAt: Date.now() - 31000,
    }),
    async () => ({
      authenticated: true,
      managed: true,
      authMethod: "api",
      checkedAt: Date.now(),
    }),
  ]) {
    const result = await runtimeInventory({
      providers: ["claude"],
      binary: () => process.execPath,
      authStatus,
    });
    assert.equal(result.runtimes[0].authentication, "unknown");
  }
});


test("OpenCode inventory requires fresh execution guard evidence for signed-in status", async () => {
  for (const [overrides, expected] of [
    [{}, "unknown"],
    [{ executionGuard: "unknown" }, "unknown"],
    [{ executionGuard: "loop-subscription-v1" }, "signed_in"],
    [{ executionGuard: "loop-subscription-v1", checkedAt: Date.now() - 31000 }, "unknown"],
    [{ executionGuard: "loop-subscription-v1", authMethod: "api" }, "unknown"],
    [{ authenticated: false }, "signed_out"],
  ] as const) {
    const result = await runtimeInventory({
      providers: ["opencode"],
      binary: () => process.execPath,
      authStatus: async (flavor: string) => {
        assert.equal(flavor, "opencode");
        return {
          authenticated: true,
          managed: true,
          authMethod: "chatgpt",
          checkedAt: Date.now(),
          ...overrides,
        };
      },
    });
    assert.equal(result.runtimes.length, 1);
    assert.equal(result.runtimes[0].flavor, "opencode");
    assert.equal(result.runtimes[0].authentication, expected);
  }
});


test("Pi inventory uses fresh existing-account evidence and honest billing", async () => {
  for (const [overrides, expected] of [
    [{}, "signed_in"],
    [{ authenticated: false }, "signed_out"],
    [{ managed: false }, "unknown"],
    [{ authMethod: "chatgpt" }, "unknown"],
    [{ checkedAt: Date.now() - 31000 }, "unknown"],
  ] as const) {
    const result = await runtimeInventory({
      providers: ["pi"],
      binary: () => process.execPath,
      authStatus: async (flavor: string) => {
        assert.equal(flavor, "pi");
        return { authenticated: true, managed: true, authMethod: "existing",
          checkedAt: Date.now(), secret: "PRIVATE_PI_METADATA", ...overrides };
      },
    });
    assert.equal(result.runtimes.length, 1);
    assert.equal(result.runtimes[0].authentication, expected);
    assert.match(result.runtimes[0].billing, /Existing billing/);
    assert.doesNotMatch(result.runtimes[0].billing, /subscription|fallback disabled/i);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_PI_METADATA"));
  }
});
