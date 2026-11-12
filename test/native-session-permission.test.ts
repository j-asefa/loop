import { gitProject } from "./git-project.js";
import { afterAll, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as nativeDecisionsQueries from "../src/server/sql/native-decisions";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-session-mode-")));
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
const mode = (conversation: string) =>
  (
    db
      .prepare(
        "SELECT permission_mode FROM companion_sessions WHERE conversation_id=?",
      )
      .get(conversation) as any
  ).permission_mode;

it("confirms a permission change and restores it after the native process is evicted", async () => {
  const sessions = new NativeSessions();
  const task = run("resume");
  const first = await sessions.session(task);
  try {
    const changed = await sessions.setSetting(
      "resume",
      "mode",
      "auto",
      first.adapter.settings!.revision,
      first.generation,
    );
    expect(changed.settings.options.find((o) => o.id === "mode")).toMatchObject(
      { confirmed: "auto" },
    );
    expect(mode("resume")).toBe("auto");
  } finally {
    await sessions.dispose(first);
  }
  const resumed = await sessions.session(task);
  try {
    expect(resumed.sessionMode).toBe("auto");
    expect(
      resumed.adapter.settings!.options.find((o) => o.id === "mode"),
    ).toMatchObject({ confirmed: "auto" });
    const argv = readFileSync(join(dir, "argv.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(
      argv.slice(
        argv.indexOf("--permission-mode"),
        argv.indexOf("--permission-mode") + 2,
      ),
    ).toEqual(["--permission-mode", "auto"]);
  } finally {
    await sessions.dispose(resumed);
  }
});

it("does not persist a rejected, unconfirmed, or superseded setting", async () => {
  const sessions = new NativeSessions();
  const live = await sessions.session(run("reject"));
  const change = vi.spyOn(live.adapter, "setSetting");
  try {
    change.mockRejectedValueOnce(new Error("Mode unavailable"));
    await expect(
      sessions.setSetting("reject", "mode", "auto", 1, live.generation),
    ).rejects.toThrow("Mode unavailable");
    expect(mode("reject")).toBeNull();
    change.mockResolvedValueOnce({
      revision: 2,
      options: [
        {
          id: "mode",
          type: "select",
          mutable: true,
          application: "live",
          confirmed: "default",
          requested: "auto",
        },
      ],
    });
    await sessions.setSetting("reject", "mode", "auto", 1, live.generation);
    expect(mode("reject")).toBeNull();
    let release!: (value: any) => void;
    change.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = sessions.setSetting(
      "reject",
      "mode",
      "auto",
      2,
      live.generation,
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    db.prepare(
      "UPDATE companion_sessions SET generation='replacement' WHERE conversation_id='reject'",
    ).run();
    release({ revision: 3, options: [{ id: "mode", confirmed: "auto" }] });
    await expect(pending).rejects.toThrow("Native session changed");
    expect(mode("reject")).toBeNull();
  } finally {
    change.mockRestore();
    await sessions.dispose(live);
  }
});

it("can change permission mode while waiting for a tool decision, without replaying that decision", async () => {
  const sessions = new NativeSessions();
  const task = run("waiting");
  const live = await sessions.session(task);
  try {
    live.run = task;
    live.waiting = true;
    const answer = vi.spyOn(live.adapter, "answer");
    await sessions.setSetting(
      "waiting",
      "mode",
      "acceptEdits",
      live.adapter.settings!.revision,
      live.generation,
    );
    expect(mode("waiting")).toBe("acceptEdits");
    expect(answer).not.toHaveBeenCalled();
    live.waiting = false;
    await expect(
      sessions.setSetting(
        "waiting",
        "mode",
        "default",
        live.adapter.settings!.revision,
        live.generation,
      ),
    ).rejects.toThrow("Wait for the native turn");
  } finally {
    live.run = undefined;
    await sessions.dispose(live);
  }
});

it("drops a session-chosen mode once the workspace level changes", async () => {
  const sessions = new NativeSessions();
  const first = await sessions.session(run("superseded"));
  try {
    await sessions.setSetting(
      "superseded",
      "mode",
      "bypassPermissions",
      first.adapter.settings!.revision,
      first.generation,
    );
    expect(mode("superseded")).toBe("bypassPermissions");
  } finally {
    await sessions.dispose(first);
  }
  // Same workspace level: the session's own choice still wins on resume.
  const kept = await sessions.session(
    enqueue(OWNER, "Fixture only", "superseded-same", {
      conversation: "superseded",
      agent: "worktree-fixture",
      payload: {
        agentId: "worktree-fixture",
        name: "Fixture",
        provider: "anthropic",
        folderId: null,
        connectionId: "native-claude",
        model: "native-default",
        instructions: "",
        permissionMode: "default",
      },
    }),
  );
  expect(kept.sessionMode).toBe("bypassPermissions");
  await sessions.dispose(kept);
  // The workspace level was tightened later: that newer decision wins.
  const next = await sessions.session(
    enqueue(OWNER, "Fixture only", "superseded-next", {
      conversation: "superseded",
      agent: "worktree-fixture",
      payload: {
        agentId: "worktree-fixture",
        name: "Fixture",
        provider: "anthropic",
        folderId: null,
        connectionId: "native-claude",
        model: "native-default",
        instructions: "",
        permissionMode: "acceptEdits",
      },
    }),
  );
  try {
    expect(mode("superseded")).toBeNull();
    expect(next.sessionMode).toBeUndefined();
    const argv = readFileSync(join(dir, "argv.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(
      argv.slice(
        argv.indexOf("--permission-mode"),
        argv.indexOf("--permission-mode") + 2,
      ),
    ).toEqual(["--permission-mode", "acceptEdits"]);
  } finally {
    await sessions.dispose(next);
  }
});

it("keeps one idle timer when setting requests overlap", async () => {
  const sessions = new NativeSessions();
  const task = run("overlap");
  const live = await sessions.session(task);
  const change = vi.spyOn(live.adapter, "setSetting");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let release!: (value: any) => void;
    change.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    change.mockRejectedValueOnce(new Error("Setting busy"));
    const slow = sessions.setSetting(
      "overlap",
      "mode",
      "auto",
      1,
      live.generation,
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(
      sessions.setSetting("overlap", "mode", "auto", 1, live.generation),
    ).rejects.toThrow("Setting busy");
    release({ revision: 2, options: [{ id: "mode", confirmed: "auto" }] });
    await slow;
    // A turn starts: it clears the session's idle timer, as session() does.
    clearTimeout(live.idle);
    live.run = task;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(live.closed).toBe(false);
  } finally {
    vi.useRealTimers();
    change.mockRestore();
    live.run = undefined;
    await sessions.dispose(live);
  }
});

it("isolates agents while reusing their dirty worktrees across conversations and process restarts", async () => {
  const { writeFileSync, renameSync } = await import("node:fs");
  const sessions = new NativeSessions();
  const task = run("worktree-first");
  writeFileSync(join(dir, "tracked.txt"), "shared edit");
  const first = await sessions.session(task);
  const checkout = first.binding.project;
  try {
    expect(checkout).not.toBe(dir);
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe(
      "committed",
    );
    writeFileSync(join(checkout, "tracked.txt"), "agent edit");
  } finally {
    await sessions.dispose(first);
  }
  const restarted = new NativeSessions();
  const resumed = await restarted.session(task);
  expect(resumed.binding.project).toBe(checkout);
  await restarted.dispose(resumed);
  const next = await sessions.session(run("worktree-next"));
  try {
    expect(next.binding.project).toBe(checkout);
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe(
      "agent edit",
    );
  } finally {
    await sessions.dispose(next);
  }
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('other-agent',?,'Other','other','codex','fixture',0)",
  ).run(OWNER);
  const otherTask = run("worktree-other");
  otherTask.agent_id = "other-agent";
  db.prepare("UPDATE runs SET agent_id=? WHERE id=?").run(
    otherTask.agent_id,
    otherTask.id,
  );
  const other = await sessions.session(otherTask);
  try {
    expect(other.binding.project).not.toBe(checkout);
    expect(
      readFileSync(join(other.binding.project, "tracked.txt"), "utf8"),
    ).toBe("committed");
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("shared edit");
  } finally {
    await sessions.dispose(other);
  }
  renameSync(checkout, checkout + "-saved");
  try {
    await expect(sessions.session(task)).rejects.toThrow(/worktree is missing/);
    await expect(sessions.session(run("worktree-missing"))).rejects.toThrow(
      /worktree is missing/,
    );
  } finally {
    renameSync(checkout + "-saved", checkout);
  }
});

it("refuses native sessions bound to another agent instead of changing their checkout", async () => {
  const sessions = new NativeSessions();
  const task = run("worktree-foreign-binding");
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,native_id,instructions,updated_at) VALUES('other-agent',?,'claude',?,'old-native-session','',0)",
  ).run(task.conversation_id, dir);
  await expect(sessions.session(task)).rejects.toThrow(/new conversation/);
  expect(
    db
      .prepare(
        "SELECT project,native_id FROM companion_sessions WHERE conversation_id=?",
      )
      .get(task.conversation_id),
  ).toEqual({ project: dir, native_id: "old-native-session" });
});

function claimed(name: string) {
  const task = run(name);
  db.prepare(
    "UPDATE runs SET state='running',worker_id='w1',heartbeat=? WHERE id=?",
  ).run(Date.now(), task.id);
  return task;
}

it("accepts setting changes once an interrupted turn has ended", async () => {
  const sessions = new NativeSessions();
  const task = claimed("after-interrupt");
  const live = await sessions.session(task);
  const prompt = vi
    .spyOn(live.adapter, "prompt")
    .mockImplementation(async () => {});
  const cancel = vi
    .spyOn(live.adapter, "cancel")
    .mockImplementation(async () => {
      sessions.projector.event(live, { type: "status", status: "interrupted" });
    });
  try {
    const turn = sessions.execute(task);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    await sessions.interrupt(task.id);
    await expect(turn).resolves.toBe(false);
    expect(live.run).toBeUndefined();
    await sessions.setSetting(
      "after-interrupt",
      "mode",
      "acceptEdits",
      live.adapter.settings!.revision,
      live.generation,
    );
    expect(mode("after-interrupt")).toBe("acceptEdits");
  } finally {
    prompt.mockRestore();
    cancel.mockRestore();
    await sessions.dispose(live);
  }
});

it("releases the session when a turn fails before it is dispatched", async () => {
  const sessions = new NativeSessions();
  const task = claimed("before-dispatch");
  const live = await sessions.session(task);
  const prompt = vi.spyOn(live.adapter, "prompt");
  // The dispatch record cannot be written (for example a busy database).
  db.exec(
    "CREATE TRIGGER refuse_dispatch BEFORE INSERT ON native_dispatch BEGIN SELECT RAISE(ABORT,'database is locked'); END",
  );
  try {
    await expect(sessions.execute(task)).rejects.toThrow("database is locked");
    expect(prompt).not.toHaveBeenCalled();
    expect(live.run).toBeUndefined();
    expect(
      db
        .prepare("SELECT count(*) n FROM native_dispatch WHERE run_id=?")
        .get(task.id),
    ).toEqual({ n: 0 });
    // The conversation is not left "already running".
    await sessions.setSetting(
      "before-dispatch",
      "mode",
      "acceptEdits",
      live.adapter.settings!.revision,
      live.generation,
    );
  } finally {
    db.exec("DROP TRIGGER refuse_dispatch");
    prompt.mockRestore();
    await sessions.dispose(live);
  }
});

it("keeps the first terminal status of a native turn", async () => {
  const sessions = new NativeSessions();
  const task = claimed("late-status");
  const live = await sessions.session(task);
  const prompt = vi
    .spyOn(live.adapter, "prompt")
    .mockImplementation(async () => {
      queueMicrotask(() => {
        sessions.projector.event(live, { type: "status", status: "completed" });
        // The harness process then fails while the turn winds down.
        sessions.projector.event(live, {
          type: "status",
          status: "failed",
          detail: "Harness exited",
        });
      });
    });
  try {
    await expect(sessions.execute(task)).resolves.toBe(true);
    expect(
      db
        .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
        .get(task.id),
    ).toEqual({ state: "completed" });
    expect(
      (db.prepare("SELECT error FROM runs WHERE id=?").get(task.id) as any)
        .error,
    ).toBeNull();
  } finally {
    prompt.mockRestore();
    await sessions.dispose(live);
  }
});

it("records a cancelled-before-dispatch turn as interrupted, not unknown outcome", async () => {
  const sessions = new NativeSessions();
  const task = claimed("not-delivered");
  const live = await sessions.session(task);
  const prompt = vi
    .spyOn(live.adapter, "prompt")
    .mockImplementation(async (_input: unknown, before?: () => void) => {
      // An interrupt lands after the turn attaches but before dispatch.
      live.cancelling = true;
      before?.(); // beforeDispatch throws NotDelivered
    });
  try {
    await expect(sessions.execute(task)).resolves.toBe(false);
    expect(prompt).toHaveBeenCalled();
    // The dispatch row is settled to a terminal state (guarded setState).
    expect(
      db
        .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
        .get(task.id),
    ).toEqual({ state: "interrupted" });
    expect(
      (db.prepare("SELECT state FROM runs WHERE id=?").get(task.id) as any)
        .state,
    ).toBe("interrupted");
    // Nothing was sent; the reason is recorded, not an "unknown outcome".
    expect(
      (db.prepare("SELECT error FROM runs WHERE id=?").get(task.id) as any)
        .error,
    ).toMatch(/was not started/);
  } finally {
    prompt.mockRestore();
    await sessions.dispose(live);
  }
});

it.each(["ordinary", "oversized", "full"])(
  "ignores a resolved request re-emission even when %s",
  async (bounds) => {
    const sessions = new NativeSessions();
    const task = claimed("re-emit-" + bounds);
    const live = await sessions.session(task);
    // A decision for this request id was already resolved in this generation.
    const decisionId = randomUUID();
    nativeDecisionsQueries.insertPending(
      db,
      decisionId,
      task.id,
      live.binding.conversation_id,
      live.generation,
      "req-1",
      JSON.stringify({ id: "req-1", kind: "approval", title: "t", detail: "" }),
      Date.now(),
    );
    nativeDecisionsQueries.finishById(db, "resolved", decisionId);
    const prompt = vi
      .spyOn(live.adapter, "prompt")
      .mockImplementation(async () => {
        // A resolved re-emission adds no display content, even at the limits.
        if (bounds === "full") {
          for (let i = 0; i < 25; i++)
            live.requests.set("pending-" + i, {
              id: "pending-" + i,
              kind: "approval",
              title: "t",
              detail: "",
            });
        }
        // The harness re-emits the already-resolved request in this generation.
        sessions.projector.event(live, {
          type: "request",
          request: {
            id: "req-1",
            kind: "approval",
            title: "t",
            detail: bounds === "oversized" ? "x".repeat(1024 * 1024) : "",
          },
        });
        // It must not move the run to awaiting_approval or set it waiting.
        expect(
          (db.prepare("SELECT state FROM runs WHERE id=?").get(task.id) as any)
            .state,
        ).toBe("running");
        expect(live.waiting).toBe(false);
        sessions.projector.event(live, { type: "status", status: "completed" });
      });
    try {
      // The turn still completes: the ignored re-emit never moved the run back
      // to awaiting_approval with nothing to answer.
      await expect(sessions.execute(task)).resolves.toBe(true);
      expect(
        (db.prepare("SELECT state FROM runs WHERE id=?").get(task.id) as any)
          .state,
      ).not.toBe("awaiting_approval");
    } finally {
      prompt.mockRestore();
      await sessions.dispose(live);
    }
  },
);

it("interrupts a settled native turn when its final output cannot be recorded", async () => {
  const sessions = new NativeSessions();
  const task = claimed("settle-throws");
  const live = await sessions.session(task);
  const decisionId = randomUUID();
  const pending = {
    id: "leftover",
    kind: "approval" as const,
    title: "pending",
    detail: "",
  };
  live.requests.set(pending.id, pending);
  nativeDecisionsQueries.insertPending(
    db,
    decisionId,
    task.id,
    live.binding.conversation_id,
    live.generation,
    pending.id,
    JSON.stringify(pending),
    Date.now(),
  );
  const project = vi.spyOn(sessions.projector, "projectOutput");
  const prompt = vi
    .spyOn(live.adapter, "prompt")
    .mockImplementation(async () => {
      queueMicrotask(() => {
        project.mockImplementation(() => {
          throw new Error("database is locked");
        });
        try {
          sessions.projector.event(live, {
            type: "status",
            status: "completed",
          });
        } catch {
          // The adapter's event callback surfaces the failure.
        }
      });
    });
  try {
    // The harness completed, but Loop cannot certify its reply was saved.
    // It must stop waiting without reporting success or submitting again.
    await expect(sessions.execute(task)).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(live.requests.size).toBe(0);
    expect(live.waiting).toBe(false);
    expect(
      db
        .prepare("SELECT state FROM native_decisions WHERE id=?")
        .get(decisionId),
    ).toEqual({ state: "expired" });
    expect(
      db
        .prepare("SELECT state FROM companion_sessions WHERE conversation_id=?")
        .get(live.binding.conversation_id),
    ).toEqual({ state: "idle" });
    expect(live.run).toBeUndefined();
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(task.id),
    ).toEqual({ state: "interrupted" });
    expect(
      db
        .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
        .get(task.id),
    ).toEqual({ state: "completed" });
  } finally {
    prompt.mockRestore();
    project.mockRestore();
    await sessions.dispose(live);
  }
});

