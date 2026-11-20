import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  legalVmTransition,
  type VmOperationKind,
  type VmState,
} from "../../shared/vm-state.js";
import * as experimentPreviewsQueries from "../sql/experiment-previews.js";
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
  /** The owner already used the id for a different request. */
  | "key_conflict"
  /** The experiment does not exist for this owner. */
  | "missing_experiment"
  /** An earlier operation on this experiment is pending or uncertain. */
  | "unsettled_operation"
  /** A create or fork for an experiment that already has its VM. */
  | "vm_exists";

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
      const vm = experimentVmsQueries.byId(
        db,
        operation.owner,
        operation.experimentId,
      );
      if (!vm) throw new VmOperationRefused("missing_experiment");
      // One experiment has one provider VM. Once it is recorded, a failed VM
      // is destroyed, not created again: the provider key is scoped to the
      // experiment, so another create would only return the same VM.
      if (
        (operation.kind === "create" || operation.kind === "fork") &&
        vm.remote_id !== null
      )
        throw new VmOperationRefused("vm_exists");
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
    const settled = db
      .transaction(() => {
        if (
          !transitionVmOperation(db, receipt, to, {
            errorMessage,
            now: clock(),
          })
        )
          return false;
        if (to === "failed") effects.refused?.(errorMessage);
        return true;
      })
      .immediate();
    if (!settled) return current();
    return to === "failed"
      ? { state: "failed", errorMessage, replayed: false }
      : { state: "uncertain", errorMessage };
  }
  const incomplete = effects.incomplete?.(result) ?? null;
  const errorMessage = incomplete ?? effects.failure?.(result) ?? null;
  const to =
    incomplete !== null
      ? "uncertain"
      : errorMessage === null
        ? "succeeded"
        : "failed";
  // The receipt and the local record of what the call did commit together.
  // If apply throws, both roll back and the receipt stays pending until the
  // sweep marks it uncertain for a reconcile. An incomplete answer writes
  // nothing locally: its provider id is provisional until a reconcile sees
  // the VM, and lives only in the receipt.
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
      if (to !== "uncertain") effects.apply?.(result);
      return true;
    })
    .immediate();
  if (!settled) return current();
  if (to === "uncertain") return { state: "uncertain", errorMessage };
  return errorMessage === null
    ? { state: "succeeded", result, replayed: false }
    : { state: "failed", errorMessage, replayed: false };
}

/** The local record cannot take what the provider answered. */
export class VmRecordConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmRecordConflict";
  }
}

/** What a call's answer means locally. Each hook runs inside the
 * transaction that settles the receipt, so the local record and the receipt
 * commit together or not at all. */
export type VmOperationEffects = {
  /** An answer that does not show the outcome yet, such as a VM still
   * starting: the receipt stays uncertain (with the answer and `apply`'s
   * writes kept) for a reconcile to settle. */
  incomplete?(result: unknown): string | null;
  /** A failure the answer itself reports, such as a VM that booted into
   * "failed"; null when the call did what was asked. */
  failure?(result: unknown): string | null;
  /** Local writes for a resolved call, including one `failure` failed. */
  apply?(result: unknown): void;
  /** Local writes for a provider refusal. */
  refused?(errorMessage: string): void;
};

type CreatedVm = { remoteId: string; status: VmStatus; errorMessage?: string };

const kindStatus: Partial<Record<VmOperationKind, VmStatus>> = {
  sleep: "sleeping",
  resume: "running",
  destroy: "terminated",
};

/** The local writes for each operation kind. runVmOperation and
 * reconcileVmOperation both use them, so an answer and a reconcile leave the
 * same record: a create or fork adopts the provider id and observed state,
 * sleep/resume/destroy move the VM, expose and unexpose keep the preview
 * rows in step, and a destroy disables every preview link. */
