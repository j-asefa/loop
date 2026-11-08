import { afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProject } from "./git-project.js";
import { until } from "./helpers.js";

const root = realpathSync(
  mkdtempSync(join(tmpdir(), "loop-native-workspaces-")),
);
const data = join(root, "data");
const chat = join(root, "chat");
const other = join(root, "other");
for (const directory of [data, chat, other]) mkdirSync(directory);
process.env.LOOP_DATA_DIR = data;
process.env.LOOP_TEST_GROK_AUTO = "1";
process.env.LOOP_TEST_GROK_LOG = join(root, "requests");
const { db } = await import("../src/server/db.js");
const { nativeSessions, NativeSessions, OWNER } =
  await import("../src/server/native-sessions.js");
const { enqueue, transition } = await import("../src/server/queue.js");
const { tick, execute } = await import("../src/server/worker.js");
const { completeCheckout } = await import("../src/server/run-checkouts.js");

await nativeSessions.enable({
  harness: "grok",
  executable: resolve("test/fixtures/fake-grok.mjs"),
  version: "1.0.70",
  project: chat,
  billing: "existing",
});
await nativeSessions.enable({
  harness: "acp",
  executable: process.execPath,
  version: "fixture",
  args: [resolve("test/fixtures/fake-acp.mjs")],
  project: other,
  billing: "existing",
});

afterAll(async () => {
  await nativeSessions.close();
  db.close();
  for (const name of [
    "LOOP_TEST_GROK_AUTO",
    "LOOP_TEST_GROK_LOG",
    "LOOP_TEST_GROK_SESSION_ID",
    "LOOP_TEST_ACP_SESSION_ID",
  ])
    delete process.env[name];
  rmSync(root, { recursive: true, force: true });
});

