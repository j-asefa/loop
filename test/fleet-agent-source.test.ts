import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { Headers, Response, type fetch as undiciFetch } from "undici";
import { Host } from "../src/host.js";
import { AgentSources } from "../src/agent-sources.js";
import { fleetAgentSource } from "../src/server/fleet-agent-source.js";
import { createFleetCommandsHttp } from "../src/server/fleet-commands-http.js";
import { fleetActionInput } from "../src/shared/fleet-action-input.js";
import { FleetPeerActions } from "../src/server/fleet-peer-actions.js";
import { FleetPeerReads } from "../src/server/fleet-peer-reads.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { FleetWorkspaceActions } from "../src/server/fleet-workspace-actions.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { applyMigrations } from "../src/server/migrations.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  fleetActionRoutes,
  fleetWorkspaceActionApi,
} from "../src/shared/fleet-workspace-action-api.js";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.js";
import { fleetDeviceFromLink } from "../src/shared/fleet-pairing.js";
import { until } from "./helpers.js";
import { DoneCardsReader } from "../src/client/feed-cards.js";
import { contractCardReader } from "../src/shared/card-client.js";
import { routePath } from "../src/shared/route-path.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-source-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = join(root, "destination");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
mkdirSync(process.env.LOOP_DATA_DIR);
mkdirSync(join(root, "gateway"));
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
const { FleetWorkspaceHttpTransport } =
  await import("../src/server/fleet-workspace-http.js");
const { FleetWorkspaceActionHttpTransport } =
  await import("../src/server/fleet-workspace-action-http.js");
