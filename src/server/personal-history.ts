import * as messagesQueries from "./sql/messages.js";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import { z } from "zod";

type HistoryRow = {
  id: string;
  content: string;
  created_at: number;
  conversation_id: string;
  attachments: string | null;
  conversation_title: string;
  agent_name: string | null;
  provider: string | null;
  agent_id: string | null;
  project_name: string | null;
};

export { personalMessageSql } from "./sql/messages.js";

// The owner is supplied by authentication, never by query parameters. Projects
// and conversations currently use this same ownership boundary (no memberships).
export function personalHistory(owner: string, before?: string, q?: string) {
  let cursor: [number, string] = [Number.MAX_SAFE_INTEGER, ""];
  if (before) {
    try {
      cursor = z
        .tuple([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.string().min(1).max(150),
        ])
        .parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
    } catch {
      throw new Problem(400, "Invalid prompt cursor");
    }
  }
  const items = messagesQueries.personalHistory(
    db,
    owner,
    q || null,
    ...cursor,
  ) as HistoryRow[];
  const more = items.length > 50;
  if (more) items.pop();
  const last = items.at(-1);
  return {
    items: items.map((item) => ({
      ...item,
      attachments: JSON.parse(item.attachments || "[]"),
    })),
    next:
      more && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString(
            "base64url",
          )
        : null,
  };
}

/** How many prompts the owner has sent: the same set the list pages through. */
export function personalPromptCount(owner: string) {
  return (messagesQueries.personalCount(db, owner) as { n: number }).n;
}
