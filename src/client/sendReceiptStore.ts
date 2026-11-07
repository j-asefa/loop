import { parse } from "./api";
import type { SendReceipt } from "./sendIntent";

// A pending composer send must survive a killed home-screen app, a new tab
// and auth expiry (Session clears sessionStorage), otherwise the restored
// draft is sent with a fresh idempotency key and an accepted first request
// can run twice (#354). Like drafts it lives in owner/source/thread-scoped
// durable storage and is cleared on settlement; an owner change reads a
// different key, so one account never sees another's pending send. Older
// receipts written to sessionStorage by earlier builds are not migrated.

/** Owner/source/thread-scoped key, stable across app restarts and re-auth. */
export function sendReceiptKey(
  owner: string,
  source: string,
  conversation: string | null,
): string {
  return `loop-send:${JSON.stringify([owner, source, conversation])}`;
}

/** Read the pending receipt for a thread from durable storage. */
export function readSendReceipt(storage: Storage, key: string): SendReceipt {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    raw = null;
  }
  return parse<SendReceipt>(raw || "", { signature: "", key: "" });
}
