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
  /** Increments when a proven refusal permits a new explicit attempt. */
  attempt?: number;
  intent?: SendIntent;
  /** Sent, but not yet confirmed accepted or refused. */
  pending?: boolean;
  /** Sent without its reply target, as a reply to the agent's latest message. */
  unquoted: boolean;
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
  const key =
    receipt.signature === signature && receipt.key ? receipt.key : newKey();
  return {
    receipt: {
      signature,
      key,
      attempt: (receipt.attempt ?? 0) + 1,
      intent: requested,
      pending: true,
      unquoted: false,
    },
    intent: requested,
    reconciled: false,
  };
}

/**
 * Whether a send leaves out its reply target because it answers the
 * agent's latest message, as the composer showed. A repeated request keeps
 * the decision it was first sent with.
 */
export function omitsReplyTarget(
  previous: SendReceipt,
  plan: { receipt: SendReceipt },
  repliesToLatest: boolean,
) {
  return plan.receipt === previous ? previous.unquoted : repliesToLatest;
}

/**
 * After a failed send: a response from Loop below 500 means the request was
 * refused and nothing was accepted. Anything else (no response, a server
 * error) leaves it uncertain, so the receipt stays pending.
 */
export function settleFailure(
  receipt: SendReceipt,
  status?: number,
  executionOutcome?: string,
): SendReceipt {
  // Fleet IDs with terminal refusals cannot execute later. A new explicit
  // send needs a fresh ID; HTTP status alone cannot settle an earlier send.
  if (executionOutcome === "refused")
    return { ...receipt, key: "", pending: false };
  if (executionOutcome) return receipt;
  return status !== undefined && status < 500
    ? { ...receipt, pending: false }
    : receipt;
}
