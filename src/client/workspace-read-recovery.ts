import { viewGeneration } from "./viewCache";

// Failed snapshots need another invalidation even when the event log is quiet.
// The shared watcher owns scheduling; view cancellation removes its interest.
let generation = -1;
type Interest = { paths: Set<string>; cleanup: () => void };
const pending = new Map<string, Map<AbortSignal, Interest>>();
let latest = new WeakMap<AbortSignal, Map<string, object>>();
function current() {
  if (generation === viewGeneration()) return;
  for (const entries of pending.values())
    for (const entry of entries.values()) entry.cleanup();
  pending.clear();
  latest = new WeakMap();
  generation = viewGeneration();
}
export function beginWorkspaceRead(
  source: string,
  path: string,
  signal: AbortSignal,
) {
  current();
  const owner = generation;
  let reads = latest.get(signal);
  if (!reads) latest.set(signal, (reads = new Map()));
  const key = JSON.stringify([source, path]);
  const token = {};
  reads.set(key, token);
  return (failed: boolean) => {
    current();
    if (signal.aborted || owner !== generation || reads.get(key) !== token)
      return;
    reads.delete(key);
    let entries = pending.get(source);
    let entry = entries?.get(signal);
    if (!failed) {
      entry?.paths.delete(path);
      if (entry && !entry.paths.size) entry.cleanup();
      return;
    }
    if (!entries) pending.set(source, (entries = new Map()));
    if (!entry) {
      const cleanup = () => {
        entries.delete(signal);
        if (!entries.size) pending.delete(source);
        signal.removeEventListener("abort", cleanup);
      };
      entry = { paths: new Set(), cleanup };
      entries.set(signal, entry);
      signal.addEventListener("abort", cleanup, { once: true });
    }
    entry.paths.add(path);
  };
}
export function needsWorkspaceReadRecovery(source: string) {
  current();
  return !!pending.get(source)?.size;
}
export function takeWorkspaceReadRecovery(source: string) {
  current();
  const entries = pending.get(source);
  if (!entries?.size) return false;
  for (const entry of entries.values()) entry.cleanup();
  return true;
}
