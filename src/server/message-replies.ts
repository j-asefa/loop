import * as messagesQueries from "./sql/messages.js";
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
  const entry = messagesQueries.replyContext(
    db,
    owner,
    agent,
    conversation,
    message,
  );
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
