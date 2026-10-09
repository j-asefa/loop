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
    status: 409,
    data: { error: expect.stringContaining("direct harness execution") },
  });
  expect(codex).not.toHaveBeenCalled();
  expect(
    (await catalog(aid, conversation(aid, codexConnection, "another-owner")))
      .status,
  ).toBe(404);
  expect((await catalog(aid, "invalid")).status).not.toBe(200);
});

it("never probes a direct harness when listing legacy connection commands", async () => {
  for (const connectionId of [codexConnection, piConnection]) {
    const aid = agent(connectionId);
    const codex = vi.spyOn(Codex.prototype, "start");
    const pi = vi.spyOn(Pi.prototype, "start");
    expect((await catalog(aid)).status).toBe(409);
    expect((await catalog(aid, directChat(aid))).status).toBe(409);
    expect(codex).not.toHaveBeenCalled(); expect(pi).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
});
