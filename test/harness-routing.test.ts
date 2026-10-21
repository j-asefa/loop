import { afterAll, afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-harness-routing-")));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_HAPI_URL = "http://fixture";
process.env.LOOP_HAPI_TOKEN = "fixture";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { core } = await import("../src/server/core-routes");
const { nativeHistory } = await import("../src/server/native-history");
const { nativeSessions, OWNER } = await import("../src/server/native-sessions");
const { Codex } = await import("../src/adapters/codex");
const { Pi } = await import("../src/adapters/pi");
const originalProject = join(dir, "original");
mkdirSync(originalProject);
for (const harness of ["codex", "pi"]) {
  db.prepare("INSERT INTO harnesses VALUES(?,?,'{}','{}','[]',0)").run(
    harness,
    JSON.stringify({
      harness,
      executable: "/fixture/" + harness,
      project: dir,
      billing: "existing",
      version: "fixture",
    }),
  );
}
function connection(metadata: object, owner = OWNER) {
  const cid = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'codex','Fixture','','connected','[]',?,?)",
  ).run(cid, owner, JSON.stringify(metadata), now());
  return cid;
}
const codexConnection = connection({ loopHarness: "codex" });
const piConnection = connection({ loopHarness: "pi" });
function agent(connectionId = piConnection) {
  const aid = id();
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,connection_id,created_at) VALUES(?,?,?,?, 'pi','fixture',?,?)",
  ).run(aid, OWNER, "agent-" + aid, "agent-" + aid, connectionId, now());
  return aid;
}
function conversation(aid: string, connectionId: string, owner = OWNER) {
  const cid = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,execution_connection_id,created_at) VALUES(?,?,?,'Fixture',?,?)",
  ).run(cid, owner, aid, connectionId, now());
  return cid;
}
function directChat(aid: string) {
  const cid = conversation(aid, codexConnection);
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,updated_at,worktree_agent_id) VALUES(?,'codex',?,?,?)",
  ).run(cid, originalProject, now(), aid);
  return cid;
}
const app = express();
app.use(express.json());
app.get("/fixture-health", (_req, res) => res.json({ ok: true }));
app.use((_req, res, next) => {
  res.locals.owner = OWNER;
  next();
});
app.use(core);
app.use(nativeHistory);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function catalog(aid: string, cid?: string) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/agents/${aid}/harness` +
      (cid ? "?conversation=" + cid : ""),
  );
  return { status: response.status, data: await response.json() };
}
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  server.close();
  await nativeSessions.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function piCommands(this: InstanceType<typeof Pi>) {
  this.commands = [
    {
      name: "pi-command",
      token: "/pi-command",
      kind: "command",
      description: "Pi command",
    },
  ];
  return {} as any;
}

it("probes the agent's new harness in the chat's project after a switch to Pi", async () => {
  // session() rebinds the chat to Pi on its next turn and keeps the project,
  // so the catalog must list the commands that turn will accept.
  const aid = agent(),
    cid = directChat(aid);
  const codex = vi.spyOn(Codex.prototype, "start");
  const pi = vi
    .spyOn(Pi.prototype, "start")
    .mockImplementation(async function (this: InstanceType<typeof Pi>) {
      expect((this as any).options).toMatchObject({
        harness: "pi",
        project: originalProject,
        probeOnly: true,
      });
      return piCommands.call(this);
    });
  vi.spyOn(Pi.prototype, "dispose").mockResolvedValue();
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: { runtime: "Pi", commands: [{ token: "/pi-command" }] },
  });
  expect(pi).toHaveBeenCalledOnce();
  expect(codex).not.toHaveBeenCalled();
});

it("probes the bound project when the chat stays on its harness", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  const start = vi
    .spyOn(Codex.prototype, "start")
    .mockImplementation(async function (this: InstanceType<typeof Codex>) {
      expect((this as any).options).toMatchObject({
        harness: "codex",
        project: originalProject,
      });
      this.commands = [];
      return {} as any;
    });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: { runtime: "Codex" },
  });
  expect(start).toHaveBeenCalledOnce();
});

it("rejects a legacy conversation catalog before starting a native probe", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  db.prepare(
    "UPDATE companion_sessions SET worktree_agent_id=NULL WHERE conversation_id=?",
  ).run(cid);
  const start = vi.spyOn(Codex.prototype, "start");
  expect(await catalog(aid, cid)).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining("Start a new conversation") },
  });
  expect(start).not.toHaveBeenCalled();
});

it("loads and reuses an ordinary-folder catalog despite inherited Git metadata", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  const start = vi.spyOn(Codex.prototype, "start").mockImplementation(async function (this: InstanceType<typeof Codex>) {
    expect((this as any).options.project).toBe(originalProject);
    this.commands = [{ name: "fixture", token: "/fixture", kind: "command", description: "Fixture" }];
    return {} as any;
  });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  nativeSessions.clearProbes();
  vi.stubEnv("GIT_DIR", join(dir, "missing-git"));
  try {
    for (let request = 0; request < 2; request++)
      expect(await catalog(aid, cid)).toMatchObject({ status: 200, data: { commands: [{ token: "/fixture" }] } });
    expect(start).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllEnvs();
    nativeSessions.clearProbes();
  }
});

it("returns actionable guidance for a deleted catalog directory", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid),
    project = join(dir, "deleted-project");
  mkdirSync(project);
  db.prepare("UPDATE companion_sessions SET project=? WHERE conversation_id=?")
    .run(project, cid);
  rmSync(project, { recursive: true });
  const start = vi.spyOn(Codex.prototype, "start");
  expect(await catalog(aid, cid)).toMatchObject({
    status: 422,
    data: { error: expect.stringContaining("Restore it or choose an existing directory") },
  });
  expect(start).not.toHaveBeenCalled();
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
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(started)}, "started\\n");
function finish() {
  fs.writeFileSync(${JSON.stringify(finished)}, "done");
  process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");
  process.exit(fs.existsSync(${JSON.stringify(failure)}) ? 1 : 128);
}
setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) finish(); }, 10);
setTimeout(finish, 2000);
`, { mode: 0o755 });
  vi.spyOn(Codex.prototype, "start").mockImplementation(async function (
    this: InstanceType<typeof Codex>,
  ) {
    this.commands = [];
    return {} as any;
  });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  nativeSessions.clearProbes();
  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath || "");
  const pending = [catalog(aid, cid), catalog(aid, cid)];
  try {
    await until(() => existsSync(started));
    const other = [agent(codexConnection), agent(codexConnection)];
    for (const id of other) pending.push(catalog(id, directChat(id)));
    await until(() => readFileSync(started, "utf8").trim().split("\n").length === 3);
    const busyAgent = agent(codexConnection),
      busyChat = directChat(busyAgent);
    expect((await catalog(busyAgent, busyChat)).status).toBe(429);
    const health = await fetch(`http://127.0.0.1:${(server.address() as any).port}/fixture-health`);
    expect(await health.json()).toEqual({ ok: true });
    expect(existsSync(finished)).toBe(false);
    expect(readFileSync(started, "utf8").trim().split("\n")).toHaveLength(3);
    writeFileSync(release, "continue");
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([409, 409, 409, 409]);
    rmSync(failure);
    expect((await catalog(busyAgent, busyChat)).status).toBe(200);
  } finally {
    writeFileSync(release, "continue");
    await Promise.allSettled(pending);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    nativeSessions.clearProbes();
  }
});

