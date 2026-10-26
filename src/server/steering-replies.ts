import { PublishReply, ReplyState } from "../shared/steering-replies.js";
import { db, now } from "./db.js";
import { ownedRun, Problem } from "./domain.js";
import { recordConversationUpdate } from "./conversation-updates.js";
import type { Run } from "./queue.js";

export function publishReply(run: Run, callId: string, input: unknown) {
  const args = PublishReply.parse(input);
  return db.transaction(() => {
    const current = ownedRun(run.id, run.owner_id);
    if (current.state !== "running") throw new Problem(409, "Run is no longer executing");
    const key = `reply:${callId}`;
    // Publication and its card commit together. A retry after publication but
    // before the native tool receipt must return the original, immutable reply.
    const prior = db.prepare(`SELECT m.id,m.content,json_extract(m.metadata,'$.reply.to') reply_to
      FROM messages m JOIN steering_replies p ON p.message_id=m.id AND p.owner_id=m.owner_id
      WHERE m.owner_id=? AND m.run_id=? AND m.update_key=?`).get(current.owner_id, current.id, key) as
      { id: string; content: string; reply_to: string } | undefined;
    if (prior) {
      if (prior.content !== args.body || prior.reply_to !== args.replyTo)
        throw new Problem(409, "Reply publication identity was reused");
      return { messageId: prior.id, replyTo: args.replyTo };
    }
    // A failed acknowledgement may still have reached the harness. Accept its
    // explicit reply without replaying or changing the uncertain delivery.
    const target = db.prepare(`SELECT s.id FROM run_steering s
      JOIN messages m ON m.id=s.message_id AND m.owner_id=s.owner_id
      WHERE s.owner_id=? AND s.run_id=? AND s.message_id=? AND m.conversation_id=?
        AND m.role='user' AND json_extract(m.metadata,'$.automation') IS NULL
        AND s.state IN ('sending','delivered','failed')`)
      .get(current.owner_id, current.id, args.replyTo, current.conversation_id) as { id: string } | undefined;
    if (!target) throw new Problem(404, "Steered user message not found in this task");
    const message = recordConversationUpdate(current, key, {
      content: args.body, metadata: { reply: { to: args.replyTo, published: true } },
    });
    if (!message) throw new Problem(404, "Conversation not found");
    db.prepare(`INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at)
      VALUES(?,?,?,?)`).run(message.id, current.owner_id, target.id, now());
    return { messageId: message.id, replyTo: args.replyTo };
  }).immediate();
}

export function setReplyState(owner: string, messageId: string, input: unknown) {
  const state = ReplyState.parse(input);
  return db.transaction(() => {
    const reply = db.prepare(`SELECT p.message_id FROM steering_replies p
      JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
      WHERE p.owner_id=? AND p.message_id=?`).get(owner, messageId);
    if (!reply) throw new Problem(404, "Reply not found");
    db.prepare(`UPDATE steering_replies SET
      read_at=CASE WHEN @read THEN COALESCE(read_at,@at) ELSE read_at END,
      archived_at=CASE WHEN @archive IS NULL THEN archived_at WHEN @archive THEN COALESCE(archived_at,@at) ELSE NULL END
      WHERE owner_id=@owner AND message_id=@id`).run({
      owner, id: messageId, at: now(), read: state.read ? 1 : 0,
      archive: state.archived === undefined ? null : Number(state.archived),
    });
    return { ok: true };
  }).immediate();
}
