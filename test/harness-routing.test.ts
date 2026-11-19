import {
  seedAgent,
  seedConnection,
  seedConversation,
  seedRun,
} from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { fixtureAdapter, fixtureBinding } from "./fixtures/native-session.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { delimiter, join } from "node:path";

import { Router } from "express";
import { until } from "./helpers/wait.js";
import { gitProject } from "./helpers/git-project.js";
import { harnessFixture } from "./helpers/harness-fixture.js";

const dir = realpathSync(testDirectory());
const harnesses = harnessFixture(dir);

const { db, id, now } = await import("../src/server/db");
const { core } = await import("../src/server/core-routes");
const { nativeHistory } = await import("../src/server/native-history");
const { nativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
const originalProject = join(dir, "original");
mkdirSync(originalProject);
for (const harness of ["codex", "pi"] as const) {
  db.prepare("INSERT INTO harnesses VALUES(?,?,'{}','{}','[]',0)").run(
    harness,
    JSON.stringify({
      harness,
      executable: harnesses.executable(harness),
      project: dir,
      billing: "existing",
      version: "fixture",
    }),
  );
}
function connection(metadata: object, owner = OWNER) {
  const cid = id();
  seedConnection(db, {
    id: cid,
    owner_id: owner,
    provider: "codex",
    secret: "",
    models: "[]",
    metadata: JSON.stringify(metadata),
    created_at: now(),
  });
  return cid;
}
const codexConnection = connection({ loopHarness: "codex" });
const piConnection = connection({ loopHarness: "pi" });
function agent(connectionId = piConnection) {
  const aid = id();
  seedAgent(db, {
    id: aid,
    owner_id: OWNER,
    name: "agent-" + aid,
    normalized_name: "agent-" + aid,
    provider: "pi",
    model: "fixture",
    connection_id: connectionId,
    created_at: now(),
  });
  return aid;
}
function conversation(aid: string, connectionId: string, owner = OWNER) {
  const cid = id();
  seedConversation(db, {
    id: cid,
    owner_id: owner,
    agent_id: aid,
    title: "Fixture",
    execution_connection_id: connectionId,
    created_at: now(),
  });
  return cid;
}
function directChat(aid: string) {
  const cid = conversation(aid, codexConnection);
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,updated_at,worktree_agent_id) VALUES(?,'codex',?,?,?)",
  ).run(cid, originalProject, now(), aid);
  return cid;
}
const health = Router();
health.get("/fixture-health", (_req, res) => res.json({ ok: true }));
const app = await productionApp(OWNER, [health, core, nativeHistory]);
async function catalog(aid: string, cid?: string) {
  const response = await fetch(
    `${app.url}/api/agents/${aid}/harness` +
      (cid ? "?conversation=" + cid : ""),
  );
  return { status: response.status, data: await response.json() };
}
afterEach(() => {
  nativeSessions.projects.clearProbes();
  harnesses.reset();
});
afterAll(async () => {
  await app.close();
  await nativeSessions.close();
  db.close();
});

it("probes the agent's new harness in the chat's project after a switch to Pi", async () => {
  // session() rebinds the chat to Pi on its next turn and keeps the project,
  // so the catalog must list the commands that turn will accept.
  const aid = agent(),
    cid = directChat(aid);
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: { runtime: "Pi", commands: [{ token: "/pi-command" }] },
  });
  expect(harnesses.launches("pi")).toMatchObject([{ cwd: originalProject }]);
  expect(harnesses.requests("pi", "prompt")).toEqual([]);
  expect(harnesses.launches("codex")).toEqual([]);
});

it("probes the bound project when the chat stays on its harness", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: { runtime: "Codex" },
  });
  expect(harnesses.launches("codex")).toMatchObject([{ cwd: originalProject }]);
  expect(harnesses.requests("codex", "thread/start")).toEqual([]);
  expect(harnesses.requests("codex", "thread/resume")).toEqual([]);
});

it("rejects a conversation bound to another agent before starting a native probe", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  db.prepare(
    "UPDATE companion_sessions SET worktree_agent_id='other-agent' WHERE conversation_id=?",
  ).run(cid);
  expect(await catalog(aid, cid)).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining("Start a new conversation") },
  });
  expect(harnesses.launches("codex")).toEqual([]);
});