it.each([false, true])(
  "suspends idle eviction during workspace validation and restores it afterward (failure=%s)",
  async (failure) => {
    const sessions = new NativeSessions();
    const conversation = "validation-idle-" + failure;
    const task = run(conversation);
    const live = await sessions.session(task);
    const workspace = await import("../src/server/native/workspace.js");
    const original = workspace.boundWorkspace;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const validation = vi
      .spyOn(workspace, "boundWorkspace")
      .mockImplementation(async (...args) => {
        entered = true;
        await gate;
        if (failure) throw new Error("Fixture validation failed");
        return original(...args);
      });
    const setting = vi
      .spyOn(live.adapter, "setSetting")
      .mockRejectedValue(new Error("Setting busy"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending: Promise<unknown> | undefined;
    let control: Promise<unknown> | undefined;
    let finishControl: ((error: Error) => void) | undefined;
    try {
      const change = () =>
        sessions.setSetting(conversation, "mode", "auto", 1, live.generation);
      await expect(change()).rejects.toThrow("Setting busy");
      pending = sessions.session(task).then(
        (value) => value,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(entered).toBe(true));
      // A completed control must not re-arm eviction during validation.
      await expect(change()).rejects.toThrow("Setting busy");
      setting.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            finishControl = reject;
          }),
      );
      control = change().catch((error: unknown) => error);
      await vi.waitFor(() => expect(finishControl).toBeDefined());
      await vi.advanceTimersByTimeAsync(61_000);
      expect(live.closed).toBe(false);
      release();
      if (failure)
        await expect(pending).resolves.toMatchObject({
          message: "Fixture validation failed",
        });
      else await expect(pending).resolves.toBe(live);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(live.closed).toBe(false);
      finishControl!(new Error("Setting busy"));
      await expect(control).resolves.toMatchObject({ message: "Setting busy" });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(live.closed).toBe(true);
    } finally {
      release();
      finishControl?.(new Error("Setting busy"));
      await Promise.allSettled([pending, control]);
      vi.useRealTimers();
      validation.mockRestore();
      setting.mockRestore();
      await sessions.close();
    }
  },
);

