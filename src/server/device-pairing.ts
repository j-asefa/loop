import * as deviceStoreQueries from "./sql/device-store.js";
import * as pairingCeremoniesQueries from "./sql/pairing-ceremonies.js";
import * as pairingClockQueries from "./sql/pairing-clock.js";
import * as devicesQueries from "./sql/devices.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { DeviceTrust, TrustedDevice } from "../device-trust.js";
import { hash, privateDir, secret } from "../state.js";
import { Problem } from "../shared/problem.js";
import { PAIRING_LIFETIME_MS } from "../shared/pairing.js";
import { DeviceExpiryChecks, type DeviceExpiryCheck } from "./device-expiry.js";

// Device pairing and trust are core: every companion pairs phones without a
// fleet identity.
const Id = z.string().uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
/** 256-bit base64url secret, the same format fleet links use. */
export const PairingSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const Device = z.object({
  id: Id,
  name: z.string().max(100),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  csrf: z.string().min(1),
  expires: z.number().finite(),
  maxExpires: z.number().finite(),
});
export const Ceremony = z.object({
  id: Id,
  owner_id: z.string(),
  origin: z.string(),
  scope: z.string(),
  expected_head: Digest.nullable(),
  mode: z.enum(["enroll", "repair", "recover"]),
  device_hash: z.string().nullable(),
  enrollment_hash: z.string().nullable(),
  expires_at: z.number().int(),
  state: z.enum(["pending", "device", "enrollment", "cancelled"]),
  operation_id: Id.nullable(),
  payload_digest: Digest.nullable(),
  result: z.string().nullable(),
});
const year = 365 * 86_400_000;
export const rejected = () =>
  new Problem(
    403,
    "Pairing link expired, invalid or already used. Run loop pair on the destination machine.",
  );

/** One transaction owns a ceremony and the device it creates. */
export class DevicePairing implements DeviceTrust {
  protected pending?: { id: string; expires: number };
  private observedWall = 0;
  private clockFailed = false;
  private readonly checks: DeviceExpiryChecks;
  private readonly retirements = new Map<
    string,
    { check: DeviceExpiryCheck; now: number }
  >();
  constructor(
    protected readonly db: Database.Database,
    protected readonly owner: string,
    directory: string,
    private readonly wall: () => number = Date.now,
    private readonly monotonic: () => number = () => performance.now(),
  ) {
    z.string().min(1).max(256).parse(owner);
    privateDir(directory);
    this.checks = new DeviceExpiryChecks(directory, owner);
    db.transaction(() => {
      const store = deviceStoreQueries.owner(db) as
        { owner_id: string } | undefined;
      if (store) {
        if (store.owner_id !== owner)
          throw new Problem(403, "Device trust belongs to another owner.");
        return;
      }
      deviceStoreQueries.initialize(db, owner);
    }).immediate();
    this.checks.recover(db);
    // Preserve completed receipts and device trust, but never reconstruct an
    // unused code's elapsed lifetime from wall time after a restart.
    pairingCeremoniesQueries.cancelPending(db, owner);
    this.expire();
  }

  protected pendingAlive(id: string) {
    return this.pending?.id === id && this.monotonic() < this.pending.expires;
  }

