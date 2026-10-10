import { db } from "./db.js";
import { Problem } from "./domain.js";
import type { ReplyContext } from "../shared/replies.js";

export function messageReplyContext(
  owner: string,
  agent: string,
  conversation: string | undefined,
  message: string,
  excerpt?: string,
): ReplyContext {
  if (!conversation)
    throw new Problem(400, "Choose the message's conversation to reply");
  // Only public messages belonging to this owner, agent and conversation can
  // be quoted: the agent's replies and your own prompts. Tool output is not.
  const entry = db
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
  // A highlighted excerpt must be text the message actually contains, so the
  // quote's attribution stays true.
  const part = excerpt?.trim();
  if (part && !rest.content.includes(part))
    throw new Problem(
      400,
      "Highlight text from the message you are replying to",
    );
  return {
    id: message,
    ...rest,
    ...(part && part !== rest.content.trim()
      ? { content: part, excerpt: true }
      : {}),
    ...(mine ? { mine: true } : {}),
  };
}
