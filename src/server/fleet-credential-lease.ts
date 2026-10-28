import { performance } from "node:perf_hooks";
import {
  FleetGrantContext,
  FleetOperation,
  MachineId,
} from "../shared/fleet.js";
import {
  FleetCredentialProof,
  SignedFleetChallenge,
  SignedFleetCredential,
} from "../shared/fleet-credentials.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { FleetCredentials } from "./fleet-credentials.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";

export interface FleetCredentialTransport {
  challenge(
    origin: string,
    context: FleetGrantContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  issue(
    origin: string,
    proof: FleetCredentialProof,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export type FleetAccessLease = Readonly<ReturnType<FleetCredentials["accept"]>>;
const unavailable = () =>
  new Problem(
    503,
    "Peer authentication is unavailable. Retry after synchronization or contact recovery.",
  );
const closed = () =>
  new Problem(
    403,
    "This peer credential lease is closed or no longer authorized.",
  );

/** One server-owned destination/operation lease. Its owner bounds the registry
 * by enrolled peers and closes or refreshes leases when directory state changes.
 * Renewal has no browser/controller dependency and never retries an agent action.
 * No transport or application entry point is installed by this primitive. */
export class FleetCredentialLease {
  private credential?: FleetAccessLease;
  private binding?: string;
  private generation = 0;
  private stopped = false;
  private failures = 0;
  private nextAttempt = 0;
  private lastTime = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: {
    controller: AbortController;
    promise: Promise<FleetAccessLease>;
  };
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly onChange: () => void;
  private readonly onUnavailable: (error: unknown) => void;

  constructor(
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    private readonly peer: string,
    private readonly operation: FleetOperation,
    private readonly transport: FleetCredentialTransport,
    options: {
      monotonic?: () => number;
      random?: () => number;
      onChange?: () => void;
      onUnavailable?: (error: unknown) => void;
    } = {},
  ) {
    MachineId.parse(peer);
    FleetOperation.parse(operation);
    this.clock = options.monotonic ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.onChange = options.onChange ?? (() => {});
    this.onUnavailable = options.onUnavailable ?? (() => {});
  }
  private notify() {
    // An observer cannot change credential lifetime or make issuance fail.
    try {
      this.onChange();
    } catch {
      /* The observer owns its error reporting. */
    }
  }
  private now() {
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0 || now < this.lastTime) {
      this.close();
      throw unavailable();
    }
    this.lastTime = now;
    return now;
  }
  private jitter() {
    const value = this.random();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }
  private target() {
    const local = this.authority.status(this.owner),
      document = local.directory?.document;
    const member = document?.members.find((m) => m.machineId === this.peer);
    if (
      !document ||
      local.state === "removed" ||
      !member ||
      this.peer === this.authority.identity.machineId ||
      !document.members.some(
        (m) => m.machineId === this.authority.identity.machineId,
      )
    )
      throw closed();
    const context = FleetGrantContext.parse({
      fleetId: document.fleetId,
      grantId: member.grantId,
      destination: this.peer,
      peer: this.authority.identity.machineId,
      directory: directoryDigest(document),
      operation: this.operation,
    });
    return {
      context,
      origin: member.origin,
      digest: fleetPayloadDigest(context),
    };
  }
  private current() {
    let target: ReturnType<FleetCredentialLease["target"]>;
    try {
      target = this.target();
    } catch {
      this.close();
      throw closed();
    }
    if (target.digest !== this.binding) {
      const changed = this.binding !== undefined;
      this.generation++;
      this.pending?.controller.abort();
      this.pending = undefined;
      this.credential = undefined;
      this.binding = target.digest;
      this.failures = 0;
      this.nextAttempt = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (changed) this.notify();
    }
    return target;
  }
  private expire(now: number) {
    if (this.credential && now >= this.credential.expiresAtMonotonic) {
      this.credential = undefined;
      this.notify();
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    let now: number;
    try {
      now = this.now();
    } catch {
      return;
    }
    const due = Math.min(
      this.credential?.expiresAtMonotonic ?? Infinity,
      this.pending ? Infinity : this.nextAttempt,
    );
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.get()
          .catch(() => {})
          .finally(() => this.schedule());
      },
      Math.max(1, due - now),
    );
    this.timer.unref();
  }
  private async request<T>(
    controller: AbortController,
    action: (signal: AbortSignal) => Promise<T>,
  ) {
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref();
    let refuse!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      refuse = () => reject(unavailable());
      controller.signal.addEventListener("abort", refuse, { once: true });
      if (controller.signal.aborted) refuse();
    });
    try {
      if (controller.signal.aborted) throw unavailable();
      return await Promise.race([action(controller.signal), aborted]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", refuse);
    }
  }
  private renew(target: ReturnType<FleetCredentialLease["target"]>) {
    if (this.pending) return this.pending.promise;
    const generation = this.generation,
      controller = new AbortController();
    const live = () => {
      if (
        this.stopped ||
        generation !== this.generation ||
        this.target().digest !== target.digest
      )
        throw closed();
    };
    const promise = (async () => {
      try {
        const challenge = SignedFleetChallenge.parse(
          await this.request(controller, (signal) =>
            this.transport.challenge(target.origin, target.context, signal),
          ),
        );
        live();
        if (fleetPayloadDigest(challenge.challenge.context) !== target.digest)
          throw unavailable();
        const proof = this.credentials.prove(this.owner, challenge);
        // A failed issue response is never replayed with its old nonce/proof.
        // A later renewal obtains a fresh destination challenge under the grant.
        const response = SignedFleetCredential.parse(
          await this.request(controller, (signal) =>
            this.transport.issue(target.origin, proof, signal),
          ),
        );
        live();
        const accepted = this.credentials.accept(this.owner, proof, response);
        const now = this.now();
        if (
          accepted.expiresAtMonotonic <= now ||
          accepted.expiresAtMonotonic > now + accepted.remainingMs + 1
        )
          throw unavailable();
        const credential = Object.freeze({
          ...accepted,
          context: Object.freeze({ ...accepted.context }),
        });
        this.credential = credential;
        this.failures = 0;
        this.nextAttempt = Math.max(
          now + 1_000,
          accepted.renewAtMonotonic - this.jitter() * 15_000,
        );
        this.notify();
        live();
        return credential;
      } catch (error) {
        if (!this.stopped && generation === this.generation) {
          const now = this.now();
          this.expire(now);
          this.failures = Math.min(16, this.failures + 1);
          this.nextAttempt =
            now +
            Math.min(
              60_000,
              1_000 * 2 ** (this.failures - 1) * (0.8 + this.jitter() * 0.4),
            );
          try {
            this.onUnavailable(error);
          } catch {
            // Recovery observers cannot extend or manufacture a credential.
          }
        }
        throw unavailable();
      } finally {
        if (this.pending?.controller === controller) this.pending = undefined;
        this.schedule();
      }
    })();
    this.pending = { controller, promise };
    this.schedule();
    return promise;
  }
  async get(): Promise<FleetAccessLease> {
    if (this.stopped) throw closed();
    const target = this.current(),
      now = this.now();
    this.expire(now);
    if (this.credential) {
      if (now >= this.nextAttempt) void this.renew(target).catch(() => {});
      return this.credential;
    }
    if (this.pending) return this.pending.promise;
    if (now < this.nextAttempt) {
      this.schedule();
      throw unavailable();
    }
    return this.renew(target);
  }
  /** Invoke synchronously when the owning gateway accepts a directory change. */
  changed() {
    if (!this.stopped) void this.get().catch(() => {});
  }
  status() {
    if (this.stopped) return { state: "closed" as const, remainingMs: 0 };
    try {
      this.current();
      const now = this.now();
      this.expire(now);
      return {
        state: this.credential
          ? ("valid" as const)
          : this.pending
            ? ("renewing" as const)
            : ("unavailable" as const),
        remainingMs: this.credential
          ? Math.max(0, this.credential.expiresAtMonotonic - now)
          : 0,
      };
    } catch {
      return { state: "closed" as const, remainingMs: 0 };
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.pending?.controller.abort();
    this.pending = undefined;
    this.credential = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.notify();
  }
}
