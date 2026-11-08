import { viewGeneration } from "./viewCache";

// Failed snapshots need another invalidation even when the event log is quiet.
// The shared watcher owns scheduling; view cancellation removes its interest.
let generation = -1;
const pending = new Map<string, Map<AbortSignal, () => void>>();
function current() {
  if (generation === viewGeneration()) return;
  for (const entries of pending.values())
    for (const cleanup of entries.values()) cleanup();
  pending.clear();
  generation = viewGeneration();
}
export function recoverWorkspaceRead(source: string, signal: AbortSignal) {
  current();
  if (signal.aborted) return;
  let entries = pending.get(source);
  if (!entries) pending.set(source, (entries = new Map()));
  if (entries.has(signal)) return;
  const abort = () => {
    entries.delete(signal);
    signal.removeEventListener("abort", abort);
  };
  entries.set(signal, abort);
  signal.addEventListener("abort", abort, { once: true });
}
export function needsWorkspaceReadRecovery(source: string) {
  current();
  return !!pending.get(source)?.size;
}
export function takeWorkspaceReadRecovery(source: string) {
  current();
  const entries = pending.get(source);
  if (!entries?.size) return false;
  for (const cleanup of entries.values()) cleanup();
  pending.delete(source);
  return true;
}
