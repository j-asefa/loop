import { afterAll, afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { initializeFleetIdentity } from "../src/server/fleet-identity.js";
import { generateMachineKey } from "../src/server/fleet-crypto.js";
import { fleetSourceId } from "../src/shared/fleet.js";

const directory = mkdtempSync(join(tmpdir(), "loop-fleet-identity-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function database(path = ":memory:", profile = "companion") {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  db.prepare("INSERT OR IGNORE INTO deployment_profile VALUES(1,?)").run(
    profile,
  );
  databases.push(db);
  return db;
}

it("retains the encrypted key through restart and migration without creating peer grants", () => {
  const path = join(directory, "persistent.db");
  const first = database(path);
  first.exec(
    "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep');",
  );
  const identity = initializeFleetIdentity(first, secrets);
  const stored = first
    .prepare("SELECT * FROM fleet_machine_identity")
    .get() as {
    private_key: string;
  };
  expect(Object.keys(identity).sort()).toEqual(["machineId", "publicKey"]);
  expect(stored.private_key.split(".")).toHaveLength(3);
  const plaintext = secrets.unseal(
    stored.private_key,
    `fleet:machine:${identity.machineId}`,
  );
  expect(stored.private_key).not.toContain(plaintext);
  expect(() => secrets.unseal(stored.private_key, "another owner")).toThrow();
  first.close();
  const reopened = database(path);
  expect(initializeFleetIdentity(reopened, secrets)).toEqual(identity);
  expect(reopened.prepare("SELECT * FROM unrelated").all()).toEqual([
    { value: "keep" },
  ]);
  expect(reopened.pragma("foreign_key_check")).toEqual([]);
  expect(fleetSourceId(identity.machineId)).toBe(`peer:${identity.machineId}`);
  expect(initializeFleetIdentity(database(), secrets).machineId).not.toBe(
    identity.machineId,
  );
});

it("refuses a server-profile database before creating any key", () => {
  const db = database(":memory:", "server");
  expect(() => initializeFleetIdentity(db, secrets)).toThrow(
    "companion data directory",
  );
  expect(db.prepare("SELECT * FROM fleet_machine_identity").all()).toEqual([]);
});

it.each(["public", "private", "missing encryption key"])(
  "does not silently replace an unreadable %s identity",
  (failure) => {
    const db = database();
    const identity = initializeFleetIdentity(db, secrets);
    if (failure === "public")
      db.prepare("UPDATE fleet_machine_identity SET public_key=?").run(
        generateMachineKey().identity.publicKey,
      );
    if (failure === "private")
      db.prepare("UPDATE fleet_machine_identity SET private_key=?").run(
        secrets.seal(
          generateMachineKey().privateKey,
          `fleet:machine:${identity.machineId}`,
        ),
      );
    const before = db.prepare("SELECT * FROM fleet_machine_identity").get();
    const storage =
      failure === "missing encryption key"
        ? {
            ...secrets,
            unseal: () => {
              throw new Error("fixture key unavailable");
            },
          }
        : secrets;
    expect(() => initializeFleetIdentity(db, storage)).toThrow();
    expect(db.prepare("SELECT * FROM fleet_machine_identity").get()).toEqual(
      before,
    );
  },
);

it("rolls back identity creation when secret storage fails", () => {
  const db = database();
  expect(() =>
    initializeFleetIdentity(db, {
      ...secrets,
      seal: () => {
        throw new Error("fixture disk failure");
      },
    }),
  ).toThrow("fixture disk failure");
  expect(db.prepare("SELECT * FROM fleet_machine_identity").all()).toEqual([]);
  expect(initializeFleetIdentity(db, secrets).machineId).toMatch(/^m_/);
});
