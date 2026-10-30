import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { testEnvironment } from "../test-runner.mjs";
test("test child cannot inherit live Loop state, credentials or memory policy", () => {
  const inherited = {
    ...process.env,
    LOOP_PROFILE: "companion",
    LOOP_DATA_DIR: "/live-user-state",
    LOOP_MEMORY_ENABLED: "0",
    LOOP_HAPI_TOKEN: "private-fixture",
    LOOP_DAEMON_CHILD: "1",
    LOOP_TEST_STOP_WAIT_MS: "10",
    LOOP55_HOME: "/live-user-home",
    LOOP55_DATA_DIR: "/live-user-state",
    LOOP55_ENCRYPTION_KEY: "private-fixture",
    LOOP55_TEST_STOP_WAIT_MS: "20",
    BETTER_AUTH_SECRET: "private-auth-fixture",
  };
  for (const suite of ["vitest", "native"]) {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^LOOP(?:55)?_/.test(k)||k==="BETTER_AUTH_SECRET"))))',
      ],
      { env: testEnvironment(inherited, suite), encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    const actual = JSON.parse(result.stdout);
    assert.equal(
      actual.LOOP_PROFILE,
      suite === "vitest" ? "server" : undefined,
    );
    assert.equal(actual.LOOP_TEST_STOP_WAIT_MS, "10");
    assert.equal(actual.LOOP55_TEST_STOP_WAIT_MS, "20");
    for (const key of [
      "LOOP_DATA_DIR",
      "LOOP_MEMORY_ENABLED",
      "LOOP_HAPI_TOKEN",
      "LOOP_DAEMON_CHILD",
      "LOOP55_HOME",
      "LOOP55_DATA_DIR",
      "LOOP55_ENCRYPTION_KEY",
      "BETTER_AUTH_SECRET",
    ])
      assert.equal(actual[key], undefined);
  }
  assert.equal(
    inherited.LOOP_MEMORY_ENABLED,
    "0",
    "parent environment remains unchanged",
  );
});
