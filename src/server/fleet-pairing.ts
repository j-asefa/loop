import * as fleetDeviceStoreQueries from "./sql/fleet-device-store.js";
import * as fleetPairingCeremoniesQueries from "./sql/fleet-pairing-ceremonies.js";
import * as fleetPairingClockQueries from "./sql/fleet-pairing-clock.js";
import * as fleetDevicesQueries from "./sql/fleet-devices.js";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { DeviceTrust, TrustedDevice } from "../device-trust.js";
import { atomic, hash, privateDir, secret } from "../state.js";
import { FleetCapabilities, FleetDigest } from "../shared/fleet.js";
import { FleetSecret } from "../shared/fleet-credentials.js";
import {
  FLEET_PAIRING_LIFETIME_MS,
  formatFleetPairLink,
} from "../shared/fleet-pairing.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { DeviceExpiryChecks, type DeviceExpiryCheck } from "./device-expiry.js";
import { fleetPayloadDigest } from "./fleet-crypto.js";

const Id = z.string().uuid();
const Device = z.object({
  id: Id,
  name: z.string().max(100),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  csrf: z.string().min(1),
  expires: z.number().finite(),
  maxExpires: z.number().finite(),
});
const LegacyDevices = z
  .array(Device.extend({ maxExpires: z.number().finite().optional() }))
  .max(10);
const Ceremony = z.object({
  id: Id,
  owner_id: z.string(),
  origin: z.string(),
  scope: z.string(),
  expected_head: FleetDigest.nullable(),
  mode: z.enum(["enroll", "repair", "recover"]),
  device_hash: z.string().nullable(),
  enrollment_hash: z.string().nullable(),
  expires_at: z.number().int(),
  state: z.enum(["pending", "device", "enrollment", "cancelled"]),
  operation_id: Id.nullable(),
  payload_digest: FleetDigest.nullable(),
  result: z.string().nullable(),
});
const year = 365 * 86_400_000;
const fullScope = FleetCapabilities.parse([
  "read",
  "act",
  "events",
  "mail",
  "files",
]);
const rejected = () =>
  new Problem(
    403,
    "Pairing link expired, invalid or already used. Run loop55 pair on the destination machine.",
  );

/** One transaction owns a ceremony and the device or pending enrollment grant
 * it creates. This class does not expose a peer endpoint or trust a peer owner ID. */
