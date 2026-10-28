import { afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Agent, Response } from "undici";
import { connect } from "node:net";
import { Host } from "../src/host.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import {
  FleetHandoffDestination,
  FleetHandoffSource,
} from "../src/server/fleet-handoff.js";
import { applyMigrations } from "../src/server/migrations.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import { FleetProof } from "../src/server/fleet-proof.js";
import {
  FleetDirectorySync,
  verifyFleetDirectoryAck,
  verifyFleetHistoryResponse,
} from "../src/server/fleet-directory-sync.js";
import { fleetDirectoryApi } from "../src/shared/fleet-directory-api.js";
import { FleetDirectoryReconcile } from "../src/server/fleet-directory-reconcile.js";
import { FleetDistribution } from "../src/server/fleet-distribution.js";
import { FleetPendingDirectory } from "../src/server/fleet-pending-directory.js";
import { fleetEnrollmentFromLink } from "../src/shared/fleet-pairing.js";
import { FleetEnrollmentIntent } from "../src/shared/fleet-enrollment.js";
import { createHash } from "node:crypto";
import { fleetHandoffApi } from "../src/shared/fleet-handoff-api.js";
import type {
  FleetHandoffProposal,
  FleetOperation,
} from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-handoff-http-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const { FleetHandoffHttpTransport } =
  await import("../src/server/fleet-handoff-http.js");
const { FleetDirectoryHttpTransport } =
  await import("../src/server/fleet-directory-http.js");
const { publicNetworkDispatcher } =
  await import("../src/server/mcp/network.js");
const { db: globalDb } = await import("../src/server/db.js");
const databases: Database.Database[] = [],
  hosts: Host[] = [];