const requests = () =>
  readFileSync(join(root, "requests"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const binding = (conversation: string) =>
  db
    .prepare("SELECT * FROM companion_sessions WHERE conversation_id=?")
    .get(conversation) as any;
const result = (run: { id: string }) =>
  db
    .prepare("SELECT state,result,error FROM runs WHERE id=?")
    .get(run.id) as any;
function directory(name: string) {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}
function submit(
  project: string,
  key: string,
  options: {
    conversation?: string;
    agent?: string;
    harness?: "grok" | "acp";
  } = {},
) {
  const { conversation = key, agent = key, harness = "grok" } = options;
  const folder = nativeSessions.addProject(project) as { id: string };
  db.prepare(
    "INSERT OR IGNORE INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,?,'native-default',0)",
  ).run(agent, OWNER, agent, agent, harness);
  db.prepare(
    "INSERT OR IGNORE INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Chat',?,0)",
  ).run(conversation, OWNER, agent, folder.id);
  return enqueue(OWNER, "Help me think through an idea", key, {
    conversation,
    agent,
    payload: {
      agentId: agent,
      name: agent,
      provider: harness,
      connectionId: `native-${harness}`,
      folderId: folder.id,
      model: "native-default",
      instructions: "Be brief.",
    },
  });
}
async function run(...args: Parameters<typeof submit>) {
  const task = submit(...args);
  process.env.LOOP_TEST_GROK_SESSION_ID = "workspace-" + args[1];
  process.env.LOOP_TEST_ACP_SESSION_ID = "workspace-" + args[1];
  expect(await tick(execute)).toBe(true);
  await completeCheckout(task.id);
  return task;
}

it("completes chat in an ordinary folder, resumes after restart and sends a follow-up without checkout records", async () => {
  writeFileSync(join(chat, "notes.txt"), "Keep this idea");
  const first = await run(chat, "plain");
  expect(result(first)).toEqual({
    state: "completed",
    result: "Fixture done",
    error: null,
  });
  const saved = binding("plain");
  expect(saved).toMatchObject({
    project: chat,
    worktree_source: null,
    worktree_agent_id: "plain",
  });
  expect(requests().find((r) => r.method === "session/new").params.cwd).toBe(
    chat,
  );
  expect(
    db.prepare("SELECT 1 FROM run_checkouts WHERE run_id=?").get(first.id),
  ).toBeUndefined();
  expect(existsSync(join(chat, ".git"))).toBe(false);
  expect(readFileSync(join(chat, "notes.txt"), "utf8")).toBe("Keep this idea");

  await nativeSessions.dispose(await nativeSessions.session(first));
  const prompts = requests().filter(
    (r) => r.method === "session/prompt",
  ).length;
  const restarted = new NativeSessions();
  try {
    const resumed = await restarted.session(first);
    expect(resumed.generation).not.toBe(saved.generation);
    expect(binding("plain").native_id).toBe(saved.native_id);
    expect(
      requests().findLast((r) => r.method === "session/load").params,
    ).toMatchObject({ sessionId: saved.native_id, cwd: chat });
    expect(
      requests().filter((r) => r.method === "session/prompt"),
    ).toHaveLength(prompts);
  } finally {
    await restarted.close();
  }
  const followup = await run(chat, "plain-followup", {
    conversation: "plain",
    agent: "plain",
  });
  expect(result(followup).state).toBe("completed");
  expect(binding("plain").project).toBe(chat);
  expect(
    db.prepare("SELECT 1 FROM run_checkouts WHERE run_id=?").get(followup.id),
  ).toBeUndefined();
});

it("keeps the selected ordinary folder when switching harnesses", async () => {
  expect(result(await run(chat, "switch-start")).state).toBe("completed");
  const task = await run(chat, "plain-switch", {
    conversation: "switch-start",
    agent: "switch-start",
    harness: "acp",
  });
  expect(result(task).state).toBe("completed");
  expect(binding("switch-start")).toMatchObject({
    harness: "acp",
    project: chat,
    worktree_source: null,
    worktree_agent_id: "switch-start",
  });
  expect(binding("switch-start").instructions).toContain("Fixture done");
  expect(
    db.prepare("SELECT 1 FROM run_checkouts WHERE run_id=?").get(task.id),
  ).toBeUndefined();
});

it("binds a fresh ordinary-folder import for catalogs, native resume and harness switching", async () => {
  const kind = "plain";
  const { importSession, prepareImportSession, resumeFromDesktop } =
    await import("../src/server/migration.js");
  const project = directory("import-" + kind);
  const nativeId = "imported-" + kind;
  const options = { ...nativeSessions.registration("grok"), project };
  const prepared = await prepareImportSession(
    options,
    "desktop",
    JSON.stringify([options.harness, nativeId, project]),
    nativeId,
  );
  const conversation = db
    .transaction(() =>
      importSession(
        options,
        nativeId,
        [
          {
            id: "import-history-" + kind,
            kind: "assistant",
            text: "Retain imported context",
          },
        ],
        "Imported fixture",
        prepared,
      ),
    )
    .immediate();
  expect(
    importSession(options, nativeId, [], "Repeated import", prepared),
  ).toBe(conversation);
  const agent = db
    .prepare(
      "SELECT a.* FROM agents a JOIN conversations c ON c.agent_id=a.id WHERE c.id=?",
    )
    .get(conversation) as any;
  const saved = binding(conversation);
  expect(saved.worktree_agent_id).toBe(agent.id);
  expect(saved.worktree_source).toBeNull();
  expect(saved.project).toBe(project);
  expect((await nativeSessions.catalog(agent, conversation)).available).toBe(
    true,
  );
  const resumed = await run(project, "import-resume-" + kind, {
    conversation,
    agent: agent.id,
  });
  expect(result(resumed).state).toBe("completed");
  expect(
    requests().findLast((request) => request.method === "session/load").params,
  ).toMatchObject({ sessionId: nativeId, cwd: saved.project });
  expect(binding(conversation).native_id).toBe(nativeId);
  const switched = await run(project, "import-switch-" + kind, {
    conversation,
    agent: agent.id,
    harness: "acp",
  });
  expect(result(switched).state).toBe("completed");
  expect(binding(conversation)).toMatchObject({
    harness: "acp",
    project: saved.project,
    worktree_agent_id: agent.id,
  });
  expect(binding(conversation).instructions).toContain(
    "Retain imported context",
  );
  const checkout = db
    .prepare("SELECT * FROM run_checkouts WHERE run_id=?")
    .get(switched.id) as any;
  expect(checkout).toBeUndefined();
  const switchedBinding = binding(conversation);
  const repeated = await resumeFromDesktop(options, nativeId);
  expect(repeated).not.toBe(conversation);
  expect(binding(repeated).worktree_agent_id).not.toBe(agent.id);
  expect(binding(repeated)).toMatchObject({
    harness: "grok",
    native_id: nativeId,
    project,
  });
  expect(binding(conversation)).toEqual(switchedBinding);
  expect(await resumeFromDesktop(options, nativeId)).toBe(repeated);
  const handoff = await resumeFromDesktop(options, "handoff-" + kind);
  expect(binding(handoff).worktree_agent_id).toBeTruthy();
  expect(binding(handoff).worktree_source).toBeNull();
  expect(await resumeFromDesktop(options, "handoff-" + kind)).toBe(handoff);
});

it("preserves directory-scoped native history instead of relocating it to a Git worktree", async () => {
  const { resumeFromDesktop } = await import("../src/server/migration.js");
  const project = directory("directory-scoped-handoff");
  gitProject(project);
  for (const harness of ["grok", "claude", "pi", "opencode", "acp"] as const) {
    await expect(
      resumeFromDesktop(
        { ...nativeSessions.registration("grok"), harness, project },
        "scoped-" + harness,
      ),
    ).rejects.toThrow(
      /native context into a new Git worktree is not supported/,
    );
    expect(
      db
        .prepare("SELECT 1 FROM companion_sessions WHERE native_id=?")
        .get("scoped-" + harness),
    ).toBeUndefined();
  }
  expect(existsSync(join(project, ".git", "loop-agent-worktrees"))).toBe(false);
});

it.each(["concurrent", "failed-insert"])(
  "reuses a durable workspace for %s desktop handoffs",
  async (mode) => {
    const { resumeFromDesktop, prepareImportSession } =
      await import("../src/server/migration.js");
    const project = directory("durable-handoff-" + mode);
    gitProject(project);
    const nativeId = "durable-handoff-" + mode;
    const options = {
      ...nativeSessions.registration("grok"),
      harness: "codex" as const,
      project,
    };
    const importKey = JSON.stringify(["codex", nativeId, project]);
    if (mode === "failed-insert") {
      db.exec(
        "CREATE TRIGGER fail_handoff BEFORE INSERT ON companion_sessions BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END",
      );
      try {
        await expect(resumeFromDesktop(options, nativeId)).rejects.toThrow(
          "fixture import failure",
        );
        const saved = db
          .prepare(
            "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND import_key=?",
          )
          .get(OWNER, importKey) as any;
        expect(saved.agent_id).toBeTruthy();
        expect(existsSync(JSON.parse(saved.workspace).directory)).toBe(true);
        expect(
          db
            .prepare("SELECT 1 FROM companion_sessions WHERE native_id=?")
            .get(nativeId),
        ).toBeUndefined();
      } finally {
        db.exec("DROP TRIGGER fail_handoff");
      }
    }
    const conversations = await Promise.all([
      resumeFromDesktop(options, nativeId),
      resumeFromDesktop(options, nativeId),
    ]);
    expect(conversations[0]).toBe(conversations[1]);
    const saved = db
      .prepare(
        "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND import_key=?",
      )
      .get(OWNER, importKey) as any;
    expect(binding(conversations[0])).toMatchObject({
      worktree_agent_id: saved.agent_id,
      project: JSON.parse(saved.workspace).directory,
    });
    await expect(
      resumeFromDesktop(
        { ...options, project: JSON.parse(saved.workspace).directory },
        nativeId,
      ),
    ).resolves.toBe(conversations[0]);
    expect(
      readdirSync(join(project, ".git", "loop-agent-worktrees")),
    ).toHaveLength(1);
    await expect(
      prepareImportSession(
        { ...options, project: chat },
        "desktop",
        importKey,
        nativeId,
      ),
    ).rejects.toThrow(/different harness or directory/);
  },
);

it.each(["plain", "git"])(
  "rejects concurrent handoffs of one native session to different %s destinations",
  async (kind) => {
    const { resumeFromDesktop } = await import("../src/server/migration.js");
    const projects = [
      directory("conflicting-handoff-a-" + kind),
      directory("conflicting-handoff-b-" + kind),
    ];
    if (kind === "git") for (const project of projects) gitProject(project);
    const nativeId = "conflicting-handoff-" + kind;
    const options = {
      ...nativeSessions.registration("grok"),
      harness: "codex" as const,
    };
    const outcomes = await Promise.allSettled(
      projects.map((project) =>
        resumeFromDesktop({ ...options, project }, nativeId),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const winner = outcomes.findIndex(
        (outcome) => outcome.status === "fulfilled",
      ),
      loser = 1 - winner;
    const conversation = (outcomes[winner] as PromiseFulfilledResult<string>)
      .value;
    expect((outcomes[loser] as PromiseRejectedResult).reason.message).toContain(
      "different workspace",
    );
    const saved = binding(conversation);
    expect(saved.worktree_source ?? saved.project).toBe(projects[winner]);
    await expect(
      resumeFromDesktop({ ...options, project: projects[winner] }, nativeId),
    ).resolves.toBe(conversation);
    await expect(
      resumeFromDesktop({ ...options, project: projects[loser] }, nativeId),
    ).rejects.toThrow(/different directory/);
    const preparations = db
      .prepare(
        "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND source=?",
      )
      .all(OWNER, nativeId) as any[];
    expect(preparations).toHaveLength(2);
    const retained = preparations.find(
      (preparation) => preparation.project === projects[loser],
    );
    expect(retained.imported_at).toBeNull();
    expect(existsSync(JSON.parse(retained.workspace).directory)).toBe(true);
    expect(binding(conversation)).toEqual(saved);
  },
);

it.each(["plain", "git"])(
  "keeps a saved %s import binding when the project's Git state changes before retry",
  async (kind) => {
    const { resumeFromDesktop } = await import("../src/server/migration.js");
    const project = directory("retry-binding-" + kind);
    if (kind === "git") gitProject(project);
    const nativeId = "retry-binding-" + kind;
    const options = {
      ...nativeSessions.registration("grok"),
      harness: "codex" as const,
      project,
    };
    const importKey = JSON.stringify(["codex", nativeId, project]);
    db.exec(
      "CREATE TRIGGER fail_retry_import BEFORE INSERT ON companion_sessions BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END",
    );
    try {
      await expect(resumeFromDesktop(options, nativeId)).rejects.toThrow(
        "fixture import failure",
      );
    } finally {
      db.exec("DROP TRIGGER fail_retry_import");
    }
    const before = db
      .prepare(
        "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND import_key=?",
      )
      .get(OWNER, importKey);
    const movedGit = join(root, "moved-import-git");
    if (kind === "git") renameSync(join(project, ".git"), movedGit);
    else gitProject(project);
    try {
      await expect(resumeFromDesktop(options, nativeId)).rejects.toThrow(
        kind === "git"
          ? /worktree could not be verified/
          : /Start a new conversation/,
      );
      expect(
        db
          .prepare(
            "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND import_key=?",
          )
          .get(OWNER, importKey),
      ).toEqual(before);
      expect(
        db
          .prepare("SELECT 1 FROM companion_sessions WHERE native_id=?")
          .get(nativeId),
      ).toBeUndefined();
    } finally {
      if (kind === "git") renameSync(movedGit, join(project, ".git"));
    }
  },
);

it("allows a new explicit handoff destination after preparation fails while retaining the first record", async () => {
  const { resumeFromDesktop } = await import("../src/server/migration.js");
  const firstProject = directory("failed-handoff-destination"),
    secondProject = directory("new-handoff-destination");
  // This failure path requires main, regardless of Git's default branch.
  gitProject(firstProject)("branch", "-M", "main");
  execFileSync("git", [
    "-C",
    firstProject,
    "remote",
    "add",
    "origin",
    join(root, "missing-import-remote"),
  ]);
  const options = {
    ...nativeSessions.registration("grok"),
    harness: "codex" as const,
    project: firstProject,
  };
  const nativeId = "changed-handoff-destination";
  await expect(resumeFromDesktop(options, nativeId)).rejects.toThrow(
    /Could not fetch latest main/,
  );
  const first = db
    .prepare(
      "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND import_key=?",
    )
    .get(OWNER, JSON.stringify(["codex", nativeId, firstProject])) as any;
  expect(first.workspace).toBeNull();
  const conversation = await resumeFromDesktop(
    { ...options, project: secondProject },
    nativeId,
  );
  expect(binding(conversation).project).toBe(secondProject);
  expect(
    db
      .prepare(
        "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='desktop' AND import_key=?",
      )
      .get(OWNER, JSON.stringify(["codex", nativeId, firstProject])),
  ).toEqual(first);
  expect(binding(conversation).worktree_agent_id).not.toBe(first.agent_id);
});

it("preserves the native binding if the workspace changes during a harness switch", async () => {
  const project = directory("switch-changing-workspace");
  const first = await run(project, "switch-changing-workspace");
  expect(result(first).state).toBe("completed");
  const saved = binding("switch-changing-workspace");
  const live = await nativeSessions.session(first);
  const dispose = live.adapter.dispose.bind(live.adapter);
  const closing = vi
    .spyOn(live.adapter, "dispose")
    .mockImplementation(async () => {
      await dispose();
      gitProject(project);
    });
  try {
    const task = await run(project, "switch-workspace-changed", {
      conversation: "switch-changing-workspace",
      agent: "switch-changing-workspace",
      harness: "acp",
    });
    expect(result(task).state).toBe("failed");
    expect(result(task).error).toContain("Start a new conversation");
    expect(binding("switch-changing-workspace")).toMatchObject({
      harness: saved.harness,
      project: saved.project,
      native_id: saved.native_id,
      worktree_agent_id: saved.worktree_agent_id,
      worktree_source: null,
    });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(task.id),
    ).toBeUndefined();
  } finally {
    closing.mockRestore();
  }
});

it("switches harnesses after a cancelled startup publishes its native session id", async () => {
  const { Grok } = await import("../src/adapters/grok.js");
  const original = Grok.prototype.start;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starting = false;
  const delayed = vi
    .spyOn(Grok.prototype, "start")
    .mockImplementation(async function (this: InstanceType<typeof Grok>) {
      starting = true;
      await ready;
      return original.call(this);
    });
  const key = "cancelled-startup-switch";
  const project = directory(key);
  const first = submit(project, key);
  process.env.LOOP_TEST_GROK_SESSION_ID = key;
  process.env.LOOP_TEST_ACP_SESSION_ID = key;
  const firstExecution = tick(execute);
  let secondExecution: Promise<boolean> | undefined;
  try {
    await until(() => starting);
    expect(binding(key).native_id).toBeNull();
    expect(transition(first, "cancelled")).toBe(true);
    const second = submit(project, key + "-followup", {
      conversation: key,
      agent: key,
      harness: "acp",
    });
    let switching = false;
    secondExecution = tick((task) => {
      switching = true;
      return execute(task);
    });
    await until(() => switching);
    release();
    expect(await firstExecution).toBe(true);
    expect(await secondExecution).toBe(true);
    expect(result(first).state).toBe("cancelled");
    expect(result(second)).toMatchObject({ state: "completed", error: null });
    expect(binding(key)).toMatchObject({ harness: "acp", project });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(first.id),
    ).toBeUndefined();
  } finally {
    release();
    await Promise.allSettled([firstExecution, secondExecution]);
    delayed.mockRestore();
  }
});

it.each(["insert", "generation"])(
  "preserves native context when a harness switch encounters a %s conflict",
  async (kind) => {
    const key = "switch-conflict-" + kind;
    const project = directory(key);
    const first = await run(project, key);
    expect(result(first).state).toBe("completed");
    const saved = binding(key);
    const live = await nativeSessions.session(first);
    const dispose = live.adapter.dispose.bind(live.adapter);
    const closing = vi
      .spyOn(live.adapter, "dispose")
      .mockImplementation(async () => {
        await dispose();
        if (kind === "generation")
          db.prepare(
            "UPDATE companion_sessions SET generation=?,native_id=? WHERE conversation_id=?",
          ).run("new-generation", "new-native-session", key);
      });
    if (kind === "insert")
      db.exec(
        "CREATE TEMP TRIGGER fail_binding_insert BEFORE INSERT ON companion_sessions WHEN NEW.harness='acp' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END",
      );
    try {
      const task = await run(project, key + "-switch", {
        conversation: key,
        agent: key,
        harness: "acp",
      });
      expect(result(task).state).toBe("failed");
      expect(binding(key)).toMatchObject({
        harness: saved.harness,
        project: saved.project,
        native_id:
          kind === "generation" ? "new-native-session" : saved.native_id,
        generation: kind === "generation" ? "new-generation" : saved.generation,
      });
      expect(
        db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(task.id),
      ).toBeUndefined();
    } finally {
      closing.mockRestore();
      db.exec("DROP TRIGGER IF EXISTS fail_binding_insert");
    }
  },
);

it.each(["live", "cached", "restarted"])(
  "validates an ordinary folder before returning its %s command catalog",
  async (mode) => {
    const key = "catalog-" + mode;
    const project = directory(key);
    const first = await run(project, key);
    expect(result(first).state).toBe("completed");
    const agent = { id: key, connection_id: "native-grok" };
    expect((await nativeSessions.catalog(agent, key)).available).toBe(true);
    const sessions = mode === "live" ? nativeSessions : new NativeSessions();
    try {
      if (mode !== "live")
        await nativeSessions.dispose(await nativeSessions.session(first));
      if (mode === "cached")
        expect((await sessions.catalog(agent, key)).available).toBe(true);
      const saved = binding(key);
      const before = requests().length;
      gitProject(project);
      await expect(sessions.catalog(agent, key)).rejects.toThrow(
        /Start a new conversation/,
      );
      expect(requests()).toHaveLength(before);
      expect(binding(key)).toEqual(saved);
    } finally {
      if (sessions !== nativeSessions) await sessions.close();
    }
  },
);

it.each(["live", "cached", "restarted"])(
  "validates an existing worktree before returning its %s command catalog",
  async (mode) => {
    const key = "git-catalog-" + mode;
    const project = directory(key);
    gitProject(project);
    const first = await run(project, key);
    expect(result(first).state).toBe("completed");
    const agent = { id: key, connection_id: "native-grok" };
    expect((await nativeSessions.catalog(agent, key)).available).toBe(true);
    const sessions = mode === "live" ? nativeSessions : new NativeSessions();
    try {
      if (mode !== "live")
        await nativeSessions.dispose(await nativeSessions.session(first));
      if (mode === "cached")
        expect((await sessions.catalog(agent, key)).available).toBe(true);
      const saved = binding(key);
      const before = requests().length;
      renameSync(join(project, ".git"), join(project, "saved-git"));
      await expect(sessions.catalog(agent, key)).rejects.toThrow(
        /worktree could not be verified/,
      );
      expect(requests()).toHaveLength(before);
      expect(binding(key)).toEqual(saved);
    } finally {
      if (sessions !== nativeSessions) await sessions.close();
    }
  },
);

it("keeps Git subdirectories isolated per agent and reuses a worktree across conversations", async () => {
  const project = directory("repo");
  const git = gitProject(project);
  const nested = join(project, "notes");
  mkdirSync(nested);
  writeFileSync(join(nested, "idea.txt"), "Committed idea");
  git("add", "notes");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "notes",
  );
  const first = await run(nested, "git-first");
  const checkout = binding("git-first").project;
  expect(result(first).state).toBe("completed");
  expect(checkout).not.toBe(nested);
  expect(binding("git-first").worktree_source).toBe(nested);
  expect(readFileSync(join(checkout, "idea.txt"), "utf8")).toBe(
    "Committed idea",
  );
  writeFileSync(join(checkout, "idea.txt"), "Agent's unfinished idea");
  expect(
    result(await run(nested, "git-second-conversation", { agent: "git-first" }))
      .state,
  ).toBe("completed");
  expect(binding("git-second-conversation").project).toBe(checkout);
  expect(readFileSync(join(checkout, "idea.txt"), "utf8")).toBe(
    "Agent's unfinished idea",
  );
  expect(result(await run(nested, "git-other-agent")).state).toBe("completed");
  expect(binding("git-other-agent").project).not.toBe(checkout);
  expect(readFileSync(join(nested, "idea.txt"), "utf8")).toBe("Committed idea");
  expect(
    db.prepare("SELECT state FROM run_checkouts WHERE run_id=?").get(first.id),
  ).toEqual({ state: "captured" });
});

it.each(["empty", "broken", "invalid-config"])(
  "does not fall back to a shared folder for a %s Git repository",
  async (kind) => {
    const project = directory(kind);
    if (kind === "broken") mkdirSync(join(project, ".git"));
    else execFileSync("git", ["-C", project, "init"], { stdio: "ignore" });
    if (kind === "invalid-config")
      writeFileSync(join(project, ".git", "config"), "[broken");
    const task = await run(project, kind);
    expect(result(task).state).toBe("failed");
    expect(binding(kind)).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(task.id),
    ).toBeUndefined();
  },
);