it("loads and reuses an ordinary-folder catalog despite inherited Git metadata", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  harnesses.respond("codex", "skills/list", {
    result: {
      data: [
        {
          skills: [
            {
              name: "fixture",
              path: join(dir, "SKILL.md"),
              enabled: true,
              description: "Fixture",
            },
          ],
        },
      ],
    },
  });
  nativeSessions.projects.clearProbes();
  vi.stubEnv("GIT_DIR", join(dir, "missing-git"));
  try {
    for (let request = 0; request < 2; request++)
      expect(await catalog(aid, cid)).toMatchObject({
        status: 200,
        data: { commands: [{ token: "$fixture" }] },
      });
    expect(harnesses.launches("codex")).toMatchObject([
      { cwd: originalProject },
    ]);
  } finally {
    vi.unstubAllEnvs();
    nativeSessions.projects.clearProbes();
  }
});

it("returns actionable guidance for a deleted catalog directory", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid),
    project = join(dir, "deleted-project");
  mkdirSync(project);
  db.prepare(
    "UPDATE companion_sessions SET project=? WHERE conversation_id=?",
  ).run(project, cid);
  rmSync(project, { recursive: true });
  expect(await catalog(aid, cid)).toMatchObject({
    status: 422,
    data: {
      error: expect.stringContaining(
        "Restore it or choose an existing directory",
      ),
    },
  });
  expect(harnesses.launches("codex")).toEqual([]);
});

