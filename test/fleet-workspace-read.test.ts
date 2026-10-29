import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { Headers, Response, type fetch as undiciFetch } from "undici";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetPeerReads } from "../src/server/fleet-peer-reads.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetProof, verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  fleetWorkspaceApi,
  fleetReadRoutes,
  FleetReadResponse,
} from "../src/shared/fleet-workspace-api.js";
import type { FleetOperation } from "../src/shared/fleet.js";
import { until } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-read-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = join(root, "destination");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
mkdirSync(process.env.LOOP_DATA_DIR);
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
const { FleetWorkspaceHttpTransport } =
  await import("../src/server/fleet-workspace-http.js");
const { app } = await import("../src/server/index.js");
const { db, workspaceClock } = await import("../src/server/db.js");
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
  destination = new FleetAuthority(db, secrets);
const sourceCredentials = new FleetCredentials(sourceDb, source, secrets),
  credentials = new FleetCredentials(db, destination, secrets);
const sourceOwner = randomUUID();
const origin = "https://destination.example";
const scope: FleetOperation[] = ["read", "act", "events", "mail", "files"];
const first = source.create(sourceOwner, {
  mutationId: randomUUID(),
  name: "Same machine label",
  origin: "https://source.example",
  scope,
});
const directory = source.revise(sourceOwner, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    {
      ...destination.identity,
      origin,
      name: "Same machine label",
      grantId: randomUUID(),
    },
  ],
});
destination.approve(OWNER, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  scope,
  controller: source.identity,
  directory,
  grantId: directory.document.members[1].grantId,
});
function token(operation: FleetOperation = "read") {
  const proof = sourceCredentials.prove(
    sourceOwner,
    credentials.challenge({
      fleetId: directory.document.fleetId,
      grantId: directory.document.members[1].grantId,
      destination: destination.identity.machineId,
      peer: source.identity.machineId,
      directory: directoryDigest(directory.document),
      operation,
    }),
  );
  return sourceCredentials.accept(sourceOwner, proof, credentials.issue(proof))
    .token;
}
const readToken = token(),
  actToken = token("act");
let hold: Promise<void> | undefined, began: (() => void) | undefined;
const bridge = new FleetWorkspaceApp((req, res) => {
  if (!hold) return app(req, res);
  began?.();
  void hold.then(() => app(req, res));
}, OWNER);
const reads = new FleetWorkspaceRead(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
);
const pairing = new FleetPairing(
  db,
  destination,
  OWNER,
  process.env.LOOP_DATA_DIR,
);
const host = new Host(
  process.env.LOOP_DATA_DIR,
  {
    harness: "codex",
    version: "fixture",
    project: root,
    billing: { mode: "existing", description: "Isolated fixture" },
    capabilities: {
      approvals: true,
      questions: true,
      resume: true,
      liveAttach: false,
      terminal: false,
    },
  },
  pairing,
);
const enrollment = new FleetEnrollmentDestination(
  db,
  destination,
  pairing,
  OWNER,
  secrets,
  () => origin,
);
host.workspace = {
  http: app,
  peerHttp: createFleetPeerHttp(enrollment, () => origin, {
    workspaceRead: reads,
    credentials,
  }),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
const ownAgent = randomUUID(),
  foreignAgent = randomUUID(),
  foreignOwner = randomUUID();
beforeAll(async () => {
  for (const [id, owner] of [
    [ownAgent, OWNER],
    [foreignAgent, foreignOwner],
  ])
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,?,?,'openai','fixture','fixture','loop',1)",
    ).run(id, owner, "Same name", id);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected','[]','{}',1)",
  ).run(randomUUID(), OWNER, "private-provider-sentinel");
  await host.listen();
  host.setOrigin(origin);
});
afterAll(async () => {
  reads.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  sourceDb.close();
  rmSync(root, { recursive: true, force: true });
});
function call(
  body: unknown,
  catalog = false,
  headers: Record<string, string> = {},
  path?: string,
  signal?: AbortSignal,
) {
  return new Promise<{ status: number; body: any; headers: object }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host.port,
          path:
            path ??
            "/api" +
              (catalog
                ? fleetWorkspaceApi.catalog.path
                : fleetWorkspaceApi.read.path),
          method: "POST",
          signal,
          headers: {
            host: new URL(origin).host,
            "content-type": "application/json",
            "x-loop-fleet-version": "1",
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    },
  );
}
function input(route = "bootstrap", params: Record<string, string> = {}) {
  return {
    version: 1,
    requestId: randomUUID(),
    credential: readToken,
    input: { route, params, query: {} },
  };
}

