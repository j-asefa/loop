import { FleetOperation, MachineId } from "../shared/fleet.js";
import { performance } from "node:perf_hooks";
import { Problem } from "../shared/problem.js";
import {
  FleetCredentialLease,
  type FleetCredentialTransport,
} from "./fleet-credential-lease.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";

/** One registry belongs to the companion's local owner and issuer instance.
 * Demand creates at most one lease for each enrolled peer/operation. Credentials
 * stay server-side; observers receive only the affected public machine ID. */
export class FleetCredentialLeases {
  private readonly leases = new Map<
    string,
    { peer: string; operation: FleetOperation; lease: FleetCredentialLease }
  >();
  private stopped = false;
  private readonly unobserve: () => void;
  private nextReconcile = 0;
  private reconciling = false;
  constructor(
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    private readonly transport: FleetCredentialTransport,
    private readonly onChange: (peer: string) => void = () => {},
    private readonly options: {
      monotonic?: () => number;
      random?: () => number;
      reconcile?: () => Promise<unknown>;
    } = {},
  ) {
    this.unobserve = authority.observe(owner, () => this.changed());
  }
  private unavailable(error: unknown) {
    if (
      this.stopped ||
      this.reconciling ||
      !this.options.reconcile ||
      !(error instanceof Problem) ||
      ![403, 409].includes(error.status)
    )
      return;
    const now = (this.options.monotonic ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < 0) return;
    if (now < this.nextReconcile) return;
    // All operation leases share this cooldown. A refusal is only a reason to
    // read signed history; it cannot install authority or replay an agent action.
    this.nextReconcile = now + 30_000;
    this.reconciling = true;
    void Promise.resolve()
      .then(() => {
        if (!this.stopped) return this.options.reconcile!();
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        this.reconciling = false;
      });
  }
  private peers() {
    const local = this.authority.status(this.owner);
    if (!local.directory || local.state === "removed") return new Set<string>();
    return new Set(
      local.directory.document.members
        .filter(
          (member) => member.machineId !== this.authority.identity.machineId,
        )
        .map((member) => member.machineId),
    );
  }
  private entry(peer: string, operation: FleetOperation) {
    MachineId.parse(peer);
    FleetOperation.parse(operation);
    if (this.stopped || !this.peers().has(peer))
      throw new Problem(
        403,
        "This peer is not available under the local fleet grant.",
      );
    const key = `${peer}:${operation}`;
    let entry = this.leases.get(key);
    if (!entry) {
      // FleetDirectory caps membership at 128 and FleetOperation has five
      // values. Reject unknown peers before allocating timers or map entries.
      if (this.leases.size >= 127 * FleetOperation.options.length)
        throw new Problem(503, "The peer credential registry is full.");
      entry = {
        peer,
        operation,
        lease: new FleetCredentialLease(
          this.authority,
          this.credentials,
          this.owner,
          peer,
          operation,
          this.transport,
          {
            ...this.options,
            onChange: () => this.onChange(peer),
            onUnavailable: (error) => this.unavailable(error),
          },
        ),
      };
      this.leases.set(key, entry);
    }
    return entry;
  }
  get(peer: string, operation: FleetOperation) {
    return this.entry(peer, operation).lease.get();
  }
  rejected(peer: string, operation: FleetOperation, token: string) {
    if (this.stopped) return;
    this.leases.get(`${peer}:${operation}`)?.lease.rejected(token);
    this.unavailable(new Problem(403, "A peer credential was refused."));
  }
  refreshDirectory() {
    this.unavailable(new Problem(409, "A peer has a different directory."));
  }
  /** Authority notifications run after commit; individual get() calls also
   * recheck the head before dispatch, even before this notification arrives. */
  changed() {
    if (this.stopped) return;
    let peers: Set<string>;
    try {
      peers = this.peers();
    } catch {
      this.close();
      return;
    }
    for (const [key, entry] of this.leases) {
      if (!peers.has(entry.peer)) {
        this.leases.delete(key);
        entry.lease.close();
      } else entry.lease.changed();
    }
  }
  status(peer: string) {
    MachineId.parse(peer);
    if (this.stopped || !this.peers().has(peer)) return [];
    return [...this.leases.values()]
      .filter((entry) => entry.peer === peer)
      .map(({ operation, lease }) => ({ operation, ...lease.status() }));
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.unobserve();
    const entries = [...this.leases.values()];
    this.leases.clear();
    for (const entry of entries) entry.lease.close();
  }
}
