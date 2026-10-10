import { db } from "./db.js";
import { owned, Problem } from "./domain.js";
import { z } from "zod";

export function agentMessages(owner: string, agent: string, before?: string) {
  owned("agents", agent, owner);
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
  const items = db
    .prepare(
      `WITH entries AS (
    SELECT m.id,m.content,COALESCE((SELECT f.created_at FROM messages f
        WHERE json_extract(m.metadata,'$.progress') IS NOT 1
          AND f.owner_id=m.owner_id AND f.run_id=m.run_id AND f.update_key IS NOT NULL
          AND json_extract(f.metadata,'$.final')=1
        ORDER BY f.rowid DESC LIMIT 1),m.created_at) created_at,m.conversation_id,m.run_id,
      CASE WHEN json_extract(m.metadata,'$.progress')=1 THEN 0 ELSE 1 END final
    FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
    WHERE m.owner_id=? AND c.agent_id=? AND m.role='assistant'
      AND json_extract(m.metadata,'$.partial') IS NOT 1
      AND NOT (json_extract(m.metadata,'$.progress') IS 1 AND json_extract(m.metadata,'$.final') IS 1)
      AND length(trim(m.content))>0
    ) SELECT *, (SELECT json_extract(r.payload,'$.model') FROM runs r WHERE r.id=entries.run_id AND r.owner_id=?) model FROM entries WHERE (created_at,final,id)<(?,?,?)
    ORDER BY created_at DESC,final DESC,id DESC LIMIT 51`,
    )
    .all(owner, agent, owner, ...cursor) as {
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
