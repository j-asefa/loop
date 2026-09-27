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
    SELECT 'trace:'||t.id id,t.content,t.created_at,
    r.conversation_id,r.id run_id,0 final FROM run_traces t
    JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.agent_id=? AND t.kind='message'
    AND json_extract(t.metadata,'$.final') IS NOT 1 AND length(trim(t.content))>0
    UNION ALL
    SELECT COALESCE('trace:'||answer.id,m.id) id,m.content,
    COALESCE(answer.created_at,m.created_at) created_at,m.conversation_id,
    m.run_id,1 final FROM messages m JOIN conversations c ON c.id=m.conversation_id
    LEFT JOIN run_traces answer ON answer.id=(
      SELECT max(t.id) FROM run_traces t WHERE t.owner_id=m.owner_id
      AND t.run_id=m.run_id AND t.kind='message' AND json_extract(t.metadata,'$.final')=1
    )
    WHERE m.owner_id=? AND c.agent_id=? AND m.role='assistant'
    AND json_extract(m.metadata,'$.partial') IS NOT 1
    AND length(trim(m.content))>0
    ) SELECT * FROM entries WHERE (created_at,final,id)<(?,?,?)
    ORDER BY created_at DESC,final DESC,id DESC LIMIT 51`,
    )
    .all(owner, agent, owner, agent, ...cursor) as {
    id: string;
    content: string;
    created_at: number;
    conversation_id: string | null;
    run_id: string | null;
    final: number;
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
