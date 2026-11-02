import * as fleetDistributionQueries from "./sql/fleet-distribution.js";
import * as fleetHandoffInstancesQueries from "./sql/fleet-handoff-instances.js";
import * as fleetHandoffJobsQueries from "./sql/fleet-handoff-jobs.js";
import * as fleetHandoffsQueries from "./sql/fleet-handoffs.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { secret } from "../state.js";
import {
  FleetHandoffProposal,
  FleetOrigin,
  SignedFleetDirectory,
} from "../shared/fleet.js";
import {
  FleetHandoffJob,
  SignedFleetHandoffQuery,
  SignedFleetHandoffReceipt,
  StartFleetHandoff,
} from "../shared/fleet-handoff.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  verifyDirectorySuccessor,
  verifyHandoffProposalSignature,
} from "./fleet-crypto.js";
import { FleetProof, verifyFleetProof } from "./fleet-proof.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

type Secrets = Parameters<typeof initializeFleetIdentity>[1];
const same = (a: unknown, b: unknown) =>
  fleetPayloadDigest(a) === fleetPayloadDigest(b);
const refused = () =>
  new Problem(403, "The controller handoff is not authorized.");

function distribute(
  db: Database.Database,
  owner: string,
  local: string,
  directory: SignedFleetDirectory,
) {
  for (const member of directory.document.members) {
    if (member.machineId === local) continue;
    fleetDistributionQueries.enqueue(
      db,
      owner,
      member.machineId,
      directoryDigest(directory.document),
    );
  }
}

/** The old controller's directory signature authorizes this exact transition.
 * No device cookie, access credential or nominated local owner is accepted. */
export class FleetHandoffDestination {
  private readonly proof: FleetProof;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    secrets: Secrets,
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
  }
  commit(input: FleetHandoffProposal): SignedFleetDirectory {
    const proposal = FleetHandoffProposal.parse(input);
    const parent = proposal.document.parent
      ? this.authority.directory(this.owner, proposal.document.parent)
      : undefined;
    if (!parent || !same(proposal.document.controller, this.authority.identity))
      throw refused();
    // Reject unauthenticated input using reads before waiting for the writer
    // lock. acceptHandoff rechecks current authority inside the transaction.
    verifyHandoffProposalSignature(proposal, parent.document);
    return this.db
      .transaction(() => {
        const digest = directoryDigest(proposal.document),
          known = this.authority.directory(this.owner, digest),
          result = this.authority.acceptHandoff(this.owner, proposal);
        if (!known)
          distribute(
            this.db,
            this.owner,
            this.authority.identity.machineId,
            result,
          );
        return result;
      })
      .immediate();
  }
  receipt(input: SignedFleetHandoffQuery): SignedFleetHandoffReceipt {
    const value = SignedFleetHandoffQuery.parse(input),
      query = value.query,
      parent = this.authority.directory(this.owner, query.expected);
    if (
      !parent ||
      !same(query.destination, this.authority.identity) ||
      !same(parent.document.controller, query.controller) ||
      !verifyFleetProof(
        query.controller,
        "handoff-query",
        query,
        value.signature,
      )
    )
      throw refused();
    const row = fleetHandoffsQueries.committed(
      this.db,
      this.owner,
      query.directory,
    ) as { proposal: string; result: string } | undefined;
    let directory: SignedFleetDirectory | null = null;
    if (row) {
      const proposal = FleetHandoffProposal.parse(JSON.parse(row.proposal));
      if (
        proposal.document.parent !== query.expected ||
        proposal.document.mutationId !== query.operationId ||
        !same(proposal.document.controller, query.destination) ||
        directoryDigest(proposal.document) !== query.directory
      )
        throw refused();
      directory = verifyDirectorySuccessor(
        JSON.parse(row.result),
        parent.document,
      );
      if (
        !same(directory.document, proposal.document) ||
        directory.signature !== proposal.signature
      )
        throw refused();
    }
    const receipt = SignedFleetHandoffReceipt.shape.receipt.parse({
      version: 1,
      queryDigest: fleetPayloadDigest(query),
      destination: this.authority.identity,
      state: directory ? "complete" : "missing",
      directory,
    });
    return { receipt, signature: this.proof.sign("handoff-receipt", receipt) };
  }
}