it("prepares a fork asynchronously before recording or dispatching the native effect", async () => {
  const catalogId = id(), commandId = id(), bin = join(dir, "import-git"),
    started = join(bin, "started"), release = join(bin, "release"), failure = join(bin, "failure");
  mkdirSync(bin);
  writeFileSync(failure, "fail preparation");
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(started)}, "started");
function finish() {
  process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");
  process.exit(fs.existsSync(${JSON.stringify(failure)}) ? 1 : 128);
}
setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) finish(); }, 10);
setTimeout(finish, 2000);
`, { mode: 0o755 });
  db.prepare("INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Import fixture',?)")
    .run(catalogId, "external-" + catalogId, originalProject, now());
  vi.spyOn(Codex.prototype, "start").mockResolvedValue({} as any);
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  const fork = vi.spyOn(Codex.prototype, "inspect").mockResolvedValue({ thread: { id: "fork-" + catalogId, turns: [] } });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (previousPath || "");
  const request = () => fetch(`http://127.0.0.1:${(server.address() as any).port}/native/history/${catalogId}/fork`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commandId }),
  });
  const pending = request();
  try {
    await until(() => existsSync(started));
    expect(db.inTransaction).toBe(false);
    expect(fork).not.toHaveBeenCalled();
    const health = await fetch(`http://127.0.0.1:${(server.address() as any).port}/fixture-health`);
    expect(await health.json()).toEqual({ ok: true });
    writeFileSync(release, "continue");
    expect((await pending).status).toBe(409);
    expect(db.prepare("SELECT 1 FROM native_history_actions WHERE id=?").get(commandId)).toBeUndefined();
    expect(fork).not.toHaveBeenCalled();
    rmSync(failure);
    const otherCatalog = id();
    db.prepare("INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Other import fixture',?)")
      .run(otherCatalog, "external-" + otherCatalog, originalProject, now());
    const savedPreparation = db.prepare("SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?").get(OWNER, commandId);
    const rebound = await fetch(`http://127.0.0.1:${(server.address() as any).port}/native/history/${otherCatalog}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commandId }),
    });
    expect(rebound.status).toBe(409);
    expect((await rebound.json()).error).toContain("Command identity belongs to another conversation");
    expect(db.prepare("SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?").get(OWNER, commandId)).toEqual(savedPreparation);
    expect(db.prepare("SELECT 1 FROM native_history_actions WHERE id=?").get(commandId)).toBeUndefined();
    expect(fork).not.toHaveBeenCalled();
    rmSync(started);
    rmSync(release);
    const racing = request();
    await until(() => existsSync(started));
    const winningWorkspace = JSON.stringify({ directory: originalProject, worktreeSource: null });
    db.prepare("UPDATE native_import_workspaces SET workspace=? WHERE owner_id=? AND kind='fork' AND import_key=?")
      .run(winningWorkspace, OWNER, commandId);
    writeFileSync(release, "continue");
    const raced = await racing;
    expect(raced.status).toBe(409);
    expect((await raced.json()).error).toContain("changed during preparation");
    expect(db.prepare("SELECT workspace FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?").get(OWNER, commandId))
      .toEqual({ workspace: winningWorkspace });
    expect(fork).not.toHaveBeenCalled();
    const response = await request();
    expect(response.status).toBe(201);
    const imported = await response.json();
    expect(fork).toHaveBeenCalledWith("thread/fork", { threadId: "external-" + catalogId, cwd: originalProject });
    expect(await (await request()).json()).toEqual(imported);
    expect(fork).toHaveBeenCalledOnce();
  } finally {
    writeFileSync(release, "continue");
    await Promise.allSettled([pending]);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

it("preserves both records when a fork result is handed off elsewhere before its import", async () => {
  const { resumeFromDesktop } = await import("../src/server/migration.js");
  const catalogId = id(), commandId = id(), nativeId = "competing-fork-" + catalogId;
  const destination = join(dir, "competing-handoff-" + catalogId);
  mkdirSync(destination);
  db.prepare("INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Competing fork fixture',?)")
    .run(catalogId, "external-" + catalogId, originalProject, now());
  vi.spyOn(Codex.prototype, "start").mockResolvedValue({} as any);
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  let handoff: string | undefined;
  const fork = vi.spyOn(Codex.prototype, "inspect").mockImplementation(async () => {
    handoff = await resumeFromDesktop({ ...nativeSessions.registration("codex"), project: destination }, nativeId);
    return { thread: { id: nativeId, turns: [] } };
  });
  const request = () => fetch(`http://127.0.0.1:${(server.address() as any).port}/native/history/${catalogId}/fork`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commandId }),
  });
  const response = await request();
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("different workspace");
  expect(db.prepare("SELECT project FROM companion_sessions WHERE conversation_id=?").get(handoff)).toEqual({ project: destination });
  expect(db.prepare("SELECT state,conversation_id FROM native_history_actions WHERE id=?").get(commandId))
    .toEqual({ state: "unknown", conversation_id: null });
  const retained = db.prepare("SELECT workspace,imported_at FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?").get(OWNER, commandId) as any;
  expect(retained.imported_at).toBeNull();
  expect(JSON.parse(retained.workspace)).toEqual({ directory: originalProject, worktreeSource: null });
  expect((await request()).status).toBe(409);
  expect(fork).toHaveBeenCalledOnce();
});

