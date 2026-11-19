import { seedAgent, seedConnection } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { ProviderSchema } from "../src/shared/provider-schema";
import { until } from "./helpers/wait.js";
import { prepareAgentWorkspace } from "../src/server/agent-worktree.js";
import { gitProject } from "./helpers/git-project.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { realpathSync, readFileSync, existsSync } from "node:fs";

import { join, resolve } from "node:path";

const dir = realpathSync(testDirectory());

gitProject(dir);
const { db, changes } = await import("../src/server/db");
seedAgent(db, {
  id: "worktree-fixture",
  owner_id: "local-workspace",
  name: "Fixture",
  normalized_name: "fixture",
  provider: "codex",
  model: "fixture",
  created_at: 0,
});
const { enqueue } = await import("../src/server/queue");
const { tick, execute } = await import("../src/server/worker");
const { nativeSessions } = await import("../src/server/native-sessions");
for (const harness of ["claude", "codex"]) {
  db.prepare("INSERT INTO harnesses VALUES(?,?,'{}','{}','[]',0)").run(
    harness,
    JSON.stringify({
      harness,
      executable: resolve("test/harness.mjs"),
      project: dir,
      billing: "existing",
      version: "fixture",
    }),
  );
  seedConnection(db, {
    id: `native-${harness}`,
    owner_id: "local-workspace",
    provider: harness === "claude" ? "anthropic" : "codex",
    label: harness,
    secret: "",
    models: "[]",
    metadata: JSON.stringify({ loopHarness: harness }),
    created_at: 0,
  });
}
afterEach(() => {
  delete process.env.LOOP_TEST_HARNESS;
  delete process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS;
  delete process.env.LOOP_TEST_CODEX_WRITER_BUSY;
  delete process.env.LOOP_TEST_AUDIT;
});
afterAll(async () => {
  await nativeSessions.close();
  db.close();
});
function submit(conversation: string, harness: string, key: string) {
  db.prepare(
    "INSERT OR IGNORE INTO conversations(id,owner_id,title,created_at) VALUES(?,'local-workspace','Recovery',0)",
  ).run(conversation);
  return enqueue("local-workspace", "Check the review", key, {
    conversation,
    agent: "worktree-fixture",
    payload: {
      agentId: "worktree-fixture",
      name: "Fixture",
      provider: ProviderSchema.parse(
        harness === "claude" ? "anthropic" : harness,
      ),
      folderId: null,
      connectionId: `native-${harness}`,
      model: "fixture",
      instructions: "",
    },
  });
}

it("keeps the user run open across injected Claude results and saves its actual final reply", async () => {
  process.env.LOOP_TEST_HARNESS = "claude";
  process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS = "1";
  const audit = join(dir, "claude-prompts");
  process.env.LOOP_TEST_AUDIT = audit;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = submit("claude-recovery", "claude", "claude-recovery");
  expect(await tick(execute)).toBe(true);
  // Ignoring a result is what keeps the run open, so it can also be what
  // leaves a run open forever if Claude relabels real user turns. Every drop
  // names its reason: a stalled turn has no other symptom to go on.
  const dropped = warn.mock.calls.map(([line]) => String(line));
  warn.mockRestore();
  for (const reason of [
    'origin.kind="task-notification" is not human',
    'origin.kind="peer" is not human',
    'origin.kind="channel" is not human',
    'origin.kind="future-origin" is not human',
    "it belongs to a different native session",
    "it belongs to a child tool session",
  ])
    expect(
      dropped.filter((line) => line.includes(reason)).length,
    ).toBeGreaterThan(0);
  expect(
    db.prepare("SELECT state,result,error FROM runs WHERE id=?").get(run.id),
  ).toEqual({ state: "completed", result: "Fixture done", error: null });
  expect(
    db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND role='assistant'",
      )
      .get(run.id),
  ).toEqual({ content: "Fixture done" });
  expect(
    db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND update_key IS NOT NULL AND json_extract(metadata,'$.final')=1",
      )
      .get(run.id),
  ).toEqual({ content: "Fixture done" });
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM native_items WHERE conversation_id=? AND run_id IS NULL",
      )
      .get("claude-recovery"),
  ).toEqual({ n: 0 });
  expect(readFileSync(audit, "utf8")).toBe("prompt\n");
});

