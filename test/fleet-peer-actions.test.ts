import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Headers, Response, type fetch as undiciFetch } from "undici";
import { fleetActionInput } from "../src/shared/fleet-action-input.js";
import { FleetPeerActions } from "../src/server/fleet-peer-actions.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { ExecutionRefused } from "../src/server/execution-refusal.js";
import { fleetWorkspaceApi } from "../src/shared/fleet-workspace-api.js";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.js";
import { fleetCredentialApi } from "../src/shared/fleet-credential-api.js";
import { until } from "./helpers.js";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetWorkspaceActions } from "../src/server/fleet-workspace-actions.js";
import { verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  fleetWorkspaceActionApi,
  fleetActionRoutes,
  type FleetActionInput,
  SignedFleetActionResponse,
} from "../src/shared/fleet-workspace-action-api.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-forward-"));
process.env.LOOP_DATA_DIR = join(root, "destination");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
mkdirSync(process.env.LOOP_DATA_DIR);
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
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
  sourceOwner = randomUUID(),
  origin = "https://destination.example";
const alternateDb = new Database(join(root, "alternate.db"));
applyMigrations(alternateDb);
alternateDb
  .prepare("INSERT INTO deployment_profile VALUES(1,'companion')")
  .run();
const alternate = new FleetAuthority(alternateDb, secrets),
  alternateOwner = randomUUID();
const first = source.create(sourceOwner, {
  mutationId: randomUUID(),
  name: "Same label",
  origin: "https://source.example",
  scope: ["read", "act"],
});
const directory = source.revise(sourceOwner, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    {
      ...alternate.identity,
      origin: "https://alternate.example",
      name: "Alternate",
      grantId: randomUUID(),
    },
    {
      ...destination.identity,
      origin,
      name: "Same label",
      grantId: randomUUID(),
    },
  ],
});
destination.approve(OWNER, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  scope: ["read", "act"],
  controller: source.identity,
  directory,
  grantId: directory.document.members.find(
    (item) => item.machineId === destination.identity.machineId,
  )!.grantId,
});
alternate.approve(alternateOwner, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  scope: ["read", "act"],
  controller: source.identity,
  directory,
  grantId: directory.document.members.find(
    (item) => item.machineId === alternate.identity.machineId,
  )!.grantId,
});
const bridge = new FleetWorkspaceApp(app, OWNER);
let actions = new FleetWorkspaceActions(
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
let advertised = Object.keys(fleetActionRoutes);
const reads = new FleetWorkspaceRead(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  { actions: () => advertised },
);
const peerHttp = () =>
  createFleetPeerHttp(enrollment, () => origin, {
    workspaceActions: actions,
    workspaceRead: reads,
    credentials,
  });
host.workspace = {
  http: app,
  peerHttp: peerHttp(),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
const connectionId = randomUUID(),
  foreignOwner = randomUUID(),
  foreignAgent = randomUUID();
beforeAll(async () => {
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',0)",
  ).run(connectionId, OWNER, JSON.stringify([{ id: "fixture" }]));
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,'Other owner','other-owner','openai','fixture','untouched','loop',0)",
  ).run(foreignAgent, foreignOwner);
  await host.listen();
  host.setOrigin(origin);
});
afterAll(async () => {
  client.close();
  leases.close();
  reads.close();
  actions.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  sourceDb.close();
  alternateDb.close();
  rmSync(root, { recursive: true, force: true });
});
function call(body: unknown, path: string, signal?: AbortSignal) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method: "POST",
        signal,
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          "x-loop-fleet-version": "1",
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
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
let mode:
  | "normal"
  | "loss"
  | "forged"
  | "replay"
  | "unsigned403"
  | "wrongProbe"
  | "offlineProbe"
  | "legacyReceipt"
  | "revokeDevice"
  | "lateDevice"
  | "stopReply" = "normal";
let actionCalls = 0,
  receiptCalls = 0,
  credentialCalls = 0,
  probeCalls = 0;
