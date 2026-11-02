import * as fleetEnrollmentInstancesQueries from "./sql/fleet-enrollment-instances.js";
import * as fleetEnrollmentsQueries from "./sql/fleet-enrollments.js";
import * as fleetDistributionQueries from "./sql/fleet-distribution.js";
import * as fleetAdminReservationsQueries from "./sql/fleet-admin-reservations.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, secret } from "../state.js";
import { FleetDigest, SignedFleetDirectory } from "../shared/fleet.js";
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
import {
  StartFleetEnrollment,
  FleetEnrollmentJob,
} from "../shared/fleet-enrollment-source.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { FleetProof, verifyFleetProof } from "./fleet-proof.js";
import type { initializeFleetIdentity } from "./fleet-identity.js";

type Secrets = Parameters<typeof initializeFleetIdentity>[1];
/** The production transport enforces public HTTPS/DNS admission, fixed paths,
 * no redirects/cookies, and bounded bodies/timeouts. */
export interface FleetEnrollmentTransport {
  probe(origin: string, input: FleetEnrollmentProbe): Promise<unknown>;
  prepare(origin: string, input: FleetPrepareEnrollment): Promise<unknown>;
  commit(origin: string, input: SignedFleetEnrollmentCommit): Promise<unknown>;
  receipt(origin: string, input: SignedFleetEnrollmentQuery): Promise<unknown>;
}
const PublicRequest = FleetPrepareEnrollment.omit({ capability: true });
const Row = z.object({
  owner_id: z.string(),
  operation_id: z.string().uuid(),
  role: z.literal("source"),
  request_digest: FleetDigest,
  local_input_digest: FleetDigest,
  request: z.string(),
  capability: z.string().nullable(),
  prepared: z.string().nullable(),
  committed: z.string().nullable(),
  state: FleetEnrollmentJob.shape.state,
  attempt_id: z.string().uuid().nullable(),
  receipt: z.string().nullable(),
  created_at: z.number().int(),
});
const same = (a: unknown, b: unknown) =>
  fleetPayloadDigest(a) === fleetPayloadDigest(b);
const refused = () =>
  new Problem(403, "The destination did not prove the confirmed enrollment.");

/** Controller-owned durable job. All entry points require local device
 * administration; peer callers cannot start, advance or cancel these jobs. */