it("a read credential returns native models without refreshing registrations or creating a project", async () => {
  const models = [{ id: "stored-native-model", name: "Stored native model" }];
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('native-claude',?,'anthropic','Native fixture','','connected',?,?,0)",
  ).run(
    OWNER,
    JSON.stringify(models),
    JSON.stringify({ loopHarness: "claude" }),
  );
  db.prepare("INSERT INTO harnesses VALUES('claude',?,'{}','[]','{}',0)").run(
    JSON.stringify({
      harness: "claude",
      executable: resolve("test/harness.mjs"),
      project: root,
      version: "fixture",
      billing: "existing",
    }),
  );
  const originalHarness = process.env.LOOP_TEST_HARNESS;
  process.env.LOOP_TEST_HARNESS = "claude";
  const before = {
    connections: db.prepare("SELECT * FROM connections ORDER BY id").all(),
    registrations: db.prepare("SELECT * FROM harnesses ORDER BY name").all(),
    folders: db.prepare("SELECT * FROM folders ORDER BY id").all(),
    runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
  };
  try {
    const native = await call(
      input("connectionModels", { id: "native-claude" }),
    );
    expect(native.status).toBe(200);
    expect(native.body.response.result).toEqual({ models });
    expect((await call(input())).status).toBe(200);
    expect((await call(input("folderList"))).status).toBe(200);
    expect({
      connections: db.prepare("SELECT * FROM connections ORDER BY id").all(),
      registrations: db.prepare("SELECT * FROM harnesses ORDER BY name").all(),
      folders: db.prepare("SELECT * FROM folders ORDER BY id").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
    }).toEqual(before);
  } finally {
    db.prepare("DELETE FROM connections WHERE id='native-claude'").run();
    db.prepare("DELETE FROM harnesses WHERE name='claude'").run();
    if (originalHarness === undefined) delete process.env.LOOP_TEST_HARNESS;
    else process.env.LOOP_TEST_HARNESS = originalHarness;
  }
});

it("the production peer reader verifies signed local projections and refuses forged or replayed responses without replaying the read", async () => {
  let mode: "normal" | "forged" | "replayed" | "advanced" = "normal";
  let previous: unknown;
  let readCalls = 0;
  let reconciles = 0;
  const destinationProof = new FleetProof(db, destination.identity, secrets);
  const fetcher: typeof undiciFetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(origin);
    const headers = new Headers(init?.headers);
    for (const name of ["cookie", "authorization", "origin", "x-loop-csrf"])
      expect(headers.has(name)).toBe(false);
    const response = await call(
      JSON.parse(String(init?.body)),
      false,
      {},
      url.pathname,
      init?.signal ?? undefined,
    );
    let body = response.body;
    if (url.pathname === "/api" + fleetWorkspaceApi.catalog.path) {
      body.catalog.reads.push("futureRead");
      body.catalog.actions.push("futureAction");
      body.signature = destinationProof.sign("workspace-catalog", body.catalog);
    }
    if (url.pathname === "/api" + fleetWorkspaceApi.read.path) {
      readCalls++;
      if (mode === "forged")
        body.response.result = {
          ...body.response.result,
          environmentName: "Forged machine",
        };
      else if (mode === "replayed") body = previous;
      else if (mode === "advanced") {
        // A valid response from this peer advertises a head the gateway has not
        // accepted. Only verified history reconciliation may adopt that head.
        body.response.directory = "f".repeat(64);
        body.signature = destinationProof.sign("workspace-read", body.response);
      } else previous = structuredClone(body);
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const registry = new FleetCredentialLeases(
    source,
    sourceCredentials,
    sourceOwner,
    new FleetCredentialHttpTransport(fetcher),
    undefined,
    {
      reconcile: async () => {
        reconciles++;
      },
    },
  );
  const client = new FleetPeerReads(
    source,
    registry,
    sourceOwner,
    new FleetWorkspaceHttpTransport(fetcher),
  );
  try {
    const selection = { route: "bootstrap" as const, params: {}, query: {} };
    const result = await client.read(destination.identity.machineId, selection);
    expect(
      (result.result as { agents: { id: string }[] }).agents.map(
        (agent) => agent.id,
      ),
    ).toEqual([ownAgent]);
    expect(result.clock?.epoch).toBe(workspaceClock(OWNER).epoch);
    expect(
      (await client.catalog(destination.identity.machineId)).reads,
    ).toContain("futureRead");
    expect(() =>
      client.read(destination.identity.machineId, {
        ...selection,
        route: "futureRead" as never,
      }),
    ).toThrow();
    expect(readCalls).toBe(1);
    mode = "forged";
    await expect(
      client.read(destination.identity.machineId, selection),
    ).rejects.toMatchObject({ status: 502 });
    mode = "replayed";
    await expect(
      client.read(destination.identity.machineId, selection),
    ).rejects.toMatchObject({ status: 502 });
    expect(readCalls).toBe(3);
    expect(reconciles).toBe(0);
    mode = "advanced";
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        client.read(destination.identity.machineId, selection),
      ).rejects.toMatchObject({ status: 409 });
    expect(readCalls).toBe(5);
    expect(reconciles).toBe(1);
    expect(source.status(sourceOwner).head).toBe(
      directoryDigest(directory.document),
    );
  } finally {
    client.close();
    registry.close();
  }
});

