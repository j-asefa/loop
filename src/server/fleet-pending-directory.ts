import type Database from "better-sqlite3";
import type { MachineIdentity, SignedFleetDirectory } from "../shared/fleet.js";
import {
  SignedFleetPendingQuery,
  SignedFleetPendingHead,
  SignedFleetPendingPush,
  SignedFleetPendingAck,
} from "../shared/fleet-pending-directory.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { FleetEnrollmentDestination } from "./fleet-enrollment.js";
import { fleetDirectoryIntroduces } from "./fleet-directory-sync.js";
import { FleetProof, verifyFleetProof } from "./fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  verifyApprovedDirectory,
  verifyDirectorySuccessor,
} from "./fleet-crypto.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

const refused = () =>
  new Problem(403, "The pending directory proof is outside local consent.");
const same = (a: unknown, b: unknown) =>
  fleetPayloadDigest(a) === fleetPayloadDigest(b);

export function verifyFleetPendingHead(
  input: SignedFleetPendingQuery,
  response: unknown,
) {
  const { query } = SignedFleetPendingQuery.parse(input),
    value = SignedFleetPendingHead.parse(response),
    { head } = value;
  if (
    !same(head.destination, query.destination) ||
    head.grantId !== query.grantId ||
    !query.operationIds.includes(head.operationId) ||
    head.queryDigest !== fleetPayloadDigest(query) ||
    !verifyFleetProof(
      query.destination,
      "pending-directory-head",
      head,
      value.signature,
    )
  )
    throw refused();
  verifyApprovedDirectory(head.directory);
  return value;
}

export function verifyFleetPendingAck(
  input: SignedFleetPendingPush,
  anchor: SignedFleetDirectory,
  response: unknown,
) {
  const { push } = SignedFleetPendingPush.parse(input),
    value = SignedFleetPendingAck.parse(response),
    { ack } = value;
  if (
    !same(ack.destination, push.destination) ||
    ack.grantId !== push.grantId ||
    ack.operationId !== push.operationId ||
    push.anchor !== directoryDigest(anchor.document) ||
    ack.requestDigest !== fleetPayloadDigest(push) ||
    !verifyFleetProof(
      push.destination,
      "pending-directory-ack",
      ack,
      value.signature,
    )
  )
    throw refused();
  let last = anchor;
  for (const entry of push.entries)
    last = verifyDirectorySuccessor(entry, last.document);
  if (ack.requested !== directoryDigest(last.document)) throw refused();
  if (ack.state !== "complete") {
    const accepted = push.entries.find(
      (entry) => directoryDigest(entry.document) === ack.accepted,
    );
    if (
      !accepted ||
      (ack.state === "prepared" && ack.accepted !== ack.requested) ||
      (ack.state === "prepared" &&
        accepted.document.tombstones.includes(push.destination.machineId)) ||
      (ack.state === "cancelled" &&
        !accepted.document.tombstones.includes(push.destination.machineId))
    )
      throw refused();
  }
  return value;
}

/** Removal delivery for a spent enrollment ceremony. Checkpoints are signed
 * receipts of verified lineage; they never install a workspace binding/grant. */
