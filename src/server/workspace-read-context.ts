import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionRefused } from "./execution-refusal.js";

const reads = new AsyncLocalStorage<string>();
/** Trusted in-process projections only. Headers and request bodies cannot select
 * this context. Inspection may return stored state but cannot refresh runtimes. */
export function withPassiveWorkspaceRead<T>(owner: string, apply: () => T): T {
  return reads.run(owner, apply);
}
export function passiveWorkspaceRead(owner?: string): boolean {
  const scope = reads.getStore();
  if (scope === undefined) return false;
  if (owner !== undefined && owner !== scope)
    throw new ExecutionRefused(
      403,
      "This workspace read belongs to another owner.",
    );
  return true;
}
/** Shared committed-event consumers own their work, outside the waking read. */
export function withoutPassiveWorkspaceRead<T>(apply: () => T): T {
  return reads.exit(apply);
}
