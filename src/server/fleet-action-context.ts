import { AsyncLocalStorage } from "node:async_hooks";
import type { FleetGrantContext } from "../shared/fleet.js";
import { ExecutionRefused } from "./execution-refusal.js";

export type FleetActionContext = {
  owner: string;
  commandId: string;
  grant: FleetGrantContext;
};
type Admission = FleetActionContext & { assertCurrent: () => void };
const contexts = new AsyncLocalStorage<Admission>();

/** Internal authenticated delegation only. No request header selects this
 * context. The peer action boundary supplies it after mapping its credential
 * to the destination owner. Async preparation retains that exact admission. */
export function withFleetAction<T>(
  context: FleetActionContext,
  assertCurrent: () => void,
  apply: () => T,
): T {
  return contexts.run({ ...structuredClone(context), assertCurrent }, () => {
    assertFleetAction(context.owner);
    return apply();
  });
}

export function assertFleetAction(owner?: string) {
  const context = contexts.getStore();
  if (!context) return;
  if (owner !== undefined && context.owner !== owner)
    throw new ExecutionRefused(
      403,
      "This fleet action belongs to another owner.",
    );
  context.assertCurrent();
}

export function currentFleetAction(): FleetActionContext | undefined {
  const value = contexts.getStore();
  if (!value) return;
  assertFleetAction();
  return {
    owner: value.owner,
    commandId: value.commandId,
    grant: structuredClone(value.grant),
  };
}

/** Committed-event consumers act on their own durable work. A request waking
 * that shared bus cannot delegate its authority to unrelated callbacks. */
export function withoutFleetAction<T>(apply: () => T): T {
  return contexts.exit(apply);
}
