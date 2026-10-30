import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { testEnvironment } from "../test-runner.mjs";
test("test child cannot inherit live Loop55 state, credentials or memory policy", () => {
  const inherited = {
    ...process.env,
    LOOP55_PROFILE: "companion",
    LOOP55_DATA_DIR: "/live-user-state",
    LOOP55_MEMORY_ENABLED: "0",
    LOOP55_HAPI_TOKEN: "private-fixture",
    LOOP55_DAEMON_CHILD: "1",
    LOOP55_TEST_STOP_WAIT_MS: "10",
  };
  for (const suite of ["vitest", "native"]) {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("LOOP55_")))))',
      ],
      { env: testEnvironment(inherited, suite), encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    const actual = JSON.parse(result.stdout);
    assert.equal(
      actual.LOOP55_PROFILE,
      suite === "vitest" ? "server" : undefined,
    );
    assert.equal(actual.LOOP55_TEST_STOP_WAIT_MS, "10");
    for (const key of [
      "LOOP55_DATA_DIR",
      "LOOP55_MEMORY_ENABLED",
      "LOOP55_HAPI_TOKEN",
      "LOOP55_DAEMON_CHILD",
    ])
      assert.equal(actual[key], undefined);
  }
  assert.equal(
    inherited.LOOP55_MEMORY_ENABLED,
    "0",
    "parent environment remains unchanged",
  );
});