const scope: FleetOperation[] = ["read", "act", "events", "mail", "files"];
afterAll(async () => {
  for (const host of hosts) await host.close();
  for (const db of databases) if (db.open) db.close();
  if (globalDb.open) globalDb.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const dir = join(root, randomUUID()),
    owner = randomUUID();
  mkdirSync(dir);
  const db = new Database(join(dir, "workspace.db"));
  databases.push(db);
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets),
    pairing = new FleetPairing(db, authority, owner, dir);
  return {
    db,
    dir,
    owner,
    authority,
    pairing,
    origin: `https://${randomUUID()}.example`,
  };
}
async function fixture(pendingEnrollment = false) {
  const a = machine(),
    b = machine(),
    host = new Host(
      b.dir,
      {
        harness: "codex",
        version: "fixture",
        project: b.dir,
        billing: { mode: "existing", description: "Isolated fixture" },
        capabilities: {
          approvals: true,
          questions: true,
          resume: true,
          liveAttach: false,
          terminal: false,
        },
      },
      b.pairing,
    );
  hosts.push(host);
  const enrollment = new FleetEnrollmentDestination(
    b.db,
    b.authority,
    b.pairing,
    b.owner,
    secrets,
    () => host.origin,
  );
  let privateCalls = 0;
  host.workspace = {
    http: (_req, res) => {
      privateCalls++;
      res.writeHead(404).end();
    },
    peerHttp: createFleetPeerHttp(enrollment, () => host.origin, {
      pendingDirectory: new FleetPendingDirectory(
        b.db,
        b.authority,
        enrollment,
        b.owner,
        secrets,
      ),
      handoff: new FleetHandoffDestination(b.db, b.authority, b.owner, secrets),
      directory: new FleetDirectorySync(b.db, b.authority, b.owner, secrets),
    }),
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  await host.listen();
  host.setOrigin(b.origin);
  const genesis = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "A",
    origin: a.origin,
    scope,
  });
  const proof = new FleetProof(a.db, a.authority.identity, secrets);
  let pendingIntent: FleetEnrollmentIntent | undefined;
  let grantId: string = randomUUID();
  if (pendingEnrollment) {
    const link = fleetEnrollmentFromLink(
      b.pairing.enrollment(b.origin, scope, false).url,
    );
    pendingIntent = FleetEnrollmentIntent.parse({
      version: 1,
      operationId: randomUUID(),
      ceremonyId: link.ceremonyId,
      capabilityHash: createHash("sha256")
        .update(link.enrollment)
        .digest("hex"),
      destination: b.authority.identity,
      origin: b.origin,
      name: "B",
      mode: "enroll",
      scope,
      directory: genesis,
    });
    const prepared = enrollment.prepare({
      intent: pendingIntent,
      capability: link.enrollment,
      signature: proof.sign("enrollment-prepare", pendingIntent),
    });
    grantId = prepared.prepared.member.grantId;
  }
  const directory = a.authority.revise(a.owner, {
    mutationId: pendingIntent?.operationId ?? randomUUID(),
    expected: directoryDigest(genesis.document),
    members: [
      ...genesis.document.members,
      { ...b.authority.identity, grantId, name: "B", origin: b.origin },
    ],
  });
  if (!pendingEnrollment)
    b.authority.approve(b.owner, {
      mutationId: randomUUID(),
      expected: null,
      kind: "enroll",
      grantId,
      scope,
      controller: a.authority.identity,
      directory,
    });
  const pendingCommit = pendingIntent && {
    version: 1 as const,
    operationId: pendingIntent.operationId,
    intentDigest: fleetPayloadDigest(pendingIntent),
    directory,
    ancestors: [],
  };
  const send = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    new Promise<{ status: number; body: unknown; cookie?: string[] }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: host.port,
            path,
            method,
            headers: {
              host: new URL(b.origin).host,
              "content-type": "application/json",
              "x-loop-fleet-version": "1",
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString();
              let value: unknown = text;
              try {
                value = JSON.parse(text);
              } catch {}
              resolve({
                status: res.statusCode!,
                body: value,
                cookie: res.headers["set-cookie"],
              });
            });
          },
        );
        req.on("error", reject);
        req.end(typeof body === "string" ? body : JSON.stringify(body));
      },
    );
  const paths: string[] = [];
  let loseCommit = false;
  const transport = new FleetHandoffHttpTransport(async (url, init) => {
    const target = new URL(String(url));
    expect(target.origin).toBe(b.origin);
    paths.push(target.pathname);
    const headers = Object.fromEntries(
      new Headers(init?.headers as HeadersInit),
    );
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    const result = await send(target.pathname, String(init?.body), headers);
    expect(result.cookie).toBeUndefined();
    if (loseCommit && target.pathname.endsWith("/commit")) {
      expect(result.status).toBe(200);
      throw new Error("Fixture lost accepted handoff response");
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  });
  const source = () =>
      new FleetHandoffSource(a.db, a.authority, a.owner, secrets, transport),
    input = {
      operationId: randomUUID(),
      expected: directoryDigest(directory.document),
      destination: b.authority.identity,
    };
  return {
    a,
    b,
    host,
    enrollment,
    source,
    input,
    send,
    paths,
    pendingCommit: pendingCommit && {
      commit: pendingCommit,
      signature: proof.sign("enrollment-commit", pendingCommit),
    },
    get privateCalls() {
      return privateCalls;
    },
    loseResponse() {
      loseCommit = true;
    },
    proposal() {
      const row = a.db
        .prepare("SELECT proposal FROM fleet_handoff_jobs WHERE operation_id=?")
        .get(input.operationId) as { proposal: string };
      return JSON.parse(row.proposal) as FleetHandoffProposal;
    },
  };
}
const commitPath = "/api" + fleetHandoffApi.handoffCommit.path;

function wireDirectory(host: Host) {
  const edge = new Agent({
    connect(_options, callback) {
      const socket = connect({ host: "127.0.0.1", port: host.port });
      const failed = (error: Error) => callback(error, null);
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        callback(null, socket);
      });
    },
  });
  const dispatch = vi
    .spyOn(publicNetworkDispatcher, "dispatch")
    .mockImplementation((options, handler) => edge.dispatch(options, handler));
  return {
    transport: new FleetDirectoryHttpTransport(),
    async close() {
      dispatch.mockRestore();
      await edge.close();
    },
  };
}

