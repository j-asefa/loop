import * as fleetEnrollmentsQueries from "./sql/fleet-enrollments.js";
import type Database from "better-sqlite3";
import { secret } from "../state.js";
import { MachineId, type SignedFleetDirectory } from "../shared/fleet.js";
import type { SignedFleetHistoryQuery } from "../shared/fleet-directory-sync.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { directoryDigest, verifyDirectorySuccessor } from "./fleet-crypto.js";
import { verifyFleetHistoryResponse } from "./fleet-directory-sync.js";
import { FleetProof } from "./fleet-proof.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

export interface FleetHistoryTransport {
  history(
    origin: string,
    query: SignedFleetHistoryQuery,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Fetch signed history from an enrolled replica without a browser or current
 * access credential. Network replies are only evidence: an entire connecting
 * chain must verify before the transaction can change any grant. */
export class FleetDirectoryReconcile {
  private readonly proof: FleetProof;
  private pending?: Promise<boolean>;
  private readonly lifetime = new AbortController();
  private active = 0;
  private nextPeer = 0;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    secrets: Parameters<typeof initializeFleetIdentity>[1],
    private readonly transport: FleetHistoryTransport,
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
  }

  async from(
    peerId: string,
    signal?: AbortSignal,
    assertCurrent: () => void = () => {},
  ): Promise<boolean> {
    if (this.active >= 2)
      throw new Problem(503, "Directory synchronization is already busy.");
    this.lifetime.signal.throwIfAborted();
    this.active++;
    try {
      return await this.read(
        peerId,
        AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(45_000),
          ...(signal ? [signal] : []),
        ]),
        assertCurrent,
      );
    } finally {
      this.active--;
    }
  }

  private async history(
    origin: string,
    query: SignedFleetHistoryQuery,
    signal: AbortSignal,
  ) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    bounded.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(new Problem(503, "Directory synchronization was interrupted."));
      bounded.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([
        this.transport.history(origin, query, bounded),
        cancelled,
      ]);
    } finally {
      bounded.removeEventListener("abort", abort);
    }
  }

  private async read(
    peerId: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<boolean> {
    MachineId.parse(peerId);
    const initial = this.authority.status(this.owner),
      peer = initial.directory?.document.members.find(
        (m) => m.machineId === peerId,
      );
    if (
      !initial.directory ||
      initial.state === "removed" ||
      !peer ||
      peerId === this.authority.identity.machineId
    )
      throw new Problem(403, "Choose a currently enrolled directory replica.");
    const live = () => {
      signal.throwIfAborted();
      assertCurrent();
      const current = this.authority.status(this.owner);
      if (current.head !== initial.head || current.state !== initial.state)
        throw new Problem(
          503,
          "Local directory authority changed during synchronization.",
        );
    };
    let cursor: string | null = null,
      expected: string | null = null,
      bytes = 0;
    const entries: SignedFleetDirectory[] = [],
      seen = new Set<string>();
    for (let pageCount = 0; pageCount < 128; pageCount++) {
      live();
      const query: SignedFleetHistoryQuery["query"] = {
        version: 1,
        nonce: secret(),
        sender: this.authority.identity,
        destination: { machineId: peer.machineId, publicKey: peer.publicKey },
        cursor,
      };
      const signed = {
        query,
        signature: this.proof.sign("directory-query", query),
      };
      const { page } = verifyFleetHistoryResponse(
        signed,
        await this.history(peer.origin, signed, signal),
      );
      live();
      for (const entry of page.entries) {
        const digest = directoryDigest(entry.document);
        if (expected && digest !== expected)
          throw new Problem(
            409,
            "Directory history does not connect to its preceding page.",
          );
        if (seen.has(digest))
          throw new Problem(409, "Directory history repeats a cursor.");
        seen.add(digest);
        const known = this.authority.directory(this.owner, digest);
        if (known) {
          if (!entries.length) return false;
          // A known old ancestor is insufficient when the local head is on
          // another branch. Never partially install a remote fork.
          if (digest !== initial.head)
            throw new Problem(
              409,
              "Directory histories conflict; explicit recovery is required.",
            );
          let predecessor = known;
          for (const successor of [...entries].reverse())
            predecessor = verifyDirectorySuccessor(
              successor,
              predecessor.document,
            );
          this.db
            .transaction(() => {
              live();
              for (const successor of [...entries].reverse()) {
                this.authority.accept(this.owner, successor);
                if (this.authority.status(this.owner).state === "removed") {
                  fleetEnrollmentsQueries.cancelPreparedDestinations(
                    this.db,
                    this.owner,
                  );
                  break;
                }
              }
            })
            .immediate();
          return true;
        }
        bytes += Buffer.byteLength(JSON.stringify(entry));
        if (entries.length >= 1024 || bytes > 16 * 1024 * 1024)
          throw new Problem(
            503,
            "Directory history exceeds the bounded synchronization window.",
          );
        entries.push(entry);
        expected =
          entry.document.kind === "recovery" ? null : entry.document.parent;
        if (!expected)
          throw new Problem(
            409,
            "This directory lineage requires explicit local enrollment or recovery.",
          );
      }
      if (page.next !== expected || !page.next)
        throw new Problem(
          409,
          "Directory history has no connecting trusted parent.",
        );
      cursor = page.next;
    }
    throw new Problem(
      503,
      "Directory history exceeds the bounded synchronization window.",
    );
  }

  /** One caller's cancellation cannot cancel a shared refresh. A later call may
   * try again; failures retain the existing directory and cannot imply freshness. */
  any(): Promise<boolean> {
    if (this.pending) return this.pending;
    const operation = (async () => {
      const local = this.authority.status(this.owner);
      if (!local.directory || local.state === "removed") return false;
      const deadline = AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(45_000),
      ]);
      const peers = local.directory.document.members.filter(
        (m) => m.machineId !== this.authority.identity.machineId,
      );
      const start = peers.length ? this.nextPeer % peers.length : 0;
      for (let i = 0; i < peers.length; i++) {
        if (deadline.aborted) return false;
        const index = (start + i) % peers.length;
        const peer = peers[index];
        this.nextPeer = index + 1;
        try {
          if (await this.from(peer.machineId, deadline)) return true;
        } catch {
          /* Another replica may hold a connecting signed history. */
        }
      }
      return false;
    })();
    this.pending = operation;
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined;
      })
      .catch(() => {});
    return operation;
  }

  close() {
    this.lifetime.abort();
  }
}
