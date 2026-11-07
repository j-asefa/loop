import Database from "better-sqlite3";
import { join } from "node:path";
import { Host } from "../../src/host.js";
import type { DeviceTrust } from "../../src/device-trust.js";
import { privateDir } from "../../src/state.js";
import { applyMigrations } from "../../src/server/migrations.js";
import { DevicePairing } from "../../src/server/device-pairing.js";

/** Real gateway and device trust, with a replaceable workspace fixture. */
export function createHost(
  directory: string,
  trust?: DeviceTrust,
  Constructor: typeof Host = Host,
) {
  let database: Database.Database | undefined;
  if (!trust) {
    privateDir(directory);
    database = new Database(join(directory, "gateway-fixture.db"));
    applyMigrations(database);
    trust = new DevicePairing(database, "fixture-owner", directory);
  }
  const host = new Constructor(directory, trust);
  host.workspace = {
    http: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    status: () => ({}),
    admin: async () => ({}),
    connect: () => () => {},
    originChanged: () => {},
  };
  const close = host.close.bind(host);
  host.close = async () => {
    try {
      await close();
    } finally {
      if (database?.open) database.close();
    }
  };
  return host;
}