let previous: unknown;
let holdProbe: Promise<void> | undefined;
let active = true;
const current = () => {
  if (!active)
    throw new ExecutionRefused(403, "The fixture device was revoked.");
};
const fetcher: typeof undiciFetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe(origin);
  const headers = new Headers(init?.headers);
  for (const name of ["cookie", "authorization", "origin", "x-loop-csrf"])
    expect(headers.has(name)).toBe(false);
  const isAction =
    url.pathname === "/api" + fleetWorkspaceActionApi.action.path;
  if (isAction) {
    actionCalls++;
    const input = JSON.parse(String(init?.body));
    expect(
      sourceDb
        .prepare(
          "SELECT state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
        )
        .get(sourceOwner, input.commandId),
    ).toEqual({ state: "unknown" });
  }
  if (url.pathname === "/api" + fleetWorkspaceActionApi.receipt.path)
    receiptCalls++;
  if (url.pathname === "/api" + fleetCredentialApi.credentialChallenge.path)
    credentialCalls++;
  if (url.pathname === "/api" + fleetPeerApi.enrollmentProbe.path) {
    probeCalls++;
    if (holdProbe) await holdProbe;
    if (mode === "offlineProbe")
      throw new TypeError("Fixture destination offline before forwarding");
  }
  if (
    mode === "legacyReceipt" &&
    url.pathname === "/api" + fleetWorkspaceActionApi.receipt.path &&
    Object.hasOwn(JSON.parse(String(init?.body)), "route")
  )
    return new Response(null, { status: 400 });
  const response = await call(
    JSON.parse(String(init?.body)),
    url.pathname,
    init?.signal ?? undefined,
  );
  let body = response.body;
  if (
    url.pathname === "/api" + fleetWorkspaceApi.catalog.path &&
    mode === "revokeDevice"
  )
    active = false;
  if (
    url.pathname === "/api" + fleetPeerApi.enrollmentProbe.path &&
    mode === "wrongProbe"
  )
    body.probe.nonce = randomBytes(32).toString("base64url");
  if (isAction) {
    if (mode === "lateDevice") active = false;
    if (mode === "stopReply") client.close();
    if (mode === "loss")
      throw new TypeError("Isolated response loss after destination commit");
    if (mode === "unsigned403") return new Response(null, { status: 403 });
    if (mode === "forged")
      body.response.receipt.result.name = "Forged remote result";
    if (mode === "replay") body = previous;
    else previous = structuredClone(body);
  }
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};
const leases = new FleetCredentialLeases(
  source,
  sourceCredentials,
  sourceOwner,
  new FleetCredentialHttpTransport(fetcher),
);
const transport = new FleetWorkspaceActionHttpTransport(fetcher);
const freshClient = () =>
  new FleetPeerActions(sourceDb, source, leases, sourceOwner, transport);
function alternateGateway() {
  const alternateLeases = new FleetCredentialLeases(
    alternate,
    new FleetCredentials(alternateDb, alternate, secrets),
    alternateOwner,
    new FleetCredentialHttpTransport(fetcher),
  );
  return {
    alternateLeases,
    gateway: new FleetPeerActions(
      alternateDb,
      alternate,
      alternateLeases,
      alternateOwner,
      transport,
    ),
  };
}
let client = freshClient();
const peer = destination.identity.machineId;
function createInput(): FleetActionInput {
  return {
    route: "agentCreate",
    params: {},
    body: {
      name: "fleet-" + randomUUID().slice(0, 8),
      connectionId,
      model: "fixture",
      initialPrompt: "Isolated queued work",
    },
  };
}
function journal(commandId: string) {
  return sourceDb
    .prepare(
      "SELECT * FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
    )
    .get(sourceOwner, commandId) as
    { state: string; result: string | null } | undefined;
}
function destinationReceipt(commandId: string) {
  return db
    .prepare(
      "SELECT state FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
    )
    .get(OWNER, commandId);
}

const act = (id: string, input: FleetActionInput) =>
  client.action(peer, id, input, current);
const lookupReceipt = (id: string, input: FleetActionInput) =>
  client.receipt(peer, id, input, current);

async function loseResponse(id: string, input: FleetActionInput) {
  mode = "loss";
  try {
    expect(await act(id, input)).toEqual({
      commandId: id,
      state: "unknown",
      result: null,
    });
  } finally {
    mode = "normal";
  }
}