it.each(["native-fork", "import-transaction"])("retains the prepared workspace after a %s failure without replaying the fork", async (mode) => {
  const { prepareImportSession } = await import("../src/server/migration.js");
  const catalogId = id(), commandId = id(), project = join(dir, "failed-fork-" + mode);
  mkdirSync(project);
  gitProject(project);
  db.prepare("INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,'Failed fork fixture',?)")
    .run(catalogId, "external-" + catalogId, project, now());
  vi.spyOn(Codex.prototype, "start").mockResolvedValue({} as any);
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  const fork = vi.spyOn(Codex.prototype, "inspect");
  if (mode === "native-fork") fork.mockRejectedValue(new Error("fixture native fork failure"));
  else {
    fork.mockResolvedValue({ thread: { id: "fork-" + catalogId, turns: [] } });
    db.exec("CREATE TRIGGER fail_fork_import BEFORE INSERT ON companion_sessions BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END");
  }
  const request = () => fetch(`http://127.0.0.1:${(server.address() as any).port}/native/history/${catalogId}/fork`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commandId }),
  });
  try {
    expect((await request()).status).toBe(500);
    const preparation = db.prepare("SELECT * FROM native_import_workspaces WHERE owner_id=? AND kind='fork' AND import_key=?").get(OWNER, commandId) as any;
    const workspace = JSON.parse(preparation.workspace);
    expect(workspace.worktreeSource).toBe(project);
    expect(existsSync(join(workspace.directory, ".git"))).toBe(true);
    expect(db.prepare("SELECT state,conversation_id FROM native_history_actions WHERE id=?").get(commandId))
      .toEqual({ state: "unknown", conversation_id: null });
    expect((await request()).status).toBe(409);
    expect(fork).toHaveBeenCalledOnce();
    const recovered = await prepareImportSession({ ...nativeSessions.registration("codex"), project }, "fork", commandId, JSON.stringify([catalogId, "external-" + catalogId]));
    expect(recovered).toEqual({ agent: preparation.agent_id, project, workspace });
    expect(readdirSync(join(project, ".git", "loop-agent-worktrees"))).toHaveLength(1);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_fork_import");
  }
});

