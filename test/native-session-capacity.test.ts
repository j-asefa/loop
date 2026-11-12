import { gitProject } from "./git-project.js";
import { afterAll, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-session-capacity-")));
process.env.LOOP_DATA_DIR = dir;
gitProject(dir);
process.env.LOOP_TEST_HARNESS = "claude";
process.env.LOOP_TEST_ARGV = join(dir, "argv.jsonl");
const { db } = await import("../src/server/db");
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('worktree-fixture','local-workspace','Fixture','fixture','codex','fixture',0)",
).run();
const { enqueue } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
const executable = resolve("test/harness.mjs");
chmodSync(executable, 0o755);
db.prepare("INSERT INTO harnesses VALUES('claude',?,'{}','{}','[]',0)").run(
  JSON.stringify({
    harness: "claude",
    executable,
    project: dir,
    billing: "existing",
    version: "fixture",
  }),
);
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('native-claude',?,'anthropic','Claude','','connected','[]',?,0)",
).run(OWNER, JSON.stringify({ loopHarness: "claude" }));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LOOP_TEST_HARNESS;
  delete process.env.LOOP_TEST_ARGV;
});
function run(name: string, permissionMode = "default") {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Test',0)",
  ).run(name, OWNER);
  return enqueue(OWNER, "Fixture only", name, {
    conversation: name,
    agent: "worktree-fixture",
    payload: {
      agentId: "worktree-fixture",
      name: "Fixture",
      provider: "anthropic",
      folderId: null,
      connectionId: "native-claude",
      model: "native-default",
      instructions: "",
      permissionMode,
    },
  });
}

it("waits for capacity in the worker and captures the checkout only after a slot opens", async () => {
  const { MAX_CONCURRENT_RUNS } = await import("../src/shared/concurrency.js");
  const { transition } = await import("../src/server/queue.js");
  const { tick } = await import("../src/server/worker.js");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const sessions = new NativeSessions();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controls: Promise<unknown>[] = [];
  const mocks: Array<{ mockRestore(): void }> = [];
  let work: Promise<boolean> | undefined;
  let entered = 0;
  try {
    let checkout = "";
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      const live = await sessions.session(run("capacity-worker-" + i));
      checkout = live.binding.project;
      mocks.push(
        vi.spyOn(live.adapter, "setSetting").mockImplementation(async () => {
          entered++;
          await gate;
          throw new Error("Fixture setting finished");
        }),
      );
      controls.push(
        sessions
          .setSetting(
            live.binding.conversation_id,
            "mode",
            "auto",
            1,
            live.generation,
          )
          .catch((error: unknown) => error),
      );
    }
    // These fixtures created idle native contexts, not worker turns.
    const queued = db
      .prepare("SELECT * FROM runs WHERE state='queued'")
      .all() as Array<Parameters<typeof transition>[0]>;
    for (const task of queued) transition(task, "cancelled");
    await vi.waitFor(() => expect(entered).toBe(MAX_CONCURRENT_RUNS));
    const extra = run("capacity-worker-new");
    let claims = 0;
    let settled = false;
    work = tick(async (claimed) => {
      expect(claimed.id).toBe(extra.id);
      claims++;
      return sessions.execute(claimed);
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(
        db
          .prepare("SELECT 1 FROM companion_sessions WHERE conversation_id=?")
          .get(extra.conversation_id),
      ).toBeDefined(),
    );
    const waiting = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1500)),
    ]);
    expect({
      waiting,
      settled,
      run: db.prepare("SELECT state FROM runs WHERE id=?").get(extra.id),
      checkout: db
        .prepare("SELECT 1 FROM run_checkouts WHERE run_id=?")
        .get(extra.id),
    }).toEqual({
      waiting: true,
      settled: false,
      run: { state: "running" },
      checkout: undefined,
    });
    expect(
      db.prepare("SELECT 1 FROM run_checkouts WHERE run_id=?").get(extra.id),
    ).toBeUndefined();
    expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
    writeFileSync(
      join(checkout, "tracked.txt"),
      "Changed while waiting for capacity",
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
      }).trim();
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-am",
      "change before native startup",
    );
    const expectedHead = git("rev-parse", "HEAD");
    release();
    await Promise.all(controls);
    expect(await work).toBe(true);
    expect(claims).toBe(1);
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(extra.id),
    ).toEqual({ state: "completed" });
    expect(
      db
        .prepare("SELECT start_head FROM run_checkouts WHERE run_id=?")
        .get(extra.id),
    ).toEqual({ start_head: expectedHead });
    expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
  } finally {
    release();
    await Promise.allSettled([...controls, work]);
    for (const mock of mocks) mock.mockRestore();
    await sessions.close();
  }
}, 30000);
