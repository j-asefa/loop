import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  request,
  type IncomingHttpHeaders,
  type ClientRequest,
} from "node:http";
import { Agent } from "undici";
import { connect } from "node:net";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetEnrollmentSource } from "../src/server/fleet-enrollment-source.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.js";
import { secret } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "loop55-fleet-admission-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const { FleetEnrollmentHttpTransport } =
  await import("../src/server/fleet-enrollment-http.js");
const { publicNetworkDispatcher } =
  await import("../src/server/mcp/network.js");
const { db: globalDb } = await import("../src/server/db.js");
const databases: Database.Database[] = [];
const scope = ["read", "act", "events", "mail", "files"] as const;
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
  return { dir, owner, db, authority, pairing };
}
let a: ReturnType<typeof machine>, b: ReturnType<typeof machine>, host: Host;
const origin = "https://destination.example";
const hostHeader = new URL(origin).host;
let workspaceCalls = 0;
beforeAll(async () => {
  a = machine();
  b = machine();
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
  const destination = new FleetEnrollmentDestination(
    b.db,
    b.authority,
    b.pairing,
    b.owner,
    secrets,
    () => host.origin,
  );
  host.workspace = {
    http: (_req, res) => {
      workspaceCalls++;
      res.writeHead(404).end();
    },
    peerHttp: createFleetPeerHttp(destination, () => host.origin),
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  await host.listen();
  host.setOrigin(origin);
});
afterAll(async () => {
  await host?.close();
  for (const db of databases) if (db.open) db.close();
  if (globalDb.open) globalDb.close();
  rmSync(root, { recursive: true, force: true });
});
function send(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: unknown;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method,
        headers: {
          host: hostHeader,
          "content-type": "application/json",
          "x-loop55-fleet-version": "1",
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
      typeof body === "string"
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    );
  });
}
const probe = () => ({
  version: 1 as const,
  nonce: secret(),
  origin,
  destination: b.authority.identity,
});
const probePath = "/api" + fleetPeerApi.enrollmentProbe.path;
function loopbackEdge() {
  return new Agent({
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
}

it("admits the default Undici transport's actual request headers through Host", async () => {
  // Replace only the network connector with an isolated plaintext loopback
  // edge. Keep the production request implementation and its header generation.
  // Public DNS policy has separate tests; this does not exercise Internet TLS.
  const edge = loopbackEdge();
  const dispatch = vi
    .spyOn(publicNetworkDispatcher, "dispatch")
    .mockImplementation((options, handler) => edge.dispatch(options, handler));
  try {
    const input = probe();
    expect(
      (await new FleetEnrollmentHttpTransport().probe(origin, input)).probe,
    ).toEqual(input);
    expect(workspaceCalls).toBe(0);
  } finally {
    dispatch.mockRestore();
    await edge.close();
  }
});

it("refuses actual redirects and oversized streamed replies without forwarding response cookies", async () => {
  const edge = loopbackEdge(),
    original = host.workspace!.peerHttp,
    dispatch = vi
      .spyOn(publicNetworkDispatcher, "dispatch")
      .mockImplementation((options, handler) =>
        edge.dispatch(options, handler),
      ),
    transport = new FleetEnrollmentHttpTransport();
  let requests = 0,
    status = 302;
  host.workspace!.peerHttp = (_req, res) => {
    requests++;
    res.statusCode = status;
    res.setHeader("Connection", "close");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", "fixture=must-not-forward");
    if (status === 302) res.setHeader("Location", origin + probePath);
    if (status === 200) res.write(" ".repeat(4 * 1024 * 1024));
    res.end(status === 200 ? " " : undefined);
  };
  try {
    for (const code of [302, 204, 205, 304, 700, 200]) {
      status = code;
      await expect(transport.probe(origin, probe())).rejects.toThrow();
    }
    expect(requests).toBe(6);
    host.workspace!.peerHttp = original;
    const input = probe();
    // Admission would reject a Cookie header if a response cookie were retained.
    expect((await transport.probe(origin, input)).probe).toEqual(input);
  } finally {
    host.workspace!.peerHttp = original;
    dispatch.mockRestore();
    await edge.close();
  }
});

it("runs a dual-owner enrollment through default transport and Host, including lost-response reconciliation", async ({
  onTestFinished,
}) => {
  const pairingUrl = host.pair().url;
  const deviceHalf = fleetDeviceFromLink(pairingUrl, origin),
    link = fleetEnrollmentFromLink(pairingUrl);
  const paths: string[] = [];
  const edge = loopbackEdge();
  const dispatch = vi
    .spyOn(publicNetworkDispatcher, "dispatch")
    .mockImplementation((options, handler) => {
      expect(String(options.origin)).toBe(origin);
      expect(String(options.body)).not.toContain(deviceHalf.secret);
      paths.push(options.path);
      return edge.dispatch(options, handler);
    });
  onTestFinished(async () => {
    dispatch.mockRestore();
    await edge.close();
  });
  const transport = new FleetEnrollmentHttpTransport(),
    commit = transport.commit.bind(transport);
  transport.commit = async (target, input) => {
    await commit(target, input);
    throw new Error(
      "Fixture lost the commit response after destination acceptance",
    );
  };
  const directory = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Same label",
    origin: "https://controller.example",
    scope: [...scope],
  });
  const source = new FleetEnrollmentSource(
      a.db,
      a.authority,
      a.owner,
      secrets,
      transport,
    ),
    operationId = randomUUID();
  source.begin({
    operationId,
    expected: directoryDigest(directory.document),
    link,
    name: "Same label",
    mode: "enroll",
    scope: [...scope],
  });
  expect((await source.advance(operationId)).state).toBe("uncertain");
  await source.advance(operationId);
  expect(paths).toHaveLength(3);
  expect((await source.reconcile(operationId)).state).toBe("complete");
  expect(paths.map((path) => path.split("/").at(-1))).toEqual([
    "probe",
    "prepare",
    "commit",
    "receipt",
  ]);
  expect(b.owner).not.toBe(a.owner);
  expect(b.db.prepare("SELECT owner_id FROM fleet_binding").get()).toEqual({
    owner_id: b.owner,
  });
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });
  expect(b.pairing.devices()).toEqual([]);
  const rejected = await send(
    "/pair",
    { ...deviceHalf, name: "Spent device half" },
    { origin },
  );
  expect(rejected.status).toBe(403);
  expect(rejected.headers["set-cookie"]).toBeUndefined();
});

