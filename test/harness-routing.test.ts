import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-harness-routing-")));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_HAPI_URL = "http://fixture";
process.env.LOOP_HAPI_TOKEN = "fixture";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { core } = await import("../src/server/core-routes");
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
    "INSERT INTO companion_sessions(conversation_id,harness,project,updated_at) VALUES(?,'codex',?,?)",
  ).run(cid, originalProject, now());
  return cid;
}
const app = express();
app.use((_req, res, next) => {
  res.locals.owner = OWNER;
  next();
});
app.use(core);
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