it("keeps the API responsive, bounds shared catalog checks and recovers after Git failures", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid),
    bin = join(dir, "slow-git"),
    started = join(bin, "started"),
    release = join(bin, "release"),
    finished = join(bin, "finished"),
    failure = join(bin, "failure");
  mkdirSync(bin);
  writeFileSync(failure, "fail the first checks");
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(started)}, "started\\n");
function finish() {
  fs.writeFileSync(${JSON.stringify(finished)}, "done");
  process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");
  process.exit(fs.existsSync(${JSON.stringify(failure)}) ? 1 : 128);
}
setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) finish(); }, 10);
setTimeout(finish, 2000);
`,
    { mode: 0o755 },
  );
  nativeSessions.projects.clearProbes();
  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath || "");
  const pending = [catalog(aid, cid), catalog(aid, cid)];
  try {
    await until(() => existsSync(started));
    const other = [agent(codexConnection), agent(codexConnection)];
    for (const id of other) pending.push(catalog(id, directChat(id)));
    await until(
      () => readFileSync(started, "utf8").trim().split("\n").length === 3,
    );
    const busyAgent = agent(codexConnection),
      busyChat = directChat(busyAgent);
    expect((await catalog(busyAgent, busyChat)).status).toBe(429);
    const health = await fetch(`${app.url}/api/fixture-health`);
    expect(await health.json()).toEqual({ ok: true });
    expect(existsSync(finished)).toBe(false);
    expect(readFileSync(started, "utf8").trim().split("\n")).toHaveLength(3);
    writeFileSync(release, "continue");
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([
      409, 409, 409, 409,
    ]);
    rmSync(failure);
    expect((await catalog(busyAgent, busyChat)).status).toBe(200);
  } finally {
    writeFileSync(release, "continue");
    await Promise.allSettled(pending);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    nativeSessions.projects.clearProbes();
  }
});

it("prepares a fork asynchronously before recording or dispatching the native effect", async () => {
  const catalogId = id(),
    commandId = id(),
    bin = join(dir, "import-git"),
    started = join(bin, "started"),
    release = join(bin, "release"),
    failure = join(bin, "failure");
  mkdirSync(bin);
  writeFileSync(failure, "fail preparation");
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(started)}, "started");
function finish() {
  process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");
  process.exit(fs.existsSync(${JSON.stringify(failure)}) ? 1 : 128);
}
setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) finish(); }, 10);
setTimeout(finish, 2000);
`,
    { mode: 0o755 },
  );
  db.prepare(
    "INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Import fixture',?)",
  ).run(catalogId, "external-" + catalogId, originalProject, now());
  harnesses.respond("codex", "thread/fork", {
    result: { thread: { id: "fork-" + catalogId, turns: [] } },
  });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath || "");
  const request = () =>
    fetch(`${app.url}/api/native/history/${catalogId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId }),
    });
  const pending = request();
  try {
    await until(() => existsSync(started));
    expect(db.inTransaction).toBe(false);
    expect(harnesses.requests("codex", "thread/fork")).toEqual([]);
    const health = await fetch(`${app.url}/api/fixture-health`);
    expect(await health.json()).toEqual({ ok: true });
    writeFileSync(release, "continue");
    expect((await pending).status).toBe(409);
    expect(
      db
        .prepare("SELECT 1 FROM native_history_actions WHERE id=?")
        .get(commandId),
    ).toBeUndefined();
    expect(harnesses.requests("codex", "thread/fork")).toEqual([]);
    rmSync(failure);
    const otherCatalog = id();
    db.prepare(
      "INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Other import fixture',?)",
    ).run(otherCatalog, "external-" + otherCatalog, originalProject, now());
    const savedPreparation = db
      .prepare(
        "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?",
      )
      .get(OWNER, commandId);
    const rebound = await fetch(
      `${app.url}/api/native/history/${otherCatalog}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId }),
      },
    );
    expect(rebound.status).toBe(409);
    expect((await rebound.json()).error).toContain(
      "Command identity belongs to another conversation",
    );
    expect(
      db
        .prepare(
          "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?",
        )
        .get(OWNER, commandId),
    ).toEqual(savedPreparation);
    expect(
      db
        .prepare("SELECT 1 FROM native_history_actions WHERE id=?")
        .get(commandId),
    ).toBeUndefined();
    expect(harnesses.requests("codex", "thread/fork")).toEqual([]);
    rmSync(started);
    rmSync(release);
    const racing = request();
    await until(() => existsSync(started));
    const winningWorkspace = JSON.stringify({
      directory: originalProject,
      worktreeSource: null,
    });
    db.prepare(
      "UPDATE native_import_workspaces SET workspace=? WHERE owner_id=? AND kind='fork' AND import_key=?",
    ).run(winningWorkspace, OWNER, commandId);
    writeFileSync(release, "continue");
    const raced = await racing;
    expect(raced.status).toBe(409);
    expect((await raced.json()).error).toContain("changed during preparation");
    expect(
      db
        .prepare(
          "SELECT workspace FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?",
        )
        .get(OWNER, commandId),
    ).toEqual({ workspace: winningWorkspace });
    expect(harnesses.requests("codex", "thread/fork")).toEqual([]);
    const response = await request();
    expect(response.status).toBe(201);
    const imported = await response.json();
    expect(harnesses.requests("codex", "thread/fork")).toMatchObject([
      {
        params: { threadId: "external-" + catalogId, cwd: originalProject },
      },
    ]);
    expect(await (await request()).json()).toEqual(imported);
    expect(harnesses.requests("codex", "thread/fork")).toHaveLength(1);
  } finally {
    writeFileSync(release, "continue");
    await Promise.allSettled([pending]);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

it("preserves both records when a fork result is handed off elsewhere before its import", async () => {
  const { resumeFromDesktop } = await import("../src/server/migration.js");
  const catalogId = id(),
    commandId = id(),
    nativeId = "competing-fork-" + catalogId;
  const destination = join(dir, "competing-handoff-" + catalogId);
  mkdirSync(destination);
  db.prepare(
    "INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Competing fork fixture',?)",
  ).run(catalogId, "external-" + catalogId, originalProject, now());
  const release = harnesses.hold("codex", "thread/fork", {
    thread: { id: nativeId, turns: [] },
  });
  const request = () =>
    fetch(`${app.url}/api/native/history/${catalogId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId }),
    });
  const pending = request();
  try {
    await until(() => harnesses.requests("codex", "thread/fork").length === 1);
    const handoff = await resumeFromDesktop(
      {
        ...nativeSessions.projects.registration("codex"),
        project: destination,
      },
      nativeId,
    );
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("different workspace");
    expect(
      db
        .prepare(
          "SELECT project FROM companion_sessions WHERE conversation_id=?",
        )
        .get(handoff),
    ).toEqual({ project: destination });
    expect(
      db
        .prepare(
          "SELECT state,conversation_id FROM native_history_actions WHERE id=?",
        )
        .get(commandId),
    ).toEqual({ state: "unknown", conversation_id: null });
    const retained = db
      .prepare(
        "SELECT workspace,imported_at FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?",
      )
      .get(OWNER, commandId) as any;
    expect(retained.imported_at).toBeNull();
    expect(JSON.parse(retained.workspace)).toEqual({
      directory: originalProject,
      worktreeSource: null,
    });
    expect((await request()).status).toBe(409);
    expect(harnesses.requests("codex", "thread/fork")).toHaveLength(1);
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
});

it.each(["native-fork", "import-transaction"])(
  "retains the prepared workspace after a %s failure without replaying the fork",
  async (mode) => {
    const { prepareImportSession } = await import("../src/server/migration.js");
    const catalogId = id(),
      commandId = id(),
      project = join(dir, "failed-fork-" + mode);
    mkdirSync(project);
    gitProject(project);
    db.prepare(
      "INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Failed fork fixture',?)",
    ).run(catalogId, "external-" + catalogId, project, now());
    if (mode === "native-fork")
      harnesses.respond("codex", "thread/fork", {
        error: { code: -32000, message: "fixture native fork failure" },
      });
    else {
      harnesses.respond("codex", "thread/fork", {
        result: { thread: { id: "fork-" + catalogId, turns: [] } },
      });
      db.exec(
        "CREATE TRIGGER fail_fork_import BEFORE INSERT ON companion_sessions BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END",
      );
    }
    const request = () =>
      fetch(`${app.url}/api/native/history/${catalogId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId }),
      });
    try {
      expect((await request()).status).toBe(500);
      const preparation = db
        .prepare(
          "SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?",
        )
        .get(OWNER, commandId) as any;
      const workspace = JSON.parse(preparation.workspace);
      expect(workspace.worktreeSource).toBe(project);
      expect(existsSync(join(workspace.directory, ".git"))).toBe(true);
      expect(
        db
          .prepare(
            "SELECT state,conversation_id FROM native_history_actions WHERE id=?",
          )
          .get(commandId),
      ).toEqual({ state: "unknown", conversation_id: null });
      expect((await request()).status).toBe(409);
      expect(harnesses.requests("codex", "thread/fork")).toHaveLength(1);
      const recovered = await prepareImportSession(
        { ...nativeSessions.projects.registration("codex"), project },
        "fork",
        commandId,
        JSON.stringify([catalogId, "external-" + catalogId]),
      );
      expect(recovered).toEqual({
        agent: preparation.agent_id,
        project,
        workspace,
      });
      expect(
        readdirSync(join(project, ".git", "loop-agent-worktrees")),
      ).toHaveLength(1);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_fork_import");
    }
  },
);