it("uses the live chat catalog only while the agent stays on that harness", async () => {
  const live = (nativeSessions as any).live as Map<string, any>;
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
  live.set(kept, session);
  live.set(moved, session);
  const pi = vi.spyOn(Pi.prototype, "start").mockImplementation(piCommands);
  vi.spyOn(Pi.prototype, "dispose").mockResolvedValue();
  try {
    expect(await catalog(same, kept)).toMatchObject({
      status: 200,
      data: { runtime: "Codex", revision: 7, commands: [{ token: "/review" }] },
    });
    expect(pi).not.toHaveBeenCalled();
    expect(await catalog(switched, moved)).toMatchObject({
      status: 200,
      data: { runtime: "Pi", commands: [{ token: "/pi-command" }] },
    });
  } finally {
    live.delete(kept);
    live.delete(moved);
  }
});

it.each(["live", "cached"])(
  "serves a %s catalog while unrelated harness probes fill their capacity",
  async (mode) => {
    nativeSessions.clearProbes();
    const aid = agent(codexConnection),
      cid = directChat(aid);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let block = false;
    let starting = 0;
    vi.spyOn(Codex.prototype, "start").mockImplementation(async function (
      this: InstanceType<typeof Codex>,
    ) {
      if (block) {
        starting++;
        await ready;
      }
      this.commands = [];
      return {} as any;
    });
    vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
    const live = (nativeSessions as any).live as Map<string, any>;
    if (mode === "live")
      live.set(cid, { closed: false, adapter: { commands: [], commandCatalog: { revision: 3 } } });
    else expect((await catalog(aid, cid)).status).toBe(200);
    block = true;
    const pending: ReturnType<typeof catalog>[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const other = agent(codexConnection),
          folder = id(),
          project = join(dir, "probe-" + mode + i);
        mkdirSync(project);
        db.prepare("INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,'Probe','project',?)")
          .run(folder, OWNER, now());
        db.prepare("INSERT INTO project_paths(folder_id,path) VALUES(?,?)")
          .run(folder, project);
        db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(folder, other);
        pending.push(catalog(other));
      }
      await until(() => starting === 3);
      expect(await catalog(aid, cid)).toMatchObject({
        status: 200,
        data: { runtime: "Codex", commands: [] },
      });
    } finally {
      release();
      await Promise.allSettled(pending);
      live.delete(cid);
      nativeSessions.clearProbes();
    }
  },
);

