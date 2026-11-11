// The repository's convention gate: formatting, types, source boundaries and
// API contracts. Steps run in order and stop at the first failure. It is not the
// full test suite; run the checks for the boundary you changed as well.
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSupervised } from "./heavy-command.mjs";
import { testEnvironment } from "./test-runner.mjs";

// Paths below are relative to the repository root, wherever this is run from.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const tests = [
  "test/source-boundaries.test.ts",
  "test/sql-inventory.test.ts",
  "test/migration-policy.test.ts",
  "test/row-schema-columns.test.ts",
  "test/format-policy.test.ts",
  "test/legacy-routes.test.ts",
  "test/workspace-event-contract.test.ts",
  ...globSync("test/*-contracts.test.ts").sort(),
];
const formatted = "{src,test,scripts}/**/*.{ts,tsx,js,jsx,mjs,cjs}";
const steps = [
  ["assets", ["scripts/package-files.mjs"]],
  ["format", ["node_modules/prettier/bin/prettier.cjs", "--check", formatted]],
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
    testEnvironment(process.env),
  ],
];

// A renamed test would otherwise drop out silently: Vitest runs whatever
// matches and ignores the rest.
for (const test of tests)
  if (!existsSync(test)) {
    console.error(`check: ${test} does not exist; update scripts/check.mjs`);
    process.exit(1);
  }

// A worktree without npm ci would otherwise fail with an unrelated error,
// or pass against another checkout's tools.
for (const tool of ["prettier", "typescript", "tsx", "vitest", "rolldown"])
  if (!existsSync(`node_modules/${tool}/package.json`)) {
    console.error(`check: node_modules/${tool} is missing; run npm ci first`);
    process.exit(1);
  }

const pinnedPrettier = JSON.parse(readFileSync("package.json", "utf8"))
  .devDependencies.prettier;
const installedPrettier = JSON.parse(
  readFileSync("node_modules/prettier/package.json", "utf8"),
).version;
if (installedPrettier !== pinnedPrettier) {
  console.error(
    `check: Prettier ${pinnedPrettier} is required, found ${installedPrettier}; run npm ci first`,
  );
  process.exit(1);
}

for (const [name, args, env = process.env] of steps) {
  const started = Date.now();
  console.log(`check: ${name}`);
  const status = await runSupervised(process.execPath, args, {
    label: `check ${name}`,
    stdio: "inherit",
    env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (status !== 0) {
    console.error(`check: ${name} failed (${status}) after ${seconds} s`);
    // Preserve the failing phase's status; earlier phases may have run.
    process.exit(status ?? 1);
  }
  console.log(`check: ${name} passed in ${seconds} s`);
}
console.log("check: all passed");