const { app } = await import("../src/server/index.js");
const { db } = await import("../src/server/db.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const secrets = await import("../src/server/secrets.js");
const sourceDb = new Database(join(root, "source.db"));
applyMigrations(sourceDb);
sourceDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const source = new FleetAuthority(sourceDb, secrets),
  destination = new FleetAuthority(db, secrets),
  credentials = new FleetCredentials(db, destination, secrets),
  sourceCredentials = new FleetCredentials(sourceDb, source, secrets),
  owner = randomUUID(),
  foreignOwner = randomUUID(),
  origin = "https://destination.example";
let gatewayOrigin = "https://gateway.example";
const first = source.create(owner, {
  mutationId: randomUUID(),
  name: "Gateway",
  origin: gatewayOrigin,
  scope: ["read", "act"],
});
const directory = source.revise(owner, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    { ...destination.identity, origin, name: "Remote", grantId: randomUUID() },
  ],
});
destination.approve(OWNER, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  scope: ["read", "act"],
  controller: source.identity,
  directory,
  grantId: directory.document.members[1].grantId,
});
const bridge = new FleetWorkspaceApp(app, OWNER);
const actions = new FleetWorkspaceActions(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
);
const reads = new FleetWorkspaceRead(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  { actions: () => Object.keys(fleetActionRoutes) },
);
const initial = {
  harness: "codex" as const,
  version: "fixture",
  project: root,
  billing: { mode: "existing" as const, description: "Isolated fixture" },
  capabilities: {
    approvals: true,
    questions: true,
    resume: true,
    liveAttach: false,
    terminal: false,
  },
};
const destinationPairing = new FleetPairing(
  db,
  destination,
  OWNER,
  process.env.LOOP_DATA_DIR,
);
const host = new Host(process.env.LOOP_DATA_DIR, initial, destinationPairing);
host.workspace = {
  http: app,
  peerHttp: createFleetPeerHttp(
    new FleetEnrollmentDestination(
      db,
      destination,
      destinationPairing,
      OWNER,
      secrets,
      () => origin,
    ),
    () => origin,
    { workspaceActions: actions, workspaceRead: reads, credentials },
  ),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
type Reply = { status: number; headers: IncomingHttpHeaders; body: any };
function http(
  port: number,
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        signal,
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
let actionCalls = 0,
  probeCalls = 0,
  loseReply = false,
  holdProbe: Promise<void> | undefined;
const fetcher: typeof undiciFetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe(origin);
  const headers = new Headers(init?.headers);
  for (const name of [
    "cookie",
    "authorization",
    "origin",
    "x-loop-csrf",
    "x-loop-owner",
    "x-loop-command-id",
  ])
    expect(headers.has(name)).toBe(false);
  const action = url.pathname === "/api" + fleetWorkspaceActionApi.action.path;
  if (action) actionCalls++;
  if (url.pathname === "/api" + fleetPeerApi.enrollmentProbe.path) {
    probeCalls++;
    if (holdProbe) await holdProbe;
  }
  const response = await http(
    host.port,
    origin,
    url.pathname,
    "POST",
    JSON.parse(String(init?.body)),
    { "x-loop-fleet-version": "1" },
    init?.signal ?? undefined,
  );
  if (action && loseReply)
    throw new TypeError("Fixture response lost after acceptance");
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};
const leases = new FleetCredentialLeases(
  source,
  sourceCredentials,
  owner,
  new FleetCredentialHttpTransport(fetcher),
);
const peerReads = new FleetPeerReads(
  source,
  leases,
  owner,
  new FleetWorkspaceHttpTransport(fetcher),
);
const peerActions = new FleetPeerActions(
  sourceDb,
  source,
  leases,
  owner,
  new FleetWorkspaceActionHttpTransport(fetcher),
);
const destinationLeases = new FleetCredentialLeases(
  destination,
  credentials,
  OWNER,
  new FleetCredentialHttpTransport(fetcher),
);
const destinationPeerActions = new FleetPeerActions(
  db,
  destination,
  destinationLeases,
  OWNER,
  new FleetWorkspaceActionHttpTransport(fetcher),
);
host.workspace.fleetCommandsHttp = createFleetCommandsHttp(
  destinationPairing,
  destinationPeerActions,
  actions,
);
const sourceAdapter = fleetAgentSource(source, owner, peerReads, peerActions);
const sourcePairing = new FleetPairing(
  sourceDb,
  source,
  owner,
  join(root, "gateway"),
);
const gateway = new Host(join(root, "gateway"), initial, sourcePairing);
let localCalls = 0;
gateway.workspace = {
  fleetCommandsHttp: createFleetCommandsHttp(sourcePairing, peerActions),
  sources: new AgentSources([sourceAdapter]),
  http: (_req, res) => {
    localCalls++;
    res.writeHead(404);
    res.end("{}");
  },
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
const peer = destination.identity.machineId;
const prefix = `/api/agent-sources/${encodeURIComponent("peer:" + peer)}`;
const connectionId = randomUUID(),
  foreignAgent = randomUUID();
let cookie = "",
  csrf = "";
async function pair() {
  const value = fleetDeviceFromLink(gateway.pair().url, gatewayOrigin);
  const paired = await http(
    gateway.port,
    gatewayOrigin,
    "/pair",
    "POST",
    { ...value, name: "Fixture phone" },
    { origin: gatewayOrigin },
  );
  expect(paired.status).toBe(200);
  cookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await http(
    gateway.port,
    gatewayOrigin,
    "/session",
    "GET",
    undefined,
    { cookie },
  );
  csrf = session.body.csrf;
}
const browser = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  http(gateway.port, gatewayOrigin, path, method, body, {
    cookie,
    origin: gatewayOrigin,
    "x-loop-csrf": csrf,
    ...headers,
  });
const createBody = () => ({
  name: "source-" + randomUUID().slice(0, 8),
  connectionId,
  model: "fixture",
});
beforeAll(async () => {
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',0)",
  ).run(connectionId, OWNER, JSON.stringify([{ id: "fixture" }]));
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,'Foreign','foreign','openai','fixture','untouched','loop',0)",
  ).run(foreignAgent, foreignOwner);
  await host.listen();
  host.setOrigin(origin);
  await gateway.listen();
  gateway.setOrigin(gatewayOrigin);
  await pair();
});
afterAll(async () => {
  destinationPeerActions.close();
  destinationLeases.close();
  peerActions.close();
  peerReads.close();
  leases.close();
  reads.close();
  actions.close();
  await gateway.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  sourceDb.close();
  rmSync(root, { recursive: true, force: true });
});

