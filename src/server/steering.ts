import { MessageMetadata, parseRun } from "./row-schemas.js";

import { watchRun } from "./run-signal.js";
import { db, emit, id, now } from "./db.js";
import { ownedRun, Problem } from "./domain.js";
import type { Run } from "./queue.js";
import type { ChatMessage } from "./providers.js";
import { attachmentPrompt } from "./uploads.js";
import { replyPrompt } from "../shared/replies.js";
import { steeredReplyPrompt } from "../shared/steering-replies.js";
import { RUN_LIVE_INPUT_SQL } from "./native-connections.js";
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
  const run = db
    .prepare(
      `SELECT r.*,${RUN_LIVE_INPUT_SQL("r")} live_input FROM runs r WHERE r.owner_id=? AND r.conversation_id=? AND (? IS NULL OR r.agent_id=?) AND r.kind='agent' AND r.state IN ('running','awaiting_approval') AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=r.id AND c.stage='done') ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(owner, conversation, agent ?? null, agent ?? null) as
    | (Run & { live_input: number })
    | undefined;
  if (!run) return;
  const { live_input, ...active } = run;
  return { run: parseRun(active), liveInput: live_input === 1 };
}

export function steeringReceipt(owner: string, key: string, request: string) {
  const prior = db
    .prepare(
      "SELECT * FROM run_steering WHERE owner_id=? AND idempotency_key=?",
    )
    .get(owner, key) as
    { request: string; run_id: string; id: string } | undefined;
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
  const steeringId = id(),
    messageId = id(),
    messageAt = now();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user',?,?,?)",
  ).run(
    messageId,
    run.owner_id,
    run.conversation_id,
    run.id,
    content,
    JSON.stringify(MessageMetadata.parse({ ...metadata, steeringId })),
    messageAt,
  );
  db.prepare(
    "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(steeringId, run.owner_id, run.id, messageId, key, request, now());
  emit(run.owner_id, run.id, "steering.pending", { messageId, steeringId });
  return { ...run, steeringId };
}

function message(input: Input, replyToolAvailable: boolean): ChatMessage {
  const metadata = JSON.parse(input.metadata);
  const content = replyPrompt(input.content, metadata.replyTo);
  return {
    role: "user",
    content: attachmentPrompt(
      !metadata.automation && replyToolAvailable ? steeredReplyPrompt(content, input.message_id) : content,
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
    return db
      .prepare(
        "SELECT s.id,s.message_id,m.content,m.metadata FROM run_steering s JOIN messages m ON m.id=s.message_id WHERE s.run_id=? AND s.state='pending' ORDER BY s.created_at,s.rowid",
      )
      .all(this.run.id) as Input[];
  }
  private receipt(input: Input, state: "delivered" | "failed", error?: string) {
    db.prepare(
      "UPDATE run_steering SET state=?,error=? WHERE id=? AND state IN ('pending','sending')",
    ).run(state, error || null, input.id);
    emit(this.run.owner_id, this.run.id, `steering.${state}`, {
      messageId: input.message_id,
    });
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
      const claimed = db
        .prepare(
          "UPDATE run_steering SET state='sending' WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM runs WHERE id=run_id AND state IN ('running','awaiting_approval'))",
        )
        .run(input.id).changes;
      if (!claimed) return;
      let retryLater = false;
      this.busy = (async () => {
        try {
          const value = message(input, this.replyToolAvailable);
          await deliver(value, input.id);
          db.transaction(() => {
            this.delivered(value);
            this.receipt(input, "delivered");
          }).immediate();
        } catch (error) {
          // Certainly not handed over: keep it pending for a later attempt.
          // If the run ends first, it is marked as never delivered.
          if (error instanceof NotDelivered) {
            retryLater = true;
            db.prepare(
              "UPDATE run_steering SET state='pending' WHERE id=? AND state='sending'",
            ).run(input.id);
            return;
          }
          this.receipt(
            input,
            "failed",
            "Live delivery could not be confirmed. Review the agent's messages before sending again.",
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
    for (const input of pending) {
      history.push(message(input, this.replyToolAvailable));
      this.receipt(input, "delivered");
    }
    return pending.length;
  }
}
