type PendingEffect = { commandId: string; attempt: string };

export class UncertainEffect extends Error {
  constructor(
    error: unknown,
    readonly supersede: () => Promise<void>,
  ) {
    super(
      error instanceof Error ? error.message : "The change is unconfirmed.",
    );
  }
}

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
    if (settledError(error, prepared.recovering)) {
      await settle();
      throw error;
    }
    throw new UncertainEffect(error, async () => {
      await navigator.locks.request(key, () => {
        if (!current())
          throw new Error(
            "This view has changed. Reopen it before continuing.",
          );
        const saved = JSON.parse(storage.getItem(key) || "null");
        if (
          saved?.commandId !== prepared.receipt.commandId ||
          saved?.attempt !== prepared.receipt.attempt
        )
          throw new Error(
            "This pending change has changed. Check its status again.",
          );
        // Keep the uncertain identity before releasing the active slot. This
        // never settles its server receipt or dispatches a replacement effect.
        storage.setItem(
          `loop-effect-history:${JSON.stringify([owner, source, saved.commandId])}`,
          JSON.stringify({ ...prepared.receipt, target }),
        );
        storage.removeItem(key);
      });
    });
  }
}
