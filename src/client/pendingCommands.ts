import { storedCommands, withCommandLock } from "./pendingCommandStorage";

type PendingEffect = { commandId: string; attempt: string; context?: string };

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

// A receipt response identifies an attempt; a terminal status read identifies
// the command itself. Neither may clear a newer command in the same slot.
export async function settleStoredEffect(
  storage: Storage,
  owner: string | undefined,
  source: string,
  target: readonly string[],
  receipt: { commandId: string; attempt?: string },
): Promise<void> {
  if (!owner) return;
  const slot = storedCommands<PendingEffect>(storage)(owner, source, target);
  const key = slot.key;
  try {
    await withCommandLock(key, () => {
      const saved = slot.read();
      if (
        saved?.commandId === receipt.commandId &&
        (receipt.attempt === undefined || saved?.attempt === receipt.attempt)
      )
        slot.remove();
    });
  } catch {
    // Settlement failure retains the identity for receipt recovery.
  }
}

export async function performStoredEffect<T>(
  storage: Storage,
  owner: string | undefined,
  source: string,
  target: readonly string[],
  current: () => boolean,
  dispatch: (commandId: string, context?: string) => Promise<T>,
  settledError: (
    error: unknown,
    recovering: boolean,
  ) => boolean = effectOutcomeSettled,
  context?: string,
): Promise<T> {
  if (!owner) throw new Error("Sign in before starting this change.");
  const slot = storedCommands<PendingEffect>(storage)(owner, source, target);
  const key = slot.key;
  const prepared = await withCommandLock(key, () => {
    if (!current()) throw new Error("This view has changed; nothing was sent.");
    let prior: PendingEffect | undefined;
    try {
      const value = slot.read();
      if (value !== undefined) {
        if (
          typeof value?.commandId !== "string" ||
          !value.commandId ||
          typeof value?.attempt !== "string" ||
          !value.attempt ||
          (context !== undefined && typeof value.context !== "string")
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
      ...(context === undefined
        ? {}
        : { context: prior ? prior.context : context }),
    };
    try {
      slot.write(receipt);
    } catch {
      throw new Error("Cannot save this change's identity; nothing was sent.");
    }
    // Start under the preparation lock, but release it before waiting for IO.
    // Another tab must be able to recover the same identity after a lost reply.
    let completion: Promise<T>;
    try {
      completion = dispatch(receipt.commandId, receipt.context);
    } catch (error) {
      completion = Promise.reject(error);
    }
    return { receipt, completion, recovering: prior !== undefined };
  });
  const settle = () =>
    settleStoredEffect(storage, owner, source, target, prepared.receipt);
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
      await withCommandLock(key, () => {
        if (!current())
          throw new Error(
            "This view has changed. Reopen it before continuing.",
          );
        const saved = slot.read();
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
        slot.remove();
      });
    });
  }
}

// Local creation commits its effect and receipt together. A fresh 4xx proves
// refusal, but an access failure during recovery says nothing about the
// earlier request. Keep that identity until its receipt can be read.
export function creationFailureSettled(
  error: unknown,
  recovering: boolean,
): boolean {
  const failure = error as {
    status?: number;
    executionOutcome?: string;
  } | null;
  if (failure?.executionOutcome === "completed") return true;
  if (recovering) return false;
  if (failure?.executionOutcome) return failure.executionOutcome === "refused";
  return (
    failure?.status !== undefined &&
    failure.status >= 400 &&
    failure.status < 500
  );
}
