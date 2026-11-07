import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../src/shared/fleet-pairing.js";
import { hash, secret } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-pairing-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
const origin = "https://destination.example";
const scope = ["read", "act", "events", "mail", "files"] as const;
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine(
  owner: string = randomUUID(),
  wall: () => number = Date.now,
  monotonic?: () => number,
) {
  const dir = join(root, randomUUID());
  mkdirSync(dir);
  const path = join(dir, "workspace.db"),
    db = new Database(path);
  db.pragma("foreign_keys=ON");
  db.pragma("busy_timeout=5000");
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  databases.push(db);
  const authority = new FleetAuthority(db, secrets);
  return {
    owner,
    path,
    dir,
    db,
    authority,
    open: () => new FleetPairing(db, authority, owner, dir, wall, monotonic),
  };
}
function capabilities(pairing: FleetPairing) {
  const { url } = pairing.pair(origin);
  return {
    device: fleetDeviceFromLink(url, origin),
    enrollment: fleetEnrollmentFromLink(url),
  };
}
function consent(
  link: ReturnType<typeof capabilities>["enrollment"],
  request: unknown = { confirmed: true },
) {
  return {
    ceremonyId: link.ceremonyId,
    secret: link.enrollment,
    origin,
    operationId: randomUUID(),
    request,
  };
}
function proposed(
  a: ReturnType<typeof machine>,
  b: ReturnType<typeof machine>,
) {
  const genesis = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "A",
    origin: "https://a.example",
    scope: [...scope],
  });
  const grantId = randomUUID();
  const signed = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(genesis.document),
    members: [
      ...genesis.document.members,
      { ...b.authority.identity, grantId, name: "B", origin },
    ],
  });
  return {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll" as const,
    grantId,
    scope: [...scope],
    controller: a.authority.identity,
    directory: signed,
  };
}
const PublicReceipt = z.object({
  head: z.string(),
  grantId: z.string().uuid(),
});

it("keeps the two capabilities independent, consumes both on device pairing and survives restart", () => {
  const m = machine(),
    pairing = m.open(),
    c = capabilities(pairing);
  expect(c.device.secret).not.toBe(c.enrollment.enrollment);
  expect(() =>
    pairing.redeem({ secret: c.enrollment.enrollment, name: "Phone" }, origin),
  ).toThrow();
  expect(() =>
    pairing.redeem({ ...c.device, name: "Phone" }, "https://wrong.example"),
  ).toThrow();
  expect(() =>
    pairing.redeem(
      { ...c.device, ceremonyId: randomUUID(), name: "Phone" },
      origin,
    ),
  ).toThrow();
  expect(() =>
    pairing.consumeEnrollment(
      { ...consent(c.enrollment), secret: c.device.secret },
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    ),
  ).toThrow();
  const device = pairing.redeem({ ...c.device, name: "Phone" }, origin);
  const reopened = m.open();
  expect(reopened.authenticate(hash(device.token))?.name).toBe("Phone");
  expect(() =>
    reopened.redeem({ ...c.device, name: "Phone" }, origin),
  ).toThrow();
  expect(() =>
    reopened.consumeEnrollment(
      consent(c.enrollment),
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    ),
  ).toThrow();
  expect(reopened.devices()).toHaveLength(1);
  expect(
    JSON.stringify(m.db.prepare("SELECT * FROM pairing_ceremonies").all()),
  ).not.toContain(c.device.secret);
  expect(
    JSON.stringify(m.db.prepare("SELECT * FROM devices").all()),
  ).not.toContain(device.token);
});

it("persists grant, mutual consumption and a projected receipt atomically; bound retries do not repeat consent", () => {
  let now = Date.now();
  const a = machine(),
    b = machine("destination-owner", () => now),
    pairing = b.open(),
    c = capabilities(pairing);
  const approval = proposed(a, b),
    input = consent(c.enrollment, approval);
  const result = pairing.consumeEnrollment(input, PublicReceipt, (accepted) => {
    expect(accepted).toEqual({
      scope: [...scope],
      expectedHead: null,
      mode: "enroll",
    });
    b.authority.approve(b.owner, approval);
    return {
      head: b.authority.status(b.owner).head!,
      grantId: approval.grantId,
      secret: "must-not-be-stored",
    };
  });
  expect(b.authority.status(b.owner).state).toBe("replica");
  now += 180_000;
  const reopened = b.open();
  expect(
    reopened.consumeEnrollment(input, PublicReceipt, () => {
      throw new Error("must not run");
    }),
  ).toEqual(result);
  expect(() =>
    reopened.consumeEnrollment(
      { ...input, operationId: randomUUID() },
      PublicReceipt,
      () => result,
    ),
  ).toThrow("different operation");
  expect(() =>
    reopened.consumeEnrollment(
      { ...input, request: { other: true } },
      PublicReceipt,
      () => result,
    ),
  ).toThrow("different operation");
  expect(() =>
    reopened.redeem({ ...c.device, name: "Phone" }, origin),
  ).toThrow();
  expect(reopened.devices()).toEqual([]);
  const row = b.db.prepare("SELECT * FROM pairing_ceremonies").get();
  expect(JSON.stringify(row)).not.toContain("must-not-be-stored");
  expect(JSON.stringify(row)).not.toContain(c.enrollment.enrollment);
});