it("journals the immutable command before HTTP and preserves the owning run and projected result", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  const receipt = await act(id, input);
  expect(receipt).toMatchObject({ commandId: id, state: "completed" });
  expect(actionCalls - before).toBe(1);
  expect(journal(id)?.state).toBe("completed");
  expect(destinationReceipt(id)).toEqual({ state: "completed" });
  const result = receipt.result as { id: string; initialRun: { id: string } };
  expect(
    db
      .prepare(
        "SELECT command_id FROM fleet_effect_authorizations WHERE owner_id=? AND effect_kind='run' AND effect_id=?",
      )
      .get(OWNER, result.initialRun.id),
  ).toEqual({ command_id: id });
  expect(await act(id, input)).toEqual(receipt);
  expect(actionCalls - before).toBe(1);
  expect(
    db.prepare("SELECT count(*) n FROM runs WHERE agent_id=?").get(result.id),
  ).toEqual({ n: 1 });
  expect(
    () =>
      new FleetPeerActions(sourceDb, source, leases, foreignOwner, transport),
  ).toThrow("owner");
  expect(
    sourceDb
      .prepare(
        "SELECT 1 FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(foreignOwner, id),
  ).toBeUndefined();
});

it("only queries the same command after a lost post-commit response and gateway replacement", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  await loseResponse(id, input);
  expect(journal(id)).toMatchObject({ state: "unknown", result: null });
  expect(destinationReceipt(id)).toEqual({ state: "completed" });
  const changed = structuredClone(input);
  (changed.body as Record<string, unknown>).initialPrompt = "Replacement work";
  await expect(act(id, changed)).rejects.toMatchObject({ status: 409 });
  client.close();
  client = freshClient();
  const queries = receiptCalls;
  expect((await act(id, input)).state).toBe("completed");
  expect(receiptCalls - queries).toBe(1);
  expect(actionCalls - before).toBe(1);
});

it("treats unsigned HTTP refusals, forged receipts and replayed signed replies as uncertain after dispatch", async () => {
  for (const failure of ["unsigned403", "forged", "replay"] as const) {
    const id = randomUUID(),
      input = createInput(),
      before = actionCalls;
    mode = failure;
    try {
      expect((await act(id, input)).state).toBe("unknown");
    } finally {
      mode = "normal";
    }
    expect(journal(id)?.state).toBe("unknown");
    expect(destinationReceipt(id)).toEqual({ state: "completed" });
    // A rejected credential observes the registry's bounded renewal cooldown;
    // waiting only queries receipts and never resubmits the action.
    await expect
      .poll(async () => (await lookupReceipt(id, input)).state, {
        timeout: 4000,
        message: failure,
      })
      .toBe("completed");
    expect(actionCalls - before).toBe(1);
  }
});

it("recovers an accepted receipt after its action is withdrawn from the catalog", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  await loseResponse(id, input);
  advertised = [];
  try {
    expect((await lookupReceipt(id, input)).state).toBe("completed");
    expect(destinationReceipt(id)).toEqual({ state: "completed" });
    expect(actionCalls).toBe(before + 1);
  } finally {
    advertised = Object.keys(fleetActionRoutes);
  }
});

it("never submits an absent receipt after explicit reconciliation on a new gateway", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  expect((await lookupReceipt(id, input)).state).toBe("refused");
  expect(journal(id)?.state).toBe("refused");
  expect(journal(id)?.result).toBeNull();
  expect((await act(id, input)).state).toBe("refused");
  expect(actionCalls).toBe(before);
  expect(destinationReceipt(id)).toEqual({ state: "refused" });
});

it("a concurrent receipt lookup cannot consume an action still preparing its first send", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls,
    probes = probeCalls;
  let release!: () => void;
  holdProbe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = act(id, input);
  try {
    await until(() => probeCalls === probes + 1);
    const lookup = lookupReceipt(id, input);
    expect((await lookup).state).toBe("unknown");
    expect(probeCalls).toBe(probes + 1);
    holdProbe = undefined;
    release();
    const [result] = await Promise.all([original, lookup]);
    expect(result.state).toBe("completed");
    expect(actionCalls - before).toBe(1);
    expect(destinationReceipt(id)).toEqual({ state: "completed" });
    expect((await lookupReceipt(id, input)).state).toBe("completed");
  } finally {
    holdProbe = undefined;
    release();
    await original.catch(() => {});
  }
});

