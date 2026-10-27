import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FleetCapabilities,
  FleetDigest,
  SignedFleetDirectory,
} from "../shared/fleet.js";
import {
  FleetEnrollmentIntent,
  FleetEnrollmentProbe,
  FleetPrepareEnrollment,
  SignedFleetEnrollmentProbe,
  SignedFleetPreparedEnrollment,
  SignedFleetEnrollmentCommit,
  SignedFleetEnrollmentQuery,
  SignedFleetEnrollmentReceipt,
} from "../shared/fleet-enrollment.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { FleetPairing } from "./fleet-pairing.js";
import { FleetProof, verifyFleetProof } from "./fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
  verifyApprovedDirectory,
  verifyDirectorySuccessor,
} from "./fleet-crypto.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

const PublicRequest = FleetPrepareEnrollment.omit({ capability: true });
const Record = z.object({
  owner_id: z.string(),
  operation_id: z.string().uuid(),
  role: z.literal("destination"),
  request_digest: FleetDigest,
  request: z.string(),
  capability: z.null(),
  prepared: z.string(),
  committed: z.string().nullable(),
  state: z.enum(["prepared", "complete", "cancelled"]),
});
const refused = () =>
  new Problem(403, "Fleet enrollment proof or local consent is invalid.");
const same = (a: unknown, b: unknown) =>
  fleetPayloadDigest(a) === fleetPayloadDigest(b);

/** Destination half of the two-phase enrollment protocol. Preparation consumes
 * the local ceremony with a pending grant; only a committed signed revision
 * activates it. No request accepts the controller's local owner or a cookie. */