it("rolls back grant and device writes with failed consumption without reviving a successfully spent code", () => {
  const a = machine(),
    b = machine(),
    pairing = b.open(),
    c = capabilities(pairing),
    approval = proposed(a, b);
  b.db.exec(
    "CREATE TRIGGER reject_consumption BEFORE UPDATE ON pairing_ceremonies BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
  );
  expect(() =>
    pairing.consumeEnrollment(
      consent(c.enrollment, approval),
      PublicReceipt,
      () => {
        b.authority.approve(b.owner, approval);
        return {
          head: b.authority.status(b.owner).head!,
          grantId: approval.grantId,
        };
      },
    ),
  ).toThrow("fixture disk failure");
  expect(b.authority.status(b.owner).state).toBe("standalone");
  expect(
    b.db.prepare("SELECT count(*) n FROM fleet_local_consents").get(),
  ).toEqual({ n: 0 });
  expect(() => pairing.redeem({ ...c.device, name: "Phone" }, origin)).toThrow(
    "fixture disk failure",
  );
  expect(pairing.devices()).toEqual([]);
  b.db.exec("DROP TRIGGER reject_consumption");
  pairing.redeem({ ...c.device, name: "Phone" }, origin);
  expect(() =>
    pairing.consumeEnrollment(
      consent(c.enrollment),
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    ),
  ).toThrow();
});

