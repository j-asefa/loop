import { parse } from "./api";
import {
  commandStorageKey,
  storedCommandAt,
  withCommandLock,
  type BrowserCommandStorage,
} from "./pendingCommandStorage";
import {
  planSend,
  omitsReplyTarget,
  type SendReceipt,
  type SendIntent,
} from "./sendIntent";

// A pending composer send must survive a killed home-screen app, a new tab
// and auth expiry (Session clears sessionStorage), otherwise the restored
// draft is sent with a fresh idempotency key and an accepted first request
// can run twice. Like drafts it lives in owner/source/thread-scoped
// durable storage; an owner change reads a different key, so one account
// never sees another's pending send.
//
// Tabs share this storage, so a thread keeps one receipt per distinct message
// (its signature), not one per thread: sending another message, from this tab
// or another, never replaces a different message's uncertain receipt.
// Settlement removes only the entry it sent. Older receipts written to
// any storage backend by earlier builds are not migrated (AGENTS.md fresh-install policy).

const EMPTY: SendReceipt = { signature: "", key: "", unquoted: false };
const MAX_RECEIPTS = 20;

/** Owner/source/thread-scoped key, stable across app restarts and re-auth. */
export function sendReceiptKey(
  owner: string,
  source: string,
  conversation: string | null,
): string {
  return commandStorageKey(owner, source, [conversation], "loop-send");
}

function readAll(storage: BrowserCommandStorage, key: string, strict = false) {
  let list: unknown;
  try {
    list = storedCommandAt(storage, key, (raw) =>
      parse<unknown>(raw, []),
    ).read();
  } catch {
    if (strict)
      throw new Error(
        "Cannot read pending sends. Restore browser storage access before sending.",
      );
    return [];
  }
  return Array.isArray(list)
    ? (list as SendReceipt[]).filter(
        (receipt) =>
          typeof receipt?.signature === "string" &&
          typeof receipt?.key === "string",
      )
    : [];
}

function writeAll(
  storage: BrowserCommandStorage,
  key: string,
  list: SendReceipt[],
) {
  // The limit applies only when settled receipts can be removed. An uncertain
  // identity must never be evicted to make room for another send.
  while (list.length > MAX_RECEIPTS) {
    const settled = list.findIndex((receipt) => !receipt.pending);
    if (settled === -1) break;
    list.splice(settled, 1);
  }
  try {
    const slot = storedCommandAt<SendReceipt[]>(storage, key);
    if (list.length) slot.write(list);
    else slot.remove();
  } catch {
    throw new Error(
      "Cannot save the pending send. Free browser storage before sending; nothing was sent.",
    );
  }
}

/**
 * The stored receipt for one message in a thread, or with no signature the
 * thread's latest receipt (the composer's starting point).
 */
export function readSendReceipt(
  storage: BrowserCommandStorage,
  key: string,
  signature?: string,
  strict = false,
): SendReceipt {
  const list = readAll(storage, key, strict);
  const found =
    signature === undefined
      ? list.at(-1)
      : list.find((receipt) => receipt.signature === signature);
  return found ?? EMPTY;
}

/** Record a message's receipt before it is sent, keeping other messages'. */
export function storeSendReceipt(
  storage: BrowserCommandStorage,
  key: string,
  receipt: SendReceipt,
) {
  const list = readAll(storage, key, true).filter(
    (entry) => entry.signature !== receipt.signature,
  );
  list.push(receipt);
  writeAll(storage, key, list);
}

/**
 * Settle the exact key and attempt that was sent: replace it with `next`, or
 * remove it. A late reply for a key that is no longer stored (already settled,
 * or replaced by a newer send of that message) changes nothing.
 */
export async function settleStoredSend(
  storage: BrowserCommandStorage,
  key: string,
  sent: SendReceipt,
  next: SendReceipt | null,
) {
  try {
    await withCommandLock(key, () => {
      const list = readAll(storage, key);
      const index = list.findIndex(
        (receipt) =>
          receipt.key === sent.key && receipt.attempt === sent.attempt,
      );
      if (index === -1) return;
      if (next) list[index] = next;
      else list.splice(index, 1);
      writeAll(storage, key, list);
    });
  } catch {
    // Settlement must not turn an accepted send into a reported failure.
    // Keep the original durable identity if storage is unavailable.
  }
}

export type PreparedSend = ReturnType<typeof planSend>;

/** Read, persist, and synchronously start IO under one cross-tab lock. */
export function prepareStoredSend(
  storage: Storage,
  key: string,
  signature: string,
  fallback: SendReceipt,
  requested: SendIntent,
  repliesToLatest: boolean,
  isCurrent: () => boolean = () => true,
  start?: (plan: PreparedSend) => Promise<void>,
) {
  return withCommandLock(
    key,
    () => {
      // The user may have changed draft, thread or owner while this tab waited.
      // An abandoned choice must not become an uncertain durable send.
      if (!isCurrent()) return null;
      const stored = readSendReceipt(storage, key, signature, true);
      const previous = stored.signature === signature ? stored : fallback;
      const plan = planSend(previous, signature, requested, () =>
        crypto.randomUUID(),
      );
      const unquoted = omitsReplyTarget(previous, plan, repliesToLatest);
      const receipt =
        plan.receipt === previous ? previous : { ...plan.receipt, unquoted };
      storeSendReceipt(storage, key, receipt);
      const prepared = { ...plan, receipt };
      // Invoke before releasing the lock; returning a wrapper keeps the lock
      // free during network IO and subsequent settlement. Mark rejection handled
      // immediately, while preserving it for the caller awaiting completion.
      const completion = start?.(prepared);
      void completion?.catch(() => {});
      return { ...prepared, completion };
    },
    "This browser cannot safely coordinate pending sends. Use a browser with Web Locks support.",
  );
}
