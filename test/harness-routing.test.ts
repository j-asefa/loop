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
const { HapiClient } = await import("../src/server/hapi/client");
const { provisionEnvironment } =
  await import("../src/server/hapi/environments");
const { billingPolicy, piPolicy } =
  await import("../src/server/hapi/contracts");

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
const env = provisionEnvironment(OWNER, {
  name: "Catalog fixture",
  url: "https://worker.invalid:3010",
  instanceId: "i-1234567890abcdef0",
  namespace: "catalog",
  credential: "a".repeat(48),
  certificateFingerprint: "AB:".repeat(31) + "AB",
});
const managedCodex = connection({
  backend: "hapi",
  authMode: "subscription",
  environmentId: env,
  flavor: "codex",
  billing: billingPolicy,
});
const managedPi = connection({
  backend: "hapi",
  authMode: "existing",
  environmentId: env,
  flavor: "pi",
  billing: piPolicy,
});
function managedChat(
  aid: string,
  flavor: "codex" | "pi",
  createdAt: number,
  launched = true,
) {
  const cid = conversation(aid, flavor === "codex" ? managedCodex : managedPi);
  db.prepare(
    "UPDATE conversations SET execution_backend='hapi' WHERE id=?",
  ).run(cid);
  db.prepare(
    "INSERT INTO native_sessions(conversation_id,owner_id,environment_id,generation,flavor,billing,launch_id,hub_session_id,gateway_secret,gateway_hash,created_at) VALUES(?,?,?,1,?,?,?,?, 'fixture','fixture',?)",
  ).run(
    cid,
    OWNER,
    env,
    flavor,
    JSON.stringify(flavor === "codex" ? billingPolicy : piPolicy),
    id(),
    launched ? "hub-" + cid : null,
    createdAt,
  );
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

it("fetches the requested managed Codex chat, not the agent's newer Pi chat", async () => {
  const aid = agent(managedPi);
  const cid = managedChat(aid, "codex", 1);
  managedChat(aid, "pi", 2);
  const request = vi
    .spyOn(HapiClient.prototype, "request")
    .mockImplementation(async (path) => {
      expect(path).toContain("/hub-" + cid + "/");
      return path.endsWith("/skills")
        ? { skills: [{ name: "goal" }] }
        : { commands: [{ name: "review" }] };
    });
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: {
      runtime: "codex",
      commands: [{ token: "/review" }, { token: "$goal" }],
    },
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("uses the requested managed chat even when another chat uses the same harness", async () => {
  const aid = agent(managedCodex),
    cid = managedChat(aid, "codex", 1);
  managedChat(aid, "codex", 2);
  vi.spyOn(HapiClient.prototype, "request").mockImplementation(async (path) => {
    expect(path).toContain("/hub-" + cid + "/");
    return { commands: [], skills: [] };
  });
  expect((await catalog(aid, cid)).status).toBe(200);
});

it("discovers the bound managed Pi catalog with its existing-provider billing mode", async () => {
  const aid = agent(managedCodex),
    cid = managedChat(aid, "pi", 1);
  vi.spyOn(HapiClient.prototype, "request").mockImplementation(async (path) => {
    expect(path).toContain("/hub-" + cid + "/");
    return path.endsWith("/skills")
      ? { skills: [{ name: "pi-skill" }] }
      : { commands: [{ name: "pi-command" }] };
  });
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: {
      available: true,
      runtime: "pi",
      commands: [{ token: "/pi-command" }, { token: "/skill:pi-skill" }],
    },
  });
});

it("does not substitute another managed chat when the selected chat has not launched", async () => {
  const aid = agent(managedCodex),
    cid = managedChat(aid, "codex", 1, false);
  managedChat(aid, "codex", 2);
  const request = vi.spyOn(HapiClient.prototype, "request");
  expect(await catalog(aid, cid)).toMatchObject({
    status: 200,
    data: { available: false, commands: [] },
  });
  expect(request).not.toHaveBeenCalled();
});

it("uses an older launched managed session for a new task", async () => {
  const aid = agent(managedCodex),
    launched = managedChat(aid, "codex", 1);
  managedChat(aid, "codex", 2, false);
  vi.spyOn(HapiClient.prototype, "request").mockImplementation(async (path) => {
    expect(path).toContain("/hub-" + launched + "/");
    return path.endsWith("/skills")
      ? { skills: [] }
      : { commands: [{ name: "review" }] };
  });
  expect(await catalog(aid)).toMatchObject({
    status: 200,
    data: { available: true, commands: [{ token: "/review" }] },
  });
});

it("refuses a legacy chat after the agent moves to a managed runtime", async () => {
  const aid = agent(managedCodex),
    cid = conversation(aid, codexConnection);
  db.prepare(
    "UPDATE conversations SET execution_backend='legacy' WHERE id=?",
  ).run(cid);
  expect((await catalog(aid, cid)).status).toBe(409);
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

it("lists a managed catalog while its connection reports disconnected, as runs still proceed", async () => {
  const disconnected = connection({
    backend: "hapi",
    authMode: "subscription",
    environmentId: env,
    flavor: "codex",
    billing: billingPolicy,
  });
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    disconnected,
  );
  const aid = agent(disconnected),
    cid = managedChat(aid, "codex", 1);
  db.prepare(
    "UPDATE conversations SET execution_connection_id=? WHERE id=?",
  ).run(disconnected, cid);
  vi.spyOn(HapiClient.prototype, "request").mockResolvedValue({
    commands: [],
    skills: [],
  });
  expect((await catalog(aid, cid)).status).toBe(200);
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
