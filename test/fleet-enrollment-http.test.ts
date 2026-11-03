import { afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Response } from "undici";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetEnrollmentSource } from "../src/server/fleet-enrollment-source.js";
import {
  directoryDigest,
  generateMachineKey,
} from "../src/server/fleet-crypto.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import { secret } from "../src/state.js";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", async (original) => ({
  ...(await original<typeof import("node:dns")>()),
  lookup: dns.lookup,
}));
const root = mkdtempSync(join(tmpdir(), "loop-fleet-http-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const { FleetEnrollmentHttpTransport } =
  await import("../src/server/fleet-enrollment-http.js");
const { publicNetworkDispatcher } =
  await import("../src/server/mcp/network.js");
const { db: globalDb } = await import("../src/server/db.js");
const databases: Database.Database[] = [];
const scope = ["read", "act", "events", "mail", "files"] as const;
afterAll(async () => {
  await publicNetworkDispatcher.close();
  for (const db of databases) if (db.open) db.close();
  if (globalDb.open) globalDb.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const owner = randomUUID(),
    dir = join(root, randomUUID());
  mkdirSync(dir);
  const db = new Database(join(dir, "workspace.db"));
  databases.push(db);
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets),
    pairing = new FleetPairing(db, authority, owner, dir),
    origin = `https://${randomUUID()}.example`;
  const destination = new FleetEnrollmentDestination(
    db,
    authority,
    pairing,
    owner,
    secrets,
    () => origin,
  );
  return { owner, db, authority, pairing, origin, destination };
}
const probe = () => ({
  version: 1 as const,
  nonce: secret(),
  origin: "https://peer.example",
  destination: generateMachineKey().identity,
});
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });

it("sends strict enrollment-only requests through fixed paths and reconciles a lost commit without a second effect", async () => {
  const a = machine(),
    b = machine();
  const url = b.pairing.pair(b.origin).url;
  const device = fleetDeviceFromLink(url, b.origin),
    link = fleetEnrollmentFromLink(url);
  const calls: string[] = [];
  const transport = new FleetEnrollmentHttpTransport(async (url, init) => {
    const target = new URL(String(url));
    expect(target.origin).toBe(b.origin);
    expect(target.search).toBe("");
    expect(target.hash).toBe("");
    expect(init?.method).toBe("POST");
    expect(init?.dispatcher).toBe(publicNetworkDispatcher);
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Loop-Fleet-Version": "1",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(init?.body)).not.toContain(device.secret);
    const input = JSON.parse(String(init?.body));
    calls.push(target.pathname);
    const prefix = "/api/fleet/peer/v1/enrollment/";
    if (target.pathname === prefix + "probe")
      return json(b.destination.probe(input));
    if (target.pathname === prefix + "prepare")
      return json(b.destination.prepare(input), {
        "set-cookie": "fixture=not-forwarded; Secure",
      });
    if (target.pathname === prefix + "commit") {
      b.destination.commit(input);
      throw new Error(`Fixture response loss: ${link.enrollment}`);
    }
    if (target.pathname === prefix + "receipt")
      return json(b.destination.receipt(input));
    throw new Error("Unexpected transport path");
  });
  const directory = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Controller",
    origin: a.origin,
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
    name: "Destination",
    mode: "enroll",
    scope: [...scope],
  });
  expect((await source.advance(operationId)).state).toBe("uncertain");
  await source.advance(operationId);
  expect(calls).toHaveLength(3);
  const result = await source.reconcile(operationId);
  expect(result.state).toBe("complete");
  expect(JSON.stringify(result)).not.toContain(link.enrollment);
  expect(calls.map((path) => path.split("/").at(-1))).toEqual([
    "probe",
    "prepare",
    "commit",
    "receipt",
  ]);
  expect(b.pairing.devices()).toEqual([]);
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 1 });
});

it("refuses noncanonical, private or credential-bearing origins before any network request", async () => {
  const fetcher = vi.fn(),
    client = new FleetEnrollmentHttpTransport(fetcher);
  for (const origin of [
    "http://peer.example",
    "https://peer.example/",
    "https://peer.example/path",
    "https://peer.example?secret=fixture",
    "https://peer.example/#fixture",
    "https://user:password@peer.example",
    "https://localhost",
    "https://foo.localhost",
    "https://foo.local",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://10.0.0.1",
    "https://169.254.169.254",
  ]) {
    await expect(client.probe(origin, { ...probe(), origin })).rejects.toThrow(
      "public HTTPS origin",
    );
  }
  await expect(client.probe("https://other.example", probe())).rejects.toThrow(
    "origin changed",
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("checks every DNS address through the production connection dispatcher", async () => {
  const client = new FleetEnrollmentHttpTransport();
  for (const addresses of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
  ]) {
    dns.lookup.mockImplementation((_hostname, options, callback) => {
      expect(options).toEqual({ all: true, verbatim: true });
      callback(null, addresses);
    });
    const origin = `https://${randomUUID()}.example`;
    await expect(client.probe(origin, { ...probe(), origin })).rejects.toThrow(
      "response is unavailable",
    );
  }
  expect(dns.lookup).toHaveBeenCalledTimes(4);
});

it("does not follow redirects, forward cookies or expose upstream errors and invalid bodies", async () => {
  const input = probe(),
    signature = Buffer.alloc(64).toString("base64url");
  const reply = { probe: input, signature };
  const happy = new FleetEnrollmentHttpTransport(async () =>
    json(reply, {
      "set-cookie": "loop=fixture",
      location: "https://elsewhere.example",
    }),
  );
  expect(await happy.probe(input.origin, input)).toEqual(reply);
  const responses = [
    new Response("fixture-secret", {
      status: 302,
      headers: { location: "https://127.0.0.1/" },
    }),
    new Response("fixture-secret", { status: 503 }),
    new Response("fixture-secret", {
      headers: { "content-type": "text/html" },
    }),
    new Response("fixture-secret", {
      headers: { "content-type": "application/json" },
    }),
    json({ ...reply, deviceCookie: "fixture-secret" }),
  ];
  for (const response of responses) {
    const fetcher = vi.fn(async () => response),
      client = new FleetEnrollmentHttpTransport(fetcher);
    const error = await client
      .probe(input.origin, input)
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("fixture-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("cancels oversized response streams regardless of the advertised length", async () => {
  const input = probe();
  for (const length of [undefined, "1", "4194305", "invalid"]) {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const response = new Response(stream, {
      headers: {
        "content-type": "application/json",
        ...(length ? { "content-length": length } : {}),
      },
    });
    const client = new FleetEnrollmentHttpTransport(async () => response);
    await expect(client.probe(input.origin, input)).rejects.toThrow(
      "response is unavailable",
    );
    expect(cancel).toHaveBeenCalledOnce();
  }
});