it("rolls back a process exit between a grant write and ceremony commit", () => {
  const a = machine(),
    b = machine(),
    approval = proposed(a, b);
  const codePath = join(b.dir, "fixture-code.json");
  const code = `
    import Database from 'better-sqlite3';
    import {z} from 'zod';
    import {FleetAuthority} from './src/server/fleet-authority.ts';
    import {FleetPairing} from './src/server/fleet-pairing.ts';
    import * as secrets from './src/server/secrets.ts';
    import {writeFileSync} from 'node:fs';
    import {fleetEnrollmentFromLink} from './src/shared/fleet-pairing.ts';
    const db=new Database(${JSON.stringify(b.path)});
    const authority=new FleetAuthority(db,secrets);
    const pairing=new FleetPairing(db,authority,${JSON.stringify(b.owner)},${JSON.stringify(b.dir)});
    const printed=pairing.pair(${JSON.stringify(origin)});
    writeFileSync(${JSON.stringify(codePath)},JSON.stringify(printed));
    const link=fleetEnrollmentFromLink(printed.url);
    pairing.consumeEnrollment({ceremonyId:link.ceremonyId,secret:link.enrollment,origin:link.origin,operationId:${JSON.stringify(randomUUID())},request:${JSON.stringify(approval)}},z.object({}),()=>{
      authority.approve(${JSON.stringify(b.owner)},${JSON.stringify(approval)});
      process.exit(17);
    });
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { env: process.env, encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  expect(b.authority.status(b.owner).state).toBe("standalone");
  const printed = JSON.parse(readFileSync(codePath, "utf8"));
  const old = fleetEnrollmentFromLink(printed.url);
  expect(
    b.db
      .prepare("SELECT state FROM pairing_ceremonies WHERE id=?")
      .get(old.ceremonyId),
  ).toEqual({ state: "pending" });
  const reopened = b.open();
  expect(() =>
    reopened.redeem(
      { ...fleetDeviceFromLink(printed.url, origin), name: "Phone" },
      origin,
    ),
  ).toThrow("expired");
  expect(() =>
    reopened.consumeEnrollment(consent(old), z.object({}), () => ({})),
  ).toThrow("expired");
  const fresh = capabilities(reopened);
  expect(
    reopened.redeem({ ...fresh.device, name: "Phone" }, origin).token,
  ).toBeTruthy();
});

it("expires unused capabilities with monotonic time and on restart while retaining device trust", () => {
  let mono = 0;
  const m = machine(
      undefined,
      () => 1_000_000,
      () => mono,
    ),
    pairing = m.open();
  const trusted = capabilities(pairing);
  const device = pairing.redeem({ ...trusted.device, name: "Phone" }, origin);
  const expired = capabilities(pairing);
  mono = 120_000;
  expect(() =>
    pairing.redeem({ ...expired.device, name: "Late" }, origin),
  ).toThrow("expired");
  expect(() =>
    pairing.consumeEnrollment(
      consent(expired.enrollment),
      z.object({}),
      () => ({}),
    ),
  ).toThrow("expired");
  const beforeRestart = capabilities(pairing),
    reopened = m.open();
  expect(() =>
    reopened.redeem({ ...beforeRestart.device, name: "Restarted" }, origin),
  ).toThrow("expired");
  expect(() =>
    pairing.redeem({ ...beforeRestart.device, name: "Old instance" }, origin),
  ).toThrow("expired");
  expect(reopened.authenticate(hash(device.token))).toBeTruthy();
});

it("keeps failed validation reusable, enforces the device limit before consuming and never grants a cookie from enrollment-only links", () => {
  const m = machine(),
    pairing = m.open();
  for (let i = 0; i < 10; i++) {
    const c = capabilities(pairing);
    pairing.redeem({ ...c.device, name: String(i) }, origin);
  }
  const c = capabilities(pairing);
  expect(() => pairing.redeem({ ...c.device, name: "Extra" }, origin)).toThrow(
    "Device limit",
  );
  pairing.revoke(pairing.devices()[0].id);
  pairing.redeem({ ...c.device, name: "Replacement" }, origin);
  const link = pairing.enrollment(origin, ["read"]);
  expect(() => fleetDeviceFromLink(link.url, origin)).toThrow(
    "enrolls a machine",
  );
  const enrollment = fleetEnrollmentFromLink(link.url);
  expect(() =>
    pairing.redeem({ secret: enrollment.enrollment, name: "Bad" }, origin),
  ).toThrow();
  const result = pairing.consumeEnrollment(
    consent(enrollment),
    z.object({ ok: z.boolean() }),
    ({ scope }) => {
      expect(scope).toEqual(["read"]);
      return { ok: true };
    },
  );
  expect(result.ok).toBe(true);
  expect(pairing.devices()).toHaveLength(10);
});

it("invalidates unused codes on mint/address changes while preserving device trust and durable revocation", () => {
  const m = machine(),
    pairing = m.open(),
    first = capabilities(pairing),
    second = capabilities(pairing);
  expect(() =>
    pairing.redeem({ ...first.device, name: "Old" }, origin),
  ).toThrow();
  const device = pairing.redeem({ ...second.device, name: "Phone" }, origin);
  const third = capabilities(pairing);
  pairing.originChanged("https://changed.example");
  expect(() =>
    pairing.consumeEnrollment(
      consent(third.enrollment),
      z.object({ ok: z.boolean() }),
      () => ({ ok: true }),
    ),
  ).toThrow();
  expect(pairing.authenticate(hash(device.token))).toBeTruthy();
  const id = pairing.devices()[0].id;
  pairing.revoke(id);
  expect(m.open().authenticate(hash(device.token))).toBeUndefined();
  expect(m.open().device(id)).toBeUndefined();
});

it("does not revive an expired code after a failed redemption and clock rollback, including restart", () => {
  let now = Date.now();
  const m = machine(undefined, () => now),
    pairing = m.open(),
    c = capabilities(pairing);
  now += 120_001;
  expect(() => pairing.redeem({ ...c.device, name: "Late" }, origin)).toThrow();
  now -= 100_000;
  expect(() =>
    m.open().redeem({ ...c.device, name: "Rewound" }, origin),
  ).toThrow("clock");
  expect(pairing.devices()).toEqual([]);
  expect(() => pairing.pair(origin)).toThrow("clock");
});

it("refuses a device store opened by another owner", () => {
  const m = machine("owner");
  m.open();
  expect(
    () => new FleetPairing(m.db, m.authority, "other-owner", m.dir),
  ).toThrow("another owner");
});

it("supports local device-only links without silently creating fleet membership", () => {
  const m = machine(),
    pairing = m.open(),
    local = "http://127.0.0.1:12345";
  const link = pairing.pair(local);
  expect(link.url).toContain("#pair=");
  expect(() => fleetEnrollmentFromLink(link.url)).toThrow();
  pairing.redeem(
    { ...fleetDeviceFromLink(link.url, local), name: "Local" },
    local,
  );
  expect(m.authority.status(m.owner).state).toBe("standalone");
  expect(() => pairing.pair("http://public.example")).toThrow("HTTPS");
});

it("authenticates and lists devices under a writer lock, deferring renewal until a later request", () => {
  let now = 1_000_000;
  const m = machine(undefined, () => now),
    pairing = m.open();
  const c = capabilities(pairing);
  const issued = pairing.redeem({ ...c.device, name: "Phone" }, origin);
  const device = pairing.devices()[0];
  const writer = new Database(m.path);
  m.db.pragma("busy_timeout=20");
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect(pairing.authenticate(hash(issued.token))?.id).toBe(device.id);
    expect(pairing.device(device.id)?.id).toBe(device.id);
    expect(pairing.devices()).toHaveLength(1);
    now += 2 * 86_400_000;
    expect(pairing.authenticate(hash(issued.token))?.expires).toBe(
      issued.expires,
    );
    expect(m.db.pragma("busy_timeout", { simple: true })).toBe(20);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  expect(pairing.authenticate(hash(issued.token))?.expires).toBe(
    issued.expires + 2 * 86_400_000,
  );
  expect(m.db.pragma("busy_timeout", { simple: true })).toBe(20);
  pairing.revoke(device.id);
  expect(pairing.authenticate(hash(issued.token))).toBeUndefined();
});

it("keeps an observed expiry durable under a writer lock while another valid device remains usable", () => {
  let now = 1_000_000;
  const m = machine(undefined, () => now),
    pairing = m.open();
  const issued = pairing.redeem(
    { ...capabilities(pairing).device, name: "Expiring phone" },
    origin,
  );
  const expiredId = pairing.devices()[0].id;
  const valid = pairing.redeem(
    { ...capabilities(pairing).device, name: "Valid phone" },
    origin,
  );
  m.db
    .prepare("UPDATE devices SET expires=?,max_expires=? WHERE id=?")
    .run(now + 1000, now + 1000, expiredId);
  const observer = m.open(),
    writer = new Database(m.path);
  m.db.pragma("busy_timeout=20");
  writer.exec("BEGIN IMMEDIATE");
  try {
    now += 1001;
    pairing.expire();
    expect(pairing.authenticate(hash(issued.token))).toBeUndefined();
    expect(observer.authenticate(hash(issued.token))).toBeUndefined();
    expect(pairing.authenticate(hash(valid.token))).toBeDefined();
    expect(m.db.prepare("SELECT count(*) n FROM devices").get()).toEqual({
      n: 2,
    });
    expect(m.db.pragma("busy_timeout", { simple: true })).toBe(20);
    now -= 500;
    expect(observer.authenticate(hash(issued.token))).toBeUndefined();
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  const reopened = m.open();
  expect(reopened.authenticate(hash(issued.token))).toBeUndefined();
  expect(reopened.authenticate(hash(valid.token))).toBeDefined();
  expect(readdirSync(join(m.dir, "device-expiry-checks"))).toEqual([]);
});

it("refuses authentication before reading the clock when an expiry check cannot be made durable", () => {
  let observations = 0;
  const m = machine(undefined, () => {
      observations++;
      return 1_000_000;
    }),
    pairing = m.open();
  const issued = pairing.redeem(
    { ...capabilities(pairing).device, name: "Phone" },
    origin,
  );
  const checks = join(m.dir, "device-expiry-checks");
  chmodSync(checks, 0o500);
  observations = 0;
  try {
    expect(pairing.authenticate(hash(issued.token))).toBeUndefined();
    expect(observations).toBe(0);
    expect(() => pairing.pair(origin)).toThrow("could not be persisted");
  } finally {
    chmodSync(checks, 0o700);
  }
  expect(m.open().authenticate(hash(issued.token))).toBeDefined();
});

it("keeps a prewritten expiry intent through simultaneous storage failures and restart before any retry", () => {
  let now = 1_000_000,
    fail = false;
  let checks = "";
  const m = machine(undefined, () => {
    if (fail) {
      // The guard must already exist before this clock observation. Later
      // file mutations and SQLite retirement now both fail.
      expect(
        readdirSync(checks).filter((name) => name.endsWith(".json")),
      ).toHaveLength(1);
      chmodSync(checks, 0o500);
    }
    return now;
  });
  checks = join(m.dir, "device-expiry-checks");
  const pairing = m.open(),
    issued = pairing.redeem(
      { ...capabilities(pairing).device, name: "Phone" },
      origin,
    );
  m.db
    .prepare("UPDATE devices SET expires=?,max_expires=?")
    .run(now + 1000, now + 1000);
  const writer = new Database(m.path);
  writer.exec("BEGIN IMMEDIATE");
  try {
    now += 1001;
    fail = true;
    pairing.expire();
    expect(pairing.authenticate(hash(issued.token))).toBeUndefined();
    const guards = readdirSync(checks).filter((name) => name.endsWith(".json"));
    const guard = readFileSync(join(checks, guards[0]), "utf8");
    expect(guard).not.toContain(issued.token);
    expect(guard).not.toContain(hash(issued.token));
    expect(m.db.prepare("SELECT count(*) n FROM devices").get()).toEqual({
      n: 1,
    });
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  // No old-instance retry. Repair storage and roll back the clock before a
  // replacement instance recovers the durable guard.
  fail = false;
  chmodSync(checks, 0o700);
  now -= 500;
  expect(m.open().authenticate(hash(issued.token))).toBeUndefined();
  expect(m.db.prepare("SELECT count(*) n FROM devices").get()).toEqual({
    n: 0,
  });
  expect(readdirSync(checks)).toEqual([]);
});

it("conservatively retires only the device in a clock check interrupted by real process death", () => {
  const m = machine(undefined, () => 1_000_000),
    pairing = m.open();
  const issued = pairing.redeem(
    { ...capabilities(pairing).device, name: "Phone" },
    origin,
  );
  const unaffected = pairing.redeem(
    { ...capabilities(pairing).device, name: "Tablet" },
    origin,
  );
  const paired = [issued, unaffected].map((device) => ({
    ...device,
    id: pairing.authenticate(hash(device.token))!.id,
  }));
  const code = `
    import Database from 'better-sqlite3';
    import {FleetAuthority} from './src/server/fleet-authority.ts';
    import {FleetPairing} from './src/server/fleet-pairing.ts';
    import * as secrets from './src/server/secrets.ts';
    const db=new Database(${JSON.stringify(m.path)});
    const authority=new FleetAuthority(db,secrets);
    new FleetPairing(db,authority,${JSON.stringify(m.owner)},${JSON.stringify(m.dir)},()=>process.exit(17));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { env: process.env, encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(17);
  const directory = join(m.dir, "device-expiry-checks");
  const pending = readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  );
  expect(pending).toHaveLength(1);
  const interrupted: string[] = JSON.parse(
    readFileSync(join(directory, pending[0]), "utf8"),
  ).devices;
  const reopened = m.open();
  for (const device of paired) {
    const authenticated = reopened.authenticate(hash(device.token));
    if (interrupted.includes(device.id)) expect(authenticated).toBeUndefined();
    else expect(authenticated).toBeDefined();
  }
  expect(m.db.prepare("SELECT count(*) n FROM devices").get()).toEqual({
    n: 1,
  });
});

