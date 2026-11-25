import {
  AgentId,
  ConversationId,
  IdempotencyKey,
  MessageId,
} from "../shared/contract-ids.js";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute } from "./api";
import { viewGeneration, viewOwner } from "./viewCache";
import { sendSignature, settleFailure, type SendReceipt } from "./sendIntent";
import {
  prepareStoredSend,
  sendReceiptKey,
  settleStoredSend,
  type PreparedSend,
} from "./sendReceiptStore";

/** A reply typed on a feed card, to the card's agent in its thread. */
export type InlineReply = {
  source: string;
  conversation: string;
  agentId: string;
  /** The card's answer, quoted as the composer quotes it. */
  replyToMessageId?: string;
  text: string;
};

export type InlineSendOutcome =
  | { outcome: "accepted"; run: string }
  /** Nothing was accepted; the text may be edited and sent again. */
  | { outcome: "refused"; message: string }
  /**
   * It may have been accepted. The receipt keeps its key, so only an
   * explicit Retry sends it again, and the server answers with the first
   * request's run instead of starting another.
   */
  | { outcome: "uncertain"; message: string }
  /** The same message is waiting as a scheduled send from the composer. */
  | { outcome: "scheduled" };

const EMPTY: SendReceipt = { signature: "", key: "", unquoted: false };

/**
 * Send a card's inline reply through the composer's durable receipt flow:
 * the receipt (key, attempt, intent) is stored before the request starts,
 * in the thread's receipt slot, under the composer's signature for the same
 * message. A retry, from this card or the thread's composer, therefore
 * repeats the first request with the same idempotency key.
 *
 * Returns null when the owner or view changed before the send was recorded;
 * nothing was sent.
 */
export async function sendInlineReply(
  reply: InlineReply,
  isCurrent: () => boolean = () => true,
): Promise<InlineSendOutcome | null> {
  const owner = viewOwner();
  if (!owner) return null;
  const generation = viewGeneration();
  const storageKey = sendReceiptKey(owner, reply.source, reply.conversation);
  const signature = sendSignature({
    agentId: reply.agentId,
    text: reply.text,
    conversationId: reply.conversation,
    replyToMessageId: reply.replyToMessageId,
    attachmentIds: [],
  });
  let sent: SendReceipt | undefined;
  let run = "";
  let scheduled = false;
  const start = async (plan: PreparedSend) => {
    // An identical message the composer scheduled stays with the composer:
    // repeating it here would need its exact time, and it has not run yet.
    if (plan.intent.mode === "schedule") {
      scheduled = true;
      return;
    }
    sent = plan.receipt;
    const accepted = await callRoute(
      workspaceApi.submit,
      {
        body: {
          agentId: AgentId.parse(reply.agentId),
          conversationId: ConversationId.parse(reply.conversation),
          replyToMessageId:
            plan.receipt.unquoted || !reply.replyToMessageId
              ? undefined
              : MessageId.parse(reply.replyToMessageId),
          input: reply.text,
          idempotencyKey: IdempotencyKey.parse(plan.receipt.key),
          attachmentIds: [],
          // Repeated exactly as first sent (planSend).
          ...(plan.intent.mode === "queue" ? { queue: true } : {}),
        },
      },
      reply.source,
    );
    run = accepted.id;
    await settleStoredSend(localStorage, storageKey, plan.receipt, null);
  };
  try {
    const plan = await prepareStoredSend(
      localStorage,
      storageKey,
      signature,
      EMPTY,
      { mode: "send", sendAt: null },
      false,
      () =>
        isCurrent() && owner === viewOwner() && generation === viewGeneration(),
      start,
    );
    if (!plan) return null;
    await plan.completion;
  } catch (e) {
    const error = e as {
      message?: string;
      status?: number;
      executionOutcome?: string;
    };
    // Nothing started: storage refused the receipt before dispatch.
    if (!sent)
      return { outcome: "refused", message: error.message || "Not sent." };
    const failed = settleFailure(sent, error.status, error.executionOutcome);
    await settleStoredSend(localStorage, storageKey, sent, failed);
    return failed.pending
      ? {
          outcome: "uncertain",
          message: "Not confirmed. Loop may have received it.",
        }
      : { outcome: "refused", message: error.message || "Not sent." };
  }
  if (scheduled) return { outcome: "scheduled" };
  return { outcome: "accepted", run };
}
