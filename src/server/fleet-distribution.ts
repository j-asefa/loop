import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { secret } from "../state.js";
import type { SignedFleetDirectory } from "../shared/fleet.js";
import {
  SignedFleetDirectoryPush,
  type SignedFleetHistoryQuery,
} from "../shared/fleet-directory-sync.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import {
  type FleetEnrollmentProbe,
  SignedFleetEnrollmentProbe,
} from "../shared/fleet-enrollment.js";
import {
  FleetDirectoryReconcile,
  type FleetHistoryTransport,
} from "./fleet-directory-reconcile.js";
import {
  verifyFleetDirectoryAck,
  verifyFleetHistoryResponse,
} from "./fleet-directory-sync.js";
import { FleetProof, verifyFleetProof } from "./fleet-proof.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";
import {
  SignedFleetPendingPush,
  type SignedFleetPendingQuery,
} from "../shared/fleet-pending-directory.js";
import {
  verifyFleetPendingAck,
  verifyFleetPendingHead,
} from "./fleet-pending-directory.js";

export interface FleetDistributionTransport extends FleetHistoryTransport {
  probe(
    origin: string,
    input: FleetEnrollmentProbe,
    signal?: AbortSignal,
  ): Promise<unknown>;
  pendingHistory?(
    origin: string,
    input: SignedFleetPendingQuery,
    signal?: AbortSignal,
  ): Promise<unknown>;
  pendingPush?(
    origin: string,
    input: SignedFleetPendingPush,
    signal?: AbortSignal,
  ): Promise<unknown>;
  push(
    origin: string,
    input: SignedFleetDirectoryPush,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
type Row = { peer_id: string; directory_digest: string; attempts: number };
class IncompatibleDirectory extends Problem {
  constructor() {
    super(409, "The directory histories require explicit reconciliation.");
  }
}
const conflict = () => new IncompatibleDirectory();
const unavailable = () =>
  new Problem(503, "The signed directory history is not available here.");

/** A bounded outbox worker for already authorized directory changes. It never
 * signs a new directory, enrolls an owner or retries a harness command. */
export class FleetDistribution {
  private readonly instance = randomUUID();
  private readonly proof: FleetProof;
  private readonly reconcile: FleetDirectoryReconcile;
  private readonly ownsReconcile: boolean;
  private readonly lifetime = new AbortController();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private lastTime = -Infinity;
  private readonly clock: () => number;
  private readonly random: () => number;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    secrets: Parameters<typeof initializeFleetIdentity>[1],
    private readonly transport: FleetDistributionTransport,
    private readonly changed: () => void = () => {},
    options: {
      monotonic?: () => number;
      random?: () => number;
      reconcile?: FleetDirectoryReconcile;
    } = {},
  ) {
    this.clock = options.monotonic ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.proof = new FleetProof(db, authority.identity, secrets);
    this.reconcile =
      options.reconcile ??
      new FleetDirectoryReconcile(db, authority, owner, secrets, transport);
    this.ownsReconcile = !options.reconcile;
    db.transaction(() => {
      db.prepare(
        "INSERT INTO fleet_distribution_instances VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET instance_id=excluded.instance_id",
      ).run(owner, this.instance);
      // Monotonic deadlines are process-relative. Only immutable stored pushes
      // can repeat after restart; resetting their scheduling does not grant work.
      db.prepare(
        "UPDATE fleet_distribution SET next_attempt=0 WHERE owner_id=? AND state='pending'",
      ).run(owner);
    }).immediate();
  }
  private live() {
    this.lifetime.signal.throwIfAborted();
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM fleet_distribution_instances WHERE owner_id=? AND instance_id=?",
        )
        .get(this.owner, this.instance)
    )
      throw new Problem(409, "This directory worker was replaced.");
  }
  private now() {
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0 || now < this.lastTime) {
      this.close();
      throw unavailable();
    }
    this.lastTime = now;
    return Math.floor(now);
  }
  private notify() {
    try {
      this.changed();
    } catch {
      /* An observer cannot alter a receipt. */
    }
  }
  private directory(digest: string) {
    const value = this.authority.directory(this.owner, digest);
    if (!value) throw unavailable();
    return value;
  }
  private ancestors(head: string) {
    return this.authority.lineage(this.owner, head);
  }
  private admission(directory: SignedFleetDirectory) {
    const entries: SignedFleetDirectory[] = [];
    let at: SignedFleetDirectory | undefined = directory,
      bytes = 2;
    while (at && entries.length < 1024) {
      const size = Buffer.byteLength(JSON.stringify(at)) + 1;
      // Keep the newest usable suffix. Excess retained history must not hide
      // an already accepted removal's small idempotent acknowledgement path.
      if (bytes + size > 768 * 1024) break;
      bytes += size;
      entries.unshift(at);
      at =
        at.document.parent && at.document.kind !== "recovery"
          ? this.authority.directory(this.owner, at.document.parent)
          : undefined;
    }
    return entries;
  }
  private async identify(
    row: Row,
    target: ReturnType<FleetDistribution["target"]>,
  ) {
    const probe: FleetEnrollmentProbe = {
      version: 1,
      nonce: secret(),
      origin: target.peer.origin,
      destination: {
        machineId: target.peer.machineId,
        publicKey: target.peer.publicKey,
      },
    };
    const response = SignedFleetEnrollmentProbe.parse(
      await this.request((signal) =>
        this.transport.probe(target.peer.origin, probe, signal),
      ),
    );
    if (
      fleetPayloadDigest(response.probe) !== fleetPayloadDigest(probe) ||
      !verifyFleetProof(
        probe.destination,
        "enrollment-probe",
        response.probe,
        response.signature,
      )
    )
      throw new Problem(
        403,
        "The fleet destination identity could not be verified.",
      );
    if (this.target(row).head !== target.head) throw unavailable();
  }
  /** Oldest first, excluding the trusted anchor. A reset is not an ordinary edge.
   * Validation walks all retained ancestors; callers collecting a wire page
   * retain a bounded prefix plus its possible admission continuation. */
  private between(anchor: string, target: string, collect = true) {
    if (!this.authority.ancestor(this.owner, target, anchor)) throw conflict();
    if (!collect) return [];
    const entries: SignedFleetDirectory[] = [];
    let cursor = target,
      bytes = 0;
    while (cursor !== anchor) {
      const entry = this.directory(cursor);
      if (collect) {
        entries.push(entry);
        bytes += Buffer.byteLength(JSON.stringify(entry));
        while (entries.length > 1024 || bytes > 16 * 1024 * 1024)
          bytes -= Buffer.byteLength(JSON.stringify(entries.shift()!));
      }
      if (!entry.document.parent || entry.document.kind === "recovery")
        throw conflict();
      cursor = entry.document.parent;
    }
    return entries.reverse();
  }
  private target(row: Row) {
    this.live();
    const local = this.authority.status(this.owner);
    if (!local.directory || local.state === "removed") throw conflict();
    this.between(row.directory_digest, local.head!, false);
    const directory = this.directory(row.directory_digest);
    let at: SignedFleetDirectory | undefined = local.directory;
    while (at) {
      const peer = at.document.members.find((m) => m.machineId === row.peer_id);
      if (peer) return { directory, peer, head: local.head! };
      at =
        at.document.parent && at.document.kind !== "recovery"
          ? this.authority.directory(this.owner, at.document.parent)
          : undefined;
    }
    throw unavailable();
  }
  private async request<T>(action: (signal: AbortSignal) => Promise<T>) {
    this.live();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(15_000),
    ]);
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(unavailable());
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([action(signal), stopped]);
      this.live();
      this.now();
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private stored(row: Row) {
    return this.db
      .prepare(
        "SELECT request,protocol FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
      )
      .get(this.owner, row.peer_id, row.directory_digest) as
      { request: string; protocol: "directory" | "pending" } | undefined;
  }
  private acknowledge(row: Row, head: string, request?: string) {
    this.db
      .transaction(() => {
        this.live();
        this.target(row);
        if (request && this.stored(row)?.request !== request) return;
        // A verified destination head can acknowledge an older target. It cannot
        // acknowledge a descendant or unrelated fork based on an integer alone.
        this.between(row.directory_digest, head, false);
        const acknowledge = this.db.prepare(
          "UPDATE fleet_distribution SET state='acked',next_attempt=0 WHERE owner_id=? AND peer_id=? AND directory_digest=? AND state='pending'",
        );
        const clear = this.db.prepare(
          "DELETE FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
        );
        // An authenticated newer revision supersedes earlier pending targets
        // on that same lineage; unrelated recovery work remains incompatible.
        for (const digest of this.ancestors(head)) {
          acknowledge.run(this.owner, row.peer_id, digest);
          clear.run(this.owner, row.peer_id, digest);
        }
      })
      .immediate();
    this.notify();
  }
  private async prepare(row: Row) {
    const target = this.target(row);
    const query: SignedFleetHistoryQuery["query"] = {
      version: 1,
      nonce: secret(),
      sender: this.authority.identity,
      destination: {
        machineId: target.peer.machineId,
        publicKey: target.peer.publicKey,
      },
      cursor: null,
    };
    let request: SignedFleetHistoryQuery = {
      query,
      signature: this.proof.sign("directory-query", query),
    };
    let response: unknown;
    try {
      try {
        response = await this.request((signal) =>
          this.transport.history(target.peer.origin, request, signal),
        );
      } catch (error) {
        if (!(error instanceof Problem) || error.status !== 403) throw error;
        await this.identify(row, target);
        const admission = this.admission(target.directory);
        if (!admission.length) throw error;
        const introduced = {
          ...query,
          nonce: secret(),
          admission,
        };
        request = {
          query: introduced,
          signature: this.proof.sign("directory-query", introduced),
        };
        response = await this.request((signal) =>
          this.transport.history(target.peer.origin, request, signal),
        );
      }
    } catch (error) {
      let failure = error;
      if (error instanceof Problem && [403, 409].includes(error.status)) {
        try {
          if (await this.preparePending(row, target)) return;
        } catch (pendingError) {
          failure = pendingError;
        }
      }
      // A peer that learned its removal from another replica no longer serves
      // history. Repeat only its already-authorized removal against the signed
      // predecessor; a still-unbound or stale peer will refuse that anchor.
      const parent =
        target.directory.document.parent &&
        this.authority.directory(this.owner, target.directory.document.parent);
      if (
        !(error instanceof Problem) ||
        error.status !== 403 ||
        !parent ||
        !target.directory.document.tombstones.includes(row.peer_id) ||
        !parent.document.members.some(
          (member) => member.machineId === row.peer_id,
        )
      )
        throw failure;
      this.save(
        row,
        target.head,
        directoryDigest(parent.document),
        [target.directory],
        query.destination,
      );
      return;
    }
    const verified = verifyFleetHistoryResponse(request, response);
    this.live();
    const current = this.target(row);
    if (current.head !== target.head) throw unavailable();
    const remote = verified.page.head;
    if (!this.authority.directory(this.owner, remote))
      this.db
        .transaction(() => {
          this.live();
          if (this.target(row).head !== target.head) throw unavailable();
          this.authority.retainAncestors(this.owner, verified.page.entries);
        })
        .immediate();
    if (!this.authority.directory(this.owner, remote)) {
      if (
        await this.reconcile.from(row.peer_id, this.lifetime.signal, () =>
          this.live(),
        )
      )
        this.notify();
      return;
    }
    if (this.ancestors(remote).has(row.directory_digest)) {
      this.acknowledge(row, remote);
      return;
    }
    const entries = this.between(remote, row.directory_digest);
    let bytes = 2;
    const selected: SignedFleetDirectory[] = [];
    for (const entry of entries) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (selected.length >= 32 || bytes + size > 768 * 1024) break;
      selected.push(entry);
      bytes += size;
    }
    if (!selected.length) throw unavailable();
    const anchor = this.directory(remote);
    const known = [anchor, selected.at(-1)!].some((entry) =>
      entry.document.members.some(
        (member) =>
          member.machineId === this.authority.identity.machineId &&
          member.publicKey === this.authority.identity.publicKey,
      ),
    );
    let admission: SignedFleetDirectory[] | undefined;
    if (!known) {
      admission = [];
      for (const entry of entries.slice(selected.length)) {
        admission.push(entry);
        if (
          entry.document.members.some(
            (member) =>
              member.machineId === this.authority.identity.machineId &&
              member.publicKey === this.authority.identity.publicKey,
          )
        )
          break;
      }
      if (!admission.length) throw unavailable();
    }
    this.save(row, target.head, remote, selected, query.destination, admission);
  }
  private save(
    row: Row,
    head: string,
    anchor: string,
    entries: SignedFleetDirectory[],
    destination: SignedFleetDirectoryPush["push"]["destination"],
    admission?: SignedFleetDirectory[],
  ) {
    const push = {
      version: 1 as const,
      nonce: secret(),
      sender: this.authority.identity,
      destination,
      anchor,
      entries,
      ...(admission ? { admission } : {}),
    };
    const signed = SignedFleetDirectoryPush.parse({
      push,
      signature: this.proof.sign("directory-sync", push),
    });
    const encoded = JSON.stringify(signed);
    this.db
      .transaction(() => {
        this.live();
        if (this.target(row).head !== head) throw unavailable();
        this.db
          .prepare(
            "INSERT OR IGNORE INTO fleet_distribution_work(owner_id,peer_id,directory_digest,request) VALUES(?,?,?,?)",
          )
          .run(this.owner, row.peer_id, row.directory_digest, encoded);
      })
      .immediate();
  }
  private pendingOperations(
    row: Row,
    peer: ReturnType<FleetDistribution["target"]>["peer"],
  ) {
    let at = this.directory(row.directory_digest);
    const operationIds: string[] = [];
    for (
      let i = 0;
      i < 1024 && at.document.parent && at.document.kind !== "recovery";
      i++
    ) {
      const parent = this.directory(at.document.parent);
      const member = at.document.members.find(
        (m) => m.machineId === row.peer_id && m.grantId === peer.grantId,
      );
      if (member) operationIds.push(at.document.mutationId);
      if (
        member &&
        !parent.document.members.some(
          (m) => m.machineId === row.peer_id && m.grantId === peer.grantId,
        )
      )
        return operationIds;
      at = parent;
    }
    if (!at.document.parent || at.document.kind === "recovery")
      return operationIds;
    throw unavailable();
  }
  private async preparePending(
    row: Row,
    target: ReturnType<FleetDistribution["target"]>,
    replace?: string,
  ) {
    if (
      !this.transport.pendingHistory ||
      !this.transport.pendingPush ||
      !target.directory.document.tombstones.includes(row.peer_id)
    )
      return false;
    await this.identify(row, target);
    const operationIds = this.pendingOperations(row, target.peer);
    if (!operationIds.length) return false;
    const query: SignedFleetPendingQuery["query"] = {
      version: 1,
      nonce: secret(),
      sender: this.authority.identity,
      destination: {
        machineId: target.peer.machineId,
        publicKey: target.peer.publicKey,
      },
      grantId: target.peer.grantId,
      operationIds,
    };
    let signed: SignedFleetPendingQuery = {
      query,
      signature: this.proof.sign("pending-directory-query", query),
    };
    let anchor: string, operationId: string;
    try {
      let response: unknown;
      try {
        response = await this.request((signal) =>
          this.transport.pendingHistory!(target.peer.origin, signed, signal),
        );
      } catch (error) {
        if (!(error instanceof Problem) || error.status !== 403) throw error;
        const introduced = {
          ...query,
          nonce: secret(),
          admission: this.admission(target.directory),
        };
        signed = {
          query: introduced,
          signature: this.proof.sign("pending-directory-query", introduced),
        };
        response = await this.request((signal) =>
          this.transport.pendingHistory!(target.peer.origin, signed, signal),
        );
      }
      const { head } = verifyFleetPendingHead(signed, response);
      this.live();
      if (this.target(row).head !== target.head) throw unavailable();
      if (head.state === "complete") {
        // Enrollment may have committed between pages. Drop only the matching
        // directory packet, then discover the enrolled head on the next attempt.
        if (replace)
          this.db
            .transaction(() => {
              this.live();
              this.target(row);
              if (this.stored(row)?.request === replace)
                this.db
                  .prepare(
                    "DELETE FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
                  )
                  .run(this.owner, row.peer_id, row.directory_digest);
            })
            .immediate();
        return true;
      }
      anchor = directoryDigest(head.directory.document);
      operationId = head.operationId;
      if (!this.authority.directory(this.owner, anchor)) throw conflict();
      if (head.state === "cancelled") {
        if (
          anchor !== row.directory_digest ||
          !head.directory.document.tombstones.includes(row.peer_id)
        )
          throw conflict();
        this.acknowledge(row, anchor, replace);
        return true;
      }
    } catch (error) {
      if (error instanceof Problem && error.status === 403) return false;
      throw error;
    }
    this.savePending(row, target.head, anchor, operationId, replace);
    return true;
  }
  private savePending(
    row: Row,
    head: string,
    anchor: string,
    operationId: string,
    replace?: string,
  ) {
    const target = this.target(row),
      entries: SignedFleetDirectory[] = [];
    let bytes = 0;
    for (const entry of this.between(anchor, row.directory_digest)) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (entries.length >= 32 || bytes + size > 768 * 1024) break;
      bytes += size;
      entries.push(entry);
    }
    if (!entries.length) throw unavailable();
    const push: SignedFleetPendingPush["push"] = {
      version: 1,
      nonce: secret(),
      sender: this.authority.identity,
      destination: {
        machineId: target.peer.machineId,
        publicKey: target.peer.publicKey,
      },
      grantId: target.peer.grantId,
      operationId,
      anchor,
      entries,
    };
    const signed = SignedFleetPendingPush.parse({
      push,
      signature: this.proof.sign("pending-directory-push", push),
    });
    this.db
      .transaction(() => {
        this.live();
        if (
          this.target(row).head !== head ||
          (replace && this.stored(row)?.request !== replace)
        )
          throw unavailable();
        this.db
          .prepare(
            "INSERT INTO fleet_distribution_work(owner_id,peer_id,directory_digest,request,protocol) VALUES(?,?,?,?,'pending') ON CONFLICT(owner_id,peer_id,directory_digest) DO UPDATE SET request=excluded.request,protocol='pending'",
          )
          .run(
            this.owner,
            row.peer_id,
            row.directory_digest,
            JSON.stringify(signed),
          );
        this.db
          .prepare(
            "UPDATE fleet_distribution SET attempts=0,next_attempt=? WHERE owner_id=? AND peer_id=? AND directory_digest=? AND state='pending'",
          )
          .run(this.now(), this.owner, row.peer_id, row.directory_digest);
      })
      .immediate();
  }
  private async sendPending(row: Row, encoded: string) {
    const target = this.target(row),
      request = SignedFleetPendingPush.parse(JSON.parse(encoded));
    if (
      !this.transport.pendingPush ||
      !target.directory.document.tombstones.includes(row.peer_id) ||
      request.push.sender.machineId !== this.authority.identity.machineId ||
      request.push.sender.publicKey !== this.authority.identity.publicKey ||
      request.push.destination.machineId !== target.peer.machineId ||
      request.push.destination.publicKey !== target.peer.publicKey ||
      request.push.grantId !== target.peer.grantId ||
      !verifyFleetProof(
        this.authority.identity,
        "pending-directory-push",
        request.push,
        request.signature,
      )
    )
      throw conflict();
    this.between(
      directoryDigest(request.push.entries.at(-1)!.document),
      row.directory_digest,
      false,
    );
    let response: unknown;
    try {
      await this.identify(row, target);
      response = await this.request((signal) =>
        this.transport.pendingPush!(target.peer.origin, request, signal),
      );
    } catch (error) {
      // An already removed, committed destination refuses pending-consent reads.
      // Its ordinary idempotent removal receipt remains available.
      const parent =
        target.directory.document.parent &&
        this.authority.directory(this.owner, target.directory.document.parent);
      if (
        !(error instanceof Problem) ||
        error.status !== 403 ||
        !parent ||
        !parent.document.members.some((m) => m.machineId === row.peer_id)
      )
        throw error;
      this.db
        .transaction(() => {
          this.live();
          if (this.stored(row)?.request !== encoded) throw unavailable();
          this.db
            .prepare(
              "DELETE FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
            )
            .run(this.owner, row.peer_id, row.directory_digest);
          this.save(
            row,
            target.head,
            directoryDigest(parent.document),
            [target.directory],
            request.push.destination,
          );
        })
        .immediate();
      return;
    }
    const { ack } = verifyFleetPendingAck(
      request,
      this.directory(request.push.anchor),
      response,
    );
    if (ack.state === "cancelled") {
      if (ack.accepted !== row.directory_digest) throw conflict();
      this.acknowledge(row, ack.accepted, encoded);
      return;
    }
    if (ack.state === "prepared") {
      this.savePending(
        row,
        target.head,
        ack.accepted,
        request.push.operationId,
        encoded,
      );
      return;
    }
    this.db
      .transaction(() => {
        this.live();
        this.target(row);
        if (this.stored(row)?.request !== encoded) return;
        this.db
          .prepare(
            "DELETE FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
          )
          .run(this.owner, row.peer_id, row.directory_digest);
      })
      .immediate();
  }
  private async one(row: Row) {
    try {
      let stored = this.stored(row);
      if (!stored) {
        await this.prepare(row);
        stored = this.stored(row);
      }
      if (!stored) {
        const state = this.db
          .prepare(
            "SELECT state FROM fleet_distribution WHERE owner_id=? AND peer_id=? AND directory_digest=?",
          )
          .get(this.owner, row.peer_id, row.directory_digest) as
          { state: string } | undefined;
        if (state?.state === "pending") throw unavailable();
        return;
      }
      if (stored.protocol === "pending") {
        await this.sendPending(row, stored.request);
        return;
      }
      const target = this.target(row),
        request = SignedFleetDirectoryPush.parse(JSON.parse(stored.request));
      if (
        request.push.sender.machineId !== this.authority.identity.machineId ||
        request.push.sender.publicKey !== this.authority.identity.publicKey ||
        request.push.destination.machineId !== target.peer.machineId ||
        request.push.destination.publicKey !== target.peer.publicKey ||
        !verifyFleetProof(
          this.authority.identity,
          "directory-sync",
          request.push,
          request.signature,
        )
      )
        throw conflict();
      const anchor = this.directory(request.push.anchor);
      const requested = directoryDigest(request.push.entries.at(-1)!.document);
      this.between(requested, row.directory_digest, false);
      await this.identify(row, target);
      const response = verifyFleetDirectoryAck(
        request,
        anchor,
        await this.request((signal) =>
          this.transport.push(target.peer.origin, request, signal),
        ),
      );
      if (response.ack.accepted === row.directory_digest) {
        this.acknowledge(row, response.ack.accepted, stored.request);
        return;
      }
      this.db
        .transaction(() => {
          this.live();
          this.target(row);
          if (this.stored(row)?.request !== stored!.request) return;
          if (response.ack.state === "removed") throw conflict();
          this.db
            .prepare(
              "DELETE FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
            )
            .run(this.owner, row.peer_id, row.directory_digest);
          this.db
            .prepare(
              "UPDATE fleet_distribution SET attempts=0,next_attempt=? WHERE owner_id=? AND peer_id=? AND directory_digest=?",
            )
            .run(this.now(), this.owner, row.peer_id, row.directory_digest);
        })
        .immediate();
      this.notify();
    } catch (error) {
      try {
        this.live();
        let failure = error;
        const stored = this.stored(row);
        if (
          (!stored || stored.protocol === "directory") &&
          error instanceof Problem &&
          [403, 409].includes(error.status)
        ) {
          let target: ReturnType<FleetDistribution["target"]> | undefined;
          try {
            target = this.target(row);
          } catch {
            /* Retired lineage must still record incompatibility below. */
          }
          if (target) {
            try {
              if (await this.preparePending(row, target, stored?.request))
                return;
            } catch (pendingError) {
              failure = pendingError;
            }
          }
        }
        this.live();
        const random = this.random(),
          jitter = Number.isFinite(random)
            ? Math.max(0, Math.min(1, random))
            : 0.5;
        const retry =
          this.now() +
          Math.ceil(
            Math.min(
              60_000,
              1000 * 2 ** Math.min(16, row.attempts) * (0.8 + 0.4 * jitter),
            ),
          );
        // An HTTP 409 can mean a temporary local reservation or a concurrent
        // synchronization. Only locally established lineage incompatibility
        // retires work; a transport status alone cannot prove that outcome.
        const state =
          failure instanceof IncompatibleDirectory ? "incompatible" : "pending";
        this.db
          .prepare(
            "UPDATE fleet_distribution SET state=?,attempts=attempts+1,next_attempt=? WHERE owner_id=? AND peer_id=? AND directory_digest=? AND state='pending'",
          )
          .run(state, retry, this.owner, row.peer_id, row.directory_digest);
        this.notify();
      } catch {
        /* A stopped or replaced worker cannot change retry state. */
      }
    }
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    this.live();
    const rows = this.db
      .prepare(
        `SELECT d.peer_id,d.directory_digest,d.attempts FROM fleet_distribution d
      JOIN fleet_directory_history h ON h.owner_id=d.owner_id AND h.digest=d.directory_digest
      WHERE d.owner_id=? AND d.state='pending' AND d.next_attempt<=?
        AND NOT EXISTS(SELECT 1 FROM fleet_distribution newer JOIN fleet_directory_history n ON n.owner_id=newer.owner_id AND n.digest=newer.directory_digest WHERE newer.owner_id=d.owner_id AND newer.peer_id=d.peer_id AND newer.state='pending' AND n.rowid>h.rowid)
      ORDER BY d.next_attempt,h.rowid,d.peer_id LIMIT 2`,
      )
      .all(this.owner, this.now()) as Row[];
    const pending = Promise.all(rows.map((row) => this.one(row))).then(
      () => {},
    );
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => {});
    return pending;
  }
  start() {
    this.live();
    this.running = true;
    this.wake();
  }
  wake() {
    if (!this.running || this.lifetime.signal.aborted || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void Promise.resolve()
        .then(() => this.flush())
        .catch(() => {})
        .finally(() => this.wake());
    }, 1000);
    this.timer.unref();
  }
  close() {
    this.running = false;
    this.lifetime.abort();
    if (this.ownsReconcile) this.reconcile.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