it("a pre-forward failure stays uncertain until the destination retires its absent ID", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  mode = "offlineProbe";
  try {
    await expect(act(id, input)).resolves.toEqual({
      commandId: id,
      state: "unknown",
      result: null,
    });
  } finally {
    mode = "normal";
  }
  expect(journal(id)?.state).toBe("unknown");
  expect(destinationReceipt(id)).toBeUndefined();
  expect(actionCalls).toBe(before);
  expect((await act(id, input)).state).toBe("refused");
  expect(destinationReceipt(id)).toEqual({ state: "refused" });
  // The destination owns this tombstone; a late original action also cannot run.
  const lease = await leases.get(peer, "act");
  const delayed = await call(
    {
      version: 1,
      requestId: randomUUID(),
      commandId: id,
      credential: lease.token,
      input: fleetActionInput(input, id),
    },
    "/api" + fleetWorkspaceActionApi.action.path,
  );
  expect(
    SignedFleetActionResponse.parse(delayed.body).response.receipt?.state,
  ).toBe("refused");
  expect((await client.action(peer, randomUUID(), input, current)).state).toBe(
    "completed",
  );
  expect(actionCalls - before).toBe(1);
});

it.each(["command_tag", "result"] as const)(
  "recovers completion with null %s without exposing a result or repeating the effect",
  async (field) => {
    const id = randomUUID(),
      input = createInput(),
      before = actionCalls;
    const runs = db.prepare("SELECT count(*) n FROM runs").get() as {
      n: number;
    };
    await loseResponse(id, input);
    // This is the row shape retained by migration 137 for pre-tag acceptances.
    db.prepare(
      `UPDATE fleet_command_receipts SET ${field}=NULL WHERE owner_id=? AND command_id=?`,
    ).run(OWNER, id);
    expect(await lookupReceipt(id, input)).toEqual({
      commandId: id,
      state: "completed",
      result: null,
    });
    expect(journal(id)?.result).toBeNull();
    expect(await act(id, input)).toEqual({
      commandId: id,
      state: "completed",
      result: null,
    });
    const repeatedResponse = await call(
      {
        version: 1,
        requestId: randomUUID(),
        commandId: id,
        credential: (await leases.get(peer, "act")).token,
        input: fleetActionInput(input, id),
      },
      "/api" + fleetWorkspaceActionApi.action.path,
    );
    expect(repeatedResponse.status).toBe(200);
    const repeated = SignedFleetActionResponse.parse(repeatedResponse.body);
    expect(repeated.response.receipt).toEqual({
      commandId: id,
      state: "completed",
      result: null,
    });
    expect(db.prepare("SELECT count(*) n FROM runs").get()).toEqual({
      n: runs.n + 1,
    });
    expect(actionCalls - before).toBe(1); // Gateway lookup never submits again.
    expect(
      db
        .prepare(
          `SELECT ${field} AS value FROM fleet_command_receipts WHERE owner_id=? AND command_id=?`,
        )
        .get(OWNER, id),
    ).toEqual({ value: null });
  },
);

it("keeps a final receipt when local device authorization ends after destination commit", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  const issued = credentialCalls;
  mode = "lateDevice";
  try {
    await expect(act(id, input)).rejects.toMatchObject({ status: 403 });
  } finally {
    mode = "normal";
    active = true;
  }
  expect(journal(id)?.state).toBe("completed");
  expect((await leases.get(peer, "act")).context.operation).toBe("act");
  expect(credentialCalls).toBe(issued);
  expect((await act(id, input)).state).toBe("completed");
  expect(actionCalls - before).toBe(1);
});

it("retains uncertainty across shutdown after dispatch and never forwards concurrent duplicates twice", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  mode = "stopReply";
  try {
    expect((await act(id, input)).state).toBe("unknown");
  } finally {
    mode = "normal";
    client = freshClient();
  }
  expect((await act(id, input)).state).toBe("completed");
  expect(actionCalls - before).toBe(1);
  const concurrentId = randomUUID(),
    concurrent = createInput();
  const values = await Promise.all([
    act(concurrentId, concurrent),
    act(concurrentId, concurrent),
  ]);
  expect(values.some((value) => value.state === "completed")).toBe(true);
  expect(actionCalls - before).toBe(2);
  const saved = await lookupReceipt(concurrentId, concurrent);
  const agent = (saved.result as { id: string }).id;
  expect(
    db.prepare("SELECT count(*) n FROM runs WHERE agent_id=?").get(agent),
  ).toEqual({ n: 1 });
});