it("uses the live chat catalog only while the agent stays on that harness", async () => {
  const session = {
    closed: false,
    adapter: {
      commandCatalog: { revision: 7 },
      commands: [
        {
          name: "review",
          token: "/review",
          kind: "command",
          description: "Codex review",
        },
      ],
    },
  };
  const same = agent(codexConnection),
    kept = directChat(same);
  const switched = agent(),
    moved = directChat(switched);
  const attach = (conversation: string) =>
    nativeSessions.state.attach({
      generation: "fixture",
      bootstrapRun: undefined as never,
      binding: fixtureBinding({
        conversation_id: conversation,
        generation: "fixture",
        harness: "codex",
      }),
      adapter: fixtureAdapter({
        ...session.adapter,
        commandCatalog: { revision: 7, commands: [] },
      }),
    });
  const keptSession = attach(kept),
    movedSession = attach(moved);
  try {
    expect(await catalog(same, kept)).toMatchObject({
      status: 200,
      data: { runtime: "Codex", revision: 7, commands: [{ token: "/review" }] },
    });
    expect(harnesses.launches("pi")).toEqual([]);
    expect(await catalog(switched, moved)).toMatchObject({
      status: 200,
      data: { runtime: "Pi", commands: [{ token: "/pi-command" }] },
    });
  } finally {
    nativeSessions.state.remove(keptSession);
    nativeSessions.state.remove(movedSession);
  }
});

