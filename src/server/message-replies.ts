import { db } from "./db.js";
import { Problem } from "./domain.js";
import { publicTraceFilter } from "./traces.js";
import type { ReplyContext } from "../shared/replies.js";

export function messageReplyContext(
  owner: string,
  agent: string,
  conversation: string | undefined,
  message: string,
): ReplyContext {
  if (!conversation)
    throw new Problem(400, "Choose the message's conversation to reply");
  // Only public messages belonging to this owner, agent and conversation can
  // be quoted: the agent's replies and your own prompts. Tool output is not.
  const entry = message.startsWith("trace:")
    ? db
        .prepare(
          `SELECT t.content,t.created_at,a.name FROM run_traces t
        JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
        JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id
        WHERE t.owner_id=? AND r.agent_id=? AND r.conversation_id=?
          AND 'trace:'||t.id=? AND t.kind='message'
          AND length(trim(t.content))>0 AND ${publicTraceFilter}`,
        )
        .get(owner, agent, conversation, message)
    : db
        .prepare(
          `SELECT m.content,m.created_at,a.name,m.role='user' AS mine FROM messages m
        JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
        JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id
        WHERE m.owner_id=? AND c.agent_id=? AND m.conversation_id=? AND m.id=?
          AND m.role IN ('assistant','user') AND json_extract(m.metadata,'$.partial') IS NOT 1
          AND length(trim(m.content))>0`,
        )
        .get(owner, agent, conversation, message);
  if (!entry) throw new Problem(404, "Message not found");
  const { mine, ...rest } = entry as Omit<ReplyContext, "id" | "mine"> & {
    mine?: number;
  };
  return { id: message, ...rest, ...(mine ? { mine: true } : {}) };
}