export class FleetEnrollmentSource {
  private readonly proof: FleetProof;
  private readonly instanceId = randomUUID();
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    private readonly secrets: Secrets,
    private readonly transport: FleetEnrollmentTransport,
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    // Retire callbacks from an earlier process/instance. A replacement may
    // query receipts but cannot infer whether an in-flight effect was sent.
    db.transaction(() => {
      fleetEnrollmentInstancesQueries.install(db, owner, this.instanceId);
      fleetEnrollmentsQueries.recoverSource(db, owner);
    }).immediate();
  }
  private currentInstance() {
    return !!fleetEnrollmentInstancesQueries.exists(
      this.db,
      this.owner,
      this.instanceId,
    );
  }
  private assertCurrentInstance() {
    if (!this.currentInstance())
      throw new Problem(
        409,
        "This controller enrollment instance was replaced.",
      );
  }
  private record(operationId: string) {
    z.string().uuid().parse(operationId);
    const raw = fleetEnrollmentsQueries.source(
      this.db,
      this.owner,
      operationId,
    );
    if (!raw)
      throw new Problem(
        404,
        "Enrollment operation is not recorded on this controller.",
      );
    const row = Row.parse(raw),
      request = PublicRequest.parse(JSON.parse(row.request));
    if (
      request.intent.operationId !== operationId ||
      fleetPayloadDigest(request.intent) !== row.request_digest ||
      !same(
        request.intent.directory.document.controller,
        this.authority.identity,
      ) ||
      !verifyFleetProof(
        this.authority.identity,
        "enrollment-prepare",
        request.intent,
        request.signature,
      )
    )
      throw new Problem(
        409,
        "The stored controller enrollment is inconsistent.",
      );
    const prepared = row.prepared
      ? SignedFleetPreparedEnrollment.parse(JSON.parse(row.prepared))
      : null;
    const committed = row.committed
      ? SignedFleetEnrollmentCommit.parse(JSON.parse(row.committed))
      : null;
    const receipt = row.receipt
      ? SignedFleetEnrollmentReceipt.parse(JSON.parse(row.receipt))
      : null;
    return { row, request, prepared, committed, receipt };
  }
  status(operationId: string): FleetEnrollmentJob {
    const { row, request, committed, receipt } = this.record(operationId),
      intent = request.intent;
    return FleetEnrollmentJob.parse({
      operationId,
      destination: intent.destination,
      name: intent.name,
      origin: intent.origin,
      mode: intent.mode,
      state: row.state,
      phase: committed ? "commit" : "prepare",
      directory: committed
        ? directoryDigest(committed.commit.directory.document)
        : null,
      remoteState: receipt?.receipt.state ?? null,
    });
  }
  list() {
    const rows = fleetEnrollmentsQueries.recentSources(this.db, this.owner) as {
      operation_id: string;
    }[];
    return rows.map((row) => this.status(row.operation_id));
  }
  begin(input: StartFleetEnrollment): FleetEnrollmentJob {
    const value = StartFleetEnrollment.parse(input),
      id = value.operationId;
    this.db
      .transaction(() => {
        this.assertCurrentInstance();
        const prior = fleetEnrollmentsQueries.sourceExists(
          this.db,
          this.owner,
          id,
        );
        if (prior) {
          if (
            this.record(id).row.local_input_digest !== fleetPayloadDigest(value)
          )
            throw new Problem(
              409,
              "Enrollment operation ID belongs to different input.",
            );
          return;
        }
        const current = this.authority.status(this.owner);
        if (current.state !== "controller" || current.head !== value.expected)
          throw new Problem(
            409,
            "Confirm the current directory on its controller before adding a machine.",
          );
        const directory = current.directory!;
        if (
          same(value.link.machine, this.authority.identity) ||
          directory.document.tombstones.includes(
            value.link.machine.machineId,
          ) ||
          value.scope.some((operation) => !value.link.scope.includes(operation))
        )
          throw refused();
        const member = directory.document.members.find(
          (m) => m.machineId === value.link.machine.machineId,
        );
        if (member && member.publicKey !== value.link.machine.publicKey)
          throw refused();
        if (value.mode === "repair" && !member) throw refused();
        if (!member && directory.document.members.length >= 128)
          throw new Problem(409, "The fleet member limit has been reached.");
        if (fleetAdminReservationsQueries.exists(this.db, this.owner))
          throw new Problem(
            409,
            "Resolve the pending enrollment before editing the directory.",
          );
        const intent = FleetEnrollmentIntent.parse({
          version: 1,
          operationId: id,
          ceremonyId: value.link.ceremonyId,
          capabilityHash: hash(value.link.enrollment),
          destination: value.link.machine,
          origin: value.link.origin,
          name: value.name,
          mode: value.mode,
          scope: value.scope,
          directory,
        });
        const request = {
          intent,
          signature: this.proof.sign("enrollment-prepare", intent),
        };
        fleetEnrollmentsQueries.insertSource(
          this.db,
          this.owner,
          id,
          fleetPayloadDigest(intent),
          fleetPayloadDigest(value),
          JSON.stringify(request),
          this.secrets.seal(
            value.link.enrollment,
            `fleet:enrollment:${this.owner}:${id}`,
          ),
          Date.now(),
        );
        fleetAdminReservationsQueries.insert(
          this.db,
          this.owner,
          id,
          value.expected,
        );
      })
      .immediate();
    return this.status(id);
  }
  private validatePrepared(intent: FleetEnrollmentIntent, input: unknown) {
    const value = SignedFleetPreparedEnrollment.parse(input),
      p = value.prepared;
    const known = intent.directory.document.members.find(
      (m) => m.machineId === intent.destination.machineId,
    );
    if (
      p.operationId !== intent.operationId ||
      p.intentDigest !== fleetPayloadDigest(intent) ||
      !verifyFleetProof(
        intent.destination,
        "enrollment-prepared",
        p,
        value.signature,
      ) ||
      p.member.machineId !== intent.destination.machineId ||
      p.member.publicKey !== intent.destination.publicKey ||
      p.member.origin !== intent.origin ||
      p.member.name !== intent.name ||
      p.mode !== intent.mode ||
      !same(p.scope, intent.scope) ||
      (intent.mode === "enroll"
        ? p.expectedHead !== null
        : p.expectedHead === null) ||
      (known && known.grantId !== p.member.grantId)
    )
      throw refused();
    return value;
  }
  private ancestors(
    intent: FleetEnrollmentIntent,
    prepared: SignedFleetPreparedEnrollment,
  ) {
    if (intent.mode !== "repair") return [];
    const result: SignedFleetDirectory[] = [];
    let next: SignedFleetDirectory | undefined = intent.directory;
    while (
      next &&
      directoryDigest(next.document) !== prepared.prepared.expectedHead
    ) {
      if (result.length >= 64)
        throw new Problem(
          409,
          "Synchronize the destination's signed history before address repair.",
        );
      result.push(next);
      next = next.document.parent
        ? this.authority.directory(this.owner, next.document.parent)
        : undefined;
    }
    if (!next)
      throw new Problem(
        409,
        "The destination has an incompatible directory; confirm explicit recovery.",
      );
    return result.reverse();
  }
  private publish(operationId: string) {
    this.db
      .transaction(() => {
        if (!this.currentInstance()) return;
        const record = this.record(operationId),
          { row, request, prepared } = record;
        if (row.state !== "prepared" || !prepared) return;
        const intent = request.intent,
          ancestors = this.ancestors(intent, prepared);
        const existing = intent.directory.document.members.some(
          (m) => m.machineId === intent.destination.machineId,
        );
        const revision = {
          mutationId: operationId,
          expected: directoryDigest(intent.directory.document),
          members: existing
            ? intent.directory.document.members.map((m) =>
                m.machineId === intent.destination.machineId
                  ? prepared.prepared.member
                  : m,
              )
            : [...intent.directory.document.members, prepared.prepared.member],
        };
        const reservation = fleetAdminReservationsQueries.reserveRevision(
          this.db,
          fleetPayloadDigest(revision),
          this.owner,
          operationId,
          revision.expected,
          fleetPayloadDigest(revision),
        );
        if (!reservation.changes)
          throw new Problem(
            409,
            "The enrollment no longer owns directory administration.",
          );
        const directory = this.authority.revise(this.owner, revision);
        const commit = {
          version: 1 as const,
          operationId,
          intentDigest: row.request_digest,
          directory,
          ancestors,
        };
        const committed = SignedFleetEnrollmentCommit.parse({
          commit,
          signature: this.proof.sign("enrollment-commit", commit),
        });
        fleetEnrollmentsQueries.publishSource(
          this.db,
          JSON.stringify(committed),
          this.owner,
          operationId,
        );
        // The canonical revision is now durable. An unavailable destination
        // must not prevent later removals or controller administration. Its
        // uncertain enrollment stays recorded separately from this reservation.
        fleetAdminReservationsQueries.remove(this.db, this.owner, operationId);
        for (const member of directory.document.members) {
          if (member.machineId === this.authority.identity.machineId) continue;
          fleetDistributionQueries.enqueue(
            this.db,
            this.owner,
            member.machineId,
            directoryDigest(directory.document),
          );
        }
      })
      .immediate();
  }
  private validateReceipt(
    record: ReturnType<FleetEnrollmentSource["record"]>,
    input: unknown,
  ) {
    const value = SignedFleetEnrollmentReceipt.parse(input),
      receipt = value.receipt,
      intent = record.request.intent;
    if (
      !verifyFleetProof(
        intent.destination,
        "enrollment-receipt",
        receipt,
        value.signature,
      ) ||
      !same(receipt.destination, intent.destination) ||
      receipt.operationId !== intent.operationId ||
      receipt.intentDigest !== record.row.request_digest
    )
      throw refused();
    this.validatePrepared(intent, receipt.prepared);
    if (record.prepared && !same(record.prepared, receipt.prepared))
      throw refused();
    if (receipt.state === "complete") {
      if (
        !record.committed ||
        receipt.directory !==
          directoryDigest(record.committed.commit.directory.document)
      )
        throw refused();
    } else if (receipt.directory !== null) throw refused();
    return value;
  }
  private applyReceipt(
    operationId: string,
    input: unknown,
    attempt?: string,
    assertAuthorized: () => void = () => {},
  ) {
    this.db
      .transaction(() => {
        assertAuthorized();
        if (!this.currentInstance()) return;
        const record = this.record(operationId);
        if (attempt && record.row.attempt_id !== attempt) return;
        if (["complete", "cancelled"].includes(record.row.state)) return;
        const value = this.validateReceipt(record, input),
          remote = value.receipt.state;
        // A 'prepared' response cannot prove an uncertain commit will never
        // arrive. Preserve both that uncertainty and any live commit callback;
        // only terminal evidence or replacement of this instance retires it.
        const state =
          remote === "prepared"
            ? record.committed
              ? record.row.state
              : "prepared"
            : remote;
        fleetEnrollmentsQueries.sourceReceipt(
          this.db,
          state,
          JSON.stringify(value.receipt.prepared),
          JSON.stringify(value),
          remote === "prepared" && record.committed
            ? record.row.attempt_id
            : null,
          this.owner,
          operationId,
        );
        if (state === "complete" || state === "cancelled")
          fleetAdminReservationsQueries.remove(
            this.db,
            this.owner,
            operationId,
          );
        if (state === "complete")
          fleetDistributionQueries.acknowledge(
            this.db,
            this.owner,
            record.request.intent.destination.machineId,
            value.receipt.directory,
          );
      })
      .immediate();
  }
  async advance(
    operationId: string,
    assertAuthorized: () => void = () => {},
  ): Promise<FleetEnrollmentJob> {
    assertAuthorized();
    if (!this.currentInstance()) return this.status(operationId);
    let record = this.record(operationId);
    if (record.row.state === "ready") {
      const intent = record.request.intent;
      const probe = FleetEnrollmentProbe.parse({
        version: 1,
        nonce: secret(),
        origin: intent.origin,
        destination: intent.destination,
      });
      try {
        const response = SignedFleetEnrollmentProbe.parse(
          await this.transport.probe(intent.origin, probe),
        );
        if (
          !same(response.probe, probe) ||
          !verifyFleetProof(
            intent.destination,
            "enrollment-probe",
            response.probe,
            response.signature,
          )
        )
          throw refused();
      } catch {
        throw new Problem(
          502,
          "The destination could not prove its identity at the confirmed address.",
        );
      }
      assertAuthorized();
      if (!this.currentInstance()) return this.status(operationId);
      const capability = this.secrets.unseal(
          record.row.capability!,
          `fleet:enrollment:${this.owner}:${operationId}`,
        ),
        attempt = randomUUID();
      const claimed = fleetEnrollmentsQueries.claimSource(
        this.db,
        attempt,
        this.owner,
        operationId,
        this.owner,
        this.instanceId,
      );
      if (!claimed.changes) return this.status(operationId);
      try {
        const prepared = this.validatePrepared(
          intent,
          await this.transport.prepare(intent.origin, {
            ...record.request,
            capability,
          }),
        );
        const accepted = fleetEnrollmentsQueries.sourcePrepared(
          this.db,
          JSON.stringify(prepared),
          this.owner,
          operationId,
          attempt,
        );
        // A replacement may have reconciled the same receipt while this
        // callback was in flight. Only the current attempt may continue into
        // publication; reading its replacement's prepared state is not a claim.
        if (!accepted.changes) return this.status(operationId);
      } catch {
        fleetEnrollmentsQueries.sourceUncertain(
          this.db,
          this.owner,
          operationId,
          attempt,
        );
        return this.status(operationId);
      }
      record = this.record(operationId);
    }
    if (record.row.state === "prepared") {
      assertAuthorized();
      this.publish(operationId);
    }
    record = this.record(operationId);
    if (record.row.state === "published") {
      const attempt = randomUUID();
      const claimed = this.db
        .transaction(() => {
          assertAuthorized();
          if (!this.currentInstance()) return false;
          const current = this.authority.status(this.owner),
            intent = record.request.intent;
          const member = current.directory?.document.members.find(
            (m) => m.machineId === intent.destination.machineId,
          );
          if (
            current.state !== "controller" ||
            current.directory?.document.fleetId !==
              intent.directory.document.fleetId ||
            current.directory.document.epoch !==
              intent.directory.document.epoch ||
            !member ||
            member.publicKey !== intent.destination.publicKey ||
            member.grantId !== record.prepared?.prepared.member.grantId ||
            member.origin !== intent.origin
          ) {
            // A local revision superseded this enrollment before its first
            // commit dispatch. Do not send a grant already known to be removed.
            fleetEnrollmentsQueries.cancelPublishedSource(
              this.db,
              this.owner,
              operationId,
            );
            return false;
          }
          return (
            fleetEnrollmentsQueries.claimPublishedSource(
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
        const receipt = await this.transport.commit(
          record.request.intent.origin,
          record.committed!,
        );
        this.applyReceipt(operationId, receipt, attempt, assertAuthorized);
      } catch {
        // The dispatch identity, exact signed payload and uncertain outcome
        // were committed before the wire effect. Only a receipt can settle it.
        fleetEnrollmentsQueries.releaseSource(
          this.db,
          this.owner,
          operationId,
          attempt,
        );
      }
    }
    return this.status(operationId);
  }
  async reconcile(
    operationId: string,
    assertAuthorized: () => void = () => {},
  ): Promise<FleetEnrollmentJob> {
    assertAuthorized();
    if (!this.currentInstance()) return this.status(operationId);
    const record = this.record(operationId);
    if (!["uncertain", "preparing", "published"].includes(record.row.state))
      return this.status(operationId);
    const query = {
      version: 1 as const,
      operationId,
      intentDigest: record.row.request_digest,
      destination: record.request.intent.destination,
    };
    try {
      // Address repair changes routing, not the original operation identity or
      // its proof. Only a canonical entry for the same key can redirect this
      // read; a receipt query never resends the enrollment effect.
      const destination = this.authority
        .directory(this.owner)
        ?.document.members.find(
          (member) =>
            member.machineId === query.destination.machineId &&
            member.publicKey === query.destination.publicKey,
        );
      const receipt = await this.transport.receipt(
        destination?.origin ?? record.request.intent.origin,
        { query, signature: this.proof.sign("enrollment-query", query) },
      );
      assertAuthorized();
      this.applyReceipt(operationId, receipt, undefined, assertAuthorized);
    } catch {
      // A missing receipt or failed read is not proof an effect was absent.
    }
    return this.status(operationId);
  }
  cancel(operationId: string): FleetEnrollmentJob {
    this.db
      .transaction(() => {
        this.assertCurrentInstance();
        const { row, committed } = this.record(operationId);
        if (row.state === "complete")
          throw new Problem(
            409,
            "This enrollment completed. Use directory removal.",
          );
        if (row.state === "uncertain" && committed)
          throw new Problem(
            409,
            "Reconcile the committed effect, or cancel pending consent on the destination first.",
          );
        fleetEnrollmentsQueries.cancelSource(this.db, this.owner, operationId);
        fleetAdminReservationsQueries.remove(this.db, this.owner, operationId);
        // Publication is irreversible: the directory keeps an unconfirmed member
        // until fresh destination consent resumes it or the user removes it.
      })
      .immediate();
    return this.status(operationId);
  }
}