it("retains expiry guards on database errors and refuses malformed guard recovery", () => {
  let now = 1_000_000;
  const m = machine(undefined, () => now),
    pairing = m.open();
  const issued = pairing.redeem(
    { ...capabilities(pairing).device, name: "Phone" },
    origin,
  );
  m.db
    .prepare("UPDATE devices SET expires=?,max_expires=?")
    .run(now + 1000, now + 1000);
  m.db.exec(
    "CREATE TRIGGER fixture_retirement_failure BEFORE DELETE ON devices BEGIN SELECT RAISE(ABORT,'fixture retirement failure'); END",
  );
  now += 1001;
  expect(() => pairing.expire()).not.toThrow();
  expect(pairing.authenticate(hash(issued.token))).toBeUndefined();
  m.db.exec("DROP TRIGGER fixture_retirement_failure");
  now -= 500;
  expect(m.open().authenticate(hash(issued.token))).toBeUndefined();
  writeFileSync(
    join(m.dir, "device-expiry-checks", randomUUID() + ".json"),
    "{",
  );
  expect(() => m.open()).toThrow("expiry checks are unreadable");
});

it("retains an interrupted expiry check when a prior failed clock write makes the observation roll backwards", () => {
  let now = 1_000_000;
  const m = machine(undefined, () => now),
    pairing = m.open();
  const issued = pairing.redeem(
    { ...capabilities(pairing).device, name: "Phone" },
    origin,
  );
  m.db
    .prepare("UPDATE devices SET expires=?,max_expires=?")
    .run(now + 1000, now + 1000);
  m.db.pragma("busy_timeout=20");
  const writer = new Database(m.path);
  writer.exec("BEGIN IMMEDIATE");
  try {
    now += 2000;
    expect(() => pairing.pair(origin)).toThrow();
    now -= 500;
    expect(pairing.authenticate(hash(issued.token))).toBeUndefined();
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  now -= 1000;
  expect(m.open().authenticate(hash(issued.token))).toBeUndefined();
});
