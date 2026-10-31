import type { FeedCategory } from "../shared/feed-categories.js";
import { idleFeedThreadSql } from "./feed-card-read.js";

/** Correlated to search_documents d, before either retrieval path ranks hits. */
export function searchCategorySql(category: FeedCategory, agent: boolean) {
  const visible = agent ? "1" : "NOT t.hide_results";
  const thread = `t.owner_id=d.owner_id AND t.conversation_id=d.conversation_id AND t.kind='thread'`;
  if (category === "threads")
    return `EXISTS(SELECT 1 FROM feed_cards t WHERE ${thread} AND NOT t.snoozed AND ${visible})`;

  // Documents retain their own run/message identity. A conversation can have
  // completed results, current work and queued follow-ups at the same time.
  const source = `SELECT m.run_id,m.id message_id FROM messages m
      WHERE substr(d.id,1,8)='message:' AND m.id=substr(d.id,9) AND m.owner_id=d.owner_id AND m.conversation_id=d.conversation_id
    UNION ALL
    SELECT a.run_id,json_extract(a.metadata,'$.messageId') message_id FROM artifacts a
      WHERE substr(d.id,1,9)='artifact:' AND a.id=substr(d.id,10) AND a.owner_id=d.owner_id AND a.conversation_id=d.conversation_id`;
  const notReply = `NOT EXISTS(SELECT 1 FROM steering_replies reply WHERE reply.owner_id=d.owner_id AND reply.message_id=s.message_id)`;
  if (category === "replies")
    return `EXISTS(SELECT 1 FROM (${source}) s
      JOIN steering_replies p ON p.owner_id=d.owner_id AND p.message_id=s.message_id
      WHERE p.archived_at IS NULL)`;

  if (category === "done")
    return `EXISTS(SELECT 1 FROM (${source}) s
      JOIN feed_cards p ON p.owner_id=d.owner_id AND p.conversation_id=d.conversation_id
      JOIN feed_cards t ON ${thread}
      WHERE NOT p.hidden AND ${visible} AND ${notReply} AND (
        (p.kind='result' AND (p.card_key='run:'||s.run_id OR p.card_key='message:'||s.message_id))
        OR (p.kind='idle' AND ${idleFeedThreadSql("t", "?")}
          AND NOT EXISTS(SELECT 1 FROM feed_cards r WHERE r.owner_id=p.owner_id AND r.conversation_id=p.conversation_id AND r.kind='result'))))`;

  return `EXISTS(SELECT 1 FROM (${source}) s
    JOIN feed_cards t ON ${thread}
    JOIN runs r ON r.id=s.run_id AND r.owner_id=d.owner_id AND r.conversation_id=d.conversation_id
    WHERE ${notReply} AND ${category === "working" ? "t.working=1 AND r.id=json_extract(t.payload,'$.row.run_id')" : "t.queued=1 AND r.state='queued'"})`;
}
