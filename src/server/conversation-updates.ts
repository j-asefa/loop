import { MessageMetadata } from "./row-schemas.js";
import { db, id, now } from "./db.js";
import type { Run } from "./queue.js";

/** Public output has a durable message identity independent of execution traces. */
export function recordConversationUpdate(
  run: Pick<Run, "id" | "owner_id">,
  key: string,
  data: { content?: string; metadata?: unknown },
) {
  const metadata = {
    ...MessageMetadata.parse(data.metadata === undefined ? {} : data.metadata),
    progress: true,
  };
  return db
    .prepare(
      `INSERT INTO messages(
    id,owner_id,conversation_id,run_id,role,content,metadata,created_at,update_key)
    SELECT ?,r.owner_id,r.conversation_id,r.id,'assistant',?,?,?,?
    FROM runs r JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    WHERE r.id=? AND r.owner_id=?
    ON CONFLICT(owner_id,run_id,update_key) DO UPDATE SET
      content=excluded.content,metadata=excluded.metadata
    RETURNING id`,
    )
    .get(
      id(),
      data.content || "",
      JSON.stringify(MessageMetadata.parse(metadata)),
      now(),
      key,
      run.id,
      run.owner_id,
    ) as { id: string } | undefined;
}