it.each(["live", "cached"])(
  "serves a %s catalog while unrelated harness probes fill their capacity",
  async (mode) => {
    nativeSessions.projects.clearProbes();
    const aid = agent(codexConnection),
      cid = directChat(aid);
    if (mode === "live")
      nativeSessions.state.attach({
        generation: "fixture",
        bootstrapRun: undefined as never,
        binding: fixtureBinding({
          conversation_id: cid,
          generation: "fixture",
          harness: "codex",
        }),
        adapter: fixtureAdapter({
          commands: [],
          commandCatalog: { revision: 3, commands: [] },
        }),
      });
    else expect((await catalog(aid, cid)).status).toBe(200);
    const before = harnesses.launches("codex").length;
    const release = harnesses.hold("codex", "skills/list", { data: [] });
    const pending: ReturnType<typeof catalog>[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const other = agent(codexConnection),
          folder = id(),
          project = join(dir, "probe-" + mode + i);
        mkdirSync(project);
        db.prepare(
          "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,'Probe','project',?)",
        ).run(folder, OWNER, now());
        db.prepare("INSERT INTO project_paths(folder_id,path) VALUES(?,?)").run(
          folder,
          project,
        );
        db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(
          folder,
          other,
        );
        pending.push(catalog(other));
      }
      await until(() => harnesses.launches("codex").length === before + 3);
      expect(await catalog(aid, cid)).toMatchObject({
        status: 200,
        data: { runtime: "Codex", commands: [] },
      });
    } finally {
      release();
      await Promise.allSettled(pending);
      const current = nativeSessions.state.find(cid);
      if (current) nativeSessions.state.remove(current);
      nativeSessions.projects.clearProbes();
    }
  },
);

it("ignores a stale execution connection on a non-managed chat", async () => {
  const aid = agent(codexConnection);
  const stale = connection({ backend: "runtime" });
  const cid = conversation(aid, stale);
  db.prepare("DELETE FROM connections WHERE id=?").run(stale);
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: { runtime: "Codex" },
  });
});

it("reports a disconnected agent connection instead of probing a bound chat", async () => {
  const disconnected = connection({ loopHarness: "codex" });
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    disconnected,
  );
  const aid = agent(disconnected),
    cid = directChat(aid);
  expect((await catalog(aid, cid)).status).toBe(409);
  expect(harnesses.launches("codex")).toEqual([]);
});

it("uses the agent's current harness for a new task", async () => {
  const aid = agent();
  directChat(aid);
  expect(await catalog(aid)).toMatchObject({
    status: 200,
    data: { runtime: "Pi", commands: [{ token: "/pi-command" }] },
  });
  expect(harnesses.launches("pi")).toHaveLength(1);
});

it("shares one recent probe across polls", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  nativeSessions.projects.clearProbes();
  expect((await catalog(aid, cid)).status).toBe(200);
  expect((await catalog(aid, cid)).status).toBe(200);
  expect(harnesses.launches("codex")).toHaveLength(1);
  nativeSessions.projects.clearProbes();
});

it("probes the folder the next turn uses, not the agent's newer folder", async () => {
  const folder = id(),
    elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere);
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,'Elsewhere','project',?)",
  ).run(folder, OWNER, now());
  db.prepare("INSERT INTO project_paths(folder_id,path) VALUES(?,?)").run(
    folder,
    elsewhere,
  );
  const aid = agent(codexConnection),
    cid = conversation(aid, codexConnection);
  // The conversation's last run had no folder; the agent got one later.
  seedRun(db, {
    id: id(),
    owner_id: OWNER,
    agent_id: aid,
    conversation_id: cid,
    input: "earlier",
    state: "completed",
    idempotency_key: id(),
    created_at: now(),
    updated_at: now(),
  });
  db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(folder, aid);
  nativeSessions.projects.clearProbes();
  expect((await catalog(aid, cid)).status).toBe(200);
  expect(harnesses.launches("codex")).toMatchObject([{ cwd: dir }]);
  nativeSessions.projects.clearProbes();
});

it("keeps discovery within the requested owner and agent", async () => {
  const aid = agent(),
    other = agent();
  // Another agent's conversation says nothing about this agent's next turn:
  // list this agent's new-task catalog, not the other conversation's.
  expect(await catalog(aid, directChat(other))).toMatchObject({
    status: 200,
    data: { runtime: "Pi" },
  });
  expect(harnesses.launches("codex")).toEqual([]);
  expect(
    (await catalog(aid, conversation(aid, codexConnection, "another-owner")))
      .status,
  ).toBe(404);
  expect((await catalog(aid, "invalid")).status).not.toBe(200);
});