it("discovers only this Host's enrolled peers without contact and projects their local source", async () => {
  const before = probeCalls;
  expect((await browser("/api/agent-sources")).body).toEqual([
    { id: "peer:" + peer, name: "Remote", kind: "peer" },
  ]);
  expect(probeCalls).toBe(before);
  expect(await new AgentSources([]).discover()).toEqual([]);
  const another = new AgentSources([
    fleetAgentSource(source, foreignOwner, peerReads, peerActions),
  ]);
  expect(await another.discover()).toEqual([]);
  const capabilities = await browser(prefix + "/capabilities");
  expect(capabilities.status).toBe(200);
  expect(capabilities.body).toMatchObject({
    profile: "companion",
    pairedDevices: false,
    runtimeHosts: false,
    cardTokens: false,
    fleet: {
      version: 1,
      machineId: peer,
      events: false,
      files: false,
      actions: Object.keys(fleetActionRoutes),
    },
  });
  expect(capabilities.body.fleet.reads).toContain("agentSuggestName");
  expect((await browser(prefix + "/agents/suggest-name")).body.name).toEqual(
    expect.any(String),
  );
  const bootstrap = await browser(prefix + "/bootstrap");
  expect(bootstrap.status).toBe(200);
  expect(JSON.stringify(bootstrap.body)).not.toContain(foreignAgent);
  expect(bootstrap.headers["x-loop-change-epoch"]).toEqual(expect.any(String));
  expect(localCalls).toBe(0);
});

it("loads, pages and refreshes remote Done cards through the paired gateway without exposing another owner", async () => {
  const agent = randomUUID(),
    privateAgent = randomUUID();
  for (const [id, account] of [
    [agent, OWNER],
    [privateAgent, foreignOwner],
  ])
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'Cards',?,'openai','fixture',1)",
    ).run(id, account, id);
  function completed(account: string, selectedAgent: string, at: number) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Fleet card',1)",
    ).run(id, account, selectedAgent);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Fleet card','completed',?,?,?)",
    ).run(id, account, selectedAgent, id, id, at, at);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','Fleet answer','{}',?)",
    ).run(id, account, id, id, at);
    return id;
  }
  const older = completed(OWNER, agent, 10),
    newer = completed(OWNER, agent, 20),
    privateRun = completed(foreignOwner, privateAgent, 30);
  const request: Parameters<typeof contractCardReader>[0] = async (
    contract,
    selection,
  ) => {
    const path = routePath(contract, selection);
    const pageSize =
      contract.path === "/v1/cards"
        ? (path.includes("?") ? "&" : "?") + "limit=1"
        : "";
    const response = await browser(prefix + path + pageSize);
    if (response.status !== 200)
      throw Object.assign(new Error("Remote Cards request failed"), {
        status: response.status,
      });
    return response.body;
  };
  const reader = new DoneCardsReader(peer + ":done");
  const selection = { view: "done" as const, agent };
  const first = await reader.load(request, selection, false);
  expect(first?.page.items.map((entry) => entry.card.id)).toEqual([
    "d:run:" + newer,
  ]);
  expect(first?.page.next).toEqual(expect.any(String));
  const next = await reader.load(request, selection, true);
  expect(next?.page.items.map((entry) => entry.card.id)).toEqual([
    "d:run:" + newer,
    "d:run:" + older,
  ]);
  db.prepare(
    "UPDATE messages SET content='Updated fleet answer' WHERE id=?",
  ).run(newer);
  const updated = await reader.load(request, selection, false);
  expect(updated?.page.items[0].card.content).toBe("Updated fleet answer");
  const cards = contractCardReader(request);
  expect((await cards.detail("d:run:" + older)).content).toBe("Fleet answer");
  const all = await cards.list({ view: "done" });
  expect(all.items.map((entry) => entry.card.id)).not.toContain(
    "d:run:" + privateRun,
  );
  await expect(cards.detail("d:run:" + privateRun)).rejects.toMatchObject({
    status: 404,
  });
  const readCommand = randomUUID();
  const markRead = () =>
    browser(
      prefix + `/feed/${newer}/read`,
      "PUT",
      { cardKey: "run:" + newer },
      { "x-loop-command-id": readCommand },
    );
  expect((await markRead()).status).toBe(200);
  const readCard = await cards.detail("d:run:" + newer);
  expect(readCard.type === "done" && readCard.display.read_at).toEqual(
    expect.any(Number),
  );
  expect((await markRead()).status).toBe(200);
  expect(await cards.detail("d:run:" + newer)).toEqual(readCard);
  expect(
    db
      .prepare("SELECT unread FROM feed_cards WHERE owner_id=? AND card_key=?")
      .get(foreignOwner, "run:" + privateRun),
  ).toEqual({ unread: 1 });
  const capabilities = await browser(prefix + "/capabilities");
  expect(capabilities.body.fleet.reads).toEqual(
    expect.arrayContaining(["cardList", "cardChanges", "cardDetail"]),
  );
  expect(capabilities.body.fleet.actions).toEqual(
    expect.arrayContaining(["feedRead"]),
  );
});

