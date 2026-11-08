import * as fleetCommandReceiptsQueries from "./sql/fleet-command-receipts.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { FleetGrantContext } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { fleetPayloadDigest } from "./fleet-crypto.js";
import { ExecutionRefused } from "./execution-refusal.js";

const ReceiptRow = z.object({
  fleet_id: z.string(),
  grant_id: z.string(),
  operation: z.string(),
  payload_digest: z.string(),
  command_tag: z.string(),
  state: z.enum(["started", "completed", "unknown", "refused"]),
  result: z.string().nullable(),
});
export type FleetCommandReceipt = {
  commandId: string;
  state: "started" | "completed" | "unknown" | "refused";
  // A compacted completed receipt retains its identity, never replays its effect.
  result: unknown | null;
};

/** Destination-owned receipts wrap, rather than replace, native command/run
 * identities. The caller passes the original command ID to the existing handler.
 * The authenticated peer boundary supplies context; request data cannot pick an
 * owner. No durable payload/credential is retained here, only a canonical digest. */
export class FleetCommands {
  private readonly inflight = new Map<string, Promise<FleetCommandReceipt>>();
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly admission: { limit: number; status: 429 | 503 } = {
      limit: 64,
      status: 429,
    },
  ) {}

  private row(owner: string, commandId: string) {
    const row = fleetCommandReceiptsQueries.get(this.db, owner, commandId);
    return row ? ReceiptRow.parse(row) : undefined;
  }

  private view(
    commandId: string,
    row: z.infer<typeof ReceiptRow>,
  ): FleetCommandReceipt {
    return {
      commandId,
      state: row.state,
      result: row.result === null ? null : JSON.parse(row.result),
    };
  }

  receipt(
    input: FleetGrantContext,
    commandId: string,
    expectedDigest?: string,
    expectedTag?: string,
  ): FleetCommandReceipt | null {
    const context = FleetGrantContext.parse(input);
    z.string().uuid().parse(commandId);
    const { owner } = this.authority.authorize(context);
    const row = this.row(owner, commandId);
    if (!row) return null;
    if (
      row.fleet_id !== context.fleetId ||
      row.grant_id !== context.grantId ||
      row.operation !== context.operation ||
      (expectedDigest !== undefined && row.payload_digest !== expectedDigest) ||
      (expectedTag !== undefined && row.command_tag !== expectedTag)
    )
      throw new Problem(
        409,
        "Fleet command belongs to another authorization context.",
      );
    return this.observed(owner, commandId, row);
  }

  /** Reconciliation retires an absent action atomically with checking for its
   * receipt. A delayed transport can now only observe this refusal, never run.
   * Existing started/unknown effects remain uncertain and are never retired. */
  reconcile(
    input: FleetGrantContext,
    commandId: string,
    digest: string,
    tag: string,
  ): FleetCommandReceipt {
    const context = FleetGrantContext.parse(input);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(digest);
    z.string().min(1).max(100).parse(tag);
    if (!["act", "files"].includes(context.operation))
      throw new Problem(400, "Only workspace actions use this reconciliation.");
    return this.db
      .transaction(() => {
        const prior = this.receipt(context, commandId, digest, tag);
        if (prior) return prior;
        const { owner } = this.authority.authorize(context);
        const now = Date.now();
        fleetCommandReceiptsQueries.refuse(
          this.db,
          owner,
          context.peer,
          commandId,
          context.fleetId,
          context.grantId,
          context.operation,
          digest,
          now,
          now,
          tag,
        );
        return { commandId, state: "refused" as const, result: null };
      })
      .immediate();
  }

  /** Only a local owner facade may call this. It has no peer grant alternative:
   * a paired user can inspect their own work even after leaving the fleet. */
  localReceipt(
    owner: string,
    commandId: string,
    digest: string,
    tag: string,
    operation: "act" | "files" = "act",
  ): FleetCommandReceipt | null {
    z.string().uuid().parse(commandId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(digest);
    const row = this.row(owner, commandId);
    if (!row) return null;
    if (
      row.operation !== operation ||
      row.payload_digest !== digest ||
      row.command_tag !== tag
    )
      throw new Problem(
        409,
        "This receipt belongs to a different command or action.",
      );
    return this.observed(owner, commandId, row);
  }
  private observed(
    owner: string,
    commandId: string,
    row: z.infer<typeof ReceiptRow>,
  ): FleetCommandReceipt {
    const key = JSON.stringify([owner, commandId]);
    // A surviving process may still be executing this request. A different
    // process cannot infer whether its external effect happened, even if the
    // original process has died. Reporting unknown never starts it again.
    if (row.state === "started" && !this.inflight.has(key))
      return { commandId, state: "unknown", result: null };
    return this.view(commandId, row);
  }

  async execute(
    input: FleetGrantContext,
    commandId: string,
    request: unknown,
    output: z.ZodType,
    apply: (owner: string, originalCommandId: string) => Promise<unknown>,
    tag: string,
  ): Promise<FleetCommandReceipt> {
    const context = FleetGrantContext.parse(input);
    z.string().uuid().parse(commandId);
    z.string().min(1).max(100).parse(tag);
    if (!["act", "mail", "files"].includes(context.operation))
      throw new Problem(400, "This fleet operation is not a mutation.");
    const digest = fleetPayloadDigest(request);
    const { owner, prior } = this.db
      .transaction(() => {
        const { owner } = this.authority.authorize(context);
        const prior = this.row(owner, commandId);
        if (prior) {
          if (
            prior.fleet_id !== context.fleetId ||
            prior.grant_id !== context.grantId ||
            prior.operation !== context.operation ||
            prior.payload_digest !== digest ||
            prior.command_tag !== tag
          )
            throw new Problem(
              409,
              "Fleet command ID belongs to different input or authorization.",
            );
        } else {
          if (this.inflight.size >= this.admission.limit)
            throw new Problem(
              this.admission.status,
              "Fleet commands are busy. Retry later.",
            );
          const now = Date.now();
          fleetCommandReceiptsQueries.start(
            this.db,
            owner,
            context.peer,
            commandId,
            context.fleetId,
            context.grantId,
            context.operation,
            digest,
            now,
            now,
            tag,
          );
        }
        return { owner, prior };
      })
      .immediate();
    const key = JSON.stringify([owner, commandId]);
    if (prior) {
      const current = this.inflight.get(key);
      if (current) return current;
      if (prior.state === "completed" || prior.state === "refused")
        return this.view(commandId, prior);
      return { commandId, state: "unknown", result: null };
    }
    const promise = Promise.resolve()
      .then(async (): Promise<FleetCommandReceipt> => {
        let dispatched = false;
        try {
          // This is the final local grant check immediately before invoking the
          // owning handler, which must still check native decision generation.
          this.authority.acceptedGrant(
            owner,
            context.peer,
            context.fleetId,
            context.grantId,
            context.operation,
          );
          dispatched = true;
          // Use the owning public route's response projection, never a raw
          // native result. Unknown private fields are stripped before storage.
          const result = output.parse(await apply(owner, commandId));
          const json = JSON.stringify(result ?? null);
          const saved = Buffer.byteLength(json) <= 64 * 1024 ? json : null;
          this.db
            .transaction(() => {
              fleetCommandReceiptsQueries.complete(
                this.db,
                saved,
                Date.now(),
                owner,
                context.peer,
                commandId,
              );
              // Retain at most 64 bounded response bodies per local owner. Durable
              // identity tombstones remain, including failures and compacted results.
              fleetCommandReceiptsQueries.pruneResults(this.db, owner, owner);
            })
            .immediate();
          return {
            commandId,
            state: "completed" as const,
            result: saved === null ? null : JSON.parse(saved),
          };
        } catch (error) {
          const state =
            !dispatched || error instanceof ExecutionRefused
              ? "refused"
              : "unknown";
          fleetCommandReceiptsQueries.finish(
            this.db,
            state,
            Date.now(),
            owner,
            context.peer,
            commandId,
          );
          // Do not persist or relay provider errors, request secrets, or raw native
          // responses. A failure after dispatch may have performed the effect.
          return { commandId, state, result: null };
        }
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