export function vmOperationEffects(
  db: Database.Database,
  operation: {
    owner: string;
    experimentId: string;
    id: string;
    kind: VmOperationKind;
    request: unknown;
  },
  clock: () => number,
): VmOperationEffects {
  const vm = { owner: operation.owner, id: operation.experimentId };
  const current = () => {
    const row = experimentVmsQueries.byId(db, vm.owner, vm.id);
    if (!row) throw new VmRecordConflict("The experiment no longer exists");
    return { ...vm, state: row.state };
  };
  const created = operation.kind === "create" || operation.kind === "fork";
  return {
    incomplete: (result) => {
      if (!created) return null;
      const { status } = result as CreatedVm;
      return status === "running" ||
        status === "sleeping" ||
        status === "paused" ||
        status === "failed"
        ? null
        : `The VM is ${status}`;
    },
    failure: (result) =>
      created && (result as CreatedVm).status === "failed"
        ? ((result as CreatedVm).errorMessage ??
          "The provider reports the VM failed")
        : null,
    apply: (result) => {
      if (created) {
        const vmResult = result as CreatedVm;
        if (
          !experimentVmsQueries.adoptRemote(
            db,
            vm.owner,
            vm.id,
            vmResult.remoteId,
          )
        )
          throw new VmRecordConflict(
            "The experiment already records another provider VM",
          );
        applyObservedStatus(
          db,
          current(),
          vmResult.status,
          clock(),
          vmResult.errorMessage,
        );
        return;
      }
      const status = kindStatus[operation.kind];
      if (status) applyObservedStatus(db, current(), status, clock());
      if (operation.kind === "destroy")
        experimentPreviewsQueries.deactivateAll(db, vm.owner, vm.id, clock());
      if (operation.kind === "expose" || operation.kind === "unexpose") {
        const request = (operation.request ?? {}) as {
          port?: unknown;
          label?: unknown;
          path?: unknown;
        };
        if (typeof request.port !== "number")
          throw new VmRecordConflict("The operation names no port");
        if (operation.kind === "unexpose") {
          experimentPreviewsQueries.deactivate(
            db,
            vm.owner,
            vm.id,
            request.port,
            clock(),
          );
          return;
        }
        const { url } = result as { url: string };
        if (
          !experimentPreviewsQueries.upsert(db, {
            // Experiment ids are unique across owners; operation ids are not.
            id: `${vm.id}:${request.port}`,
            owner: vm.owner,
            experimentId: vm.id,
            port: request.port,
            label: typeof request.label === "string" ? request.label : null,
            path: typeof request.path === "string" ? request.path : "/",
            url,
            now: clock(),
          })
        )
          throw new VmRecordConflict("The experiment is not the owner's");
      }
    },
    refused: (errorMessage) => {
      if (operation.kind !== "destroy") return;
      const row = current();
      if (row.state === "destroying")
        transitionVm(db, row, "failed", {
          expected: "destroying",
          lastError: errorMessage,
          now: clock(),
        });
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

// Until the longest provider call has passed, the original call may still
// land and change what a lookup saw: a late delete can remove a listener a
// later expose added, a late sleep can stop a VM a later resume woke. So an
// observation settles only when its lookup began after that window. The one
// exception is `early`: a create or fork whose VM exists, because a late
// arrival of the original create reaches the same VM (its provider
// idempotency key is scoped to the experiment) and cannot undo it.
type Observation =
  | { settle: "succeeded"; result: unknown; status?: VmStatus; early?: true }
  | {
      settle: "failed";
      errorMessage: string;
      status?: VmStatus;
      result?: unknown;
      early?: true;
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

  // The age is taken before the provider is asked, so the lookup itself
  // must begin after the original call could have finished.
  const observedAt = clock();
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
    !observation.early &&
    observedAt - operation.created_at <= VM_OPERATION_MAX_CALL_MS
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
      const effects = vmOperationEffects(
        db,
        {
          owner: target.owner,
          experimentId: vm.id,
          id: operation.id,
          kind: operation.kind,
          request: JSON.parse(operation.request_json),
        },
        clock,
      );
      try {
        if (seen.settle === "succeeded" || seen.result !== undefined)
          effects.apply?.(seen.result);
        else if (seen.status)
          applyObservedStatus(
            db,
            { owner: target.owner, id: vm.id, state: fresh.state },
            seen.status,
            clock(),
          );
      } catch (error) {
        // The local record no longer matches what was observed (another
        // writer got there first): keep the receipt uncertain. Any other
        // error, such as a failed write, propagates and rolls back.
        if (error instanceof VmRecordConflict) throw new SettledConcurrently();
        throw error;
      }
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
      };
    if (match.status === "failed")
      return {
        settle: "failed",
        errorMessage: "The provider reports the VM failed",
        result: { remoteId: match.remoteId, status: "failed" },
        early: true,
      };
    // Only a VM that finished starting shows the create succeeded.
    if (
      match.status !== "running" &&
      match.status !== "sleeping" &&
      match.status !== "paused"
    )
      return unsure(`the VM is ${match.status}`);
    return {
      settle: "succeeded",
      result: { remoteId: match.remoteId, status: match.status },
      early: true,
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
          };
    return published
      ? {
          settle: "failed",
          errorMessage: "The port is still published",
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
  };
}
