import { gitProject } from "./git-project.js";
import { afterAll, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
function run(name: string, permissionMode = "default", conversation = name) {
  db.prepare(
    "INSERT OR IGNORE INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Test',0)",
  ).run(conversation, OWNER);
  return enqueue(OWNER, "Fixture only", name, {
    conversation,
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

it.each([false, true])(
  "waits for capacity without premature baseline or permission mutations (cancel=%s)",
  async (cancel) => {
    const { MAX_CONCURRENT_RUNS } =
      await import("../src/shared/concurrency.js");
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
      const prefix = cancel ? "cancel-" : "complete-";
      const saved = run(prefix + "saved");
      const initial = await sessions.session(saved);
      await sessions.setSetting(
        saved.conversation_id!,
        "mode",
        "auto",
        initial.adapter.settings!.revision,
        initial.generation,
      );
      await sessions.dispose(initial);
      let checkout = "";
      for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
        const live = await sessions.session(
          run(prefix + "capacity-worker-" + i),
        );
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
      const extra = run(
        prefix + "capacity-worker-new",
        "acceptEdits",
        saved.conversation_id!,
      );
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
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), 1500),
        ),
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
      if (cancel) {
        transition(extra, "cancelled");
        expect(await work).toBe(true);
        expect(claims).toBe(1);
        expect(
          db
            .prepare(
              "SELECT permission_mode,permission_base FROM companion_sessions WHERE conversation_id=?",
            )
            .get(saved.conversation_id),
        ).toEqual({ permission_mode: "auto", permission_base: "default" });
        release();
        await Promise.all(controls);
        const next = await sessions.session(
          run(prefix + "followup", "default", saved.conversation_id!),
        );
        expect(next.sessionMode).toBe("auto");
        expect(
          next.adapter.settings!.options.find((option) => option.id === "mode"),
        ).toMatchObject({ confirmed: "auto" });
        return;
      }
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
        db
          .prepare(
            "SELECT permission_mode,permission_base FROM companion_sessions WHERE conversation_id=?",
          )
          .get(saved.conversation_id),
      ).toEqual({ permission_mode: null, permission_base: null });
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
  },
  30000,
);

it.each(["running", "cancelled"] as const)(
  "settles completed native turns after a concurrent %s decision",
  async (next) => {
    const { transition, claim, completeLeased } =
      await import("../src/server/queue.js");
    const domain = await import("../src/server/domain.js");
    const sessions = new NativeSessions();
    const task = run("native-completion-race-" + next);
    const live = await sessions.session(task);
    let finishing = false;
    const read = domain.ownedRun;
    const spy = vi.spyOn(domain, "ownedRun").mockImplementation((...args) => {
      const row = read(...args);
      if (
        args[0] === task.id &&
        finishing &&
        row.state === "awaiting_approval"
      ) {
        finishing = false;
        expect(transition(task, next)).toBe(true);
      }
      return row;
    });
    const prompt = vi
      .spyOn(live.adapter, "prompt")
      .mockImplementation(async () => {
        expect(transition(task, "awaiting_approval")).toBe(true);
        finishing = true;
        live.finish!("completed");
      });
    try {
      const claimed = claim(
        "completion-race",
        (candidate) => candidate.id === task.id,
      )!;
      expect(claimed.id).toBe(task.id);
      const complete = await sessions.execute(claimed);
      if (complete !== false) completeLeased(claimed, "completion-race");
      expect(finishing).toBe(false);
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(task.id),
      ).toEqual({ state: next === "running" ? "completed" : "cancelled" });
    } finally {
      spy.mockRestore();
      prompt.mockRestore();
      await sessions.dispose(live);
    }
  },
);
