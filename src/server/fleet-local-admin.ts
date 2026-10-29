import type Database from "better-sqlite3";
import { z } from "zod";
import {
  FleetCapabilities,
  FleetOrigin,
  type SignedFleetDirectory,
} from "../shared/fleet.js";
import {
  FleetAdminState,
  FleetEnrollmentPage,
  FleetHandoffPage,
  FleetOperationCursor,
  FleetPendingPage,
  FleetDeliveryPage,
  fleetAdminApi,
} from "../shared/fleet-admin-api.js";
import {
  FleetPrepareEnrollment,
  SignedFleetPreparedEnrollment,
} from "../shared/fleet-enrollment.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { FleetEnrollmentDestination } from "./fleet-enrollment.js";
import { FleetEnrollmentSource } from "./fleet-enrollment-source.js";
import { FleetPairing } from "./fleet-pairing.js";
import type { FleetHandoffSource } from "./fleet-handoff.js";
import { directoryDigest } from "./fleet-crypto.js";

/** A local-device facade. Its HTTP adapter authenticates the device again after
 * body parsing and before dispatch; the local owner never comes from the wire. */
export class FleetLocalAdmin {
  constructor(
    private readonly db: Database.Database,
    readonly authority: FleetAuthority,
    readonly pairing: FleetPairing,
    readonly source: FleetEnrollmentSource,
    readonly destination: FleetEnrollmentDestination,
    readonly handoff: FleetHandoffSource,
    private readonly owner: string,
    private readonly origin: () => string,
  ) {}
  private lineage() {
    return this.authority.lineage(this.owner);
  }
  deliveries(cursor: string | null) {
    const rows = this.db
      .prepare(
        `
      SELECT d.peer_id,d.directory_digest,d.state,d.attempts
      FROM fleet_distribution d
      JOIN fleet_directory_history h ON h.owner_id=d.owner_id AND h.digest=d.directory_digest
      WHERE d.owner_id=? AND (? IS NULL OR d.peer_id>?)
        AND NOT EXISTS (
          SELECT 1 FROM fleet_distribution newer
          JOIN fleet_directory_history n ON n.owner_id=newer.owner_id AND n.digest=newer.directory_digest
          WHERE newer.owner_id=d.owner_id AND newer.peer_id=d.peer_id AND n.rowid>h.rowid
        )
      ORDER BY d.peer_id LIMIT 51
    `,
      )
      .all(this.owner, cursor, cursor) as {
      peer_id: string;
      directory_digest: string;
      state: string;
      attempts: number;
    }[];
    const lineage = this.lineage();
    return FleetDeliveryPage.parse({
      items: rows.slice(0, 50).map((row) => {
        const directory = this.authority.directory(
          this.owner,
          row.directory_digest,
        )!;
        return {
          peerId: row.peer_id,
          digest: row.directory_digest,
          epoch: directory.document.epoch,
          revision: directory.document.revision,
          state: row.state,
          attempts: row.attempts,
          current: lineage.has(row.directory_digest),
        };
      }),
      next: rows.length > 50 ? rows[49].peer_id : null,
    });
  }
  retryDelivery(input: z.infer<typeof fleetAdminApi.retryDelivery.body>) {
    const value = fleetAdminApi.retryDelivery.body.parse(input);
    this.db
      .transaction(() => {
        const status = this.authority.status(this.owner);
        if (
          status.head !== value.expected ||
          !["controller", "replica"].includes(status.state) ||
          !this.lineage().has(value.digest)
        )
          throw new Problem(
            409,
            "Refresh the current directory before retrying synchronization.",
          );
        const row = this.db
          .prepare(
            "SELECT state FROM fleet_distribution WHERE owner_id=? AND peer_id=? AND directory_digest=?",
          )
          .get(this.owner, value.peerId, value.digest) as
          { state: string } | undefined;
        if (!row) throw new Problem(404, "Directory delivery was not found.");
        if (row.state !== "acked")
          this.db
            .prepare(
              "UPDATE fleet_distribution SET state='pending',next_attempt=0 WHERE owner_id=? AND peer_id=? AND directory_digest=?",
            )
            .run(this.owner, value.peerId, value.digest);
        // Retain the durable packet. Only idempotent signed directory exchange
        // may retry; this endpoint cannot repeat enrollment or an agent effect.
      })
      .immediate();
  }
  state() {
    const current = this.authority.status(this.owner);
    const binding = this.db
      .prepare("SELECT scope,grant_id FROM fleet_binding WHERE owner_id=?")
      .get(this.owner) as { scope: string; grant_id: string } | undefined;
    const consent = binding
      ? (this.db
          .prepare(
            "SELECT previous_head FROM fleet_local_consents WHERE owner_id=? AND grant_id=? AND kind='recover'",
          )
          .get(this.owner, binding.grant_id) as
          { previous_head: string | null } | undefined)
      : undefined;
    const prior = consent?.previous_head
      ? this.authority.directory(this.owner, consent.previous_head)
      : undefined;
    const lineage = this.lineage();
    const pending = this.db
      .prepare(
        "SELECT directory_digest,count(DISTINCT peer_id) n FROM fleet_distribution WHERE owner_id=? AND state<>'acked' GROUP BY directory_digest",
      )
      .all(this.owner) as { directory_digest: string; n: number }[];
    return FleetAdminState.parse({
      identity: this.authority.identity,
      origin: FleetOrigin.parse(this.origin()),
      state: current.state,
      head: current.head,
      directory: current.directory ?? null,
      scope: binding ? FleetCapabilities.parse(JSON.parse(binding.scope)) : [],
      pendingDistribution: pending.reduce(
        (total, row) => total + (lineage.has(row.directory_digest) ? row.n : 0),
        0,
      ),
      unconfirmed:
        current.state !== "removed" && current.directory && prior
          ? prior.document.members.filter(
              (member) =>
                !current.directory!.document.members.some(
                  (known) => known.machineId === member.machineId,
                ) &&
                !current.directory!.document.tombstones.includes(
                  member.machineId,
                ),
            )
          : [],
    });
  }
  private distribute(
    directory: SignedFleetDirectory,
    previous?: SignedFleetDirectory,
  ) {
    // Removed peers remain explicit recipients. Their last address can be found
    // in signed history even though the current roster no longer lists them.
    const peers = new Set(
      [
        ...directory.document.members,
        ...(previous?.document.members ?? []),
      ].map((m) => m.machineId),
    );
    for (const peer of peers) {
      if (peer === this.authority.identity.machineId) continue;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
        )
        .run(this.owner, peer, directoryDigest(directory.document));
    }
  }
  create(input: z.infer<typeof fleetAdminApi.create.body>) {
    const { confirm: _, ...value } = fleetAdminApi.create.body.parse(input);
    this.authority.create(this.owner, {
      ...value,
      origin: FleetOrigin.parse(this.origin()),
    });
    return this.state();
  }
  recover(input: z.infer<typeof fleetAdminApi.recover.body>) {
    const { confirm: _, ...value } = fleetAdminApi.recover.body.parse(input);
    this.authority.recover(this.owner, {
      ...value,
      origin: FleetOrigin.parse(this.origin()),
    });
    return this.state();
  }
  revise(
    input:
      | z.infer<typeof fleetAdminApi.remove.body>
      | z.infer<typeof fleetAdminApi.repairSelf.body>,
  ) {
    const value =
      "machineId" in input
        ? fleetAdminApi.remove.body.parse(input)
        : fleetAdminApi.repairSelf.body.parse(input);
    this.db
      .transaction(() => {
        // Reconstruct the same operation from its confirmed predecessor, even
        // if a later revision arrived after the original response was lost.
        const previous = this.authority.directory(this.owner, value.expected);
        if (!previous)
          throw new Problem(409, "Create or recover a fleet first.");
        const members =
          "machineId" in value
            ? previous.document.members.filter(
                (m) => m.machineId !== value.machineId,
              )
            : previous.document.members.map((m) =>
                m.machineId === this.authority.identity.machineId
                  ? { ...m, origin: FleetOrigin.parse(this.origin()) }
                  : m,
              );
        const directory = this.authority.revise(this.owner, {
          mutationId: value.mutationId,
          expected: value.expected,
          members,
        });
        this.distribute(directory, previous);
      })
      .immediate();
    return this.state();
  }
  mint(input: z.infer<typeof fleetAdminApi.mint.body>) {
    const value = fleetAdminApi.mint.body.parse(input);
    return {
      url: this.pairing.enrollment(
        FleetOrigin.parse(this.origin()),
        value.scope,
        value.recover,
      ).url,
    };
  }
  list(cursor: z.infer<typeof FleetOperationCursor> | null) {
    FleetOperationCursor.nullable().parse(cursor);
    const rows = this.db
      .prepare(
        "SELECT operation_id,created_at FROM fleet_enrollments WHERE owner_id=? AND role='source' AND (? IS NULL OR created_at<? OR (created_at=? AND operation_id<?)) ORDER BY created_at DESC,operation_id DESC LIMIT 51",
      )
      .all(
        this.owner,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.operationId ?? "",
      ) as { operation_id: string; created_at: number }[];
    const shown = rows.slice(0, 50),
      last = shown.at(-1);
    return FleetEnrollmentPage.parse({
      items: shown.map((row) => this.source.status(row.operation_id)),
      next:
        rows.length > 50 && last
          ? { createdAt: last.created_at, operationId: last.operation_id }
          : null,
    });
  }
  handoffs(cursor: z.infer<typeof FleetOperationCursor> | null) {
    FleetOperationCursor.nullable().parse(cursor);
    const rows = this.db
      .prepare(
        "SELECT operation_id,created_at FROM fleet_handoff_jobs WHERE owner_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND operation_id<?)) ORDER BY created_at DESC,operation_id DESC LIMIT 51",
      )
      .all(
        this.owner,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.operationId ?? "",
      ) as { operation_id: string; created_at: number }[];
    const shown = rows.slice(0, 50),
      last = shown.at(-1);
    return FleetHandoffPage.parse({
      items: shown.map((row) => this.handoff.status(row.operation_id)),
      next:
        rows.length > 50 && last
          ? { createdAt: last.created_at, operationId: last.operation_id }
          : null,
    });
  }
  pending(cursor: string | null) {
    z.string().uuid().nullable().parse(cursor);
    const rows = this.db
      .prepare(
        "SELECT operation_id,request,prepared FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND state='prepared' AND (? IS NULL OR operation_id>?) ORDER BY operation_id LIMIT 51",
      )
      .all(this.owner, cursor, cursor) as {
      operation_id: string;
      request: string;
      prepared: string;
    }[];
    const shown = rows.slice(0, 50);
    return FleetPendingPage.parse({
      items: shown.map((row) => {
        const { intent } = FleetPrepareEnrollment.omit({
          capability: true,
        }).parse(JSON.parse(row.request));
        const { prepared } = SignedFleetPreparedEnrollment.parse(
          JSON.parse(row.prepared),
        );
        return {
          operationId: row.operation_id,
          controller: intent.directory.document.controller,
          fleetId: intent.directory.document.fleetId,
          mode: prepared.mode,
          scope: prepared.scope,
        };
      }),
      next: rows.length > 50 ? shown.at(-1)!.operation_id : null,
    });
  }
}