it("requires a new conversation when an ordinary folder becomes a repository, preserving its old session", async () => {
  const project = directory("becomes-git");
  expect(result(await run(project, "before-git")).state).toBe("completed");
  const saved = binding("before-git");
  gitProject(project);
  const followup = await run(project, "after-git", {
    conversation: "before-git",
    agent: "before-git",
  });
  expect(result(followup).state).toBe("failed");
  expect(result(followup).error).toContain("Start a new conversation");
  expect(binding("before-git")).toMatchObject({
    project,
    native_id: saved.native_id,
    worktree_source: null,
  });
  const switched = await run(project, "after-git-switch", {
    conversation: "before-git",
    agent: "before-git",
    harness: "acp",
  });
  expect(result(switched).state).toBe("failed");
  expect(binding("before-git").harness).toBe("grok");
  const fresh = await run(project, "after-git-new", { agent: "before-git" });
  expect(result(fresh)).toMatchObject({ state: "completed" });
  expect(binding("after-git-new").project).not.toBe(project);
  expect(binding("after-git-new").worktree_source).toBe(project);
});

it("does not replace an existing checkout with its source when Git metadata disappears", async () => {
  const project = directory("lost-git");
  gitProject(project);
  expect(result(await run(project, "before-loss")).state).toBe("completed");
  const saved = binding("before-loss");
  renameSync(join(project, ".git"), join(project, "saved-git"));
  const task = await run(project, "after-loss", {
    conversation: "before-loss",
    agent: "before-loss",
  });
  expect(result(task).state).toBe("failed");
  expect(binding("before-loss")).toMatchObject({
    project: saved.project,
    native_id: saved.native_id,
    worktree_source: project,
  });
});

it("rejects redirected ordinary folders and changed agent identities before dispatch", async () => {
  const project = directory("redirected");
  expect(result(await run(project, "before-redirect")).state).toBe("completed");
  const saved = binding("before-redirect");
  const reassigned = await run(project, "other-identity", {
    conversation: "before-redirect",
  });
  expect(result(reassigned).state).toBe("failed");
  expect(binding("before-redirect").worktree_agent_id).toBe("before-redirect");
  renameSync(project, project + "-saved");
  symlinkSync(other, project);
  const redirected = await run(project, "after-redirect", {
    conversation: "before-redirect",
    agent: "before-redirect",
  });
  expect(result(redirected).state).toBe("failed");
  expect(binding("before-redirect")).toMatchObject({
    project,
    native_id: saved.native_id,
  });
  expect(
    db
      .prepare("SELECT 1 FROM native_dispatch WHERE run_id=?")
      .get(redirected.id),
  ).toBeUndefined();
});
