// Device pairing is core: a companion pairs and authenticates phones without
// a fleet identity, and devices paired while fleets were on stay paired.
import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { DevicePairing } from "../src/server/device-pairing.js";
import { hash, secret } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "loop-device-pairing-"));
process.env.LOOP_PROFILE = "companion";
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
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
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

it("imports a legacy device file once without a fleet identity", () => {
  const w = workspace(),
    token = secret();
  writeFileSync(
    join(w.dir, "devices.json"),
    JSON.stringify([
      {
        id: randomUUID(),
        name: "Old phone",
        hash: hash(token),
        csrf: secret(),
        expires: Date.now() + 60_000,
      },
    ]),
  );
  const pairing = new DevicePairing(w.db, w.owner, w.dir);
  expect(pairing.authenticate(hash(token))).toMatchObject({
    name: "Old phone",
  });
  expect(identities(w.db)).toEqual({ n: 0 });
});
