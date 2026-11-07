import { createHost } from "./helpers/gateway.js";
import { afterAll, afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { Response } from "undici";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetEnrollmentSource } from "../src/server/fleet-enrollment-source.js";
import {
  FleetHandoffDestination,
  FleetHandoffSource,
} from "../src/server/fleet-handoff.js";
import { FleetHandoffHttpTransport } from "../src/server/fleet-handoff-http.js";
import { FleetDirectorySync } from "../src/server/fleet-directory-sync.js";
import { FleetLocalAdmin } from "../src/server/fleet-local-admin.js";
import { createFleetAdminHttp } from "../src/server/fleet-admin-http.js";
import { createFleetPeerHttp } from "../src/server/fleet-peer-http.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import { fleetAdminApi } from "../src/shared/fleet-admin-api.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-admin-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const { FleetEnrollmentHttpTransport } =
  await import("../src/server/fleet-enrollment-http.js");
const { db: globalDb } = await import("../src/server/db.js");
const scope = ["read", "act", "events", "mail", "files"] as const;
type Machine = {
  db: Database.Database;
  owner: string;
  authority: FleetAuthority;
  pairing: FleetPairing;
  host: Host;
  destination: FleetEnrollmentDestination;
  source: FleetEnrollmentSource;
  admin: FleetLocalAdmin;
  cookie: string;
  headers: Record<string, string>;
  device: { id: string };
  workspaceCalls: () => number;
};
const machines: Machine[] = [];
const wireCalls: string[] = [];
const controls: {
  probeWait?: Promise<void>;
  probed?: () => void;
  prepareWait?: Promise<void>;
  prepared?: () => void;
  loseCommit?: boolean;
  receiptWait?: Promise<void>;
  receipted?: () => void;
  commitWait?: Promise<void>;
  committed?: () => void;
} = {};
afterEach(async () => {
  for (const m of machines.splice(0)) {
    await m.host.close();
    m.db.close();
  }
  wireCalls.length = 0;
  for (const key of Object.keys(controls))
    delete controls[key as keyof typeof controls];
});
afterAll(() => {
  globalDb.close();
  rmSync(root, { recursive: true, force: true });
});
type Reply = { status: number; headers: IncomingHttpHeaders; body: any };
function send(
  host: Host,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method,
        headers: {
          host: new URL(host.origin).host,
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
    );
  });
}
async function machine(): Promise<Machine> {
  const dir = join(root, randomUUID()),
    owner = randomUUID();
  mkdirSync(dir);
  const db = new Database(join(dir, "workspace.db"));
  applyMigrations(db);
  const authority = new FleetAuthority(db, secrets),
    pairing = new FleetPairing(db, authority, owner, dir);
  const host = createHost(dir, pairing);
  const destination = new FleetEnrollmentDestination(
    db,
    authority,
    pairing,
    owner,
    secrets,
    () => host.origin,
  );
  const fetcher: NonNullable<
    ConstructorParameters<typeof FleetEnrollmentHttpTransport>[0]
  > = async (url, init) => {
    const parsed = new URL(String(url)),
      peer = machines.find((m) => m.host.origin === parsed.origin)!;
    wireCalls.push(parsed.pathname);
    const response = await send(
      peer.host,
      parsed.pathname,
      String(init?.body),
      Object.fromEntries(new Headers(init?.headers as HeadersInit)),
    );
    expect(response.headers["set-cookie"]).toBeUndefined();
    if (parsed.pathname.endsWith("/probe")) {
      controls.probed?.();
      await controls.probeWait;
    }
    if (parsed.pathname.endsWith("/prepare")) {
      controls.prepared?.();
      await controls.prepareWait;
    }
    if (parsed.pathname.endsWith("/receipt")) {
      controls.receipted?.();
      await controls.receiptWait;
    }
    if (parsed.pathname.endsWith("/commit")) {
      controls.committed?.();
      await controls.commitWait;
    }
    if (parsed.pathname.endsWith("/commit") && controls.loseCommit)
      throw new Error("Fixture lost response");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const transport = new FleetEnrollmentHttpTransport(fetcher);
  const source = new FleetEnrollmentSource(
      db,
      authority,
      owner,
      secrets,
      transport,
    ),
    admin = new FleetLocalAdmin(
      db,
      authority,
      pairing,
      source,
      destination,
      new FleetHandoffSource(
        db,
        authority,
        owner,
        secrets,
        new FleetHandoffHttpTransport(fetcher),
      ),
      owner,
      () => host.origin,
    );
  let workspaceCalls = 0;
  host.workspace = {
    http: (_req, res) => {
      workspaceCalls++;
      res.writeHead(404).end();
    },
    peerHttp: createFleetPeerHttp(destination, () => host.origin, {
      handoff: new FleetHandoffDestination(db, authority, owner, secrets),
      directory: new FleetDirectorySync(db, authority, owner, secrets),
    }),
    fleetAdminHttp: createFleetAdminHttp(admin),
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  await host.listen();
  host.setOrigin(`https://${randomUUID()}.example`);
  const paired = await send(
    host,
    "/pair",
    {
      ...fleetDeviceFromLink(host.pair().url, host.origin),
      name: "Fixture phone",
    },
    { origin: host.origin },
  );
  expect(paired.status).toBe(200);
  const cookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await send(host, "/session", undefined, { cookie }, "GET");
  const headers = {
    cookie,
    origin: host.origin,
    "x-loop-csrf": session.body.csrf,
  };
  const result = {
    db,
    owner,
    authority,
    pairing,
    host,
    destination,
    source,
    admin,
    cookie,
    headers,
    device: session.body.device,
    workspaceCalls: () => workspaceCalls,
  };
  machines.push(result);
  return result;
}
function call(
  m: Machine,
  name: keyof typeof fleetAdminApi,
  body?: unknown,
  headers = m.headers,
) {
  const route = fleetAdminApi[name];
  return send(m.host, "/api" + route.path, body, headers, route.method);
}
async function create(m: Machine) {
  const response = await call(m, "create", {
    mutationId: randomUUID(),
    name: "Same label",
    scope: [...scope],
    confirm: true,
  });
  expect(response.status).toBe(200);
  return response.body;
}
async function begin(a: Machine, b: Machine) {
  const current = a.admin.state();
  const minted = await call(b, "mint", {
    scope: [...scope],
    recover: false,
    confirm: true,
  });
  expect(minted.status).toBe(200);
  const input = {
    operationId: randomUUID(),
    expected: current.head!,
    link: fleetEnrollmentFromLink(minted.body.url),
    name: "Same label",
    mode: "enroll" as const,
    scope: [...scope],
    confirm: true as const,
  };
  const response = await call(a, "begin", input);
  expect(response.status).toBe(200);
  return input;
}

async function enrolled(a: Machine, b: Machine) {
  await create(a);
  const input = await begin(a, b);
  const result = await call(a, "advance", { operationId: input.operationId });
  expect(result.status).toBe(200);
  expect(result.body.state).toBe("complete");
}

async function pairFreshOrigin(m: Machine) {
  const paired = await send(
    m.host,
    "/pair",
    {
      ...fleetDeviceFromLink(m.host.pair().url, m.host.origin),
      name: "New-origin device",
    },
    { origin: m.host.origin },
  );
  expect(paired.status).toBe(200);
  m.cookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await send(
    m.host,
    "/session",
    undefined,
    { cookie: m.cookie },
    "GET",
  );
  m.headers = {
    cookie: m.cookie,
    origin: m.host.origin,
    "x-loop-csrf": session.body.csrf,
  };
  m.device = session.body.device;
}

it("hands off through the old controller's local session and rejects its stale page after lost-response reconciliation", async () => {
  const a = await machine(),
    b = await machine();
  await enrolled(a, b);
  const input = {
    operationId: randomUUID(),
    expected: a.admin.state().head,
    destination: b.authority.identity,
    confirm: true,
  };
  expect((await call(b, "handoffBegin", input)).status).toBe(403);
  expect(
    (await call(a, "handoffBegin", { ...input, confirm: false })).status,
  ).toBe(400);
  expect((await call(a, "handoffBegin", input)).body.state).toBe("ready");
  expect(a.admin.state().state).toBe("handoff_pending");
  controls.loseCommit = true;
  expect(
    (await call(a, "handoffAdvance", { operationId: input.operationId })).body
      .state,
  ).toBe("uncertain");
  expect(b.admin.state().state).toBe("controller");
  const count = wireCalls.filter((p) => p.endsWith("/handoff/commit")).length;
  expect(count).toBe(1);
  expect(
    (await call(a, "handoffAdvance", { operationId: input.operationId })).body
      .state,
  ).toBe("uncertain");
  b.host.setOrigin(`https://${randomUUID()}.example`);
  expect(
    (
      await call(a, "handoffReconcile", {
        operationId: input.operationId,
        origin: b.host.origin,
        confirm: true,
      })
    ).body.state,
  ).toBe("complete");
  expect(wireCalls.filter((p) => p.endsWith("/handoff/commit"))).toHaveLength(
    count,
  );
  expect((await call(a, "state")).body.state).toBe("replica");
  expect(
    (
      await call(a, "repairSelf", {
        mutationId: randomUUID(),
        expected: a.admin.state().head,
        confirm: true,
      })
    ).status,
  ).toBe(403);
  const history = await call(a, "handoffList", { cursor: null });
  expect(history.status).toBe(200);
  expect(history.body.items).toHaveLength(1);
  expect(history.body.items[0].state).toBe("complete");
  expect(JSON.stringify(history.body)).not.toContain(a.owner);
});

it("repairs a changed controller origin only after explicit local confirmation and compare-and-swap", async () => {
  const a = await machine(),
    b = await machine();
  await enrolled(a, b);
  const prior = a.admin.state(),
    identity = a.authority.identity;
  a.host.setOrigin(`https://${randomUUID()}.example`);
  await pairFreshOrigin(a);
  expect(a.admin.state().head).toBe(prior.head);
  const input = {
    mutationId: randomUUID(),
    expected: prior.head,
    confirm: true,
  };
  expect(
    (await call(a, "repairSelf", { ...input, confirm: false })).status,
  ).toBe(400);
  const result = await call(a, "repairSelf", input);
  expect(result.status).toBe(200);
  expect(result.body.identity).toEqual(identity);
  expect(
    result.body.directory.document.members.find(
      (m: any) => m.machineId === identity.machineId,
    ).origin,
  ).toBe(a.host.origin);
  expect(
    (await call(a, "repairSelf", { ...input, mutationId: randomUUID() }))
      .status,
  ).toBe(409);
  expect(b.admin.state().head).toBe(prior.head);
  expect(result.body.pendingDistribution).toBeGreaterThan(0);
});

it("a paired replica explicitly recovers only itself and does not grant the excluded old controller", async () => {
  const a = await machine(),
    b = await machine();
  await enrolled(a, b);
  const prior = b.admin.state();
  const input = {
    mutationId: randomUUID(),
    expected: prior.head,
    name: "Recovered",
    scope: [...scope],
    confirm: true,
  };
  expect((await call(b, "recover", { ...input, confirm: false })).status).toBe(
    400,
  );
  const result = await call(b, "recover", input);
  expect(result.status).toBe(200);
  expect(result.body.state).toBe("controller");
  expect(result.body.directory.document.parent).toBe(prior.head);
  expect(result.body.unconfirmed.map((m: any) => m.machineId)).toEqual([
    a.authority.identity.machineId,
  ]);
  expect(
    result.body.directory.document.members.map((m: any) => m.machineId),
  ).toEqual([b.authority.identity.machineId]);
  expect(
    b.db
      .prepare("SELECT count(*) n FROM fleet_peer_grants WHERE active=1")
      .get(),
  ).toEqual({ n: 0 });
  expect(a.admin.state().head).toBe(prior.head);
  expect(a.admin.state().state).toBe("controller");
  expect(
    (await call(b, "recover", { ...input, mutationId: randomUUID() })).status,
  ).toBe(409);
});

it("admits only a local paired device with Origin/CSRF and an internal authorization marker", async () => {
  const a = await machine();
  const input = {
    mutationId: randomUUID(),
    name: "Fleet",
    scope: [...scope],
    confirm: true,
  };
  for (const headers of [
    {},
    { ...a.headers, "x-loop-csrf": "wrong" },
    { ...a.headers, origin: "https://attacker.example" },
    { ...a.headers, authorization: "Bearer public-token" },
    { ...a.headers, "x-method-override": "GET" },
  ]) {
    const response = await send(
      a.host,
      "/api" + fleetAdminApi.create.path,
      input,
      headers as Record<string, string>,
    );
    expect([401, 403]).toContain(response.status);
  }
  expect(a.authority.status(a.owner).state).toBe("standalone");
  expect(
    (await call(a, "create", { ...input, ownerId: "another-owner" })).status,
  ).toBe(400);
  expect((await call(a, "create", { ...input, confirm: false })).status).toBe(
    400,
  );
  // The workspace HTTP path cannot provide the server-only marker, even when
  // given the same cookie and CSRF header; only Host's dedicated path sets it.
  a.host.workspace!.http = createFleetAdminHttp(a.admin);
  expect(
    (await send(a.host, "/api/state", undefined, a.headers, "GET")).status,
  ).toBe(403);
  const state = await create(a);
  expect(state.state).toBe("controller");
  expect(JSON.stringify(state)).not.toContain(a.owner);
  expect(JSON.stringify(state)).not.toContain(a.cookie);
  expect(a.workspaceCalls()).toBe(0);
});

it("enrolls independent owners through local administration and peer HTTP, reconciles loss, and retains removal distribution", async () => {
  const a = await machine(),
    b = await machine();
  await create(a);
  const input = await begin(a, b);
  controls.loseCommit = true;
  const first = await call(a, "advance", { operationId: input.operationId });
  expect(first.body.state).toBe("uncertain");
  const count = wireCalls.length;
  expect(
    (await call(a, "advance", { operationId: input.operationId })).body.state,
  ).toBe("uncertain");
  expect(wireCalls).toHaveLength(count);
  expect(
    (await call(a, "reconcile", { operationId: input.operationId })).body.state,
  ).toBe("complete");
  expect(b.db.prepare("SELECT owner_id FROM fleet_binding").get()).toEqual({
    owner_id: b.owner,
  });
  expect(a.owner).not.toBe(b.owner);
  expect(b.pairing.devices()).toHaveLength(1);
  const state = a.admin.state();
  expect(
    (
      await call(b, "remove", {
        mutationId: randomUUID(),
        expected: b.admin.state().head,
        machineId: a.authority.identity.machineId,
        confirm: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(a, "remove", {
        mutationId: randomUUID(),
        expected: state.head,
        machineId: a.authority.identity.machineId,
        confirm: true,
      })
    ).status,
  ).toBe(409);
  const removal = {
    mutationId: randomUUID(),
    expected: state.head,
    machineId: b.authority.identity.machineId,
    confirm: true,
  };
  const removed = await call(a, "remove", removal);
  expect(removed.status).toBe(200);
  expect(removed.body.directory.document.tombstones).toContain(
    b.authority.identity.machineId,
  );
  expect(
    a.db
      .prepare(
        "SELECT state FROM fleet_distribution WHERE owner_id=? AND peer_id=? AND directory_digest=?",
      )
      .get(a.owner, b.authority.identity.machineId, removed.body.head),
  ).toEqual({ state: "pending" });
  expect(b.authority.status(b.owner).state).toBe("replica");
  const later = await call(a, "repairSelf", {
    mutationId: randomUUID(),
    expected: removed.body.head,
    confirm: true,
  });
  expect(later.status).toBe(200);
  const repeated = await call(a, "remove", removal);
  expect(repeated.status).toBe(200);
  expect(repeated.body.head).toBe(later.body.head);
  expect(
    a.db
      .prepare(
        "SELECT count(*) n FROM fleet_admin_receipts WHERE owner_id=? AND mutation_id=?",
      )
      .get(a.owner, removal.mutationId),
  ).toEqual({ n: 1 });
});

it("fences a pending dispatch when its device is revoked while the identity probe is in flight", async () => {
  const a = await machine(),
    b = await machine();
  await create(a);
  const input = await begin(a, b);
  let release!: () => void, observed!: () => void, finished!: () => void;
  controls.probeWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probed = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  controls.probed = observed;
  const advance = a.source.advance.bind(a.source);
  a.source.advance = (...args) => advance(...args).finally(finished);
  const pending = call(a, "advance", { operationId: input.operationId }).catch(
    (error) => error,
  );
  await probed;
  expect((await send(a.host, "/api/auth/sign-out", {}, a.headers)).status).toBe(
    200,
  );
  release();
  await completed;
  expect(await pending).toBeInstanceOf(Error);
  expect(a.source.status(input.operationId).state).toBe("ready");
  expect(wireCalls.map((path) => path.split("/").at(-1))).toEqual(["probe"]);
  expect(
    b.db
      .prepare(
        "SELECT count(*) n FROM fleet_enrollments WHERE role='destination'",
      )
      .get(),
  ).toEqual({ n: 0 });
  expect((await call(a, "state")).status).toBe(401);
});

it("fences the old origin while an enrollment identity probe is in flight", async () => {
  const a = await machine(),
    b = await machine();
  await create(a);
  const input = await begin(a, b);
  let release!: () => void, observed!: () => void, finished!: () => void;
  controls.probeWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probed = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  controls.probed = observed;
  const advance = a.source.advance.bind(a.source);
  a.source.advance = (...args) => advance(...args).finally(finished);
  const pending = call(a, "advance", { operationId: input.operationId }).catch(
    (error) => error,
  );
  await probed;
  a.host.setOrigin(`https://${randomUUID()}.example`);
  release();
  await completed;
  expect(await pending).toBeInstanceOf(Error);
  expect(a.source.status(input.operationId).state).toBe("ready");
  expect(wireCalls.map((path) => path.split("/").at(-1))).toEqual(["probe"]);
  expect(
    b.db
      .prepare(
        "SELECT count(*) n FROM fleet_enrollments WHERE role='destination'",
      )
      .get(),
  ).toEqual({ n: 0 });
});

it("refuses a repair body admitted before the gateway origin changed", async () => {
  const a = await machine();
  const before = await create(a);
  const body = JSON.stringify({
    mutationId: randomUUID(),
    expected: before.head,
    confirm: true,
  });
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const handler = a.host.workspace!.fleetAdminHttp!;
  a.host.workspace!.fleetAdminHttp = (req, res) => {
    handler(req, res);
    admitted();
  };
  const req = request({
    hostname: "127.0.0.1",
    port: a.host.port,
    path: "/api/fleet/admin/repair-self",
    method: "POST",
    headers: {
      ...a.headers,
      host: new URL(a.host.origin).host,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  const response = new Promise<unknown>((resolve) => {
    req.once("error", resolve);
    req.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
  });
  req.write(body.slice(0, -1));
  await admission;
  a.host.setOrigin(`https://${randomUUID()}.example`);
  req.end(body.slice(-1));
  expect(await response).toBeInstanceOf(Error);
  expect(a.admin.state().head).toBe(before.head);
  expect(a.admin.state().directory!.document.members[0].origin).toBe(
    before.origin,
  );
});

it("does not apply a handoff receipt after the requesting device is revoked", async () => {
  const a = await machine(),
    b = await machine();
  await enrolled(a, b);
  const operationId = randomUUID();
  await call(a, "handoffBegin", {
    operationId,
    expected: a.admin.state().head,
    destination: b.authority.identity,
    confirm: true,
  });
  controls.loseCommit = true;
  await call(a, "handoffAdvance", { operationId });
  let release!: () => void, observed!: () => void, finished!: () => void;
  controls.receiptWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receipted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  controls.receipted = observed;
  const reconcile = a.admin.handoff.reconcile.bind(a.admin.handoff);
  a.admin.handoff.reconcile = (...args) => reconcile(...args).finally(finished);
  const pending = call(a, "handoffReconcile", {
    operationId,
    confirm: true,
  }).catch((error) => error);
  await receipted;
  await send(a.host, "/api/auth/sign-out", {}, a.headers);
  release();
  await completed;
  expect(await pending).toBeInstanceOf(Error);
  expect(a.admin.handoff.status(operationId).state).toBe("uncertain");
  expect(a.admin.state().state).toBe("handoff_pending");
  expect(b.admin.state().state).toBe("controller");
  expect(
    wireCalls.filter((path) => path.endsWith("/handoff/commit")),
  ).toHaveLength(1);
});

it("does not apply an enrollment receipt after the requesting origin changed", async () => {
  const a = await machine(),
    b = await machine();
  await create(a);
  const input = await begin(a, b);
  controls.loseCommit = true;
  await call(a, "advance", { operationId: input.operationId });
  let release!: () => void, observed!: () => void, finished!: () => void;
  controls.receiptWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receipted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  controls.receipted = observed;
  const reconcile = a.source.reconcile.bind(a.source);
  a.source.reconcile = (...args) => reconcile(...args).finally(finished);
  const pending = call(a, "reconcile", {
    operationId: input.operationId,
  }).catch((error) => error);
  await receipted;
  a.host.setOrigin(`https://${randomUUID()}.example`);
  release();
  await completed;
  expect(await pending).toBeInstanceOf(Error);
  expect(a.source.status(input.operationId).state).toBe("uncertain");
  expect(b.authority.status(b.owner).state).toBe("replica");
  expect(
    wireCalls.filter((path) => path.endsWith("/enrollment/commit")),
  ).toHaveLength(1);
});

it.each(["enrollment", "handoff"] as const)(
  "fences a successful %s commit callback after authorization changes, then reconciles once",
  async (kind) => {
    const a = await machine(),
      b = await machine();
    let operationId: string;
    if (kind === "enrollment") {
      await create(a);
      operationId = (await begin(a, b)).operationId;
    } else {
      await enrolled(a, b);
      operationId = randomUUID();
      expect(
        (
          await call(a, "handoffBegin", {
            operationId,
            expected: a.admin.state().head,
            destination: b.authority.identity,
            confirm: true,
          })
        ).status,
      ).toBe(200);
    }
    wireCalls.length = 0;
    let release!: () => void, observed!: () => void, finished!: () => void;
    controls.commitWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    controls.committed = observed;
    const service = kind === "enrollment" ? a.source : a.admin.handoff;
    if (kind === "enrollment") {
      const advance = a.source.advance.bind(a.source);
      a.source.advance = (...args) => advance(...args).finally(finished);
    } else {
      const advance = a.admin.handoff.advance.bind(a.admin.handoff);
      a.admin.handoff.advance = (...args) => advance(...args).finally(finished);
    }
    const pending = call(
      a,
      kind === "enrollment" ? "advance" : "handoffAdvance",
      { operationId },
    ).catch((error) => error);
    await committed;
    if (kind === "enrollment")
      await send(a.host, "/api/auth/sign-out", {}, a.headers);
    else a.host.setOrigin(`https://${randomUUID()}.example`);
    release();
    await completed;
    expect(await pending).toBeInstanceOf(Error);
    expect(service.status(operationId).state).toBe("uncertain");
    expect(b.admin.state().state).toBe(
      kind === "enrollment" ? "replica" : "controller",
    );
    if (kind === "handoff")
      expect(a.admin.state().state).toBe("handoff_pending");
    await pairFreshOrigin(a);
    const receipt = await call(
      a,
      kind === "enrollment" ? "reconcile" : "handoffReconcile",
      {
        operationId,
        ...(kind === "handoff" ? { confirm: true } : {}),
      },
    );
    expect(receipt.status).toBe(200);
    expect(receipt.body.state).toBe("complete");
    expect(wireCalls.filter((path) => path.endsWith("/commit"))).toHaveLength(
      1,
    );
  },
);

it("shows owner-scoped latest directory delivery, retries only its durable packet and retires old recovery work", async () => {
  const a = await machine(),
    b = await machine();
  await enrolled(a, b);
  const previous = a.admin.state();
  const removed = await call(a, "remove", {
    mutationId: randomUUID(),
    expected: previous.head,
    machineId: b.authority.identity.machineId,
    confirm: true,
  });
  expect(removed.status).toBe(200);
  const head = removed.body.head;
  const foreign = randomUUID();
  a.db
    .prepare(
      `INSERT INTO fleet_directory_history
    SELECT ?,digest,fleet_id,mutation_id,signed,accepted_at FROM fleet_directory_history WHERE owner_id=? AND digest=?`,
    )
    .run(foreign, a.owner, head);
  a.db
    .prepare(
      "INSERT INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
    )
    .run(foreign, a.authority.identity.machineId, head);
  a.db
    .prepare(
      "UPDATE fleet_distribution SET state='incompatible',attempts=3,next_attempt=123456 WHERE owner_id=? AND peer_id=? AND directory_digest=?",
    )
    .run(a.owner, b.authority.identity.machineId, head);
  a.db
    .prepare(
      "INSERT INTO fleet_distribution_work(owner_id,peer_id,directory_digest,request) VALUES(?,?,?,?)",
    )
    .run(
      a.owner,
      b.authority.identity.machineId,
      head,
      "retained packet fixture",
    );
  const page = await call(a, "deliveries", { cursor: null });
  expect(page.status).toBe(200);
  expect(page.body.items).toHaveLength(1);
  const delivery = page.body.items[0];
  expect(delivery).toMatchObject({
    peerId: b.authority.identity.machineId,
    digest: head,
    state: "incompatible",
    current: true,
    attempts: 3,
  });
  expect(JSON.stringify(page.body)).not.toContain(foreign);
  expect(JSON.stringify(page.body)).not.toContain("packet");
  const input = {
    peerId: delivery.peerId,
    digest: head,
    expected: head,
    confirm: true,
  };
  expect(
    (await call(a, "retryDelivery", { ...input, expected: previous.head }))
      .status,
  ).toBe(409);
  const dispatches = wireCalls.length;
  expect((await call(a, "retryDelivery", input)).status).toBe(200);
  expect(wireCalls).toHaveLength(dispatches);
  expect(
    a.db
      .prepare(
        "SELECT state,attempts,next_attempt FROM fleet_distribution WHERE owner_id=? AND peer_id=? AND directory_digest=?",
      )
      .get(a.owner, delivery.peerId, head),
  ).toEqual({ state: "pending", attempts: 3, next_attempt: 0 });
  expect(
    a.db
      .prepare(
        "SELECT request FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
      )
      .get(a.owner, delivery.peerId, head),
  ).toEqual({ request: "retained packet fixture" });
  const recovered = await call(a, "recover", {
    mutationId: randomUUID(),
    expected: head,
    name: "Recovered",
    scope: [...scope],
    confirm: true,
  });
  expect(recovered.status).toBe(200);
  expect(recovered.body.pendingDistribution).toBe(0);
  expect(
    (await call(a, "deliveries", { cursor: null })).body.items[0].current,
  ).toBe(false);
  expect(
    (
      await call(a, "retryDelivery", {
        ...input,
        expected: recovered.body.head,
      })
    ).status,
  ).toBe(409);
});

it("keeps a pending removal current after more than 1024 ordinary revisions", async () => {
  const a = await machine(),
    b = await machine();
  await enrolled(a, b);
  const removed = await call(a, "remove", {
    mutationId: randomUUID(),
    expected: a.admin.state().head,
    machineId: b.authority.identity.machineId,
    confirm: true,
  });
  expect(removed.status).toBe(200);
  let head = removed.body.head;
  for (let i = 0; i < 1025; i++) {
    a.authority.revise(a.owner, {
      mutationId: randomUUID(),
      expected: head,
      members: a.authority.directory(a.owner)!.document.members,
    });
    head = a.authority.status(a.owner).head!;
    // Keep HTTP keep-alive timers progressing during the signed-history setup.
    if (i % 64 === 63)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const page = await call(a, "deliveries", { cursor: null });
  expect(page.status).toBe(200);
  expect(
    page.body.items.find(
      (item: { peerId: string }) =>
        item.peerId === b.authority.identity.machineId,
    ),
  ).toMatchObject({
    digest: removed.body.head,
    current: true,
    state: "pending",
  });
  expect((await call(a, "state")).body.pendingDistribution).toBeGreaterThan(0);
  expect(
    (
      await call(a, "retryDelivery", {
        peerId: b.authority.identity.machineId,
        digest: removed.body.head,
        expected: head,
        confirm: true,
      })
    ).status,
  ).toBe(200);
  const recovered = await call(a, "recover", {
    mutationId: randomUUID(),
    expected: head,
    name: "Recovered",
    scope: [...scope],
    confirm: true,
  });
  expect(recovered.status).toBe(200);
  expect(
    (await call(a, "deliveries", { cursor: null })).body.items[0].current,
  ).toBe(false);
  expect(
    (
      await call(a, "retryDelivery", {
        peerId: b.authority.identity.machineId,
        digest: removed.body.head,
        expected: recovered.body.head,
        confirm: true,
      })
    ).status,
  ).toBe(409);
}, 60000);

it("pages every retained operation without leaking capabilities or another owner's jobs", async () => {
  const a = await machine(),
    b = await machine();
  const current = await create(a);
  const minted = await call(b, "mint", {
    scope: [...scope],
    recover: false,
    confirm: true,
  });
  const link = fleetEnrollmentFromLink(minted.body.url);
  const ids = new Set<string>();
  for (let i = 0; i < 55; i++) {
    const operationId = randomUUID();
    ids.add(operationId);
    a.source.begin({
      operationId,
      expected: current.head,
      link,
      name: "Peer",
      mode: "enroll",
      scope: [...scope],
    });
    a.source.cancel(operationId);
  }
  const first = await call(a, "list", { cursor: null });
  expect(first.status).toBe(200);
  expect(first.body.items).toHaveLength(50);
  expect(first.body.next).not.toBeNull();
  const next = await call(a, "list", { cursor: first.body.next });
  expect(next.body.items).toHaveLength(5);
  expect(next.body.next).toBeNull();
  expect(
    new Set(
      [...first.body.items, ...next.body.items].map((item) => item.operationId),
    ),
  ).toEqual(ids);
  expect(JSON.stringify([first.body, next.body])).not.toContain(
    link.enrollment,
  );
  expect((await call(b, "list", { cursor: null })).body.items).toEqual([]);
  expect(
    (await call(b, "state", undefined, { ...a.headers, origin: b.host.origin }))
      .status,
  ).toBe(401);
});

it("exposes pending destination consent only locally and lets that device cancel it", async () => {
  const a = await machine(),
    b = await machine();
  await create(a);
  const input = await begin(a, b);
  // Lose the preparation response after the real destination transaction.
  const original = b.destination.prepare.bind(b.destination);
  b.destination.prepare = (value) => {
    original(value);
    throw new Error("Fixture dropped prepared response");
  };
  expect(
    (await call(a, "advance", { operationId: input.operationId })).body.state,
  ).toBe("uncertain");
  b.destination.prepare = original;
  const pending = await call(b, "pending", { cursor: null });
  expect(pending.body.items).toMatchObject([
    {
      operationId: input.operationId,
      controller: a.authority.identity,
      mode: "enroll",
    },
  ]);
  expect(JSON.stringify(pending.body)).not.toContain(input.link.enrollment);
  expect((await call(a, "pending", { cursor: null })).body.items).toEqual([]);
  expect(
    (await call(b, "cancelPending", { operationId: input.operationId })).body,
  ).toEqual({ ok: true });
  expect(
    (await call(a, "reconcile", { operationId: input.operationId })).body.state,
  ).toBe("cancelled");
  expect((await call(b, "pending", { cursor: null })).body.items).toEqual([]);
  expect(b.authority.status(b.owner).state).toBe("standalone");
});

it("keeps preview and absent integrations outside local fleet administration", async () => {
  const a = await machine();
  a.host.workspace!.isolated = true;
  // Preview cookies have a separate namespace, so authorize only the boundary
  // under test with a fresh preview-local device session.
  const paired = await send(
    a.host,
    "/pair",
    {
      ...fleetDeviceFromLink(a.host.pair().url, a.host.origin),
      name: "Preview fixture",
    },
    { origin: a.host.origin },
  );
  const cookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await send(a.host, "/session", undefined, { cookie }, "GET");
  const headers = {
    cookie,
    origin: a.host.origin,
    "x-loop-csrf": session.body.csrf,
  };
  expect((await call(a, "state", undefined, headers)).status).toBe(404);
  a.host.workspace!.isolated = false;
  a.host.workspace!.fleetAdminHttp = undefined;
  expect((await call(a, "state")).status).toBe(404);
  expect(a.workspaceCalls()).toBe(0);
});

it("retains prepared consent without publishing after its authorizing request is revoked", async () => {
  const a = await machine(),
    b = await machine();
  const initial = await create(a);
  const input = await begin(a, b);
  let release!: () => void, observed!: () => void, finished!: () => void;
  controls.prepareWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepared = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  controls.prepared = observed;
  const advance = a.source.advance.bind(a.source);
  a.source.advance = (...args) => advance(...args).finally(finished);
  const pending = call(a, "advance", { operationId: input.operationId }).catch(
    (error) => error,
  );
  await prepared;
  expect((await send(a.host, "/api/auth/sign-out", {}, a.headers)).status).toBe(
    200,
  );
  release();
  await completed;
  expect(await pending).toBeInstanceOf(Error);
  expect(a.source.status(input.operationId).state).toBe("prepared");
  expect(a.authority.status(a.owner).head).toBe(initial.head);
  expect(wireCalls.map((path) => path.split("/").at(-1))).toEqual([
    "probe",
    "prepare",
  ]);
  expect(b.admin.pending(null).items).toHaveLength(1);
});

it("bounds administration bodies and keeps invalid capability input out of errors", async () => {
  const a = await machine();
  const invalid = await call(a, "begin", {
    link: { enrollment: "sensitive-fixture-capability" },
  });
  expect(invalid.status).toBe(400);
  expect(JSON.stringify(invalid.body)).not.toContain(
    "sensitive-fixture-capability",
  );
  // Parsing failures must release their admission slot and redact raw input.
  for (let attempt = 0; attempt < 17; attempt++) {
    const malformed = await call(
      a,
      "begin",
      '{"enrollment":"sensitive-fixture-capability"',
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({
      error: "Fleet administration is unavailable.",
    });
  }
  const large = await call(a, "begin", { padding: "x".repeat(256 * 1024) });
  expect(large.status).toBe(413);
  expect((await call(a, "state")).body.state).toBe("standalone");
});