export class FleetPendingDirectory {
  private readonly proof: FleetProof;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly destination: FleetEnrollmentDestination,
    private readonly owner: string,
    secrets: Parameters<typeof initializeFleetIdentity>[1],
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
  }
  private member(directory: SignedFleetDirectory, peer: MachineIdentity) {
    return directory.document.members.some((m) =>
      same({ machineId: m.machineId, publicKey: m.publicKey }, peer),
    );
  }
  private context(grantId: string, operationId: string) {
    let enrollment: ReturnType<FleetEnrollmentDestination["pendingGrant"]>;
    try {
      enrollment = this.destination.pendingGrant(grantId, operationId);
    } catch {
      // Unknown and inaccessible grants have the same public refusal.
      throw refused();
    }
    const { record, request, prepared } = enrollment;
    if (record.owner_id !== this.owner) throw refused();
    const saved = this.db
      .prepare(
        "SELECT head,signed,receipt FROM fleet_pending_directory WHERE owner_id=? AND operation_id=?",
      )
      .get(this.owner, record.operation_id) as
      { head: string; signed: string; receipt: string } | undefined;
    let directory = request.intent.directory,
      receipt: SignedFleetPendingAck | undefined;
    if (saved) {
      directory = verifyApprovedDirectory(JSON.parse(saved.signed));
      receipt = SignedFleetPendingAck.parse(JSON.parse(saved.receipt));
      if (
        directoryDigest(directory.document) !== saved.head ||
        receipt.ack.accepted !== saved.head ||
        receipt.ack.grantId !== grantId ||
        receipt.ack.operationId !== record.operation_id ||
        !same(receipt.ack.destination, this.authority.identity) ||
        !verifyFleetProof(
          this.authority.identity,
          "pending-directory-ack",
          receipt.ack,
          receipt.signature,
        ) ||
        (receipt.ack.state === "cancelled" &&
          !directory.document.tombstones.includes(
            this.authority.identity.machineId,
          ))
      )
        throw refused();
    }
    if (
      prepared.prepared.member.grantId !== grantId ||
      !same(request.intent.destination, this.authority.identity)
    )
      throw refused();
    return { ...enrollment, directory, receipt };
  }
  private complete(
    context: ReturnType<FleetPendingDirectory["context"]>,
    sender: MachineIdentity,
  ) {
    const local = this.authority.status(this.owner);
    const member = local.directory?.document.members.find(
      (m) => m.machineId === this.authority.identity.machineId,
    );
    if (
      !local.directory ||
      local.state === "removed" ||
      member?.grantId !== context.prepared.prepared.member.grantId ||
      !this.member(local.directory, sender)
    )
      throw refused();
    return local.directory;
  }
  history(input: SignedFleetPendingQuery): SignedFleetPendingHead {
    const { query, signature } = SignedFleetPendingQuery.parse(input);
    if (
      !same(query.destination, this.authority.identity) ||
      query.sender.machineId === this.authority.identity.machineId ||
      !verifyFleetProof(
        query.sender,
        "pending-directory-query",
        query,
        signature,
      )
    )
      throw refused();
    const record = this.db
      .prepare(
        "SELECT operation_id FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND json_extract(prepared,'$.prepared.member.grantId')=? AND operation_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 1",
      )
      .get(this.owner, query.grantId, JSON.stringify(query.operationIds)) as
      { operation_id: string } | undefined;
    if (!record) throw refused();
    const context = this.context(query.grantId, record.operation_id);
    const directory =
      context.record.state === "complete"
        ? this.complete(context, query.sender)
        : context.directory;
    try {
      if (
        !this.member(directory, query.sender) &&
        !fleetDirectoryIntroduces(directory, query.sender, query.admission)
      )
        throw refused();
    } catch {
      throw refused();
    }
    const head = SignedFleetPendingHead.shape.head.parse({
      version: 1,
      queryDigest: fleetPayloadDigest(query),
      destination: this.authority.identity,
      grantId: query.grantId,
      operationId: context.record.operation_id,
      state: context.record.state,
      directory,
    });
    return { head, signature: this.proof.sign("pending-directory-head", head) };
  }
  private validate(push: SignedFleetPendingPush["push"]) {
    const context = this.context(push.grantId, push.operationId),
      digest = fleetPayloadDigest(push);
    if (context.record.state === "complete") {
      this.complete(context, push.sender);
      return {
        context,
        digest,
        complete: true as const,
        accepted: context.directory,
        requested: directoryDigest(push.entries.at(-1)!.document),
      };
    }
    if (context.receipt?.ack.requestDigest === digest) {
      if (
        context.record.state === "cancelled" &&
        context.receipt.ack.state !== "cancelled"
      )
        throw refused();
      return {
        context,
        digest,
        duplicate: context.receipt,
        accepted: context.directory,
        requested: context.receipt.ack.requested,
      };
    }
    if (
      context.record.state !== "prepared" ||
      push.anchor !== directoryDigest(context.directory.document) ||
      // An initial checkpoint must include this ceremony's published revision.
      // Knowing a newer operation UUID cannot retarget older removal history.
      (!context.receipt &&
        push.entries[0].document.mutationId !== context.record.operation_id)
    )
      throw refused();
    let last = context.directory,
      removed: SignedFleetDirectory | undefined;
    for (const entry of push.entries) {
      last = verifyDirectorySuccessor(entry, last.document);
      const member = last.document.members.find(
        (m) => m.machineId === this.authority.identity.machineId,
      );
      if (
        member &&
        (member.publicKey !== this.authority.identity.publicKey ||
          member.grantId !== push.grantId)
      )
        throw refused();
      if (
        !removed &&
        last.document.tombstones.includes(this.authority.identity.machineId)
      )
        removed = last;
    }
    // The original locally approved controller authorizes this chain, including
    // any signed handoff. A relay need not already appear in the checkpoint:
    // accepting a prefix can only advance this inactive consent or cancel it.
    // It never admits the relay or returns unrelated current authority data.
    return {
      context,
      digest,
      accepted: removed ?? last,
      requested: directoryDigest(last.document),
    };
  }
  receive(input: SignedFleetPendingPush): SignedFleetPendingAck {
    const { push, signature } = SignedFleetPendingPush.parse(input);
    if (
      !same(push.destination, this.authority.identity) ||
      push.sender.machineId === this.authority.identity.machineId ||
      !verifyFleetProof(push.sender, "pending-directory-push", push, signature)
    )
      throw refused();
    // Invalid known-operation chains and unknown operation/grant pairs have the
    // same public refusal. Authenticate before acquiring the writer lock.
    try {
      this.validate(push);
    } catch {
      throw refused();
    }
    return this.db
      .transaction(() => {
        const result = this.validate(push),
          { context, accepted, requested, digest } = result;
        if (result.duplicate) return result.duplicate;
        const state = result.complete
          ? "complete"
          : accepted.document.tombstones.includes(
                this.authority.identity.machineId,
              )
            ? "cancelled"
            : "prepared";
        const ack = SignedFleetPendingAck.shape.ack.parse({
          version: 1,
          requestDigest: digest,
          destination: this.authority.identity,
          grantId: push.grantId,
          operationId: context.record.operation_id,
          state,
          requested,
          accepted: directoryDigest(accepted.document),
        });
        const response = {
          ack,
          signature: this.proof.sign("pending-directory-ack", ack),
        };
        if (state === "complete") return response;
        if (state === "cancelled")
          this.db
            .prepare(
              "UPDATE fleet_enrollments SET state='cancelled' WHERE owner_id=? AND role='destination' AND operation_id=? AND state='prepared'",
            )
            .run(this.owner, context.record.operation_id);
        this.db
          .prepare(
            "INSERT INTO fleet_pending_directory(owner_id,operation_id,head,signed,receipt) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,operation_id) DO UPDATE SET head=excluded.head,signed=excluded.signed,receipt=excluded.receipt",
          )
          .run(
            this.owner,
            context.record.operation_id,
            ack.accepted,
            JSON.stringify(accepted),
            JSON.stringify(response),
          );
        return response;
      })
      .immediate();
  }
}