it("reports a Codex writer conflict without dispatch, takeover or raw native error disclosure", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  process.env.LOOP_TEST_CODEX_WRITER_BUSY = "1";
  const audit = join(dir, "codex-prompts");
  process.env.LOOP_TEST_AUDIT = audit;
  const run = submit("codex-busy", "codex", "codex-busy");
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,native_id,state,updated_at,generation,worktree_source,worktree_agent_id) VALUES(?,'codex',?,'private-native-thread','idle',0,'old',?,'worktree-fixture')",
  ).run(
    "codex-busy",
    (
      await prepareAgentWorkspace(dir, dir, {
        ownerId: "local-workspace",
        agentId: "worktree-fixture",
        environmentId: dir,
        projectId: dir,
      })
    ).directory,
    dir,
  );
  expect(await tick(execute)).toBe(true);
  const result = db
    .prepare("SELECT state,error FROM runs WHERE id=?")
    .get(run.id) as any;
  expect(result.state).toBe("failed");
  expect(result.error).toContain("in use by another Codex client");
  expect(result.error).toContain("No prompt was sent");
  expect(result.error).not.toContain("private-native-thread");
  expect(
    db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toBeUndefined();
  expect(existsSync(audit)).toBe(false);
  const trace = db
    .prepare(
      "SELECT metadata FROM run_traces WHERE run_id=? AND trace_key='run:failure'",
    )
    .get(run.id) as any;
  expect(JSON.parse(trace.metadata).failure).toMatchObject({
    phase: "native startup",
    code: "native_session_in_use",
  });
  expect(
    db
      .prepare(
        "SELECT native_id FROM companion_sessions WHERE conversation_id='codex-busy'",
      )
      .get(),
  ).toEqual({ native_id: "private-native-thread" });
  // Once its other owner releases it, only an explicit new request resumes
  // that same conversation. The rejected posting request is never replayed.
  delete process.env.LOOP_TEST_CODEX_WRITER_BUSY;
  const retry = submit("codex-busy", "codex", "codex-explicit-retry");
  expect(await tick(execute)).toBe(true);
  expect(
    db.prepare("SELECT state,result FROM runs WHERE id=?").get(retry.id),
  ).toEqual({ state: "completed", result: "Fixture done" });
  expect(readFileSync(audit, "utf8")).toBe("prompt\n");
});

it("recognises a reworded Codex writer conflict instead of leaking the native error", async () => {
  process.env.LOOP_TEST_HARNESS = "codex";
  // Loop does not own this message, so it matches the phrase rather than the
  // exact sentence: a prefix or suffix upstream must not drop the person back
  // to the raw native error.
  process.env.LOOP_TEST_CODEX_WRITER_BUSY = "reworded";
  const audit = join(dir, "codex-reworded-prompts");
  process.env.LOOP_TEST_AUDIT = audit;
  const run = submit("codex-reworded", "codex", "codex-reworded");
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,native_id,state,updated_at,generation,worktree_source,worktree_agent_id) VALUES(?,'codex',?,'other-native-thread','idle',0,'old',?,'worktree-fixture')",
  ).run(
    "codex-reworded",
    (
      await prepareAgentWorkspace(dir, dir, {
        ownerId: "local-workspace",
        agentId: "worktree-fixture",
        environmentId: dir,
        projectId: dir,
      })
    ).directory,
    dir,
  );
  expect(await tick(execute)).toBe(true);
  const result = db
    .prepare("SELECT state,error FROM runs WHERE id=?")
    .get(run.id) as any;
  expect(result.state).toBe("failed");
  expect(result.error).toContain("in use by another Codex client");
  expect(result.error).toContain("No prompt was sent");
  expect(result.error).not.toContain("other-native-thread");
  expect(result.error).not.toContain("pid 4121");
  expect(existsSync(audit)).toBe(false);
  expect(
    db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
  ).toBeUndefined();
});

it.each([true, false])(
  "interrupts a native turn through the cancel route (bus=%s)",
  async (enabled) => {
    process.env.LOOP_TEST_HARNESS = "codex";
    const { core } = await import("../src/server/core-routes");
    const app = await productionApp("local-workspace", [core]);
    const run = submit(`cancel-${enabled}`, "codex", `cancel-${enabled}`);
    db.prepare("UPDATE runs SET input='wait' WHERE id=?").run(run.id);
    const bus = enabled
      ? undefined
      : vi.spyOn(changes, "subscribe").mockImplementation(() => () => {});
    let finished = false;
    const work = tick(execute).finally(() => {
      finished = true;
    });
    try {
      await until(
        () =>
          (
            db
              .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
              .get(run.id) as any
          )?.state === "accepted",
      );
      const started = Date.now();
      const response = await fetch(`${app.url}/api/runs/${run.id}/cancel`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      await until(() => finished, 2400);
      await work;
      expect(Date.now() - started).toBeLessThan(enabled ? 700 : 2300);
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "cancelled" });
      expect(
        db
          .prepare("SELECT count(*) n FROM native_dispatch WHERE run_id=?")
          .get(run.id),
      ).toEqual({ n: 1 });
    } finally {
      bus?.mockRestore();
      await nativeSessions.interrupt(run.id);
      await work;
      await app.close();
    }
  },
  10000,
);
