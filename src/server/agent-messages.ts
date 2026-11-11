import * as messagesQueries from "./sql/messages.js";
import { db } from "./db.js";
import { Problem, ownedAgent } from "./domain.js";
import { z } from "zod";

export function agentMessages(owner: string, agent: string, before?: string) {
  ownedAgent(agent, owner);
  let cursor: [number, number, string] = [Number.MAX_SAFE_INTEGER, 2, ""];
  if (before) {
    try {
      cursor = z
        .tuple([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.union([z.literal(0), z.literal(1)]),
          z.string().min(1).max(150),
        ])
        .parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
    } catch {
      throw new Problem(400, "Invalid message cursor");
    }
  }
  const items = messagesQueries.agentOutputPage(
    db,
    owner,
    agent,
    ...cursor,
  ) as {
    id: string;
    content: string;
    created_at: number;
    conversation_id: string | null;
    run_id: string | null;
    final: number;
    model: string | null;
  }[];
  const hasMore = items.length > 50;
  if (hasMore) items.pop();
  const last = items.at(-1);
  return {
    items,
    next:
      hasMore && last
        ? Buffer.from(
            JSON.stringify([last.created_at, last.final, last.id]),
          ).toString("base64url")
        : null,
  };
}
