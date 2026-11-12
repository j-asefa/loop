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
/** Clear the stored id, but only while it is still `commandId`: a late answer
 * for an earlier start (from this tab or another) must not drop a newer
 * start's pending id. */
export function clearUpgradeCommandId(
  storage: Storage,
  source: string,
  runtime: string,
  commandId: string,
) {
  const key = `loop-upgrade-cmd:${JSON.stringify([source, runtime])}`;
  if (read(storage, key) === commandId) remove(storage, key);
}

/** The command id to send for a harness upgrade: a pending id is reused so a
 * lost start reply hits the host's command-id dedupe. */
export function beginUpgradeStart(
  storage: Storage,
  source: string,
  runtime: string,
): string {
  return upgradeCommandId(storage, source, runtime);
}
/** Consume the command id once the host confirms a start, so a later genuine
 * start mints a fresh id instead of deduping onto an already-settled record. */
export function confirmUpgradeStart(
  storage: Storage,
  source: string,
  runtime: string,
  commandId: string,
) {
  clearUpgradeCommandId(storage, source, runtime, commandId);
}
