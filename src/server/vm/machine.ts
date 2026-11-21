import type Database from "better-sqlite3";
import {
  legalVmOperationTransition,
  legalVmTransition,
  type VmOperationState,
  type VmState,
} from "../../shared/vm-state.js";
import * as experimentVmsQueries from "../sql/experiment-vms.js";
import * as vmOperationsQueries from "../sql/vm-operations.js";

// The only writers of experiment_vms.state and vm_operations.state
// (docs/state-machines.md#cloud-vm-experiments). Each re-reads the row and
// checks its state inside one immediate transaction, so a caller that decided
// from an older read changes nothing.

export type VmTransitionResult =
  | { changed: true; from: VmState }
  | { changed: false; reason: "missing" | "illegal"; from?: VmState };

/** Moves the owner's VM to `to` when that edge is legal from its current
 * state. `expected` narrows the move to a state the caller observed. */
export function transitionVm(
  db: Database.Database,
  vm: { owner: string; id: string },
  to: VmState,
  options: { expected?: VmState; lastError?: string | null; now: number },
): VmTransitionResult {
  return db
    .transaction((): VmTransitionResult => {
      const row = experimentVmsQueries.byId(db, vm.owner, vm.id);
      if (!row) return { changed: false, reason: "missing" };
      if (
        (options.expected !== undefined && row.state !== options.expected) ||
        !legalVmTransition(row.state, to)
      )
        return { changed: false, reason: "illegal", from: row.state };
      experimentVmsQueries.setState(
        db,
        vm.owner,
        vm.id,
        row.state,
        to,
        options.lastError ?? null,
        options.now,
      );
      return { changed: true, from: row.state };
    })
    .immediate();
}

/** Settles or marks uncertain the owner's operation receipt. Returns false
 * when the receipt is missing or the edge is not legal from its state. */
export function transitionVmOperation(
  db: Database.Database,
  operation: { owner: string; id: string },
  to: Exclude<VmOperationState, "pending">,
  outcome: { result?: unknown; errorMessage?: string | null; now: number },
): boolean {
  return db
    .transaction(() => {
      const row = vmOperationsQueries.byId(db, operation.owner, operation.id);
      if (!row || !legalVmOperationTransition(row.state, to)) return false;
      return vmOperationsQueries.setState(
        db,
        operation.owner,
        operation.id,
        row.state,
        to,
        {
          resultJson:
            outcome.result === undefined
              ? row.result_json
              : JSON.stringify(outcome.result),
          errorMessage: outcome.errorMessage ?? null,
        },
        outcome.now,
      );
    })
    .immediate();
}

/** No provider call Loop makes waits longer than this (the longest is a
 * boot, at ten minutes in vm/sailbox-provider.ts). */
export const VM_OPERATION_MAX_CALL_MS = 15 * 60_000;

/** A receipt still pending after the longest provider call belongs to a
 * caller that died between writing it and observing the answer, whichever
 * process it was. Its outcome is unknown, so it becomes uncertain and is
 * never sent again automatically. The worker runs this on every tick. */
export function markStaleVmOperationsUncertain(
  db: Database.Database,
  now: number,
) {
  let marked = 0;
  for (const row of vmOperationsQueries.pendingBefore(
    db,
    now - VM_OPERATION_MAX_CALL_MS,
  ))
    if (
      transitionVmOperation(
        db,
        { owner: row.owner_id, id: row.id },
        "uncertain",
        {
          errorMessage: "Loop stopped before the provider answered",
          now,
        },
      )
    )
      marked += 1;
  return marked;
}
