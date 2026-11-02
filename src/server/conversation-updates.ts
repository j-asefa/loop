import * as messagesQueries from "./sql/messages.js";
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
  return messagesQueries.upsertConversationUpdate(
    db,
    id(),
    data.content || "",
    JSON.stringify(MessageMetadata.parse(metadata)),
    now(),
    key,
    run.id,
    run.owner_id,
  ) as { id: string } | undefined;
}