it("reads the destination's real local projection with its clock and mapped owner", async () => {
  const command = input();
  const response = await call(command);
  expect(response.status).toBe(200);
  const parsed = FleetReadResponse.parse(response.body.response);
  expect(parsed.requestId).toBe(command.requestId);
  expect(parsed.requestDigest).toBe(
    fleetPayloadDigest({ requestId: command.requestId, input: command.input }),
  );
  expect(parsed.peer).toBe(source.identity.machineId);
  expect(
    verifyFleetProof(
      destination.identity,
      "workspace-read",
      parsed,
      response.body.signature,
    ),
  ).toBe(true);
  expect(
    verifyFleetProof(
      destination.identity,
      "workspace-read",
      { ...parsed, requestId: randomUUID() },
      response.body.signature,
    ),
  ).toBe(false);
  expect(parsed.machineId).toBe(destination.identity.machineId);
  expect(parsed.clock?.epoch).toBe(workspaceClock(OWNER).epoch);
  expect(
    (parsed.result as { agents: { id: string }[] }).agents.map(
      (agent) => agent.id,
    ),
  ).toEqual([ownAgent]);
  expect(JSON.stringify(response)).not.toContain(foreignOwner);
  expect(JSON.stringify(response)).not.toContain("private-provider-sentinel");
  expect(JSON.stringify(response)).not.toContain(readToken);
  expect(response.headers).not.toHaveProperty("set-cookie");
  expect((await call(input("agentDetail", { id: foreignAgent }))).status).toBe(
    404,
  );
  expect((await call(input("agentDetail", { id: ownAgent }))).status).toBe(200);
});