it("rejects browser and Cards credentials before protocol handling, including a real paired cookie", async () => {
  const device = fleetDeviceFromLink(host.pair().url, origin);
  const paired = await send("/pair", { ...device, name: "Phone" }, { origin });
  expect(paired.status).toBe(200);
  const cookie = paired.headers["set-cookie"]![0].split(";")[0];
  const forbidden: Record<string, string>[] = [
    { origin },
    { origin: "" },
    { origin: "https://attacker.example" },
    { cookie },
    { authorization: "Bearer fixture-card-token" },
    { "x-loop55-csrf": "fixture" },
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-mode": "cors" },
    { "x-http-method-override": "POST" },
    { "x-method-override": "POST" },
  ];
  for (const headers of forbidden) {
    const response = await send(probePath, probe(), headers);
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
  }
  expect((await send(probePath, probe())).status).toBe(200);
});

it("matches Host and exact peer paths without trusting forwarded headers or falling through to private APIs", async () => {
  expect(
    (
      await send(probePath, probe(), {
        host: "attacker.example",
        "x-forwarded-host": hostHeader,
        "x-forwarded-proto": "https",
      })
    ).status,
  ).toBe(403);
  expect(
    (await send(probePath, probe(), { "x-forwarded-host": "attacker.example" }))
      .status,
  ).toBe(200);
  for (const path of [
    probePath + "/",
    probePath + "?owner=other",
    probePath.replace("probe", "%70robe"),
    "/api/fleet/peer/v2/enrollment/probe",
    "/api/fleet/peer/v1/native",
    "/api/fleet/peer/../workspace/devices",
  ]) {
    expect((await send(path, probe())).status).toBe(404);
  }
  expect((await send(probePath, undefined, {}, "GET")).status).toBe(405);
  expect(
    (await send("/api/workspace/devices", undefined, {}, "GET")).status,
  ).toBe(401);
  expect((await send("/api/native/providers", {})).status).toBe(401);
  expect((await send("/revoke", { id: randomUUID() })).status).toBe(404);
  expect(workspaceCalls).toBe(0);
});

it("refuses wrong version, malformed or oversized JSON without reflecting capability-bearing input", async () => {
  expect(
    (await send(probePath, probe(), { "x-loop55-fleet-version": "2" })).status,
  ).toBe(400);
  expect(
    (await send(probePath, probe(), { "content-type": "text/plain" })).status,
  ).toBe(415);
  const invalid = await send(
    probePath,
    '{"capability":"fixture-sensitive-parse-error"',
  );
  expect(invalid.status).toBe(400);
  expect(JSON.stringify(invalid.body)).not.toContain("fixture-sensitive");
  const unknownOwner = await send(probePath, { ...probe(), owner_id: a.owner });
  expect(unknownOwner.status).toBe(400);
  const huge = await send(
    probePath,
    JSON.stringify({ value: "x".repeat(4 * 1024 * 1024) }),
  );
  expect(huge.status).toBe(413);
  expect((await send(probePath, probe())).status).toBe(200);
});

it("refuses peer entry in previews and when no companion peer handler is installed", async () => {
  const handler = host.workspace!.peerHttp;
  try {
    host.workspace!.isolated = true;
    expect((await send(probePath, probe())).status).toBe(404);
    host.workspace!.isolated = false;
    host.workspace!.peerHttp = undefined;
    expect((await send(probePath, probe())).status).toBe(404);
  } finally {
    host.workspace!.isolated = false;
    host.workspace!.peerHttp = handler;
  }
  expect(workspaceCalls).toBe(0);
});

it("bounds concurrent incomplete peer bodies without consuming a local ceremony", async () => {
  const open: ClientRequest[] = [];
  try {
    await Promise.all(
      Array.from(
        { length: 16 },
        () =>
          new Promise<void>((resolve, reject) => {
            const req = request({
              hostname: "127.0.0.1",
              port: host.port,
              path: probePath,
              method: "POST",
              headers: {
                host: hostHeader,
                "content-type": "application/json",
                "content-length": "1000",
                "x-loop55-fleet-version": "1",
              },
            });
            open.push(req);
            req.on("error", () => {});
            req.on("socket", (socket) => {
              if (socket.connecting) socket.once("connect", resolve);
              else resolve();
              socket.once("error", reject);
            });
            req.write("{");
          }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await send(probePath, probe())).status).toBe(503);
  } finally {
    for (const req of open) req.destroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await send(probePath, probe())).status).toBe(200);
});
