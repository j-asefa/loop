import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-verification-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");

const { db, id, now } = await import("../src/server/db");
const {
  observeCompletedOutput,
  runVerifications,
  verificationSummary,
  verificationLines,
  verificationById,
  verificationContent,
} = await import("../src/server/run-verifications");
const { classifyVerification, verificationLine } = await import("../src/shared/verification");
const { resolveCite, checkQuote } = await import("../src/server/briefs/cites");
import type { Run } from "../src/server/queue";
import type { OutputData } from "../src/agent-activities";

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
for (const [f, name] of [[folder, "Repo"], [otherFolder, "Other"]])
  db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project',?,0)").run(f, owner, name);

function runFixture(conversation: string): Run {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Thread',?,0)",
  ).run(conversation, owner, agent, folder);
  const runId = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Check things','running',?,'{}',?,?)",
  ).run(runId, owner, agent, conversation, runId, now(), now());
  return db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Run;
}
function output(command: string, overrides: Partial<OutputData> = {}, text = "ok\n"): OutputData {
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
  const tools = (command: string) => classifyVerification(command).map((c) => `${c.kind}:${c.tool}`);
  expect(tools("npm test")).toEqual(["test:npm test"]);
  expect(tools("npm run typecheck")).toEqual(["typecheck:npm run typecheck"]);
  expect(tools("npm run test:unit -- --maxWorkers=1")).toEqual(["test:npm run test:unit"]);
  expect(tools("pnpm lint")).toEqual([]);
  expect(tools("pnpm run lint")).toEqual(["lint:pnpm run lint"]);
  expect(tools("yarn test")).toEqual(["test:yarn test"]);
  expect(tools("npx vitest run test/feed.test.ts")).toEqual(["test:vitest"]);
  expect(tools("CI=1 vitest run")).toEqual(["test:vitest"]);
  expect(tools("cd packages/web && npm run typecheck && npm test")).toEqual([
    "typecheck:npm run typecheck",
    "test:npm test",
  ]);
  expect(tools('bash -c "pytest -q tests/test_api.py"')).toEqual(["test:pytest"]);
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
});

it("records the exit Loop saw, including failures, unknown exits and cut output", () => {
  const run = runFixture("thread-exits");
  observeCompletedOutput(run, output("npm test", {}, "12 passed\n"));
  observeCompletedOutput(run, output("npx tsc --noEmit", { exitCode: 2 }, "src/a.ts(3,1): error TS2322\n"));
  observeCompletedOutput(run, output("eslint src", { status: "failed", exitCode: undefined }, ""));
  observeCompletedOutput(run, output("pytest", { unavailable: "terminal output not retained" }));
  observeCompletedOutput(
    run,
    output("go test ./...", { truncated: { droppedBytes: 5000, droppedChunks: 2, floor: 0 } }, "x".repeat(4000)),
  );
  // Not verification, still running, or from a stale session: never recorded.
  observeCompletedOutput(run, output("npm install"));
  observeCompletedOutput(run, output("vitest", { status: "running", exitCode: undefined }));
  observeCompletedOutput(run, output("vitest"), () => false);
  const items = runVerifications(owner, run.id);
  expect(items.map((i) => [i.tools.join(","), i.status, i.exit_code, i.truncated])).toEqual([
    ["npm test", "passed", 0, false],
    ["tsc", "failed", 2, false],
    ["eslint", "unknown", null, false],
    ["pytest", "unknown", null, false],
    ["go test", "passed", 0, true],
  ]);
  expect(items[1].output_tail).toContain("error TS2322");
  expect(items[4].output_tail!.length).toBe(1500);
  const summary = verificationSummary(owner, run.id)!;
  expect(summary).toMatchObject({ passed: 2, failed: 1, unknown: 2 });
  expect(verificationLine(summary)).toBe("Ran npm test ✓ · tsc ✗ · eslint ? · pytest ? · go test ✓");
  expect(verificationLine(null)).toBe("No checks observed");
});

it("gives a chain one exit shared by its tools", () => {
  const run = runFixture("thread-chain");
  observeCompletedOutput(run, output("npm run typecheck && npm test", { exitCode: 1 }));
  const [item] = runVerifications(owner, run.id);
  expect(item).toMatchObject({ kind: "test", tools: ["npm run typecheck", "npm test"], status: "failed", exit_code: 1 });
  expect(verificationLine(verificationSummary(owner, run.id))).toBe("Ran npm run typecheck + npm test ✗");
});

it("is a brief citation scoped to the run's project, with the command and exit in its content", () => {
  const run = runFixture("thread-cite");
  observeCompletedOutput(run, output("npx vitest run test/feed.test.ts", {}, "3 passed\n"));
  const [item] = runVerifications(owner, run.id);
  const ref = "ver_" + item.id;
  const cite = resolveCite(owner, folder, { ref, quote: "vitest passed (exit 0)" });
  expect(cite).toMatchObject({ kind: "verification", runId: run.id, conversation: "thread-cite" });
  expect(cite!.content).toBe(verificationContent(verificationById(owner, item.id)!));
  expect(checkQuote(cite!.content, "vitest passed (exit 0)")).toBe(true);
  expect(checkQuote(cite!.content, "all tests pass")).toBe(false);
  expect(cite!.content).toContain("or that the right ones ran");
  expect(resolveCite(owner, otherFolder, { ref })).toBeNull();
  expect(resolveCite("someone-else", folder, { ref })).toBeNull();
  expect(verificationLines(owner, run.id)).toBe(`[${ref}] vitest passed (exit 0): npx vitest run test/feed.test.ts`);
  expect(verificationLines(owner, runFixture("thread-empty").id)).toBe("");
});