export class FleetEnrollmentDestination {
  private readonly proof: FleetProof;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly pairing: FleetPairing,
    private readonly owner: string,
    secrets: Parameters<typeof initializeFleetIdentity>[1],
    private readonly origin: () => string,
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
  }
  private record(operationId: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND operation_id=?",
      )
      .get(this.owner, operationId);
    // Peer callers must authenticate the recorded operation before learning
    // anything about it; unknown and unauthorized operations are both refused.
    if (!row) throw refused();
    const record = Record.parse(row);
    const request = PublicRequest.parse(JSON.parse(record.request));
    const prepared = SignedFleetPreparedEnrollment.parse(
      JSON.parse(record.prepared),
    );
    if (
      fleetPayloadDigest(request.intent) !== record.request_digest ||
      prepared.prepared.intentDigest !== record.request_digest ||
      prepared.prepared.operationId !== operationId ||
      !verifyFleetProof(
        this.authority.identity,
        "enrollment-prepared",
        prepared.prepared,
        prepared.signature,
      )
    )
      throw new Problem(409, "The stored enrollment receipt is inconsistent.");
    return { record, request, prepared };
  }

  /** Prove this origin's identity before the controller sends a capability.
   * The caller supplies a fresh nonce and verifies the exact signed response. */
  probe(input: FleetEnrollmentProbe): SignedFleetEnrollmentProbe {
    const probe = FleetEnrollmentProbe.parse(input);
    if (
      !same(probe.destination, this.authority.identity) ||
      probe.origin !== this.origin()
    )
      throw refused();
    return {
      probe,
      signature: this.proof.sign("enrollment-probe", probe),
    };
  }

  prepare(input: FleetPrepareEnrollment): SignedFleetPreparedEnrollment {
    const value = FleetPrepareEnrollment.parse(input),
      intent = value.intent;
    const directory = verifyApprovedDirectory(intent.directory),
      controller = directory.document.controller;
    if (
      !same(intent.destination, this.authority.identity) ||
      intent.origin !== this.origin() ||
      controller.machineId === this.authority.identity.machineId ||
      intent.capabilityHash !==
        createHash("sha256").update(value.capability).digest("hex") ||
      !verifyFleetProof(
        controller,
        "enrollment-prepare",
        intent,
        value.signature,
      )
    )
      throw refused();
    const digest = fleetPayloadDigest(intent);
    const result = this.pairing.consumeEnrollment(
      {
        ceremonyId: intent.ceremonyId,
        secret: value.capability,
        origin: intent.origin,
        operationId: intent.operationId,
        request: intent,
      },
      SignedFleetPreparedEnrollment,
      (consent) => {
        const local = this.authority.status(this.owner);
        if (
          consent.expectedHead !== local.head ||
          consent.mode !== intent.mode ||
          intent.scope.some((operation) => !consent.scope.includes(operation))
        )
          throw refused();
        if (local.state === "handoff_pending")
          throw new Problem(
            409,
            "Resolve the prepared controller handoff before enrolling.",
          );
        let grantId: string = randomUUID();
        if (intent.mode === "enroll") {
          if (local.head) throw refused();
        } else {
          if (
            !local.directory ||
            local.directory.document.fleetId !== directory.document.fleetId
          )
            throw refused();
          if (intent.mode === "repair") {
            const previous = local.directory.document,
              member = previous.members.find(
                (m) => m.machineId === this.authority.identity.machineId,
              ),
              advertised = directory.document.members.find(
                (m) => m.machineId === this.authority.identity.machineId,
              );
            const binding = this.db
              .prepare("SELECT scope FROM fleet_binding WHERE owner_id=?")
              .get(this.owner) as { scope: string } | undefined;
            if (
              !member ||
              !advertised ||
              !binding ||
              member.grantId !== advertised.grantId ||
              !same(previous.controller, controller) ||
              !same(
                FleetCapabilities.parse(JSON.parse(binding.scope)),
                intent.scope,
              )
            )
              throw refused();
            grantId = member.grantId;
          } else if (directory.document.epoch < 1) throw refused();
        }
        if (intent.mode !== "repair") {
          const advertised = directory.document.members.find(
            (m) => m.machineId === this.authority.identity.machineId,
          );
          if (advertised) {
            // A controller can have published its revision before this machine
            // cancelled or lost the commit. Fresh local consent may finish that
            // enrollment with the never-activated grant we originally issued.
            // A controller-provided UUID alone can never establish this fact.
            const pending = this.db
              .prepare(
                "SELECT operation_id FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND state IN ('prepared','cancelled') AND json_extract(prepared,'$.prepared.member.grantId')=?",
              )
              .all(this.owner, advertised.grantId) as {
              operation_id: string;
            }[];
            const issuedHere = pending.some(({ operation_id }) => {
              const prior = this.record(operation_id);
              // This is provenance of an inactive grant, not reuse of the old
              // consent. The freshly consumed ceremony pins today's local head
              // and scope even if synchronization invalidated the earlier one.
              return (
                prior.request.intent.mode === intent.mode &&
                prior.request.intent.directory.document.fleetId ===
                  directory.document.fleetId &&
                same(
                  prior.request.intent.directory.document.controller,
                  controller,
                ) &&
                prior.prepared.prepared.member.machineId ===
                  advertised.machineId &&
                prior.prepared.prepared.member.publicKey ===
                  advertised.publicKey
              );
            });
            if (
              !issuedHere ||
              this.db
                .prepare(
                  "SELECT 1 FROM fleet_local_consents WHERE owner_id=? AND grant_id=?",
                )
                .get(this.owner, advertised.grantId)
            )
              throw refused();
            grantId = advertised.grantId;
          }
        }
        if (
          directory.document.tombstones.includes(
            this.authority.identity.machineId,
          )
        )
          throw new Problem(
            409,
            "This identity is removed from the controller's directory.",
          );
        const prepared: SignedFleetPreparedEnrollment["prepared"] = {
          version: 1,
          operationId: intent.operationId,
          intentDigest: digest,
          member: {
            ...this.authority.identity,
            grantId,
            name: intent.name,
            origin: intent.origin,
          },
          expectedHead: local.head,
          mode: intent.mode,
          scope: intent.scope,
        };
        const result = SignedFleetPreparedEnrollment.parse({
          prepared,
          signature: this.proof.sign("enrollment-prepared", prepared),
        });
        // A freshly redeemed local ceremony supersedes earlier pending
        // consent. Its scope/controller cannot race an older delayed commit.
        this.db
          .prepare(
            "UPDATE fleet_enrollments SET state='cancelled' WHERE owner_id=? AND role='destination' AND state='prepared'",
          )
          .run(this.owner);
        this.db
          .prepare(
            "INSERT INTO fleet_enrollments(owner_id,operation_id,role,request_digest,request,capability,prepared,committed,state) VALUES(?,?,'destination',?,?,NULL,?,NULL,'prepared')",
          )
          .run(
            this.owner,
            intent.operationId,
            digest,
            JSON.stringify({ intent, signature: value.signature }),
            JSON.stringify(result),
          );
        return result;
      },
    );
    if (this.record(intent.operationId).record.state === "cancelled")
      throw new Problem(
        409,
        "The destination cancelled this enrollment. Mint a fresh code.",
      );
    return result;
  }

  /** A signed receipt query reconciles a lost response; it never retries an
   * external grant effect or changes an accepted directory. */
  receipt(input: SignedFleetEnrollmentQuery): SignedFleetEnrollmentReceipt {
    const value = SignedFleetEnrollmentQuery.parse(input),
      query = value.query;
    const { record, request, prepared } = this.record(query.operationId);
    if (
      !same(query.destination, this.authority.identity) ||
      query.intentDigest !== record.request_digest ||
      !verifyFleetProof(
        request.intent.directory.document.controller,
        "enrollment-query",
        query,
        value.signature,
      )
    )
      throw refused();
    const receipt: SignedFleetEnrollmentReceipt["receipt"] = {
      version: 1,
      operationId: query.operationId,
      intentDigest: record.request_digest,
      destination: this.authority.identity,
      state: record.state,
      prepared,
      directory: record.committed
        ? directoryDigest(
            SignedFleetDirectory.parse(JSON.parse(record.committed)).document,
          )
        : null,
    };
    return {
      receipt,
      signature: this.proof.sign("enrollment-receipt", receipt),
    };
  }

  commit(input: SignedFleetEnrollmentCommit): SignedFleetEnrollmentReceipt {
    const value = SignedFleetEnrollmentCommit.parse(input),
      commit = value.commit;
    return this.db
      .transaction(() => {
        const { record, request, prepared } = this.record(commit.operationId),
          intent = request.intent;
        if (
          commit.intentDigest !== record.request_digest ||
          !verifyFleetProof(
            intent.directory.document.controller,
            "enrollment-commit",
            commit,
            value.signature,
          )
        )
          throw refused();
        if (record.state === "cancelled")
          throw new Problem(
            409,
            "The destination cancelled this enrollment. Mint a fresh code.",
          );
        const signed = verifyDirectorySuccessor(
          commit.directory,
          intent.directory.document,
        );
        const expected = intent.directory.document.members.filter(
          (m) => m.machineId !== this.authority.identity.machineId,
        );
        // Preserve the old position for repairs and resumed pending members;
        // order is signed content.
        const members = intent.directory.document.members.some(
          (m) => m.machineId === this.authority.identity.machineId,
        )
          ? intent.directory.document.members.map((m) =>
              m.machineId === this.authority.identity.machineId
                ? prepared.prepared.member
                : m,
            )
          : [...expected, prepared.prepared.member];
        if (
          signed.document.mutationId !== commit.operationId ||
          !same(signed.document.members, members) ||
          !same(
            signed.document.tombstones,
            intent.directory.document.tombstones,
          )
        )
          throw refused();
        if (record.state === "complete") {
          if (!same(JSON.parse(record.committed!), signed))
            throw new Problem(
              409,
              "Enrollment operation was committed to another directory.",
            );
        } else {
          // Preparing a handoff fences this authority without changing its
          // directory head. A previously prepared enrollment must not replace
          // that newer local decision merely because its head still matches.
          if (this.authority.status(this.owner).state === "handoff_pending")
            throw new Problem(
              409,
              "Resolve the prepared controller handoff before committing enrollment.",
            );
          if (intent.mode === "repair") {
            // Ordinary signed synchronization can arrive before this commit.
            // It must not invalidate a repair within the same local binding;
            // a new local consent, authority or removal still fences it.
            const assertBinding = () => {
              const current = this.authority.directory(this.owner)?.document;
              const member = current?.members.find(
                (m) => m.machineId === this.authority.identity.machineId,
              );
              const binding = this.db
                .prepare("SELECT scope FROM fleet_binding WHERE owner_id=?")
                .get(this.owner) as { scope: string } | undefined;
              if (
                !current ||
                !member ||
                !binding ||
                current.fleetId !== intent.directory.document.fleetId ||
                !same(
                  current.controller,
                  intent.directory.document.controller,
                ) ||
                current.epoch !== intent.directory.document.epoch ||
                member.grantId !== prepared.prepared.member.grantId ||
                !same(
                  FleetCapabilities.parse(JSON.parse(binding.scope)),
                  prepared.prepared.scope,
                )
              )
                throw refused();
            };
            assertBinding();
            // The supplied history is exactly the prefix between the prepared
            // local head and the intent, never this repair or a later change.
            // Validate it before changing local authority state.
            let previous = prepared.prepared.expectedHead
              ? this.authority.directory(
                  this.owner,
                  prepared.prepared.expectedHead,
                )?.document
              : undefined;
            if (!previous) throw refused();
            const intendedHead = directoryDigest(intent.directory.document);
            for (const ancestor of commit.ancestors) {
              if (directoryDigest(previous) === intendedHead) throw refused();
              previous = verifyDirectorySuccessor(ancestor, previous).document;
            }
            if (directoryDigest(previous) !== intendedHead)
              throw new Problem(
                409,
                "Synchronize the signed directory before completing address repair.",
              );
            for (const ancestor of commit.ancestors)
              this.authority.accept(this.owner, ancestor);
            assertBinding();
            if (
              this.authority.status(this.owner).head !==
                directoryDigest(intent.directory.document) &&
              !this.authority.directory(
                this.owner,
                directoryDigest(signed.document),
              )
            )
              throw new Problem(
                409,
                "Synchronize the signed directory before completing address repair.",
              );
            this.authority.accept(this.owner, signed);
          } else {
            if (
              this.authority.status(this.owner).head !==
              prepared.prepared.expectedHead
            )
              throw new Problem(
                409,
                "The destination directory changed after enrollment preparation.",
              );
            if (commit.ancestors.length) throw refused();
            this.authority.approve(this.owner, {
              mutationId: intent.operationId,
              expected: prepared.prepared.expectedHead,
              kind: intent.mode,
              grantId: prepared.prepared.member.grantId,
              scope: prepared.prepared.scope,
              controller: intent.directory.document.controller,
              directory: signed,
            });
          }
          this.db
            .prepare(
              "UPDATE fleet_enrollments SET state='complete',committed=? WHERE owner_id=? AND role='destination' AND operation_id=?",
            )
            .run(JSON.stringify(signed), this.owner, commit.operationId);
        }
        const receipt: SignedFleetEnrollmentReceipt["receipt"] = {
          version: 1,
          operationId: commit.operationId,
          intentDigest: record.request_digest,
          destination: this.authority.identity,
          state: "complete",
          prepared,
          directory: directoryDigest(signed.document),
        };
        return {
          receipt,
          signature: this.proof.sign("enrollment-receipt", receipt),
        };
      })
      .immediate();
  }

  /** Explicit destination-device cancellation; a spent code remains spent. */
  cancel(operationId: string) {
    z.string().uuid().parse(operationId);
    this.db
      .transaction(() => {
        const { record } = this.record(operationId);
        if (record.state === "complete")
          throw new Problem(
            409,
            "This enrollment is already committed. Use directory removal.",
          );
        this.db
          .prepare(
            "UPDATE fleet_enrollments SET state='cancelled' WHERE owner_id=? AND role='destination' AND operation_id=? AND state='prepared'",
          )
          .run(this.owner, operationId);
      })
      .immediate();
  }
}