it("preserves one command through the browser source route, lost response and receipt reconciliation", async () => {
  const id = randomUUID(),
    body = createBody(),
    before = actionCalls;
  loseReply = true;
  const uncertain = await browser(prefix + "/agents", "POST", body, {
    "x-loop-command-id": id,
    "x-loop-owner": foreignOwner,
  });
  expect(uncertain.status).toBe(503);
  expect(uncertain.body.executionOutcome).toBe("unknown");
  expect(uncertain.headers["x-loop-command-id"]).toBe(id);
  expect(uncertain.headers["x-loop-command-state"]).toBe("unknown");
  loseReply = false;
  const complete = await browser(prefix + "/agents", "POST", body, {
    "x-loop-command-id": id,
    "x-loop-receipt-only": "1",
  });
  expect(complete.status).toBe(201);
  expect(complete.headers["x-loop-command-id"]).toBe(id);
  expect(complete.headers["x-loop-command-state"]).toBe("completed");
  expect(complete.body.name).toBe(body.name);
  expect(actionCalls - before).toBe(1);
  expect(
    db.prepare("SELECT owner_id FROM agents WHERE id=?").get(complete.body.id),
  ).toEqual({ owner_id: OWNER });
  expect(
    sourceDb
      .prepare(
        "SELECT state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(owner, id),
  ).toEqual({ state: "completed" });
  const different = await browser(prefix + "/agents", "POST", createBody(), {
    "x-loop-command-id": id,
  });
  expect(different.status).toBeGreaterThanOrEqual(400);
  expect(actionCalls - before).toBe(1);
});

it.each(["move", "reorder", "withdraw", "cancel"] as const)(
  "routes a queued run's %s operation through its owning handler and receipt",
  async (operation) => {
    const created = await browser(prefix + "/agents", "POST", createBody(), {
      "x-loop-command-id": randomUUID(),
    });
    expect(created.status).toBe(201);
    const agent = created.body.id;
    const { enqueue } = await import("../src/server/queue.js");
    function queued() {
      const conversation = randomUUID();
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Queue routing fixture',1)",
      ).run(conversation, OWNER, agent);
      return enqueue(OWNER, "Queued routing fixture", randomUUID(), {
        agent,
        conversation,
        payload: { connectionId },
      });
    }
    const run = queued(),
      other = queued(),
      commandId = randomUUID();
    let target = agent;
    if (operation === "move") {
      const destination = await browser(
        prefix + "/agents",
        "POST",
        createBody(),
        {
          "x-loop-command-id": randomUUID(),
        },
      );
      expect(destination.status).toBe(201);
      target = destination.body.id;
    }
    const body =
      operation === "move"
        ? { agentId: target }
        : operation === "reorder"
          ? { direction: "down" }
          : {};
    const before = actionCalls;
    const send = () =>
      browser(prefix + `/runs/${run.id}/${operation}`, "POST", body, {
        "x-loop-command-id": commandId,
      });
    const first = await send();
    expect(first.status).toBe(operation === "move" ? 202 : 200);
    expect(first.headers["x-loop-command-state"]).toBe("completed");
    expect(
      db
        .prepare(
          "SELECT state,command_tag FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
        )
        .get(OWNER, commandId),
    ).toEqual({
      state: "completed",
      command_tag:
        operation === "cancel"
          ? "runAction"
          : `run${operation[0].toUpperCase()}${operation.slice(1)}`,
    });
    if (operation === "reorder") {
      expect(
        db
          .prepare(
            "SELECT id FROM runs WHERE owner_id=? AND agent_id=? AND state='queued' ORDER BY COALESCE(queue_rank,created_at),rowid",
          )
          .all(OWNER, agent),
      ).toEqual([{ id: other.id }, { id: run.id }]);
    } else {
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "cancelled" });
      if (operation === "withdraw") expect(first.body.input).toBe(run.input);
      if (operation === "move") {
        expect(first.body.agent_id).toBe(target);
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM runs WHERE owner_id=? AND idempotency_key=?",
            )
            .get(OWNER, commandId),
        ).toEqual({ n: 1 });
      }
    }
    expect((await send()).body).toEqual(first.body);
    expect(actionCalls).toBe(before + 1);
    expect(localCalls).toBe(0);
  },
);