it("releases bounded peer requests on caller cancellation and close even when a transport ignores its signal", async () => {
  const registry = new FleetCredentialLeases(
    source,
    sourceCredentials,
    sourceOwner,
    {
      challenge: async (_origin, input) => credentials.challenge(input),
      issue: async (_origin, input) => credentials.issue(input),
    },
  );
  let started = 0;
  const client = new FleetPeerReads(source, registry, sourceOwner, {
    probe: async (_origin, input) => enrollment.probe(input),
    catalog: async () => {
      started++;
      return new Promise(() => {});
    },
    read: async () => {
      throw new Error("No read may follow an unfinished catalog");
    },
  });
  const caller = new AbortController();
  try {
    const pending = Array.from({ length: 4 }, () =>
      client
        .catalog(destination.identity.machineId, caller.signal)
        .catch((error: unknown) => error),
    );
    await until(() => started === 4);
    await expect(
      client.catalog(destination.identity.machineId),
    ).rejects.toMatchObject({ status: 503 });
    caller.abort();
    for (const error of await Promise.all(pending))
      expect(error).toMatchObject({ status: 503 });
    const afterCancel = client
      .catalog(destination.identity.machineId)
      .catch((error: unknown) => error);
    await until(() => started === 5);
    client.close();
    expect(await afterCancel).toMatchObject({ status: 503 });
    await expect(
      client.catalog(destination.identity.machineId),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    caller.abort();
    client.close();
    registry.close();
  }
});

it("verifies the current destination before sending an existing credential to a reassigned origin", async () => {
  let reassigned = false,
    credentialRequests = 0;
  const fetcher: typeof undiciFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if ("credential" in body) credentialRequests++;
    const response = await call(
      body,
      false,
      {},
      new URL(String(url)).pathname,
      init?.signal ?? undefined,
    );
    if (reassigned && "probe" in response.body) {
      response.body.probe.nonce = randomBytes(32).toString("base64url");
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const registry = new FleetCredentialLeases(
    source,
    sourceCredentials,
    sourceOwner,
    new FleetCredentialHttpTransport(fetcher),
  );
  const client = new FleetPeerReads(
    source,
    registry,
    sourceOwner,
    new FleetWorkspaceHttpTransport(fetcher),
  );
  try {
    await client.catalog(destination.identity.machineId);
    expect(credentialRequests).toBe(1);
    reassigned = true;
    await expect(
      client.read(destination.identity.machineId, {
        route: "bootstrap",
        params: {},
        query: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(credentialRequests).toBe(1);
  } finally {
    client.close();
    registry.close();
  }
});

it("advertises only implemented read contracts and refuses unknown, recursive and private operations", async () => {
  const request = {
    version: 1,
    requestId: randomUUID(),
    credential: readToken,
  };
  const catalog = await call(request, true);
  expect(catalog.status).toBe(200);
  expect(catalog.body.catalog).toMatchObject({
    requestId: request.requestId,
    profile: "companion",
    actions: [],
    events: false,
    files: false,
  });
  expect(catalog.body.catalog.reads.sort()).toEqual(
    Object.keys(fleetReadRoutes).sort(),
  );
  for (const route of [
    "authSession",
    "cardTokens",
    "runtimeAuthStatus",
    "federationEnroll",
    "agentSources",
    "../auth/get-session",
    "nativeHistoryDetail",
    "agentCreate",
  ])
    expect((await call(input(route))).status).toBe(400);
  expect((await call({ ...input(), owner: foreignOwner })).status).toBe(400);
  expect(
    (
      await call({
        ...input(),
        input: { ...input().input, url: "https://attacker.example" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(input("agentDetail", { id: "../../auth/get-session" }))).status,
  ).toBe(404);
});

it("separates paired-browser and Cards credentials from operation-scoped machine admission", async () => {
  expect((await call({ ...input(), credential: actToken })).status).toBe(403);
  expect(
    (
      await call({
        ...input(),
        credential: randomBytes(32).toString("base64url"),
      })
    ).status,
  ).toBe(403);
  const browserHeaders: Record<string, string>[] = [
    { cookie: "loop=fixture" },
    { authorization: "Bearer card-fixture" },
    { origin },
    { "sec-fetch-mode": "cors" },
  ];
  for (const headers of browserHeaders)
    expect((await call(input(), false, headers)).status).toBe(403);
  const wrongOwner = new FleetWorkspaceRead(
    db,
    destination,
    credentials,
    foreignOwner,
    bridge,
    secrets,
  );
  await expect(wrongOwner.read(input())).rejects.toMatchObject({
    status: 403,
  });
  db.prepare("UPDATE deployment_profile SET profile='server'").run();
  try {
    expect((await call(input())).status).toBe(403);
  } finally {
    db.prepare("UPDATE deployment_profile SET profile='companion'").run();
  }
});

it("signs and verifies a projected response above one MiB within the declared read limit", async () => {
  const instructions = "large projected fixture ".repeat(60_000);
  db.prepare("UPDATE agents SET instructions=? WHERE id=?").run(
    instructions,
    ownAgent,
  );
  const fetcher: typeof undiciFetch = async (url, init) => {
    const response = await call(
      JSON.parse(String(init?.body)),
      false,
      {},
      new URL(String(url)).pathname,
      init?.signal ?? undefined,
    );
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const registry = new FleetCredentialLeases(
    source,
    sourceCredentials,
    sourceOwner,
    new FleetCredentialHttpTransport(fetcher),
  );
  const client = new FleetPeerReads(
    source,
    registry,
    sourceOwner,
    new FleetWorkspaceHttpTransport(fetcher),
  );
  try {
    const result = await client.read(destination.identity.machineId, {
      route: "agentDetail",
      params: { id: ownAgent },
      query: {},
    });
    expect(Buffer.byteLength(JSON.stringify(result.result))).toBeGreaterThan(
      1024 * 1024,
    );
    expect(result.result).toMatchObject({ agent: { instructions } });
  } finally {
    client.close();
    registry.close();
    db.prepare("UPDATE agents SET instructions='fixture' WHERE id=?").run(
      ownAgent,
    );
  }
});

it("bounds actual projected output and keeps a closed reader unavailable", async () => {
  db.prepare("UPDATE agents SET instructions=? WHERE id=?").run(
    "x".repeat(3 * 1024 * 1024),
    ownAgent,
  );
  try {
    const response = await call(input());
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body).length).toBeLessThan(200);
  } finally {
    db.prepare("UPDATE agents SET instructions='fixture' WHERE id=?").run(
      ownAgent,
    );
  }
  const closed = new FleetWorkspaceRead(
    db,
    destination,
    credentials,
    OWNER,
    bridge,
    secrets,
  );
  closed.close();
  await expect(closed.read(input())).rejects.toMatchObject({ status: 403 });
});

it("bounds in-flight local reads and refuses an admitted response after its owner grant is revoked", async () => {
  let release!: () => void;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  let allStarted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  began = () => {
    if (++started === 4) allStarted();
  };
  const requests = Array.from({ length: 4 }, () => call(input()));
  try {
    await waiting;
    expect((await call(input())).status).toBe(503);
    const removal = source.revise(sourceOwner, {
      mutationId: randomUUID(),
      expected: directoryDigest(directory.document),
      members: directory.document.members.filter(
        (member) => member.machineId !== destination.identity.machineId,
      ),
    });
    destination.accept(OWNER, removal);
  } finally {
    release();
    hold = undefined;
    began = undefined;
  }
  for (const response of await Promise.all(requests))
    expect(response.status).toBe(403);
  expect((await call(input())).status).toBe(403);
});
