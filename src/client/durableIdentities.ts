// Pending command identities must survive reloads and uncertain responses so
// a retry repeats the same idempotency key the server or host already saw,
// instead of minting a fresh one and running an accepted effect twice (#354).
// They are kept in owner/source/thread-scoped durable storage and cleared on
// settlement. The storage is injected so the behavior is testable; the app
// passes `localStorage`, which Session's `sessionStorage.clear()` never wipes.

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage restrictions must not block a retry; it then mints a fresh key.
  }
}
function remove(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {}
}

/** The idempotency key to retry a run as a new run, remembered across
 * reloads so a lost retry response is not submitted a second time. */
export function runRetryKey(
  storage: Storage,
  owner: string,
  source: string,
  runId: string,
): string {
  const key = `loop-retry-key:${JSON.stringify([owner, source, runId])}`;
  const existing = read(storage, key);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  write(storage, key, fresh);
  return fresh;
}
export function clearRunRetryKey(
  storage: Storage,
  owner: string,
  source: string,
  runId: string,
) {
  remove(storage, `loop-retry-key:${JSON.stringify([owner, source, runId])}`);
}

/** Reuse the last harness-upgrade command id for a runtime until the upgrade
 * settles, so the host's command-id dedupe recognizes a retried start. */
export function upgradeCommandId(
  storage: Storage,
  source: string,
  runtime: string,
): string {
  const key = `loop-upgrade-cmd:${JSON.stringify([source, runtime])}`;
  const existing = read(storage, key);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  write(storage, key, fresh);
  return fresh;
}
export function clearUpgradeCommandId(
  storage: Storage,
  source: string,
  runtime: string,
) {
  remove(storage, `loop-upgrade-cmd:${JSON.stringify([source, runtime])}`);
}