it("capacity eviction skips a session awaiting workspace validation", async () => {
  const { MAX_CONCURRENT_RUNS } = await import("../src/shared/concurrency.js");
  const sessions = new NativeSessions();
  const first = run("capacity-held");
  const held = await sessions.session(first);
  const workspace = await import("../src/server/native/workspace.js");
  const original = workspace.boundWorkspace;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  let pending: Promise<unknown> | undefined;
  const validation = vi
    .spyOn(workspace, "boundWorkspace")
    .mockImplementation(async (...args) => {
      if (args[0].conversation_id === first.conversation_id) {
        entered = true;
        await gate;
      }
      return original(...args);
    });
  try {
    const evictable = await sessions.session(run("capacity-idle"));
    for (let i = 2; i < MAX_CONCURRENT_RUNS; i++)
      await sessions.session(run("capacity-" + i));
    expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
    pending = sessions.session(first).then(
      (live) => live,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const extra = await sessions.session(run("capacity-new"));
    expect(held.closed).toBe(false);
    expect(evictable.closed).toBe(true);
    expect(extra.closed).toBe(false);
    expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
    release();
    await expect(pending).resolves.toBe(held);
  } finally {
    release();
    await pending;
    validation.mockRestore();
    await sessions.close();
  }
}, 30000);

it("defers native startup when every capacity slot is held and resumes after release", async () => {
  const { MAX_CONCURRENT_RUNS } = await import("../src/shared/concurrency.js");
  const { RunDeferred } = await import("../src/server/run-deferred.js");
  const sessions = new NativeSessions();
  const tasks = Array.from({ length: MAX_CONCURRENT_RUNS }, (_, i) =>
    run("capacity-all-held-" + i),
  );
  const lives = [];
  for (const task of tasks) lives.push(await sessions.session(task));
  const workspace = await import("../src/server/native/workspace.js");
  const original = workspace.boundWorkspace;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const validation = vi
    .spyOn(workspace, "boundWorkspace")
    .mockImplementation(async (...args) => {
      entered++;
      await gate;
      return original(...args);
    });
  const pending = tasks.map((task) =>
    sessions.session(task).then(
      (value) => value,
      (error: unknown) => error,
    ),
  );
  try {
    await vi.waitFor(() => expect(entered).toBe(MAX_CONCURRENT_RUNS));
    const extra = run("capacity-all-held-new");
    await expect(sessions.session(extra)).rejects.toBeInstanceOf(RunDeferred);
    expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
    expect(lives.every((live) => !live.closed)).toBe(true);
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(extra.id),
    ).toBeUndefined();
    release();
    expect(await Promise.all(pending)).toEqual(lives);
    const started = await sessions.session(extra);
    expect(started.closed).toBe(false);
    expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
  } finally {
    release();
    await Promise.allSettled(pending);
    validation.mockRestore();
    await sessions.close();
  }
}, 30000);