  protected now(persist = true) {
    if (this.clockFailed)
      throw new Problem(
        409,
        "Device expiry could not be persisted. Repair local storage and restart Loop.",
      );
    const prior = pairingClockQueries.current(this.db) as
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
    if (persist) pairingClockQueries.observe(this.db, value);
    return value;
  }
  private insertDevice(device: TrustedDevice) {
    const d = Device.parse(device);
    devicesQueries.insert(
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
    return devicesQueries
      .list(this.db, this.owner)
      .map((row) => Device.parse(row));
  }
  devices() {
    // Administrative inventory is independent of authentication eligibility.
    // A clock/storage failure must not hide a credential from local revocation.
    return this.selectDevices();
  }
  device(id: string) {
    const row = devicesQueries.byId(this.db, this.owner, id);
    return row ? this.checked(Device.parse(row))?.device : undefined;
  }
  authenticate(digest: string) {
    const row = devicesQueries.byHash(this.db, this.owner, digest);
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
        const update = devicesQueries.renew(
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
    devicesQueries.remove(this.db, this.owner, id);
  }
  private retire(id: string, check: DeviceExpiryCheck, now: number) {
    const timeout = this.db.pragma("busy_timeout", { simple: true }) as number;
    try {
      this.db.pragma("busy_timeout = 0");
      this.db
        .transaction(() => {
          pairingClockQueries.observe(this.db, now);
          devicesQueries.remove(this.db, this.owner, id);
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
    pairingCeremoniesQueries.cancelOtherOrigins(this.db, this.owner, origin);
  }
  /** The directory head a new ceremony expects; none without an extension. */
  protected ceremonyHead(): string | null {
    return null;
  }
  /** Links that carry more than a device secret belong to an extension. */
  protected extendedLink(_link: {
    kind: "combined" | "enrollment";
    ceremonyId: string;
    origin: string;
    scope: readonly string[];
    enrollment: string;
    device?: string;
  }): string {
    throw new Problem(404, "Only device pairing is available on this machine.");
  }
  protected mint(
    origin: string,
    kind: "combined" | "enrollment" | "device",
    scope: readonly string[],
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
    const allowed = [...scope];
    const now = this.now();
    const result = this.db
      .transaction(() => {
        const state = { head: this.ceremonyHead() };
        if (recovery && !state.head)
          throw new Problem(
            409,
            "This machine has no previous fleet to recover.",
          );
        const id = randomUUID(),
          device = kind === "enrollment" ? null : secret(),
          enrollment = kind === "device" ? null : secret();
        pairingCeremoniesQueries.expire(this.db, this.owner, now);
        pairingCeremoniesQueries.cancelPending(this.db, this.owner);
        // Rapid minting is bounded as well as expiry; cancelled capabilities can
        // be removed because an absent ceremony can never be redeemed.
        pairingCeremoniesQueries.clearCancelled(this.db, this.owner);
        pairingCeremoniesQueries.insert(
          this.db,
          id,
          this.owner,
          origin,
          JSON.stringify(allowed),
          state.head,
          recovery ? "recover" : state.head ? "repair" : "enroll",
          device && hash(device),
          enrollment && hash(enrollment),
          now + PAIRING_LIFETIME_MS,
        );
        if (kind === "device") return { id, url: `${origin}/#pair=${device}` };
        const url = this.extendedLink({
          kind,
          ceremonyId: id,
          origin,
          scope: allowed,
          enrollment: enrollment!,
          ...(kind === "combined" ? { device: device! } : {}),
        });
        return { id, url };
      })
      .immediate();
    this.pending = {
      id: result.id,
      expires: this.monotonic() + PAIRING_LIFETIME_MS,
    };
    return { url: result.url, expiresIn: PAIRING_LIFETIME_MS / 1000 };
  }
  pair(origin: string) {
    return this.mint(origin, "device", []);
  }
  redeem(
    input: { secret: string; name: string; ceremonyId?: string },
    origin: string,
  ) {
    const value = z
      .object({
        secret: PairingSecret,
        name: z.string().trim().max(80),
        ceremonyId: Id.optional(),
      })
      .strict()
      .parse(input);
    const now = this.now();
    return this.db
      .transaction(() => {
        const row = pairingCeremoniesQueries.device(
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
        devicesQueries.expire(this.db, this.owner, now, now);
        const count = devicesQueries.count(this.db, this.owner) as {
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
        pairingCeremoniesQueries.consumeDevice(
          this.db,
          ceremony.id,
          this.owner,
        );
        return { token, expires };
      })
      .immediate();
  }
}
