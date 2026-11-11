import * as runSteeringQueries from "./sql/run-steering.js";
import * as steeringRepliesQueries from "./sql/steering-replies.js";
import * as messagesQueries from "./sql/messages.js";
import { PublishReply, ReplyState } from "../shared/steering-replies.js";
import { db, now } from "./db.js";
import { ownedRun, Problem } from "./domain.js";
import { recordConversationUpdate } from "./conversation-updates.js";
import type { Run } from "./queue.js";

export function publishReply(run: Run, callId: string, input: unknown) {
  const args = PublishReply.parse(input);
  return db
    .transaction(() => {
      const current = ownedRun(run.id, run.owner_id);
      if (current.state !== "running")
        throw new Problem(409, "Run is no longer executing");
      const key = `reply:${callId}`;
      // Publication and its card commit together. A retry after publication but
      // before the native tool receipt must return the original, immutable reply.
      const prior = messagesQueries.publishedReply(
        db,
        current.owner_id,
        current.id,
        key,
      );
      if (prior) {
        if (prior.content !== args.body || prior.reply_to !== args.replyTo)
          throw new Problem(409, "Reply publication identity was reused");
        return { messageId: prior.id, replyTo: args.replyTo };
      }
      // A failed acknowledgement may still have reached the harness. Accept its
      // explicit reply without replaying or changing the uncertain delivery.
      const target = runSteeringQueries.replyTarget(
        db,
        current.owner_id,
        current.id,
        args.replyTo,
        current.conversation_id,
      );
      if (!target)
        throw new Problem(404, "Steered user message not found in this task");
      const message = recordConversationUpdate(current, key, {
        content: args.body,
        metadata: { reply: { to: args.replyTo, published: true } },
      });
      if (!message) throw new Problem(404, "Conversation not found");
      steeringRepliesQueries.insert(
        db,
        message.id,
        current.owner_id,
        target.id,
        now(),
      );
      return { messageId: message.id, replyTo: args.replyTo };
    })
    .immediate();
}

export function setReplyState(
  owner: string,
  messageId: string,
  input: unknown,
) {
  const state = ReplyState.parse(input);
  return db
    .transaction(() => {
      const reply = steeringRepliesQueries.ownedMessage(db, owner, messageId);
      if (!reply) throw new Problem(404, "Reply not found");
      steeringRepliesQueries.setReadArchive(db, {
        owner,
        id: messageId,
        at: now(),
        read: state.read ? 1 : 0,
        archive: state.archived === undefined ? null : Number(state.archived),
      });
      return { ok: true };
    })
    .immediate();
}
