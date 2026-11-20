import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { VmOperationKind } from "../../shared/vm-state.js";
import * as experimentVmsQueries from "../sql/experiment-vms.js";
import * as vmOperationsQueries from "../sql/vm-operations.js";
import { transitionVm, transitionVmOperation } from "./machine.js";
import { VmProviderError, type VmProvider, type VmStatus } from "./provider.js";

// Every provider call that changes something runs through runVmOperation: a
// receipt is committed before the call and settled from what was observed.
// Nothing here calls the provider a second time. An unobserved outcome is
// kept as "uncertain" until the owner asks for a reconcile.

export type VmOperationOutcome =
  | { state: "succeeded"; result: unknown; replayed: boolean }
  | { state: "failed"; errorMessage: string; replayed: boolean }
  | { state: "uncertain" | "pending"; errorMessage: string | null };

export type VmOperationRefusal =
  /** The id was used for a different request, or belongs to someone else. */
  | "key_conflict"
  /** The experiment does not exist for this owner. */
  | "missing_experiment"
  /** An earlier operation on this experiment is pending or uncertain. */
  | "unsettled_operation";

export class VmOperationRefused extends Error {
  constructor(readonly reason: VmOperationRefusal) {
    super(`VM operation refused: ${reason}`);
    this.name = "VmOperationRefused";
  }
}

/** SHA-256 of the request with object keys sorted, so the same request
 * always has the same digest whatever order its fields were written in. */
export function vmRequestDigest(request: unknown) {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

function stored(
  row: NonNullable<ReturnType<typeof vmOperationsQueries.byId>>,
): VmOperationOutcome {
  if (row.state === "succeeded")
    return {
      state: "succeeded",
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      replayed: true,
    };
  if (row.state === "failed")
    return {
      state: "failed",
      errorMessage: row.error_message ?? "The provider refused the request",
      replayed: true,
    };
  return { state: row.state, errorMessage: row.error_message };
}

/** Runs `call` at most once for `operation.id`. A repeat of the same id and
 * request returns the stored outcome without calling the provider; the same
 * id with a different request is refused. */
export async function runVmOperation(
  db: Database.Database,
  operation: {
    id: string;
    owner: string;
    experimentId: string;
    kind: VmOperationKind;
    request: unknown;
  },
  call: () => Promise<unknown>,
  clock: () => number,
): Promise<VmOperationOutcome> {
  const requestDigest = vmRequestDigest({
    kind: operation.kind,
    experimentId: operation.experimentId,
    request: operation.request,
  });
  const prior = db
    .transaction(() => {
      const existing = vmOperationsQueries.byId(
        db,
        operation.owner,
        operation.id,
      );
      if (existing) {
        if (existing.request_digest !== requestDigest)
          throw new VmOperationRefused("key_conflict");
        return existing;
      }
      if (vmOperationsQueries.idTaken(db, operation.id))
        throw new VmOperationRefused("key_conflict");
      if (
        !experimentVmsQueries.byId(db, operation.owner, operation.experimentId)
      )
        throw new VmOperationRefused("missing_experiment");
      if (
        vmOperationsQueries.unsettledByExperiment(
          db,
          operation.owner,
          operation.experimentId,
        ).length > 0
      )
        throw new VmOperationRefused("unsettled_operation");
      vmOperationsQueries.insertPending(db, {
        id: operation.id,
        owner: operation.owner,
        experimentId: operation.experimentId,
        kind: operation.kind,
        requestDigest,
        now: clock(),
      });
      return undefined;
    })
    .immediate();
  if (prior) return stored(prior);

  const receipt = { owner: operation.owner, id: operation.id };
  try {
    const result = await call();
    transitionVmOperation(db, receipt, "succeeded", { result, now: clock() });
    return { state: "succeeded", result, replayed: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Only an answer from the provider proves the call did nothing. Anything
    // else, including a bug in the adapter, leaves the outcome unknown.
    if (error instanceof VmProviderError && error.outcome === "refused") {
      transitionVmOperation(db, receipt, "failed", {
        errorMessage,
        now: clock(),
      });
      return { state: "failed", errorMessage, replayed: false };
    }
    transitionVmOperation(db, receipt, "uncertain", {
      errorMessage,
      now: clock(),
    });
    return { state: "uncertain", errorMessage };
  }
}

const liveState = {
  provisioning: undefined,
  running: "running",
  sleeping: "sleeping",
  paused: "paused",
  failed: "failed",
  terminating: undefined,
  terminated: "failed",
  unknown: undefined,
} as const satisfies Record<
  VmStatus,
  "running" | "sleeping" | "paused" | "failed" | undefined
>;

export type VmCreateReconciliation =
  | { outcome: "adopted"; remoteId: string }
  | { outcome: "absent" }
  | { outcome: "still_uncertain"; reason: string };

/** Settles an uncertain create or fork by looking for the VM's name. This
 * reads from the provider and never creates: one match is adopted, no match
 * fails the operation so the owner can start a new one, and anything else
 * leaves it uncertain. */
export async function reconcileVmCreate(
  db: Database.Database,
  provider: Pick<VmProvider, "findByName">,
  target: { owner: string; operationId: string; appId: string },
  clock: () => number,
): Promise<VmCreateReconciliation> {
  const operation = vmOperationsQueries.byId(
    db,
    target.owner,
    target.operationId,
  );
  if (
    !operation ||
    operation.state !== "uncertain" ||
    (operation.kind !== "create" && operation.kind !== "fork")
  )
    return { outcome: "still_uncertain", reason: "not an uncertain create" };
  const vm = experimentVmsQueries.byId(
    db,
    target.owner,
    operation.experiment_id,
  );
  if (!vm) return { outcome: "still_uncertain", reason: "experiment missing" };

  let matches: Awaited<ReturnType<VmProvider["findByName"]>>;
  try {
    matches = await provider.findByName(target.appId, vm.remote_name);
  } catch (error) {
    return {
      outcome: "still_uncertain",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (matches.length > 1)
    return {
      outcome: "still_uncertain",
      reason: `${matches.length} VMs are named ${vm.remote_name}`,
    };

  const receipt = { owner: target.owner, id: operation.id };
  const subject = { owner: target.owner, id: vm.id };
  const [match] = matches;
  if (!match) {
    if (
      !transitionVmOperation(db, receipt, "failed", {
        errorMessage: "The provider has no VM with this name",
        now: clock(),
      })
    )
      return { outcome: "still_uncertain", reason: "settled concurrently" };
    transitionVm(db, subject, "failed", {
      expected: "provisioning",
      lastError: "The VM was not created",
      now: clock(),
    });
    return { outcome: "absent" };
  }
  const adopted = db
    .transaction(() => {
      if (
        !experimentVmsQueries.adoptRemote(
          db,
          target.owner,
          vm.id,
          match.remoteId,
        )
      )
        return false;
      return transitionVmOperation(db, receipt, "succeeded", {
        result: { remoteId: match.remoteId },
        now: clock(),
      });
    })
    .immediate();
  if (!adopted)
    return { outcome: "still_uncertain", reason: "settled concurrently" };
  const state = liveState[match.status];
  if (state)
    transitionVm(db, subject, state, {
      expected: "provisioning",
      lastError:
        state === "failed" ? "The provider reports the VM failed" : null,
      now: clock(),
    });
  return { outcome: "adopted", remoteId: match.remoteId };
}