function queuePendingRemoval(f: Awaited<ReturnType<typeof fixture>>) {
  f.a.db.transaction(() => {
    for (let i = 0; i < 70; i++) {
      const current = f.a.authority.directory(f.a.owner)!;
      f.a.authority.revise(f.a.owner, {
        mutationId: randomUUID(),
        expected: directoryDigest(current.document),
        members: current.document.members,
      });
    }
  })();
  const current = f.a.authority.directory(f.a.owner)!;
  const removed = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(current.document),
    members: current.document.members.filter(
      (member) => member.machineId !== f.b.authority.identity.machineId,
    ),
  });
  f.a.db
    .prepare(
      "INSERT INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
    )
    .run(
      f.a.owner,
      f.b.authority.identity.machineId,
      directoryDigest(removed.document),
    );
  return removed;
}

it("restarts exact pending-removal delivery over HTTP and prevents a delayed enrollment commit", async ({
  onTestFinished,
}) => {
  const f = await fixture(true),
    wire = wireDirectory(f.host),
    removed = queuePendingRemoval(f);
  onTestFinished(() => wire.close());
  const packets: string[] = [];
  let lose = true;
  const transport = {
    probe: wire.transport.probe.bind(wire.transport),
    history: wire.transport.history.bind(wire.transport),
    push: wire.transport.push.bind(wire.transport),
    pendingHistory: wire.transport.pendingHistory.bind(wire.transport),
    pendingPush: async (
      ...args: Parameters<typeof wire.transport.pendingPush>
    ) => {
      packets.push(JSON.stringify(args[1]));
      const receipt = await wire.transport.pendingPush(...args);
      if (lose) {
        lose = false;
        throw new Error("Lost pending acknowledgement");
      }
      return receipt;
    },
  };
  const first = new FleetDistribution(
    f.a.db,
    f.a.authority,
    f.a.owner,
    secrets,
    transport,
  );
  onTestFinished(() => first.close());
  await first.flush();
  expect(f.b.authority.status(f.b.owner).state).toBe("standalone");
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").get()).toEqual({
    state: "pending",
  });
  expect(
    f.a.db.prepare("SELECT protocol FROM fleet_distribution_work").get(),
  ).toEqual({ protocol: "pending" });
  const restarted = new FleetDistribution(
    f.a.db,
    f.a.authority,
    f.a.owner,
    secrets,
    transport,
  );
  onTestFinished(() => restarted.close());
  for (let i = 0; i < 3; i++) await restarted.flush();
  expect(packets[1]).toBe(packets[0]);
  expect(packets).toHaveLength(4);
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").get()).toEqual({
    state: "acked",
  });
  expect(f.b.authority.status(f.b.owner).state).toBe("standalone");
  expect(
    f.b.db.prepare("SELECT count(*) n FROM fleet_peer_grants").get(),
  ).toEqual({ n: 0 });
  expect(
    f.b.db.prepare("SELECT head FROM fleet_pending_directory").get(),
  ).toEqual({ head: directoryDigest(removed.document) });
  expect(() => f.enrollment.commit(f.pendingCommit!)).toThrow("cancelled");
  expect(f.privateCalls).toBe(0);
}, 20_000);

it("switches pending-removal delivery to ordinary synchronization if enrollment commits between pages", async ({
  onTestFinished,
}) => {
  const f = await fixture(true),
    wire = wireDirectory(f.host),
    removed = queuePendingRemoval(f);
  onTestFinished(() => wire.close());
  const worker = new FleetDistribution(
    f.a.db,
    f.a.authority,
    f.a.owner,
    secrets,
    wire.transport,
  );
  onTestFinished(() => worker.close());
  await worker.flush();
  expect(f.b.authority.status(f.b.owner).state).toBe("standalone");
  f.enrollment.commit(f.pendingCommit!);
  expect(f.b.authority.status(f.b.owner).state).toBe("replica");
  for (let i = 0; i < 5; i++) await worker.flush();
  expect(f.b.authority.status(f.b.owner)).toMatchObject({
    state: "removed",
    head: directoryDigest(removed.document),
  });
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").get()).toEqual({
    state: "acked",
  });
  expect(
    f.b.db
      .prepare("SELECT count(*) n FROM fleet_peer_grants WHERE active=1")
      .get(),
  ).toEqual({ n: 0 });
  expect(f.privateCalls).toBe(0);
}, 20_000);

