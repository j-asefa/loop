import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  legalVmTransition,
  type VmOperationKind,
  type VmState,
} from "../../shared/vm-state.js";
import * as experimentVmsQueries from "../sql/experiment-vms.js";
import * as vmOperationsQueries from "../sql/vm-operations.js";
import {
  VM_OPERATION_MAX_CALL_MS,
  transitionVm,
  transitionVmOperation,
} from "./machine.js";
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

/** The request with object keys sorted, so the same request always has the
 * same text, and so the same digest, whatever order its fields were in. */
export function canonicalVmRequest(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalVmRequest).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalVmRequest(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** SHA-256 of the canonical request. */
export function vmRequestDigest(request: unknown) {
  return createHash("sha256").update(canonicalVmRequest(request)).digest("hex");
}

type OperationRow = NonNullable<ReturnType<typeof vmOperationsQueries.byId>>;

function stored(row: OperationRow): VmOperationOutcome {
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
 * id with a different request is refused. The receipt is the record: when a
 * reconcile settled it while the call was still out, the stored outcome is
 * returned, not the late answer. */
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
  effects: VmOperationEffects = {},
): Promise<VmOperationOutcome> {
  const requestJson = canonicalVmRequest(operation.request);
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
        requestJson,
        now: clock(),
      });
      return undefined;
    })
    .immediate();
  if (prior) return stored(prior);

  const receipt = { owner: operation.owner, id: operation.id };
  const current = () =>
    stored(vmOperationsQueries.byId(db, receipt.owner, receipt.id)!);
  let result: unknown;
  try {
    result = await call();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Only an answer from the provider proves the call did nothing. Anything
    // else, including a bug in the adapter, leaves the outcome unknown.
    const to =
      error instanceof VmProviderError && error.outcome === "refused"
        ? "failed"
        : "uncertain";
    if (!transitionVmOperation(db, receipt, to, { errorMessage, now: clock() }))
      return current();
    return to === "failed"
      ? { state: "failed", errorMessage, replayed: false }
      : { state: "uncertain", errorMessage };
  }
  const errorMessage = effects.failure?.(result) ?? null;
  const to = errorMessage === null ? "succeeded" : "failed";
  // The receipt and the local record of what the call did commit together.
  // If apply throws, both roll back and the receipt stays pending until the
  // sweep marks it uncertain for a reconcile.
  const settled = db
    .transaction(() => {
      if (
        !transitionVmOperation(db, receipt, to, {
          result,
          errorMessage,
          now: clock(),
        })
      )
        return false;
      effects.apply?.(result);
      return true;
    })
    .immediate();
  if (!settled) return current();
  return errorMessage === null
    ? { state: "succeeded", result, replayed: false }
    : { state: "failed", errorMessage, replayed: false };
}

/** What a resolved call means locally. */
export type VmOperationEffects = {
  /** A failure the answer itself reports, such as a VM that booted into
   * "failed"; null when the call did what was asked. */
  failure?(result: unknown): string | null;
  /** Local writes that must commit with the settled receipt. Runs inside
   * its transaction. */
  apply?(result: unknown): void;
};

type CreatedVm = { remoteId: string; status: VmStatus; errorMessage?: string };

/** Effects for a create or fork: the VM's provider id and observed state
 * commit with the receipt, and a VM that booted into "failed" fails it. */
export function createdVmEffects(
  db: Database.Database,
  vm: { owner: string; id: string },
  clock: () => number,
): VmOperationEffects {
  return {
    failure: (result) =>
      (result as CreatedVm).status === "failed"
        ? ((result as CreatedVm).errorMessage ??
          "The provider reports the VM failed")
        : null,
    apply: (result) => {
      const created = result as CreatedVm;
      if (
        !experimentVmsQueries.adoptRemote(db, vm.owner, vm.id, created.remoteId)
      )
        throw new Error("The experiment already records another provider VM");
      const row = experimentVmsQueries.byId(db, vm.owner, vm.id);
      if (row)
        applyObservedStatus(
          db,
          { ...vm, state: row.state },
          created.status,
          clock(),
          created.errorMessage,
        );
    },
  };
}

/** Moves the VM to the state the provider reports, when that edge is legal
 * from where it is. Call inside the transaction that settles the receipt. */
function applyObservedStatus(
  db: Database.Database,
  vm: { owner: string; id: string; state: VmState },
  status: VmStatus,
  now: number,
  reason?: string,
) {
  const observed: Record<VmStatus, VmState | undefined> = {
    provisioning: undefined,
    running: "running",
    sleeping: "sleeping",
    paused: "paused",
    failed: "failed",
    terminating: undefined,
    terminated: vm.state === "destroying" ? "destroyed" : "failed",
    unknown: undefined,
  };
  let to = observed[status];
  // A destroy that did not finish leaves a VM the owner must destroy again;
  // failed is the state that allows it.
  if (to && vm.state === "destroying" && to !== "destroyed") to = "failed";
  if (!to || to === vm.state || !legalVmTransition(vm.state, to)) return;
  transitionVm(db, vm, to, {
    expected: vm.state,
    lastError:
      to === "failed"
        ? (reason ??
          (vm.state === "destroying"
            ? `The destroy did not finish; the provider reports the VM ${status}`
            : `The provider reports the VM ${status}`))
        : null,
    now,
  });
}

export type VmReconciliation =
  | { outcome: "succeeded"; result: unknown }
  | { outcome: "failed"; errorMessage: string }
  | { outcome: "still_uncertain"; reason: string };

