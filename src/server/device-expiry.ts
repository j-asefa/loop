import * as devicesQueries from "./sql/devices.js";
import type Database from "better-sqlite3";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomic, privateDir } from "../state.js";
import { Problem } from "../shared/problem.js";

const Intent = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1).max(256),
    devices: z.array(z.string().uuid()).min(1).max(10),
  })
  .strict();
export type DeviceExpiryCheck = { path: string; devices: string[] };

/** A device more than EXPIRY_GUARD_WINDOW_MS (device-pairing.ts) from either
 * expiry is accepted from a plain clock read; nothing here is written. Any
 * other clock check starts with a durable intent before the wall time read
 * that decides it. If both
 * SQLite and later filesystem writes fail, the intent still identifies devices
 * whose expiry observation may be lost. Recovery conservatively retires them,
 * even if the clock has since moved backwards, so an interrupted check can
 * require a device to pair again. Checks run on device access, at startup and
 * on the gateway heartbeat (host.ts). The database and this directory are
 * restored together. No cookie, credential hash or native context is stored
 * here. */
export class DeviceExpiryChecks {
  private readonly directory: string;
  constructor(
    directory: string,
    private readonly owner: string,
  ) {
    this.directory = join(directory, "device-expiry-checks");
    privateDir(this.directory);
    // Persist the guard directory's name as well as the records inside it.
    this.sync(directory);
  }
  pending(): DeviceExpiryCheck[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        if (!/^[a-f0-9-]{36}\.json$/.test(name))
          throw new Problem(
            409,
            "Device expiry checks are unreadable. Restore the complete workspace directory.",
          );
        const path = join(this.directory, name);
        let record: z.infer<typeof Intent>;
        try {
          record = Intent.parse(JSON.parse(readFileSync(path, "utf8")));
        } catch (error) {
          // Another completed synchronous check may have removed its own file.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new Problem(
            409,
            "Device expiry checks are unreadable. Restore the complete workspace directory.",
          );
        }
        if (record.owner !== this.owner)
          throw new Problem(
            403,
            "Device expiry checks belong to another owner.",
          );
        return { path, devices: record.devices };
      })
      .filter((record): record is DeviceExpiryCheck => record !== null);
  }
  begin(devices: string[]): DeviceExpiryCheck {
    const record = Intent.parse({ version: 1, owner: this.owner, devices });
    const check = {
      path: join(this.directory, `${randomUUID()}.json`),
      devices: record.devices,
    };
    atomic(check.path, record);
    return check;
  }
  finish(check: DeviceExpiryCheck) {
    try {
      unlinkSync(check.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.sync(this.directory);
  }
  private sync(path: string) {
    const directory = openSync(path, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  /** Called before the gateway opens, under the companion's workspace lock.
   * Device deletion commits before removing any uncertainty guard. */
  recover(db: Database.Database) {
    const pending = this.pending();
    if (!pending.length) return;
    db.transaction(() => {
      for (const check of pending)
        for (const id of check.devices)
          devicesQueries.remove(db, this.owner, id);
    }).immediate();
    for (const check of pending) this.finish(check);
  }
}