it("distributes the durable outbox through default HTTP transport and acknowledges a removal learned elsewhere", async ({
  onTestFinished,
}) => {
  const f = await fixture(),
    wire = wireDirectory(f.host);
  onTestFinished(() => wire.close());
  const previous = f.a.authority.directory(f.a.owner)!;
  const next = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(previous.document),
    members: previous.document.members,
  });
  const enqueue = (digest: string) =>
    f.a.db
      .prepare(
        "INSERT INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
      )
      .run(f.a.owner, f.b.authority.identity.machineId, digest);
  enqueue(directoryDigest(next.document));
  const worker = new FleetDistribution(
    f.a.db,
    f.a.authority,
    f.a.owner,
    secrets,
    wire.transport,
  );
  onTestFinished(() => worker.close());
  await worker.flush();
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(next.document),
  );
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").get()).toEqual({
    state: "acked",
  });
  const removed = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(next.document),
    members: next.document.members.filter(
      (member) => member.machineId !== f.b.authority.identity.machineId,
    ),
  });
  f.b.authority.accept(f.b.owner, removed);
  enqueue(directoryDigest(removed.document));
  await worker.flush();
  expect(
    f.a.db
      .prepare("SELECT state FROM fleet_distribution WHERE directory_digest=?")
      .get(directoryDigest(removed.document)),
  ).toEqual({ state: "acked" });
  expect(f.b.authority.status(f.b.owner).state).toBe("removed");
  expect(f.privateCalls).toBe(0);
});

it("lets a removed former controller pull only its removal proof through production HTTP", async ({
  onTestFinished,
}) => {
  const f = await fixture(),
    source = f.source();
  source.begin(f.input);
  expect((await source.advance(f.input.operationId)).state).toBe("complete");
  const before = f.b.authority.directory(f.b.owner)!;
  const removed = f.b.authority.revise(f.b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(before.document),
    members: before.document.members.filter(
      (m) => m.machineId !== f.a.authority.identity.machineId,
    ),
  });
  const later = f.b.authority.revise(f.b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(removed.document),
    members: removed.document.members,
  });
  const wire = wireDirectory(f.host);
  onTestFinished(() => wire.close());
  const reconcile = new FleetDirectoryReconcile(
    f.a.db,
    f.a.authority,
    f.a.owner,
    secrets,
    wire.transport,
  );
  expect(await reconcile.from(f.b.authority.identity.machineId)).toBe(true);
  expect(f.a.authority.status(f.a.owner)).toMatchObject({
    state: "removed",
    head: directoryDigest(removed.document),
  });
  expect(
    f.a.authority.directory(f.a.owner, directoryDigest(later.document)),
  ).toBeUndefined();
  const query = {
    version: 1 as const,
    nonce: randomBytes(32).toString("base64url"),
    sender: f.a.authority.identity,
    destination: f.b.authority.identity,
    cursor: directoryDigest(later.document),
  };
  const proof = new FleetProof(f.a.db, f.a.authority.identity, secrets);
  await expect(
    wire.transport.history(f.b.origin, {
      query,
      signature: proof.sign("directory-query", query),
    }),
  ).rejects.toThrow("refused");
  expect(f.privateCalls).toBe(0);
});