export interface FleetHandoffTransport {
  commit(origin: string, proposal: FleetHandoffProposal): Promise<unknown>;
  receipt(origin: string, query: SignedFleetHandoffQuery): Promise<unknown>;
}
const Row = z.object({
  input: z.string(),
  input_digest: z.string(),
  proposal: z.string(),
  directory_digest: z.string(),
  origin: FleetOrigin,
  state: FleetHandoffJob.shape.state,
  attempt_id: z.string().uuid().nullable(),
});

/** Local-device administration owns begin/advance. The source is fenced in the
 * same transaction as the job; uncertain dispatches are only reconciled, never
 * automatically repeated or timed out into an active old controller. */
export class FleetHandoffSource {
  private readonly proof: FleetProof;
  private readonly instanceId = randomUUID();
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    secrets: Secrets,
    private readonly transport: FleetHandoffTransport,
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    db.transaction(() => {
      fleetHandoffInstancesQueries.install(db, owner, this.instanceId);
      fleetHandoffJobsQueries.recover(db, owner);
    }).immediate();
  }
  private currentInstance() {
    return !!fleetHandoffInstancesQueries.exists(
      this.db,
      this.owner,
      this.instanceId,
    );
  }
  private record(operationId: string) {
    z.string().uuid().parse(operationId);
    const raw = fleetHandoffJobsQueries.get(this.db, this.owner, operationId);
    if (!raw)
      throw new Problem(404, "This controller handoff is not recorded here.");
    const row = Row.parse(raw),
      input = StartFleetHandoff.parse(JSON.parse(row.input)),
      proposal = FleetHandoffProposal.parse(JSON.parse(row.proposal)),
      parent = this.authority.directory(this.owner, input.expected);
    if (
      !parent ||
      input.operationId !== operationId ||
      fleetPayloadDigest(input) !== row.input_digest ||
      proposal.document.mutationId !== operationId ||
      proposal.document.parent !== input.expected ||
      !same(proposal.document.controller, input.destination) ||
      !same(parent.document.controller, this.authority.identity) ||
      directoryDigest(proposal.document) !== row.directory_digest
    )
      throw new Problem(409, "The stored controller handoff is inconsistent.");
    return { row, input, proposal, parent };
  }
  status(operationId: string): FleetHandoffJob {
    const { row, input } = this.record(operationId);
    return FleetHandoffJob.parse({
      operationId,
      destination: input.destination,
      origin: row.origin,
      directory: row.directory_digest,
      state: row.state,
    });
  }
  begin(input: StartFleetHandoff): FleetHandoffJob {
    const value = StartFleetHandoff.parse(input);
    this.db
      .transaction(() => {
        if (!this.currentInstance())
          throw new Problem(
            409,
            "This controller handoff instance was replaced.",
          );
        const prior = fleetHandoffJobsQueries.inputDigest(
          this.db,
          this.owner,
          value.operationId,
        ) as { input_digest: string } | undefined;
        if (prior) {
          if (prior.input_digest !== fleetPayloadDigest(value))
            throw new Problem(
              409,
              "Handoff operation ID belongs to different input.",
            );
          return;
        }
        const proposal = this.authority.prepareHandoff(this.owner, {
            mutationId: value.operationId,
            expected: value.expected,
            destination: value.destination,
          }),
          destination = proposal.document.members.find(
            (m) => m.machineId === value.destination.machineId,
          )!;
        fleetHandoffJobsQueries.insert(
          this.db,
          this.owner,
          value.operationId,
          JSON.stringify(value),
          fleetPayloadDigest(value),
          JSON.stringify(proposal),
          directoryDigest(proposal.document),
          destination.origin,
          Date.now(),
        );
      })
      .immediate();
    return this.status(value.operationId);
  }
  private complete(
    operationId: string,
    response: unknown,
    attempt?: string,
    assertAuthorized: () => void = () => {},
  ) {
    this.db
      .transaction(() => {
        assertAuthorized();
        if (!this.currentInstance()) return;
        const record = this.record(operationId);
        if (attempt && record.row.attempt_id !== attempt) return;
        if (["complete", "superseded"].includes(record.row.state)) return;
        const directory = verifyDirectorySuccessor(
          response,
          record.parent.document,
        );
        if (
          !same(directory.document, record.proposal.document) ||
          directory.signature !== record.proposal.signature
        )
          throw refused();
        const current = this.authority.status(this.owner);
        if (
          current.state === "handoff_pending" &&
          current.head === record.input.expected
        ) {
          this.authority.accept(this.owner, directory);
          distribute(
            this.db,
            this.owner,
            this.authority.identity.machineId,
            directory,
          );
        }
        // A later explicit recovery is an independent local trust reset. Retain
        // proof of the historical handoff without replacing that newer decision.
        fleetHandoffJobsQueries.complete(
          this.db,
          JSON.stringify(directory),
          this.owner,
          operationId,
        );
        fleetHandoffsQueries.commitPrepared(
          this.db,
          JSON.stringify(directory),
          this.owner,
          record.row.directory_digest,
        );
        fleetDistributionQueries.acknowledge(
          this.db,
          this.owner,
          record.input.destination.machineId,
          record.row.directory_digest,
        );
      })
      .immediate();
  }
  async advance(
    operationId: string,
    assertAuthorized = () => {},
  ): Promise<FleetHandoffJob> {
    assertAuthorized();
    if (!this.currentInstance()) return this.status(operationId);
    const record = this.record(operationId);
    if (record.row.state !== "ready") return this.status(operationId);
    const attempt = randomUUID();
    const claimed = this.db
      .transaction(() => {
        assertAuthorized();
        if (!this.currentInstance()) return false;
        const current = this.authority.status(this.owner);
        if (
          current.state !== "handoff_pending" ||
          current.head !== record.input.expected
        ) {
          const known = this.authority.directory(
            this.owner,
            record.row.directory_digest,
          );
          if (known) this.complete(operationId, known);
          else
            fleetHandoffJobsQueries.supersede(this.db, this.owner, operationId);
          return false;
        }
        return (
          fleetHandoffJobsQueries.claim(
            this.db,
            attempt,
            this.owner,
            operationId,
          ).changes > 0
        );
      })
      .immediate();
    if (!claimed) return this.status(operationId);
    try {
      this.complete(
        operationId,
        await this.transport.commit(record.row.origin, record.proposal),
        attempt,
        assertAuthorized,
      );
    } catch {
      // Durable uncertainty and the writer fence survive every transport or
      // receipt failure. A replacement instance may query the same operation.
    }
    return this.status(operationId);
  }
  async reconcile(
    operationId: string,
    confirmedOrigin?: string,
    assertAuthorized: () => void = () => {},
  ): Promise<FleetHandoffJob> {
    assertAuthorized();
    if (!this.currentInstance()) return this.status(operationId);
    const record = this.record(operationId);
    if (["complete", "superseded"].includes(record.row.state))
      return this.status(operationId);
    const query = SignedFleetHandoffQuery.shape.query.parse({
      version: 1,
      nonce: secret(),
      operationId,
      expected: record.input.expected,
      directory: record.row.directory_digest,
      controller: this.authority.identity,
      destination: record.input.destination,
    });
    const destination = this.authority
      .directory(this.owner)
      ?.document.members.find(
        (m) =>
          m.machineId === query.destination.machineId &&
          m.publicKey === query.destination.publicKey,
      );
    // Explicitly choosing a changed origin only routes this proof-bound read;
    // it cannot rewrite the canonical directory or dispatch a proposal again.
    const origin = FleetOrigin.parse(
      confirmedOrigin ?? destination?.origin ?? record.row.origin,
    );
    try {
      const value = SignedFleetHandoffReceipt.parse(
        await this.transport.receipt(origin, {
          query,
          signature: this.proof.sign("handoff-query", query),
        }),
      );
      if (
        !same(value.receipt.destination, query.destination) ||
        value.receipt.queryDigest !== fleetPayloadDigest(query) ||
        !verifyFleetProof(
          query.destination,
          "handoff-receipt",
          value.receipt,
          value.signature,
        )
      )
        throw refused();
      assertAuthorized();
      if (value.receipt.state === "complete")
        this.complete(
          operationId,
          value.receipt.directory,
          undefined,
          assertAuthorized,
        );
      // A concurrent missing receipt must not retire a live commit callback.
    } catch {
      // Missing/invalid/unavailable proof never revives old controller writes.
    }
    return this.status(operationId);
  }
}