it("refuses missing identities, foreign resources, arbitrary routes and cross-origin headers without local fallback", async () => {
  const before = actionCalls;
  expect((await browser(prefix + "/agents", "POST", createBody())).status).toBe(
    400,
  );
  for (const path of [
    "/teams",
    "/connections",
    "/agent-sources",
    "/fleet/admin/state",
    "/execution/dispatch",
  ])
    expect(
      (
        await browser(
          prefix + path,
          "POST",
          {},
          { "x-loop-command-id": randomUUID() },
        )
      ).status,
    ).toBe(409);
  expect(
    (
      await browser(prefix + "/bootstrap", "GET", undefined, {
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(prefix + "/bootstrap", "GET", undefined, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(prefix + "/bootstrap", "GET", undefined, {
        "x-http-method-override": "POST",
      })
    ).status,
  ).toBe(403);
  expect(actionCalls).toBe(before);
  const foreign = await browser(
    prefix + "/agents/" + foreignAgent,
    "PATCH",
    { name: "changed" },
    { "x-loop-command-id": randomUUID() },
  );
  expect(foreign.status).toBeGreaterThanOrEqual(400);
  expect(
    db.prepare("SELECT name FROM agents WHERE id=?").get(foreignAgent),
  ).toEqual({ name: "Foreign" });
  expect(localCalls).toBe(0);
});

it("isolated previews cannot use an injected peer source", async () => {
  const before = probeCalls;
  const original = { cookie, csrf };
  gateway.workspace!.isolated = true;
  try {
    expect((await browser(prefix + "/bootstrap")).status).toBe(401);
    await pair();
    expect((await browser(prefix + "/bootstrap")).status).toBe(403);
    expect((await browser("/api/agent-sources")).body).toEqual([]);
    expect(probeCalls).toBe(before);
  } finally {
    gateway.workspace!.isolated = false;
    cookie = original.cookie;
    csrf = original.csrf;
  }
});

it("revoking a browser during destination preparation closes the delegated request before any action", async () => {
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const before = actionCalls,
    probes = probeCalls,
    id = randomUUID(),
    body = createBody();
  const pending = browser(prefix + "/agents", "POST", body, {
    "x-loop-command-id": id,
  }).catch((error) => error);
  await until(() => probeCalls > probes);
  expect((await browser("/api/auth/sign-out", "POST", {})).status).toBe(200);
  release();
  holdProbe = undefined;
  try {
    expect(await pending).toBeInstanceOf(Error);
    expect(actionCalls).toBe(before);
    await expect
      .poll(() =>
        sourceDb
          .prepare(
            "SELECT state FROM fleet_forwarded_actions WHERE command_id=?",
          )
          .get(id),
      )
      .toEqual({ state: "unknown" });
  } finally {
    await pair();
  }
  const refused = await browser(prefix + "/agents", "POST", body, {
    "x-loop-command-id": id,
    "x-loop-receipt-only": "1",
  });
  expect(refused.status).toBe(409);
  expect(refused.headers["x-loop-command-state"]).toBe("refused");
  expect(actionCalls).toBe(before);
  const fresh = await browser(prefix + "/agents", "POST", body, {
    "x-loop-command-id": randomUUID(),
  });
  expect(fresh.status).toBe(201);
  expect(actionCalls).toBe(before + 1);
});

it("a gateway origin change fences a prepared read without erasing another viewer's credential", async () => {
  const credential = await leases.get(peer, "read");
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const probes = probeCalls;
  const pending = browser(prefix + "/bootstrap").catch((error) => error);
  await until(() => probeCalls > probes);
  gatewayOrigin = "https://gateway-new.example";
  gateway.setOrigin(gatewayOrigin);
  release();
  holdProbe = undefined;
  expect(await pending).toBeInstanceOf(Error);
  expect((await leases.get(peer, "read")).token).toBe(credential.token);
  await pair();
});

const receiptPath = "/api/fleet/commands/receipt";
it("recovers a committed command using only its original ID, route and digest through the paired Host", async () => {
  const id = randomUUID(),
    body = createBody(),
    before = actionCalls;
  const reference = {
    peer,
    commandId: id,
    route: "agentCreate" as const,
    payloadDigest: fleetPayloadDigest(
      fleetActionInput({ route: "agentCreate", params: {}, body }, id),
    ),
  };
  loseReply = true;
  try {
    expect(
      (
        await browser(prefix + "/agents", "POST", body, {
          "x-loop-command-id": id,
        })
      ).status,
    ).toBe(503);
  } finally {
    loseReply = false;
  }
  const wrong = await browser(receiptPath, "POST", {
    ...reference,
    payloadDigest: "0".repeat(64),
  });
  expect(wrong.status).toBe(409);
  const receipt = await browser(receiptPath, "POST", reference);
  expect(receipt.status).toBe(200);
  expect(receipt.body).toMatchObject({
    commandId: id,
    state: "completed",
    result: { name: body.name },
  });
  expect(actionCalls - before).toBe(1);
  expect(
    db.prepare("SELECT count(*) n FROM agents WHERE name=?").get(body.name),
  ).toEqual({ n: 1 });
  // Explicitly open and pair the owning machine as the new gateway. This is a
  // new origin session; neither the old gateway cookie nor a peer credential
  // authorizes the local receipt endpoint.
  const value = fleetDeviceFromLink(host.pair().url, origin);
  const paired = await http(
    host.port,
    origin,
    "/pair",
    "POST",
    { ...value, name: "Recovered phone" },
    { origin },
  );
  expect(paired.status).toBe(200);
  const localCookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await http(host.port, origin, "/session", "GET", undefined, {
    cookie: localCookie,
  });
  const localHeaders = {
    cookie: localCookie,
    origin,
    "x-loop-csrf": session.body.csrf,
  };
  const calls = probeCalls;
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        reference,
        localHeaders,
      )
    ).body,
  ).toEqual(receipt.body);
  expect(
    (await http(host.port, origin, receiptPath, "POST", reference, { origin }))
      .status,
  ).toBe(401);
  expect(
    (
      await http(host.port, origin, receiptPath, "POST", reference, {
        ...localHeaders,
        "x-loop-csrf": "wrong",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        { ...reference, route: "agentUpdate" },
        localHeaders,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        { ...reference, payloadDigest: "0".repeat(64) },
        localHeaders,
      )
    ).status,
  ).toBe(409);
  // An otherwise matching receipt owned by someone else remains invisible.
  const foreignId = randomUUID();
  db.prepare(
    "INSERT INTO fleet_command_receipts SELECT ?,peer_id,?,fleet_id,grant_id,operation,payload_digest,state,result,created_at,updated_at,command_tag FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
  ).run(foreignOwner, foreignId, OWNER, id);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        { ...reference, commandId: foreignId },
        localHeaders,
      )
    ).body,
  ).toEqual({ commandId: foreignId, state: "unknown", result: null });
  db.prepare(
    "UPDATE fleet_command_receipts SET result=NULL WHERE owner_id=? AND command_id=?",
  ).run(OWNER, id);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        reference,
        localHeaders,
      )
    ).body,
  ).toEqual({ commandId: id, state: "completed", result: null });
  expect(probeCalls).toBe(calls);
  expect(actionCalls - before).toBe(1);
  sourceDb
    .prepare(
      "UPDATE fleet_forwarded_actions SET result=NULL WHERE owner_id=? AND command_id=?",
    )
    .run(owner, id);
  expect((await browser(receiptPath, "POST", reference)).body).toEqual({
    commandId: id,
    state: "completed",
    result: null,
  });
  expect(actionCalls - before).toBe(1);
});