it("preserves uncertainty for wrong identity, unsupported actions and revoked device preparation", async () => {
  const before = actionCalls,
    issued = credentialCalls;
  const wrong = randomUUID();
  mode = "wrongProbe";
  try {
    await expect(act(wrong, createInput())).resolves.toMatchObject({
      commandId: wrong,
      state: "unknown",
    });
  } finally {
    mode = "normal";
  }
  expect(journal(wrong)?.state).toBe("unknown");
  expect(credentialCalls).toBe(issued);
  advertised = [];
  try {
    await expect(
      client.action(peer, randomUUID(), createInput(), current),
    ).resolves.toMatchObject({ state: "unknown" });
  } finally {
    advertised = Object.keys(fleetActionRoutes);
  }
  const revoked = randomUUID();
  mode = "revokeDevice";
  try {
    await expect(act(revoked, createInput())).rejects.toMatchObject({
      status: 403,
    });
  } finally {
    active = true;
    mode = "normal";
  }
  expect(journal(revoked)?.state).toBe("unknown");
  expect(actionCalls).toBe(before);
});

it("bounds peer preparation without claiming the command was globally refused", async () => {
  let release!: () => void;
  holdProbe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = probeCalls,
    sent = actionCalls;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const ids = controllers.map(() => randomUUID());
  const calls = controllers.map((controller, index) =>
    client
      .action(peer, ids[index], createInput(), current, controller.signal)
      .catch((error: unknown) => error),
  );
  try {
    await until(() => probeCalls - before === 4);
    await expect(
      client.action(peer, randomUUID(), createInput(), current),
    ).resolves.toMatchObject({ state: "unknown" });
    for (const controller of controllers) controller.abort();
    for (const outcome of await Promise.all(calls))
      expect(outcome).toMatchObject({ state: "unknown" });
    expect(actionCalls).toBe(sent);
    for (const id of ids) expect(journal(id)?.state).toBe("unknown");
  } finally {
    holdProbe = undefined;
    release();
  }
});

