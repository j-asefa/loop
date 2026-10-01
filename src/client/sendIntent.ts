// What a composer send asks for, kept with its idempotency key so a retry
// after a lost response repeats exactly the same request.
export type SendIntent = {
  mode: "send" | "queue" | "schedule";
  /** Exact time for a scheduled send, fixed when it was first chosen. */
  sendAt: number | null;
};
export type SendReceipt = {
  /** The message: recipient, text, thread, reply target and files. */
  signature: string;
  key: string;
  intent?: SendIntent;
  /** Sent, but not yet confirmed accepted or refused. */
  pending?: boolean;
};

const sameIntent = (a: SendIntent, b: SendIntent) =>
  a.mode === b.mode && a.sendAt === b.sendAt;

/**
 * Decide what to send. While an earlier request for the same message may
 * have been accepted, it is repeated exactly as first sent (same key, same
 * mode and time), even if a different option was picked now: the server
 * then returns that request's receipt instead of doing the work twice.
 * `reconciled` says the earlier request was used rather than the new choice.
 */
export function planSend(
  receipt: SendReceipt,
  signature: string,
  requested: SendIntent,
  newKey: () => string,
): { receipt: SendReceipt; intent: SendIntent; reconciled: boolean } {
  if (receipt.signature === signature && receipt.pending && receipt.intent)
    return {
      receipt,
      intent: receipt.intent,
      reconciled: !sameIntent(receipt.intent, requested),
    };
  // A new message gets a new key. The same message whose earlier attempt was
  // refused (nothing was accepted) keeps its key with the new choice.
  const key = receipt.signature === signature && receipt.key ? receipt.key : newKey();
  return {
    receipt: { signature, key, intent: requested, pending: true },
    intent: requested,
    reconciled: false,
  };
}

/**
 * After a failed send: a response from Loop below 500 means the request was
 * refused and nothing was accepted. Anything else (no response, a server
 * error) leaves it uncertain, so the receipt stays pending.
 */
export function settleFailure(receipt: SendReceipt, status?: number): SendReceipt {
  return status !== undefined && status < 500
    ? { ...receipt, pending: false }
    : receipt;
}
