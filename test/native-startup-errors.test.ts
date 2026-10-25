import { gitProject } from "./git-project.js";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-native-startup-")));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = dir;
gitProject(dir);
const { db } = await import("../src/server/db");
db.prepare("INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('worktree-fixture','local-workspace','Fixture','fixture','codex','fixture',0)").run();
const { enqueue } = await import("../src/server/queue");
const { tick, execute } = await import("../src/server/worker");
const { nativeSessions } = await import("../src/server/native-sessions");
const executable = resolve("test/harness.mjs");
chmodSync(executable, 0o755);
const options = {
  harness: "pi",
  executable,
  project: dir,
  billing: "subscription",
  version: "fixture",
};
db.prepare("INSERT INTO harnesses VALUES('pi',?,'{}','{}','[]',0)").run(
  JSON.stringify(options),
);
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('native-pi','local-workspace','pi','Pi','','connected','[]',?,0)",
).run(JSON.stringify({ loopHarness: "pi" }));

afterEach(() => {
  delete process.env.LOOP_TEST_HARNESS;
  delete process.env.LOOP_TEST_PI_AUTH;
  delete process.env.LOOP_TEST_AUDIT;
});
afterAll(async () => {
  await nativeSessions.close();
  db.close();
  delete process.env.LOOP_PROFILE;
  rmSync(dir, { recursive: true, force: true });
});

it("preserves safe subscription setup guidance through the real worker and trace boundary without dispatch", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  process.env.LOOP_TEST_PI_AUTH = "api";
  const audit = join(dir, "prompts.log");
  process.env.LOOP_TEST_AUDIT = audit;
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('startup','local-workspace','Setup test',0)",
  ).run();
  const run = enqueue(
    "local-workspace",
    "What folders can you access?",
    "startup",
    {
      conversation: "startup", agent: "worktree-fixture",
      payload: {
        agentId: "worktree-fixture", name: "Fixture", provider: "pi", folderId: null,
        connectionId: "native-pi",
        model: "openai/fixture",
        instructions: "",
      },
    },
  );
  expect(await tick(execute)).toBe(true);
  const result = db
    .prepare("SELECT state,error FROM runs WHERE id=?")
    .get(run.id) as any;
  expect(result.state).toBe("failed");
  expect(result.error).toContain("subscription login");
  expect(result.error).toContain("openai-codex");
  expect(result.error).toContain(
    "No prompt was sent and no API fallback occurred",
  );
  const trace = db
    .prepare(
      "SELECT content,metadata FROM run_traces WHERE run_id=? AND trace_key='run:failure'",
    )
    .get(run.id) as any;
  expect(trace.content).toBe(result.error);
  expect(JSON.parse(trace.metadata).failure).toMatchObject({
    phase: "native startup",
    code: "native_billing_mismatch",
  });
  expect(
    db
      .prepare(
        "SELECT state FROM companion_sessions WHERE conversation_id='startup'",
      )
      .get(),
  ).toEqual({ state: "failed" });
  expect(
    db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toBeUndefined();
  expect(existsSync(audit)).toBe(false);
});

it("also returns safe setup guidance when enabling Pi", async () => {
  process.env.LOOP_TEST_HARNESS = "pi";
  process.env.LOOP_TEST_PI_AUTH = "api";
  await expect(nativeSessions.enable(options as any)).rejects.toMatchObject({
    status: 422,
    diagnostic: { phase: "native startup", code: "native_billing_mismatch" },
  });
});