it("ignores a stale execution connection on a non-managed chat", async () => {
  const aid = agent(codexConnection);
  const stale = connection({ backend: "runtime" });
  const cid = conversation(aid, stale);
  db.prepare("DELETE FROM connections WHERE id=?").run(stale);
  vi.spyOn(Codex.prototype, "start").mockImplementation(async function (
    this: InstanceType<typeof Codex>,
  ) {
    this.commands = [];
    return {} as any;
  });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
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
  const start = vi.spyOn(Codex.prototype, "start");
  expect((await catalog(aid, cid)).status).toBe(409);
  expect(start).not.toHaveBeenCalled();
});

it("uses the agent's current harness for a new task", async () => {
  const aid = agent();
  directChat(aid);
  const pi = vi.spyOn(Pi.prototype, "start").mockImplementation(piCommands);
  vi.spyOn(Pi.prototype, "dispose").mockResolvedValue();
  expect(await catalog(aid)).toMatchObject({
    status: 200,
    data: { runtime: "Pi", commands: [{ token: "/pi-command" }] },
  });
  expect(pi).toHaveBeenCalledOnce();
});

it("shares one recent probe across polls", async () => {
  const aid = agent(codexConnection),
    cid = directChat(aid);
  const start = vi
    .spyOn(Codex.prototype, "start")
    .mockImplementation(async function (this: InstanceType<typeof Codex>) {
      this.commands = [];
      return {} as any;
    });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  (nativeSessions as any).clearProbes();
  expect((await catalog(aid, cid)).status).toBe(200);
  expect((await catalog(aid, cid)).status).toBe(200);
  expect(start).toHaveBeenCalledOnce();
  (nativeSessions as any).clearProbes();
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
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'earlier','completed',?,'{}',?,?)",
  ).run(id(), OWNER, aid, cid, id(), now(), now());
  db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(folder, aid);
  (nativeSessions as any).clearProbes();
  const start = vi
    .spyOn(Codex.prototype, "start")
    .mockImplementation(async function (this: InstanceType<typeof Codex>) {
      expect((this as any).options.project).toBe(dir);
      this.commands = [];
      return {} as any;
    });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  expect((await catalog(aid, cid)).status).toBe(200);
  expect(start).toHaveBeenCalledOnce();
  (nativeSessions as any).clearProbes();
});

it("keeps discovery within the requested owner and agent", async () => {
  const aid = agent(),
    other = agent();
  // Another agent's conversation says nothing about this agent's next turn:
  // list this agent's new-task catalog, not the other conversation's.
  const codex = vi.spyOn(Codex.prototype, "start");
  vi.spyOn(Pi.prototype, "start").mockImplementation(piCommands);
  vi.spyOn(Pi.prototype, "dispose").mockResolvedValue();
  expect(await catalog(aid, directChat(other))).toMatchObject({
    status: 200,
    data: { runtime: "Pi" },
  });
  expect(codex).not.toHaveBeenCalled();
  expect(
    (await catalog(aid, conversation(aid, codexConnection, "another-owner")))
      .status,
  ).toBe(404);
  expect((await catalog(aid, "invalid")).status).not.toBe(200);
});