it("relays signed revisions and fetches authenticated history through default transport without a controller or device session", async ({
  onTestFinished,
}) => {
  const f = await fixture(),
    c = machine(),
    stranger = machine(),
    wire = wireDirectory(f.host),
    anchor = f.a.authority.directory(f.a.owner)!,
    aProof = new FleetProof(f.a.db, f.a.authority.identity, secrets);
  onTestFinished(() => wire.close());
  const next = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(anchor.document),
    members: [
      ...anchor.document.members,
      {
        ...c.authority.identity,
        grantId: randomUUID(),
        name: "C",
        origin: c.origin,
      },
    ],
  });
  const push = {
    version: 1 as const,
    nonce: randomBytes(32).toString("base64url"),
    sender: f.a.authority.identity,
    destination: f.b.authority.identity,
    anchor: directoryDigest(anchor.document),
    entries: [next],
  };
  const signed = { push, signature: aProof.sign("directory-sync", push) };
  const ack = verifyFleetDirectoryAck(
    signed,
    anchor,
    await wire.transport.push(f.b.origin, signed),
  );
  expect(ack.ack).toMatchObject({
    state: "replica",
    accepted: directoryDigest(next.document),
    head: directoryDigest(next.document),
  });
  const bGrant = next.document.members.find(
    (member) => member.machineId === f.b.authority.identity.machineId,
  )!.grantId;
  expect(
    f.b.authority.authorize({
      fleetId: next.document.fleetId,
      grantId: bGrant,
      destination: f.b.authority.identity.machineId,
      peer: c.authority.identity.machineId,
      directory: directoryDigest(next.document),
      operation: "mail",
    }).owner,
  ).toBe(f.b.owner);
  const query = {
      version: 1 as const,
      nonce: randomBytes(32).toString("base64url"),
      sender: c.authority.identity,
      destination: f.b.authority.identity,
      cursor: null,
    },
    cProof = new FleetProof(c.db, c.authority.identity, secrets);
  const request = { query, signature: cProof.sign("directory-query", query) };
  const page = verifyFleetHistoryResponse(
    request,
    await wire.transport.history(f.b.origin, request),
  );
  expect(page.page.head).toBe(directoryDigest(next.document));
  expect(page.page.entries[0]).toEqual(next);
  expect(JSON.stringify(page)).not.toContain(f.a.owner);
  expect(JSON.stringify(page)).not.toContain(f.b.owner);
  const replay = { ...query, nonce: randomBytes(32).toString("base64url") };
  expect(() =>
    verifyFleetHistoryResponse(
      { query: replay, signature: cProof.sign("directory-query", replay) },
      page,
    ),
  ).toThrow();
  const unknown = { ...query, sender: stranger.authority.identity },
    strangerProof = new FleetProof(
      stranger.db,
      stranger.authority.identity,
      secrets,
    );
  await expect(
    wire.transport.history(f.b.origin, {
      query: unknown,
      signature: strangerProof.sign("directory-query", unknown),
    }),
  ).rejects.toThrow("refused");
  expect(
    (
      await f.send("/api" + fleetDirectoryApi.directoryHistory.path, {
        ...request,
        owner: f.b.owner,
      })
    ).status,
  ).toBe(400);
  expect(f.privateCalls).toBe(0);
});

it("acknowledges its own removal over HTTP, refuses later grants and returns duplicate tombstone receipts", async ({
  onTestFinished,
}) => {
  const f = await fixture(),
    wire = wireDirectory(f.host),
    anchor = f.a.authority.directory(f.a.owner)!,
    proof = new FleetProof(f.a.db, f.a.authority.identity, secrets);
  onTestFinished(() => wire.close());
  const removed = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(anchor.document),
    members: anchor.document.members.filter(
      (member) => member.machineId !== f.b.authority.identity.machineId,
    ),
  });
  const later = f.a.authority.revise(f.a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(removed.document),
    members: removed.document.members.map((member) => ({
      ...member,
      name: "Later",
    })),
  });
  const push = {
      version: 1 as const,
      nonce: randomBytes(32).toString("base64url"),
      sender: f.a.authority.identity,
      destination: f.b.authority.identity,
      anchor: directoryDigest(anchor.document),
      entries: [removed, later],
    },
    signed = { push, signature: proof.sign("directory-sync", push) };
  const ack = verifyFleetDirectoryAck(
    signed,
    anchor,
    await wire.transport.push(f.b.origin, signed),
  );
  expect(ack.ack).toMatchObject({
    state: "removed",
    accepted: directoryDigest(removed.document),
    requested: directoryDigest(later.document),
  });
  expect(f.b.authority.status(f.b.owner)).toMatchObject({
    state: "removed",
    head: directoryDigest(removed.document),
  });
  expect(
    f.b.db
      .prepare("SELECT count(*) n FROM fleet_peer_grants WHERE active=1")
      .get(),
  ).toEqual({ n: 0 });
  const duplicate = verifyFleetDirectoryAck(
    signed,
    anchor,
    await wire.transport.push(f.b.origin, signed),
  );
  expect(duplicate.ack.accepted).toBe(ack.ack.accepted);
  const query = {
    version: 1 as const,
    nonce: randomBytes(32).toString("base64url"),
    sender: f.a.authority.identity,
    destination: f.b.authority.identity,
    cursor: null,
  };
  await expect(
    wire.transport.history(f.b.origin, {
      query,
      signature: proof.sign("directory-query", query),
    }),
  ).rejects.toThrow("refused");
  expect(f.privateCalls).toBe(0);
});

