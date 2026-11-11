import * as runSteeringQueries from "./sql/run-steering.js";
import * as runsQueries from "./sql/runs.js";
import * as messagesQueries from "./sql/messages.js";
import { MessageMetadata, parseRun } from "./row-schemas.js";
import { recordEffect, inheritEffect, withEffect } from "./effect-authority.js";
import { ExecutionRefused } from "./execution-refusal.js";

import { watchRun } from "./run-signal.js";
import { db, emit, id, now } from "./db.js";
import { ownedRun, Problem } from "./domain.js";
import type { Run } from "./queue.js";
import type { ChatMessage } from "./providers.js";
import { attachmentPrompt } from "./uploads.js";
import { replyPrompt } from "../shared/replies.js";
import { steeredReplyPrompt } from "../shared/steering-replies.js";
import { NotDelivered } from "../adapters/types.js";

type Delivery = (message: ChatMessage, id: string) => Promise<void>;
type Input = {
  id: string;
  message_id: string;
  content: string;
  metadata: string;
};

/**
 * The conversation's active agent run, and whether a reply can steer it:
 * only when the runtime it was started with takes live input. Otherwise a
 * reply queues for the next turn.
 */
export function activeRun(owner: string, conversation: string, agent?: string) {
  const run = runsQueries.activeSteering(
    db,
    owner,
    conversation,
    agent ?? null,
  );
  if (!run) return;
  const { live_input, ...active } = run;
  return { run: parseRun(active), liveInput: live_input === 1 };
}

export function steeringReceipt(owner: string, key: string, request: string) {
  const prior = runSteeringQueries.byIdempotency(db, owner, key);
  if (!prior) return;
  if (prior.request !== request)
    throw new Problem(409, "This request key belongs to different work");
  return { ...ownedRun(prior.run_id, owner), steeringId: prior.id };
}

export function saveSteering(
  run: Run,
  key: string,
  request: string,
  content: string,
  metadata: object,
) {
  return db
    .transaction(() => {
      const steeringId = id(),
        messageId = id(),
        messageAt = now();
      recordEffect(run.owner_id, "steering", steeringId);
      messagesQueries.insertUser(
        db,
        messageId,
        run.owner_id,
        run.conversation_id,
        run.id,
        content,
        JSON.stringify(MessageMetadata.parse({ ...metadata, steeringId })),
        messageAt,
      );
      runSteeringQueries.insert(
        db,
        steeringId,
        run.owner_id,
        run.id,
        messageId,
        key,
        request,
        now(),
      );
      // Accepting peer input constrains the receiving run, including subsequent
      // tools after delivery. Keep the constraint even if delivery is uncertain.
      inheritEffect(run.owner_id, "steering", steeringId, run.id);
      emit(run.owner_id, run.id, "steering.pending", { messageId, steeringId });
      return { ...run, steeringId };
    })
    .immediate();
}

function message(input: Input, replyToolAvailable: boolean): ChatMessage {
  const metadata = JSON.parse(input.metadata);
  const content = replyPrompt(input.content, metadata.replyTo);
  return {
    role: "user",
    content: attachmentPrompt(
      !metadata.automation && replyToolAvailable
        ? steeredReplyPrompt(content, input.message_id)
        : content,
      metadata.attachments || [],
    ),
    attachments: metadata.attachments || [],
  };
}

/** The worker owns delivery. Pending input is durable; an uncertain dispatch is
 * never replayed. A listener exists only while its exact native turn is alive. */
export class SteeringInbox {
  private busy?: Promise<void>;
  private listener?: Delivery;
  constructor(
    private run: Run,
    private delivered: (message: ChatMessage) => void = () => {},
    private replyToolAvailable = false,
  ) {}
  private pending() {
    return runSteeringQueries.pendingMessages(db, this.run.id);
  }
  // Returns whether the row actually took this state. A run that ended while
  // a delivery was in flight is failed by the run-end trigger, so a late
  // "delivered" must not overwrite it or fire a false delivered event.
  private receipt(
    input: Input,
    state: "delivered" | "failed",
    error?: string,
  ): boolean {
    const changed = runSteeringQueries.finish(
      db,
      state,
      error || null,
      input.id,
    ).changes;
    if (changed)
      emit(this.run.owner_id, this.run.id, `steering.${state}`, {
        messageId: input.message_id,
      });
    return changed > 0;
  }
  listen(deliver: Delivery) {
    if (this.listener || this.busy)
      throw new Error("Steering listener already active");
    this.listener = deliver;
    const watched = watchRun(this.run);
    const pump = () => {
      if (this.busy || this.listener !== deliver) return;
      const input = this.pending()[0];
      if (!input) return;
      const claimed = runSteeringQueries.markSending(db, input.id).changes;
      if (!claimed) return;
      let retryLater = false;
      this.busy = (async () => {
        try {
          const value = message(input, this.replyToolAvailable);
          await withEffect(this.run.owner_id, "steering", input.id, () =>
            deliver(value, input.id),
          );
          db.transaction(() => {
            if (this.receipt(input, "delivered")) this.delivered(value);
          }).immediate();
        } catch (error) {
          // Certainly not handed over: keep it pending for a later attempt.
          // If the run ends first, it is marked as never delivered.
          if (error instanceof NotDelivered) {
            retryLater = true;
            runSteeringQueries.returnPending(db, input.id);
            return;
          }
          this.receipt(
            input,
            "failed",
            error instanceof ExecutionRefused
              ? "The fleet grant was revoked before this input was delivered."
              : "Live delivery could not be confirmed. Review the agent's messages before sending again.",
          );
        }
      })().finally(() => {
        this.busy = undefined;
        if (!retryLater) pump();
      });
    };
    watched.on("steering.pending", pump);
    watched.on("running", pump);
    watched.on("fallback", pump);
    pump();
    return async () => {
      if (this.listener === deliver) {
        this.listener = undefined;
        watched.release();
      }
      await this.busy;
    };
  }
  // Use at an ordinary model boundary, inside the same transaction that saves
  // its history/checkpoint. This also catches sends racing with turn completion.
  appendPending(history: ChatMessage[]) {
    const pending = this.pending();
    let delivered = 0;
    for (const input of pending) {
      try {
        withEffect(this.run.owner_id, "steering", input.id, () => {
          history.push(message(input, this.replyToolAvailable));
          if (this.receipt(input, "delivered")) delivered++;
        });
      } catch (error) {
        if (!(error instanceof ExecutionRefused)) throw error;
        this.receipt(
          input,
          "failed",
          "The fleet grant was revoked before this input was delivered.",
        );
      }
    }
    return delivered;
  }
}