it("refuses unauthorized receipt lookup and retires an absent command without forwarding an action", async () => {
  const before = actionCalls,
    id = randomUUID();
  const reference = {
    peer,
    commandId: id,
    route: "agentCreate",
    payloadDigest: "1".repeat(64),
  };
  expect(
    (
      await http(gateway.port, gatewayOrigin, receiptPath, "POST", reference, {
        origin: gatewayOrigin,
      })
    ).status,
  ).toBe(401);
  expect(
    (await browser(receiptPath, "POST", reference, { "x-loop-csrf": "wrong" }))
      .status,
  ).toBe(403);
  expect(
    (
      await browser(receiptPath, "POST", reference, {
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(receiptPath, "POST", reference, {
        "x-http-method-override": "GET",
      })
    ).status,
  ).toBe(403);
  expect(
    (await browser(receiptPath, "POST", { ...reference, owner: foreignOwner }))
      .status,
  ).toBe(400);
  expect(
    (
      await browser(receiptPath, "POST", {
        ...reference,
        peer: source.identity.machineId,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(receiptPath, "POST", {
        ...reference,
        extra: "x".repeat(4096),
      })
    ).status,
  ).toBe(413);
  const original = { cookie, csrf };
  gateway.workspace!.isolated = true;
  try {
    await pair();
    expect((await browser(receiptPath, "POST", reference)).status).toBe(404);
  } finally {
    gateway.workspace!.isolated = false;
    cookie = original.cookie;
    csrf = original.csrf;
  }
  expect((await browser(receiptPath, "POST", reference)).body).toEqual({
    commandId: id,
    state: "refused",
    result: null,
  });
  expect(
    sourceDb
      .prepare(
        "SELECT state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(owner, id),
  ).toEqual({ state: "refused" });
  expect(actionCalls).toBe(before);
  expect(localCalls).toBe(0);
});

it("sign-out aborts a receipt lookup before its result is exposed", async () => {
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const probes = probeCalls,
    before = actionCalls;
  const pending = browser(receiptPath, "POST", {
    peer,
    commandId: randomUUID(),
    route: "agentCreate",
    payloadDigest: "2".repeat(64),
  }).catch((error) => error);
  try {
    await until(() => probeCalls > probes);
    expect((await browser("/api/auth/sign-out", "POST", {})).status).toBe(200);
    release();
    holdProbe = undefined;
    expect(await pending).toBeInstanceOf(Error);
    expect(actionCalls).toBe(before);
  } finally {
    release();
    holdProbe = undefined;
    await pair();
  }
});

it("keeps a completed command uncertain when its destination is removed before retry", async () => {
  const id = randomUUID(),
    body = createBody(),
    before = actionCalls;
  loseReply = true;
  try {
    expect(
      (
        await browser(prefix + "/agents", "POST", body, {
          "x-loop-command-id": id,
        })
      ).body.executionOutcome,
    ).toBe("unknown");
  } finally {
    loseReply = false;
  }
  expect(
    db
      .prepare("SELECT state FROM fleet_command_receipts WHERE command_id=?")
      .get(id),
  ).toEqual({ state: "completed" });
  const directory = source.directory(owner)!;
  source.revise(owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(directory.document),
    members: directory.document.members.filter(
      (item) => item.machineId !== peer,
    ),
  });
  const retry = await browser(prefix + "/agents", "POST", body, {
    "x-loop-command-id": id,
  });
  expect(retry.status).toBe(403);
  expect(retry.body.executionOutcome).toBe("unknown");
  expect(retry.headers["x-loop-command-state"]).toBeUndefined();
  expect(actionCalls).toBe(before + 1);
  expect(
    db
      .prepare("SELECT count(*) n FROM agents WHERE owner_id=? AND name=?")
      .get(OWNER, body.name),
  ).toEqual({ n: 1 });
});
