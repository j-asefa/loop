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

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop55-session-mode-")));
process.env.LOOP55_DATA_DIR = dir;
gitProject(dir);
process.env.LOOP55_TEST_HARNESS = "claude";
process.env.LOOP55_TEST_ARGV = join(dir, "argv.jsonl");
const { db } = await import("../src/server/db");
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('worktree-fixture','local-workspace','Fixture','fixture','codex','fixture',0)",
).run();
const { enqueue } = await import("../src/server/queue");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
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
).run(OWNER, JSON.stringify({ loop55Harness: "claude" }));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LOOP55_TEST_HARNESS;
  delete process.env.LOOP55_TEST_ARGV;
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

it("preserves old native sessions instead of resuming them in a different checkout", async () => {
  const sessions = new NativeSessions();
  const task = run("worktree-legacy");
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,native_id,instructions,updated_at) VALUES(?,'claude',?,'old-native-session','',0)",
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
