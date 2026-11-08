// Pending command identities must survive reloads and uncertain responses so
// a retry repeats the same idempotency key the server or host already saw,
// instead of minting a fresh one and running an accepted effect twice (#354).
// Retry keys are owner/source/run-scoped; upgrade command ids belong to a
// source's host runtime, which every owner of that host shares. All are kept in
// durable storage and cleared on settlement. The storage is injected so the behavior is testable; the app
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
 * reloads so a lost retry response is not submitted a second time. The local
 * workspace's source is "", a valid scope; only a missing owner (signed out)
 * gets an unremembered key. */
export function runRetryKey(
  storage: Storage,
  owner: string | undefined,
  source: string,
  runId: string,
): string {
  if (!owner) return crypto.randomUUID();
  const key = `loop-retry-key:${JSON.stringify([owner, source, runId])}`;
  const existing = read(storage, key);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  write(storage, key, fresh);
  return fresh;
}
export function clearRunRetryKey(
  storage: Storage,
  owner: string | undefined,
  source: string,
  runId: string,
) {
  if (!owner) return;
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

type PendingEffect = { commandId: string; attempt: string };

// HTTP status alone cannot settle an execution command: an unknown effect
// also returns 409. Only the authority's explicit outcome settles it.
function effectOutcomeSettled(error: unknown): boolean {
  const outcome = (error as { executionOutcome?: string } | null)
    ?.executionOutcome;
  return outcome === "refused" || outcome === "completed";
}

export async function performStoredEffect<T>(
  storage: Storage,
  owner: string | undefined,
  source: string,
  target: readonly string[],
  current: () => boolean,
  dispatch: (commandId: string) => Promise<T>,
  settledError: (
    error: unknown,
    recovering: boolean,
  ) => boolean = effectOutcomeSettled,
): Promise<T> {
  if (!owner) throw new Error("Sign in before starting this change.");
  if (!navigator.locks)
    throw new Error("Cannot protect pending changes; nothing was sent.");
  const key = `loop-effect:${JSON.stringify([owner, source, ...target])}`;
  const prepared = await navigator.locks.request(key, () => {
    if (!current()) throw new Error("This view has changed; nothing was sent.");
    let prior: PendingEffect | undefined;
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        const value = JSON.parse(raw);
        if (
          typeof value?.commandId !== "string" ||
          !value.commandId ||
          typeof value?.attempt !== "string" ||
          !value.attempt
        )
          throw new Error("Invalid pending change");
        prior = value;
      }
    } catch {
      throw new Error("Cannot read pending changes; nothing was sent.");
    }
    const receipt: PendingEffect = {
      commandId: prior?.commandId ?? crypto.randomUUID(),
      attempt: crypto.randomUUID(),
    };
    try {
      storage.setItem(key, JSON.stringify(receipt));
    } catch {
      throw new Error("Cannot save this change's identity; nothing was sent.");
    }
    // Start under the preparation lock, but release it before waiting for IO.
    // Another tab must be able to recover the same identity after a lost reply.
    let completion: Promise<T>;
    try {
      completion = dispatch(receipt.commandId);
    } catch (error) {
      completion = Promise.reject(error);
    }
    return { receipt, completion, recovering: prior !== undefined };
  });
  async function settle() {
    await navigator.locks.request(key, () => {
      try {
        const saved = JSON.parse(storage.getItem(key) || "null");
        if (
          saved?.commandId === prepared.receipt.commandId &&
          saved?.attempt === prepared.receipt.attempt
        )
          storage.removeItem(key);
      } catch {
        // Failure retains the pending identity for receipt recovery.
      }
    });
  }
  try {
    const value = await prepared.completion;
    await settle();
    return value;
  } catch (error) {
    if (settledError(error, prepared.recovering)) await settle();
    throw error;
  }
}
