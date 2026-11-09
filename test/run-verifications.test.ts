import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-verification-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");

const { db, id, now } = await import("../src/server/db");
const { ownedRun } = await import("../src/server/domain");
const { observeCompletedOutput, runVerifications } =
  await import("../src/server/run-verifications");
const { classifyVerification, summarize } =
  await import("../src/shared/verification");
const { shellWords, createdPullRequest } =
  await import("../src/shared/pr-command");
import type { Run } from "../src/server/queue";
import type { OutputData } from "../src/shared/agent-activities";

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const owner = "owner";
const agent = "verifying-agent";
const folder = id();
const otherFolder = id();
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'Fixture','fixture','codex','fixture',0)",
).run(agent, owner);
for (const [f, name] of [
  [folder, "Repo"],
  [otherFolder, "Other"],
])
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project',?,0)",
  ).run(f, owner, name);

function runFixture(conversation: string): Run {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Thread',?,0)",
  ).run(conversation, owner, agent, folder);
  const runId = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Check things','running',?,'{}',?,?)",
  ).run(runId, owner, agent, conversation, runId, now(), now());
  return ownedRun(runId, owner);
}
function output(
  command: string,
  overrides: Partial<OutputData> = {},
  text = "ok\n",
): OutputData {
  return {
    command,
    chunks: [{ stream: "combined", text, index: 0 }],
    streams: "combined",
    status: "exited",
    exitCode: 0,
    truncated: { droppedBytes: 0, droppedChunks: 0, floor: 0 },
    nextIndex: 1,
    pending: [],
    ...overrides,
  };
}

it("recognises test, type-check and lint commands, and nothing else", () => {
  const tools = (command: string) =>
    classifyVerification(command).map((c) => `${c.kind}:${c.tool}`);
  expect(tools("npm test")).toEqual(["test:npm test"]);
  expect(tools("npm run typecheck")).toEqual(["typecheck:npm run typecheck"]);
  expect(tools("npm run test:unit -- --maxWorkers=1")).toEqual([
    "test:npm run test:unit",
  ]);
  expect(tools("pnpm lint")).toEqual([]);
  expect(tools("pnpm run lint")).toEqual(["lint:pnpm run lint"]);
  expect(tools("yarn test")).toEqual(["test:yarn test"]);
  expect(tools("npx vitest run test/feed.test.ts")).toEqual(["test:vitest"]);
  expect(tools("CI=1 vitest run")).toEqual(["test:vitest"]);
  expect(tools("cd packages/web && npm run typecheck && npm test")).toEqual([
    "typecheck:npm run typecheck",
    "test:npm test",
  ]);
  expect(tools('bash -c "pytest -q tests/test_api.py"')).toEqual([
    "test:pytest",
  ]);
  expect(tools("python -m pytest")).toEqual(["test:pytest"]);
  expect(tools("python3 -m mypy src")).toEqual(["typecheck:mypy"]);
  expect(tools("go test ./...")).toEqual(["test:go test"]);
  expect(tools("cargo clippy -- -D warnings")).toEqual(["lint:cargo clippy"]);
  expect(tools("node --test test/")).toEqual(["test:node --test"]);
  expect(tools("bundle exec rspec spec/models")).toEqual(["test:rspec"]);
  expect(tools("make lint")).toEqual(["lint:make lint"]);
  expect(tools("prettier --check .")).toEqual(["lint:prettier --check"]);
  expect(tools("tsc --noEmit")).toEqual(["typecheck:tsc"]);
  expect(tools("./node_modules/.bin/eslint src")).toEqual(["lint:eslint"]);
  // Not verification, or not a literal chain Loop can read.
  expect(tools("npm install")).toEqual([]);
  expect(tools("npm run build")).toEqual([]);
  expect(tools("git status")).toEqual([]);
  expect(tools("npm test | tail -5")).toEqual([]);
  expect(tools("npm test || true")).toEqual([]);
  expect(tools("npm test; echo done")).toEqual([]);
  expect(tools("$RUNNER test")).toEqual([]);
  // Separate lines are separate commands; a syntax check runs nothing.
  expect(tools("npm test\ntrue")).toEqual([]);
  expect(tools("bash -nc 'npm test'")).toEqual([]);
  expect(tools("bash -ec 'npm test'")).toEqual(["test:npm test"]);
  // A chain that can end before its checks, and tools asked to check nothing.
  expect(tools("exit 0 && npm test")).toEqual([]);
  expect(tools("npm test && exec bash")).toEqual([]);
  expect(tools("tsc --version")).toEqual([]);
  expect(tools("eslint --help")).toEqual([]);
  expect(tools("npx playwright install")).toEqual([]);
  expect(tools("vitest --dry-run")).toEqual([]);
  expect(tools("X=1 exit 0 && npm test")).toEqual([]);
  expect(tools("make -n test")).toEqual([]);
  expect(tools("make --dry-run test")).toEqual([]);
  expect(tools("cargo test --no-run")).toEqual([]);
  expect(tools("make test")).toEqual(["test:make test"]);
  // A command long enough to have been cut by the reporting adapter.
  expect(tools("npm test" + " ".repeat(2500) + "|| true")).toEqual([]);
  expect(tools("npm test" + " ".repeat(2500))).toEqual([]);
  // The wrapper's script is parsed as strictly as a bare command.
  expect(tools("bash -c 'npm test\ntrue'")).toEqual([]);
  expect(tools("bash -c 'set -n && npm test'")).toEqual([]);
  expect(tools("bash -c 'set -o noexec && npm test'")).toEqual([]);
  expect(tools("set -euo pipefail && npm test")).toEqual(["test:npm test"]);
  // Multipurpose tools need their test subcommand; executors are seen through.
  expect(tools("npx playwright install-deps")).toEqual([]);
  expect(tools("npx playwright test e2e/")).toEqual(["test:playwright test"]);
  expect(tools("cypress open")).toEqual([]);
  expect(tools("cypress run")).toEqual(["test:cypress run"]);
  expect(tools("pnpm dlx vitest run")).toEqual(["test:vitest"]);
  expect(tools("npx --yes vitest run")).toEqual(["test:vitest"]);
  expect(tools("npm run test --if-present")).toEqual([]);
  expect(tools("go test -c ./pkg")).toEqual([]);
  expect(tools("bash -c 'builtin exit 0 && npm test'")).toEqual([]);
  expect(tools("command exit 0 && npm test")).toEqual([]);
});