it("another enrolled gateway checks the original destination receipt without the original body or another action", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  await loseResponse(id, input);
  const { gateway, alternateLeases } = alternateGateway();
  const reference = {
    route: input.route,
    payloadDigest: fleetPayloadDigest(fleetActionInput(input, id)),
  };
  try {
    const wrongId = randomUUID(),
      wrongInput = createInput();
    await loseResponse(wrongId, wrongInput);
    // A new gateway has no local row to reject this relabelled receipt. The
    // destination must check the action recorded at original acceptance.
    expect(
      await gateway.lookup(
        peer,
        wrongId,
        {
          route: "agentUpdate",
          payloadDigest: fleetPayloadDigest(
            fleetActionInput(wrongInput, wrongId),
          ),
        },
        current,
      ),
    ).toEqual({ commandId: wrongId, state: "unknown", result: null });
    const afterWrong = actionCalls;
    expect(afterWrong - before).toBe(2);
    const receipt = await gateway.lookup(peer, id, reference, current);
    expect(receipt.state).toBe("completed");
    expect(actionCalls).toBe(afterWrong);
    expect(
      alternateDb
        .prepare(
          "SELECT state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
        )
        .get(alternateOwner, id),
    ).toEqual({ state: "completed" });
    expect(await gateway.action(peer, id, input, current)).toEqual(receipt);
    expect(actionCalls).toBe(afterWrong);
    await expect(
      gateway.lookup(
        peer,
        id,
        { ...reference, payloadDigest: "f".repeat(64) },
        current,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const missing = randomUUID();
    const missingInput = fleetActionInput(createInput(), missing);
    expect(
      await gateway.lookup(
        peer,
        missing,
        {
          route: missingInput.route,
          payloadDigest: fleetPayloadDigest(missingInput),
        },
        current,
      ),
    ).toEqual({ commandId: missing, state: "refused", result: null });
    expect(
      (await gateway.action(peer, missing, missingInput, current)).state,
    ).toBe("refused");
    expect(actionCalls).toBe(afterWrong);
    expect(
      db
        .prepare("SELECT state FROM fleet_command_receipts WHERE command_id=?")
        .get(missing),
    ).toEqual({ state: "refused" });
  } finally {
    gateway.close();
    alternateLeases.close();
  }
});

it.each(["offlineProbe", "unsupported", "capacity"] as const)(
  "does not refuse a completed command when a second gateway encounters %s",
  async (failure) => {
    const id = randomUUID(),
      input = createInput();
    await loseResponse(id, input);
    const before = actionCalls;
    const { gateway, alternateLeases } = alternateGateway();
    let release: (() => void) | undefined;
    const controllers: AbortController[] = [];
    const occupied: Promise<unknown>[] = [];
    try {
      if (failure === "capacity") {
        holdProbe = new Promise<void>((resolve) => {
          release = resolve;
        });
        const probes = probeCalls;
        for (let i = 0; i < 4; i++) {
          const controller = new AbortController();
          controllers.push(controller);
          occupied.push(
            gateway.action(
              peer,
              randomUUID(),
              createInput(),
              current,
              controller.signal,
            ),
          );
        }
        await until(() => probeCalls === probes + 4);
      } else if (failure === "unsupported") advertised = [];
      else mode = failure;
      expect(await gateway.action(peer, id, input, current)).toEqual({
        commandId: id,
        state: "unknown",
        result: null,
      });
      expect(destinationReceipt(id)).toEqual({ state: "completed" });
      mode = "normal";
      advertised = Object.keys(fleetActionRoutes);
      for (const controller of controllers) controller.abort();
      await Promise.all(occupied);
      holdProbe = undefined;
      release?.();
      const receipt = await gateway.lookup(
        peer,
        id,
        {
          route: input.route,
          payloadDigest: fleetPayloadDigest(fleetActionInput(input, id)),
        },
        current,
      );
      expect(receipt.state).toBe("completed");
      expect(actionCalls).toBe(before);
      expect(
        db
          .prepare("SELECT count(*) n FROM runs WHERE agent_id=?")
          .get((receipt.result as { id: string }).id),
      ).toEqual({ n: 1 });
    } finally {
      mode = "normal";
      advertised = Object.keys(fleetActionRoutes);
      holdProbe = undefined;
      for (const controller of controllers) controller.abort();
      release?.();
      await Promise.allSettled(occupied);
      gateway.close();
      alternateLeases.close();
    }
  },
);

it("recovers outcome-only receipts from a legacy strict v1 peer without resending the action", async () => {
  const id = randomUUID(),
    input = createInput(),
    before = actionCalls;
  await loseResponse(id, input);
  const queries = receiptCalls;
  mode = "legacyReceipt";
  try {
    expect(await lookupReceipt(id, input)).toEqual({
      commandId: id,
      state: "completed",
      result: null,
    });
  } finally {
    mode = "normal";
  }
  expect(receiptCalls - queries).toBe(2);
  expect(actionCalls - before).toBe(1);
  expect(destinationReceipt(id)).toEqual({ state: "completed" });
  expect(journal(id)).toMatchObject({ state: "completed", result: null });
});

it("accepts legacy v1 receipt requests without a route and preserves their signed digest", async () => {
  const id = randomUUID(),
    input = createInput();
  const completed = await act(id, input);
  const requestId = randomUUID(),
    payloadDigest = fleetPayloadDigest(fleetActionInput(input, id));
  const { token } = await leases.get(peer, "act");
  const response = await call(
    { version: 1, requestId, commandId: id, credential: token, payloadDigest },
    "/api" + fleetWorkspaceActionApi.receipt.path,
  );
  expect(response.status).toBe(200);
  const signed = SignedFleetActionResponse.parse(response.body);
  expect(signed.response.receipt).toEqual(completed);
  expect(signed.response.requestDigest).toBe(
    fleetPayloadDigest({ requestId, commandId: id, payloadDigest }),
  );
  expect(
    verifyFleetProof(
      destination.identity,
      "workspace-action",
      signed.response,
      signed.signature,
    ),
  ).toBe(true);
});