export class FleetPairing implements DeviceTrust {
  private pending?: { id: string; expires: number };
  private observedWall = 0;
  private clockFailed = false;
  private readonly checks: DeviceExpiryChecks;
  private readonly retirements = new Map<
    string,
    { check: DeviceExpiryCheck; now: number }
  >();
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    directory: string,
    private readonly wall: () => number = Date.now,
    private readonly monotonic: () => number = () => performance.now(),
  ) {
    z.string().min(1).max(256).parse(owner);
    privateDir(directory);
    this.checks = new DeviceExpiryChecks(directory, owner);
    let importedCheck: DeviceExpiryCheck | undefined;
    const path = join(directory, "devices.json");
    db.transaction(() => {
      const imported = fleetDeviceStoreQueries.owner(db) as
        { owner_id: string } | undefined;
      if (imported) {
        if (imported.owner_id !== owner)
          throw new Problem(403, "Device trust belongs to another owner.");
        return;
      }
      let devices: z.infer<typeof LegacyDevices> = [];
      try {
        devices = LegacyDevices.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Problem(
            409,
            "Device trust could not be imported. Restore the workspace database and devices.json together.",
          );
      }
      if (devices.length)
        importedCheck = this.checks.begin(devices.map((device) => device.id));
      const now = this.now();
      for (const old of devices) {
        const maxExpires = old.maxExpires ?? old.expires;
        const expires = Math.min(old.expires, maxExpires);
        if (expires > now) this.insertDevice({ ...old, expires, maxExpires });
      }
      fleetDeviceStoreQueries.initialize(db, owner);
    }).immediate();
    if (importedCheck) this.checks.finish(importedCheck);
    this.checks.recover(db);
    // Written before a gateway can listen. An older binary must fail closed
    // instead of reading an obsolete pre-migration list after a SQL revocation.
    // A crash between import and this marker cannot expose new SQL credentials;
    // the next startup retries the marker using the already imported database.
    atomic(path, { version: 2, store: "workspace-database" });
    // Preserve completed receipts and device trust, but never reconstruct an
    // unused code's elapsed lifetime from wall time after a restart.
    fleetPairingCeremoniesQueries.cancelPending(db, owner);
    this.expire();
  }

  private pendingAlive(id: string) {
    return this.pending?.id === id && this.monotonic() < this.pending.expires;
  }

  private now(persist = true) {
    if (this.clockFailed)
      throw new Problem(
        409,
        "Device expiry could not be persisted. Repair local storage and restart Loop55.",
      );
    const prior = fleetPairingClockQueries.current(this.db) as
      { observed_at: number } | undefined;
    const value = Math.floor(this.wall());
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value < this.observedWall ||
      (prior && value < prior.observed_at)
    )
      throw new Problem(
        409,
        "The local clock moved backwards. Restore the clock before pairing or authenticating.",
      );
    this.observedWall = value;
    if (persist) fleetPairingClockQueries.observe(this.db, value);
    return value;
  }
  private insertDevice(device: TrustedDevice) {
    const d = Device.parse(device);
    fleetDevicesQueries.insert(
      this.db,
      d.id,
      this.owner,
      d.name,
      d.hash,
      d.csrf,
      d.expires,
      d.maxExpires,
    );
  }
  private checked(device: TrustedDevice) {
    if (this.clockFailed) return;
    let check: DeviceExpiryCheck | undefined;
    try {
      if (
        this.checks
          .pending()
          .some((pending) => pending.devices.includes(device.id))
      )
        return;
      // No wall clock is read until the intent is durable. A failure to start
      // the check refuses access without making an unrecorded expiry decision.
      check = this.checks.begin([device.id]);
      const now = this.now(false);
      if (device.expires <= now || device.maxExpires <= now) {
        this.retirements.set(device.id, { check, now });
        this.retire(device.id, check, now);
        return;
      }
      this.checks.finish(check);
      return { device, now };
    } catch {
      // A failed completion leaves the write-ahead intent. Startup retires its
      // at-risk device rather than clearing a memory-only failure flag.
      this.clockFailed = true;
      return;
    }
  }
  private selectDevices() {
    return fleetDevicesQueries
      .list(this.db, this.owner)
      .map((row) => Device.parse(row));
  }
  devices() {
    // Administrative inventory is independent of authentication eligibility.
    // A clock/storage failure must not hide a credential from local revocation.
    return this.selectDevices();
  }
  device(id: string) {
    const row = fleetDevicesQueries.byId(this.db, this.owner, id);
    return row ? this.checked(Device.parse(row))?.device : undefined;
  }
  authenticate(digest: string) {
    const row = fleetDevicesQueries.byHash(this.db, this.owner, digest);
    if (!row) return;
    const checked = this.checked(Device.parse(row));
    if (!checked) return;
    const { device, now } = checked;
    if (device.expires < Math.min(device.maxExpires, now + year - 86_400_000)) {
      const expires = Math.min(device.maxExpires, now + year);
      const timeout = this.db.pragma("busy_timeout", {
        simple: true,
      }) as number;
      try {
        this.db.pragma("busy_timeout = 0");
        const update = fleetDevicesQueries.renew(
          this.db,
          expires,
          this.owner,
          device.id,
          digest,
          now,
          now,
        );
        if (!update.changes) return;
        device.expires = expires;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && !code?.startsWith("SQLITE_BUSY_")) return;
      } finally {
        this.db.pragma(`busy_timeout = ${timeout}`);
      }
    }
    return device;
  }
  revoke(id: string) {
    fleetDevicesQueries.remove(this.db, this.owner, id);
  }
  private retire(id: string, check: DeviceExpiryCheck, now: number) {
    const timeout = this.db.pragma("busy_timeout", { simple: true }) as number;
    try {
      this.db.pragma("busy_timeout = 0");
      this.db
        .transaction(() => {
          fleetPairingClockQueries.observe(this.db, now);
          fleetDevicesQueries.remove(this.db, this.owner, id);
        })
        .immediate();
      this.checks.finish(check);
      this.retirements.delete(id);
    } catch {
      // The intent was durable before observing expiry. Busy or damaged SQL
      // storage cannot revive this device, even if the process dies now.
    } finally {
      this.db.pragma(`busy_timeout = ${timeout}`);
    }
  }
  /** Retry only durable local retirement; there is no external effect here. */
  expire() {
    for (const [id, pending] of this.retirements)
      this.retire(id, pending.check, pending.now);
    for (const device of this.selectDevices()) this.checked(device);
  }
  originChanged(origin: string) {
    fleetPairingCeremoniesQueries.cancelOtherOrigins(
      this.db,
      this.owner,
      origin,
    );
  }
  private mint(
    origin: string,
    kind: "combined" | "enrollment" | "device",
    scope: z.infer<typeof FleetCapabilities>,
    recovery = false,
  ) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      (parsed.protocol !== "https:" &&
        !(
          kind === "device" &&
          parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        ))
    )
      throw new Problem(400, "Use the machine's current HTTPS origin.");
    const allowed = FleetCapabilities.parse(scope);
    const now = this.now();
    const result = this.db
      .transaction(() => {
        const state = this.authority.status(this.owner);
        if (recovery && !state.head)
          throw new Problem(
            409,
            "This machine has no previous fleet to recover.",
          );
        const id = randomUUID(),
          device = kind === "enrollment" ? null : secret(),
          enrollment = kind === "device" ? null : secret();
        fleetPairingCeremoniesQueries.expire(this.db, this.owner, now);
        fleetPairingCeremoniesQueries.cancelPending(this.db, this.owner);
        // Rapid minting is bounded as well as expiry; cancelled capabilities can
        // be removed because an absent ceremony can never be redeemed.
        fleetPairingCeremoniesQueries.clearCancelled(this.db, this.owner);
        fleetPairingCeremoniesQueries.insert(
          this.db,
          id,
          this.owner,
          origin,
          JSON.stringify(allowed),
          state.head,
          recovery ? "recover" : state.head ? "repair" : "enroll",
          device && hash(device),
          enrollment && hash(enrollment),
          now + FLEET_PAIRING_LIFETIME_MS,
        );
        if (kind === "device") return { id, url: `${origin}/#pair=${device}` };
        const common = {
          version: 1 as const,
          ceremonyId: id,
          origin,
          machine: this.authority.identity,
          scope: allowed,
          enrollment: enrollment!,
        };
        const url = formatFleetPairLink(
          kind === "combined"
            ? { ...common, kind, device: device! }
            : { ...common, kind },
        );
        return { id, url };
      })
      .immediate();
    this.pending = {
      id: result.id,
      expires: this.monotonic() + FLEET_PAIRING_LIFETIME_MS,
    };
    return { url: result.url, expiresIn: FLEET_PAIRING_LIFETIME_MS / 1000 };
  }
  pair(origin: string) {
    return this.mint(
      origin,
      origin.startsWith("https:") ? "combined" : "device",
      fullScope,
    );
  }
  /** Local authenticated device administration only; never a peer operation. */
  enrollment(origin: string, scope = fullScope, recovery = false) {
    return this.mint(origin, "enrollment", scope, recovery);
  }
  redeem(
    input: { secret: string; name: string; ceremonyId?: string },
    origin: string,
  ) {
    const value = z
      .object({
        secret: FleetSecret,
        name: z.string().trim().max(80),
        ceremonyId: Id.optional(),
      })
      .strict()
      .parse(input);
    const now = this.now();
    return this.db
      .transaction(() => {
        const row = fleetPairingCeremoniesQueries.device(
          this.db,
          this.owner,
          hash(value.secret),
        );
        if (!row) throw rejected();
        const ceremony = Ceremony.parse(row);
        if (
          ceremony.origin !== origin ||
          ceremony.state !== "pending" ||
          !this.pendingAlive(ceremony.id) ||
          ceremony.expires_at <= now ||
          (value.ceremonyId && value.ceremonyId !== ceremony.id)
        )
          throw rejected();
        fleetDevicesQueries.expire(this.db, this.owner, now, now);
        const count = fleetDevicesQueries.count(this.db, this.owner) as {
          n: number;
        };
        if (count.n >= 10)
          throw new Problem(
            409,
            "Device limit reached. Revoke a device on the desktop.",
          );
        const token = secret(),
          expires = now + year;
        this.insertDevice({
          id: randomUUID(),
          name: value.name || "Phone",
          hash: hash(token),
          csrf: secret(),
          expires,
          maxExpires: now + 2 * year,
        });
        fleetPairingCeremoniesQueries.consumeDevice(
          this.db,
          ceremony.id,
          this.owner,
        );
        return { token, expires };
      })
      .immediate();
  }

  /** Used only after the enrollment protocol has authenticated the destination,
   * controller proof and bound request. `accept` performs synchronous writes to
   * this database only, including its pending grant. Never dispatch network or
   * native work here. The explicit response schema keeps receipts public. */
  consumeEnrollment<T>(
    input: {
      ceremonyId: string;
      secret: string;
      origin: string;
      operationId: string;
      request: unknown;
    },
    response: z.ZodType<T>,
    accept: (consent: {
      scope: z.infer<typeof FleetCapabilities>;
      expectedHead: string | null;
      mode: "enroll" | "repair" | "recover";
    }) => T,
  ): T {
    const value = z
      .object({
        ceremonyId: Id,
        secret: FleetSecret,
        origin: z.string().max(2048),
        operationId: Id,
        request: z.unknown(),
      })
      .strict()
      .parse(input);
    const digest = fleetPayloadDigest({
      purpose: "loop-fleet-pairing-operation-v1",
      request: value.request,
    });
    const now = this.now();
    return this.db
      .transaction(() => {
        const raw = fleetPairingCeremoniesQueries.enrollment(
          this.db,
          value.ceremonyId,
          this.owner,
          hash(value.secret),
        );
        if (!raw) throw rejected();
        const ceremony = Ceremony.parse(raw);
        if (ceremony.origin !== value.origin) throw rejected();
        if (ceremony.state === "enrollment") {
          if (
            ceremony.operation_id !== value.operationId ||
            ceremony.payload_digest !== digest
          )
            throw new Problem(
              409,
              "This enrollment capability belongs to a different operation.",
            );
          return response.parse(JSON.parse(ceremony.result!));
        }
        if (
          ceremony.state !== "pending" ||
          ceremony.expires_at <= now ||
          !this.pendingAlive(ceremony.id)
        )
          throw rejected();
        if (
          fleetPairingCeremoniesQueries.operationExists(
            this.db,
            this.owner,
            value.operationId,
          )
        )
          throw new Problem(409, "Enrollment operation ID is already bound.");
        const result = response.parse(
          accept({
            scope: FleetCapabilities.parse(JSON.parse(ceremony.scope)),
            expectedHead: ceremony.expected_head,
            mode: ceremony.mode,
          }),
        );
        const json = JSON.stringify(result);
        if (!json || Buffer.byteLength(json) > 64 * 1024)
          throw new Problem(413, "Enrollment receipt exceeds its bound.");
        fleetPairingCeremoniesQueries.consumeEnrollment(
          this.db,
          value.operationId,
          digest,
          json,
          ceremony.id,
          this.owner,
        );
        return result;
      })
      .immediate();
  }
}