it("keeps pull request detection as lenient as before", () => {
  expect(shellWords("cd repo &&\ngh pr create")).toEqual([
    "cd",
    "repo",
    null,
    "gh",
    "pr",
    "create",
  ]);
  expect(
    shellWords("cd repo &&\ngh pr create", { strict: true }),
  ).toBeUndefined();
  expect(
    createdPullRequest(
      "bash -uc 'gh pr create'",
      "https://github.com/o/r/pull/7",
    ),
  ).toMatchObject({ number: 7 });
});

it("keeps one observation per invocation when a later update brings the exit", () => {
  const run = runFixture("thread-dedupe");
  observeCompletedOutput(
    run,
    output("npm test", { status: "unknown", exitCode: undefined }, "running…"),
    () => true,
    null,
    "rec-1",
  );
  observeCompletedOutput(
    run,
    output("npm test", {}, "12 passed\n"),
    () => true,
    null,
    "rec-1",
  );
  observeCompletedOutput(
    run,
    output("npm test", {}, "12 passed\n"),
    () => true,
    null,
    "rec-2",
  );
  const items = runVerifications(owner, run.id);
  expect(items.map((i) => i.status)).toEqual(["passed", "passed"]);
  expect(items[0].output_tail).toBe("12 passed\n");
  expect(summarize(runVerifications(owner, run.id))).toMatchObject({
    passed: 2,
    unknown: 0,
  });
});

it("records the exit Loop saw, including failures, unknown exits and cut output", () => {
  const run = runFixture("thread-exits");
  observeCompletedOutput(run, output("npm test", {}, "12 passed\n"));
  observeCompletedOutput(
    run,
    output(
      "npx tsc --noEmit",
      { exitCode: 2 },
      "src/a.ts(3,1): error TS2322\n",
    ),
  );
  observeCompletedOutput(
    run,
    output("eslint src", { status: "failed", exitCode: undefined }, ""),
  );
  observeCompletedOutput(
    run,
    output("pytest", { unavailable: "terminal output not retained" }, ""),
  );
  observeCompletedOutput(
    run,
    output(
      "go test ./...",
      { truncated: { droppedBytes: 5000, droppedChunks: 2, floor: 0 } },
      "x".repeat(4000),
    ),
  );
  // Not verification, still running, or from a stale session: never recorded.
  observeCompletedOutput(run, output("npm install"));
  observeCompletedOutput(
    run,
    output("vitest", { status: "running", exitCode: undefined }),
  );
  observeCompletedOutput(run, output("vitest"), () => false);
  const items = runVerifications(owner, run.id);
  expect(
    items.map((i) => [i.tools.join(","), i.status, i.exit_code, i.truncated]),
  ).toEqual([
    ["npm test", "passed", 0, false],
    ["tsc", "failed", 2, false],
    ["eslint", "unknown", null, false],
    ["pytest", "passed", 0, false],
    ["go test", "passed", 0, true],
  ]);
  expect(items[1].output_tail).toContain("error TS2322");
  expect(items[3].output_tail).toBeNull();
  expect(items[4].output_tail!.length).toBe(1500);
  const summary = summarize(runVerifications(owner, run.id))!;
  expect(summary).toMatchObject({ passed: 3, failed: 1, unknown: 1 });
});

it("gives a chain one exit shared by its tools, and only trusts a zero exit", () => {
  const run = runFixture("thread-chain");
  observeCompletedOutput(run, output("npm run typecheck && npm test"));
  // A nonzero exit from a chain says nothing about which step failed, or
  // whether the checks ran at all.
  observeCompletedOutput(
    run,
    output("npm run typecheck && npm test", { exitCode: 1 }),
  );
  observeCompletedOutput(
    run,
    output("cd missing-directory && npm test", { exitCode: 1 }),
  );
  // A reported nonzero exit is a failure whatever status word accompanies it.
  observeCompletedOutput(
    run,
    output("npm test", { status: "failed", exitCode: 1 }),
  );
  const items = runVerifications(owner, run.id);
  expect(items.map((i) => [i.tools, i.status, i.exit_code])).toEqual([
    [["npm run typecheck", "npm test"], "passed", 0],
    [["npm run typecheck", "npm test"], "unknown", 1],
    [["npm test"], "unknown", 1],
    [["npm test"], "failed", 1],
  ]);
});