// `notYet`: the provider shows the effect did not happen. The original call
// may still be in flight until the longest provider call has passed, so such
// an observation settles nothing before then.
type Observation =
  | { settle: "succeeded"; result: unknown; status?: VmStatus }
  | {
      settle: "failed";
      errorMessage: string;
      status?: VmStatus;
      result?: unknown;
      notYet?: true;
    }
  | { settle: "unknown"; reason: string };

class SettledConcurrently extends Error {}

const unsure = (reason: string): Observation => ({ settle: "unknown", reason });

/** Observes the outcome of the owner's uncertain operation and settles it.
 * This only reads from the provider: nothing is created, sent or retried.
 * The receipt and the VM's observed state are written in one transaction,
 * and only while the receipt is still uncertain. */
export async function reconcileVmOperation(
  db: Database.Database,
  provider: Pick<VmProvider, "findByName" | "get" | "getHttpPort">,
  target: { owner: string; operationId: string; appId: string },
  clock: () => number,
): Promise<VmReconciliation> {
  const operation = vmOperationsQueries.byId(
    db,
    target.owner,
    target.operationId,
  );
  if (!operation || operation.state !== "uncertain")
    return { outcome: "still_uncertain", reason: "not an uncertain operation" };
  const vm = experimentVmsQueries.byId(
    db,
    target.owner,
    operation.experiment_id,
  );
  if (!vm) return { outcome: "still_uncertain", reason: "experiment missing" };

  let observation: Observation;
  try {
    observation = await observe(provider, operation, vm, target.appId);
  } catch (error) {
    observation = unsure(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (observation.settle === "unknown")
    return { outcome: "still_uncertain", reason: observation.reason };
  if (
    observation.settle === "failed" &&
    observation.notYet &&
    clock() - operation.created_at <= VM_OPERATION_MAX_CALL_MS
  )
    return {
      outcome: "still_uncertain",
      reason: "the original call may still be in flight",
    };
  const seen = observation;

  const receipt = { owner: target.owner, id: operation.id };
  try {
    db.transaction(() => {
      const fresh = experimentVmsQueries.byId(db, target.owner, vm.id);
      if (!fresh) throw new SettledConcurrently();
      const settled =
        seen.settle === "succeeded"
          ? transitionVmOperation(db, receipt, "succeeded", {
              result: seen.result,
              now: clock(),
            })
          : transitionVmOperation(db, receipt, "failed", {
              result: seen.result,
              errorMessage: seen.errorMessage,
              now: clock(),
            });
      if (!settled) throw new SettledConcurrently();
      const adopted =
        (operation.kind === "create" || operation.kind === "fork") &&
        (seen.result as { remoteId?: unknown } | undefined)?.remoteId;
      if (typeof adopted === "string") {
        if (!experimentVmsQueries.adoptRemote(db, target.owner, vm.id, adopted))
          throw new SettledConcurrently();
      }
      if (seen.status)
        applyObservedStatus(
          db,
          { owner: target.owner, id: vm.id, state: fresh.state },
          seen.status,
          clock(),
        );
    }).immediate();
  } catch (error) {
    if (error instanceof SettledConcurrently)
      return { outcome: "still_uncertain", reason: "settled concurrently" };
    throw error;
  }
  return seen.settle === "succeeded"
    ? { outcome: "succeeded", result: seen.result }
    : { outcome: "failed", errorMessage: seen.errorMessage };
}

async function observe(
  provider: Pick<VmProvider, "findByName" | "get" | "getHttpPort">,
  operation: OperationRow,
  vm: NonNullable<ReturnType<typeof experimentVmsQueries.byId>>,
  appId: string,
): Promise<Observation> {
  if (operation.kind === "create" || operation.kind === "fork") {
    const matches = await provider.findByName(appId, vm.remote_name);
    if (matches.length > 1)
      return unsure(`${matches.length} VMs are named ${vm.remote_name}`);
    const [match] = matches;
    if (!match)
      return {
        settle: "failed",
        errorMessage: "The provider has no VM with this name",
        status: "terminated",
        notYet: true,
      };
    if (match.status === "failed")
      return {
        settle: "failed",
        errorMessage: "The provider reports the VM failed",
        result: { remoteId: match.remoteId },
        status: "failed",
      };
    return {
      settle: "succeeded",
      result: { remoteId: match.remoteId },
      status: match.status,
    };
  }
  if (!vm.remote_id) return unsure("the VM has no provider id");
  if (operation.kind === "expose" || operation.kind === "unexpose") {
    const request: unknown = JSON.parse(operation.request_json);
    const port = (request as { port?: unknown } | null)?.port;
    if (typeof port !== "number") return unsure("the receipt names no port");
    const published = await provider.getHttpPort(vm.remote_id, port);
    if (operation.kind === "expose")
      return published
        ? { settle: "succeeded", result: published }
        : {
            settle: "failed",
            errorMessage: "The port is not published",
            notYet: true,
          };
    return published
      ? {
          settle: "failed",
          errorMessage: "The port is still published",
          notYet: true,
        }
      : { settle: "succeeded", result: null };
  }
  const status = (await provider.get(vm.remote_id))?.status ?? "terminated";
  if (status === "unknown" || status === "provisioning")
    return unsure(`the provider reports the VM ${status}`);
  const reached = {
    sleep: status === "sleeping",
    resume: status === "running",
    destroy: status === "terminated",
  }[operation.kind];
  if (reached) return { settle: "succeeded", result: null, status };
  if (operation.kind === "destroy" && status === "terminating")
    return unsure("the VM is still shutting down");
  return {
    settle: "failed",
    errorMessage: `The provider reports the VM ${status}`,
    status,
    notYet: true,
  };
}
