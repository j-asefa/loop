// The repository's convention gate: types, source boundaries and API
// contracts. Steps run in order and stop at the first failure. It is not the
// full test suite; run the checks for the boundary you changed as well.
import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { testEnvironment } from "./test-runner.mjs";

const tests = [
  "test/source-boundaries.test.ts",
  "test/legacy-routes.test.ts",
  "test/workspace-event-contract.test.ts",
  ...globSync("test/*-contracts.test.ts").sort(),
];
const steps = [
  ["typecheck", ["scripts/typecheck.mjs"]],
  ["openapi", ["--import", "tsx", "scripts/openapi.mjs", "--check"]],
  [
    "contracts",
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--maxWorkers=2",
      // File arguments are substring filters; skip nested checkouts as
      // test-runner.mjs does.
      "--exclude",
      "**/.tmp/**",
      ...tests,
    ],
    testEnvironment(process.env, "vitest"),
  ],
];

// A worktree without npm ci would otherwise fail with an unrelated error,
// or pass against another checkout's tools.
for (const tool of ["typescript", "tsx", "vitest", "rolldown"])
  if (!existsSync(`node_modules/${tool}/package.json`)) {
    console.error(`check: node_modules/${tool} is missing; run npm ci first`);
    process.exit(1);
  }

for (const [name, args, env = process.env] of steps) {
  const started = Date.now();
  console.log(`check: ${name}`);
  const { status, signal } = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (status !== 0) {
    console.error(
      `check: ${name} failed (${signal ?? status}) after ${seconds} s`,
    );
    // Keep typecheck's "slot busy, nothing ran" status for callers that retry.
    process.exit(status ?? 1);
  }
  console.log(`check: ${name} passed in ${seconds} s`);
}
console.log("check: all passed");