it("hands off through actual Host admission, survives a lost response and never sends a second transition", async () => {
  const f = await fixture(),
    source = f.source();
  source.begin(f.input);
  f.loseResponse();
  expect((await source.advance(f.input.operationId)).state).toBe("uncertain");
  expect(f.a.authority.status(f.a.owner).state).toBe("handoff_pending");
  expect(f.b.authority.status(f.b.owner).state).toBe("controller");
  const restarted = f.source();
  await restarted.advance(f.input.operationId);
  expect((await restarted.reconcile(f.input.operationId)).state).toBe(
    "complete",
  );
  expect(f.paths).toEqual([
    commitPath,
    "/api" + fleetHandoffApi.handoffReceipt.path,
  ]);
  expect(f.a.authority.status(f.a.owner).state).toBe("replica");
  expect(f.a.db.prepare("SELECT state FROM fleet_handoff_jobs").get()).toEqual({
    state: "complete",
  });
  expect(f.b.db.prepare("SELECT state FROM fleet_handoffs").get()).toEqual({
    state: "committed",
  });
  expect(f.a.db.prepare("SELECT state FROM fleet_distribution").get()).toEqual({
    state: "acked",
  });
  expect(f.b.db.prepare("SELECT state FROM fleet_distribution").get()).toEqual({
    state: "pending",
  });
  expect(f.privateCalls).toBe(0);
  // Repeating an already accepted proposal returns history, preserving later
  // authority and without generating another outbox or mutation identity.
  const head = f.b.authority.directory(f.b.owner)!;
  const next = f.b.authority.revise(f.b.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(head.document),
    members: head.document.members,
  });
  expect((await f.send(commitPath, f.proposal())).status).toBe(200);
  expect(f.b.authority.status(f.b.owner).head).toBe(
    directoryDigest(next.document),
  );
  expect(f.b.db.prepare("SELECT count(*) n FROM fleet_handoffs").get()).toEqual(
    { n: 1 },
  );
});

it("rejects browser credentials, wrong identities, owner injection and preview or absent hooks without private API fallthrough", async () => {
  const f = await fixture(),
    source = f.source();
  source.begin(f.input);
  const proposal = f.proposal();
  const forbidden: Record<string, string>[] = [
    { origin: f.b.origin },
    { cookie: "device=fixture" },
    { authorization: "Bearer fixture-card" },
    { "x-loop-csrf": "fixture" },
    { "sec-fetch-site": "same-origin" },
    { host: "wrong.example" },
  ];
  for (const headers of forbidden)
    expect((await f.send(commitPath, proposal, headers)).status).toBe(403);
  expect(
    (await f.send(commitPath, { ...proposal, owner: f.b.owner })).status,
  ).toBe(400);
  expect((await f.send(commitPath + "?owner=other", proposal)).status).toBe(
    404,
  );
  const changed = {
    ...proposal,
    document: { ...proposal.document, mutationId: randomUUID() },
  };
  expect((await f.send(commitPath, changed)).status).toBe(403);
  expect(f.b.authority.status(f.b.owner).state).toBe("replica");
  const hook = f.host.workspace!.peerHttp;
  f.host.workspace!.isolated = true;
  expect((await f.send(commitPath, proposal)).status).toBe(404);
  f.host.workspace!.isolated = false;
  f.host.workspace!.peerHttp = createFleetPeerHttp(
    f.enrollment,
    () => f.host.origin,
  );
  expect((await f.send(commitPath, proposal)).status).toBe(404);
  f.host.workspace!.peerHttp = hook;
  expect(f.privateCalls).toBe(0);
  expect((await source.advance(f.input.operationId)).state).toBe("complete");
});
