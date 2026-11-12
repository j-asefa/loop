// Device pairing is core: a companion pairs and authenticates phones without
// a fleet identity, and devices paired while fleets were on stay paired.
import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { DevicePairing } from "../src/server/device-pairing.js";
import { hash } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "loop-device-pairing-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const { FleetAuthority } = await import("../src/server/fleet-authority.js");
const { FleetPairing } = await import("../src/server/fleet-pairing.js");
const databases: Database.Database[] = [];
const origin = "https://phone.example";
afterAll(() => {
  for (const db of databases) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function workspace(owner = randomUUID()) {
  const dir = join(root, randomUUID());
  mkdirSync(dir);
  const db = new Database(join(dir, "workspace.db"));
  applyMigrations(db);
  databases.push(db);
  return { owner, dir, db };
}
const identities = (db: Database.Database) =>
  db.prepare("SELECT count(*) n FROM fleet_machine_identity").get();
const secretOf = (url: string) => new URL(url).hash.replace(/^#pair=/, "");

it("pairs, authenticates and revokes a device without creating a fleet identity", () => {
  const w = workspace(),
    pairing = new DevicePairing(w.db, w.owner, w.dir);
  const link = pairing.pair(origin);
  // An HTTPS origin still mints a device-only link: no enrollment secret.
  expect(link.url).toMatch(/^https:\/\/phone\.example\/#pair=[\w-]+$/);
  const { token } = pairing.redeem(
    { secret: secretOf(link.url), name: "Phone" },
    origin,
  );
  const device = pairing.authenticate(hash(token));
  expect(device).toMatchObject({ name: "Phone" });
  expect(pairing.devices().map((d) => d.id)).toEqual([device!.id]);
  // A link is single use.
  expect(() =>
    pairing.redeem({ secret: secretOf(link.url), name: "Again" }, origin),
  ).toThrow("already used");
  pairing.revoke(device!.id);
  expect(pairing.authenticate(hash(token))).toBeUndefined();
  expect(identities(w.db)).toEqual({ n: 0 });
});

it("keeps a device paired while fleets were on after a restart without them", () => {
  const w = workspace();
  const fleet = new FleetPairing(
    w.db,
    new FleetAuthority(w.db, secrets),
    w.owner,
    w.dir,
  );
  const local = "http://127.0.0.1:4000";
  const link = fleet.pair(local);
  const { token } = fleet.redeem(
    { secret: secretOf(link.url), name: "Phone" },
    local,
  );
  // Restart without --fleet: the same database and directory, no authority.
  const core = new DevicePairing(w.db, w.owner, w.dir);
  expect(core.authenticate(hash(token))).toMatchObject({ name: "Phone" });
  // Another owner cannot adopt this device store.
  expect(() => new DevicePairing(w.db, "someone-else", w.dir)).toThrow(
    "another owner",
  );
});

it("keeps renewal and expiry nonblocking under a writer lock and restores ordinary wait policy", () => {
  const w = workspace();
  const pairing = new DevicePairing(w.db, w.owner, w.dir);
  const link = pairing.pair(origin);
  const { token } = pairing.redeem(
    { secret: secretOf(link.url), name: "Phone" },
    origin,
  );
  const device = pairing.authenticate(hash(token))!;
  const expires = Date.now() + 86_400_000;
  w.db
    .prepare("UPDATE devices SET expires=? WHERE owner_id=? AND id=?")
    .run(expires, w.owner, device.id);
  w.db.pragma("busy_timeout = 4321");
  const writer = new Database(join(w.dir, "workspace.db"));
  try {
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    expect(pairing.authenticate(hash(token))?.expires).toBe(expires);
    expect(performance.now() - started).toBeLessThan(500);
    expect(w.db.pragma("busy_timeout", { simple: true })).toBe(4321);
    writer.exec("ROLLBACK");
    expect(pairing.authenticate(hash(token))!.expires).toBeGreaterThan(expires);
    expect(w.db.pragma("busy_timeout", { simple: true })).toBe(4321);
    w.db
      .prepare("UPDATE devices SET expires=? WHERE owner_id=? AND id=?")
      .run(expires, w.owner, device.id);
    w.db.exec(
      "CREATE TEMP TRIGGER refuse_renewal BEFORE UPDATE ON devices BEGIN SELECT RAISE(ABORT, 'renewal failed'); END",
    );
    expect(pairing.authenticate(hash(token))).toBeUndefined();
    expect(w.db.pragma("busy_timeout", { simple: true })).toBe(4321);
    w.db.exec("DROP TRIGGER refuse_renewal");
    expect(pairing.authenticate(hash(token))!.expires).toBeGreaterThan(expires);
    w.db
      .prepare("UPDATE devices SET expires=? WHERE owner_id=? AND id=?")
      .run(Date.now() - 1, w.owner, device.id);
    writer.exec("BEGIN IMMEDIATE");
    const retirementStarted = performance.now();
    expect(pairing.authenticate(hash(token))).toBeUndefined();
    expect(performance.now() - retirementStarted).toBeLessThan(500);
    expect(w.db.pragma("busy_timeout", { simple: true })).toBe(4321);
    writer.exec("ROLLBACK");
    w.db.exec(
      "CREATE TEMP TRIGGER refuse_retirement BEFORE DELETE ON devices BEGIN SELECT RAISE(ABORT, 'retirement failed'); END",
    );
    pairing.expire();
    expect(pairing.devices()).toHaveLength(1);
    expect(pairing.authenticate(hash(token))).toBeUndefined();
    expect(w.db.pragma("busy_timeout", { simple: true })).toBe(4321);
    w.db.exec("DROP TRIGGER refuse_retirement");
    pairing.expire();
    expect(pairing.devices()).toEqual([]);
    expect(w.db.pragma("busy_timeout", { simple: true })).toBe(4321);
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});
