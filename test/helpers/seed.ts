import type Database from "better-sqlite3";
import type { z } from "zod";
import { ConnectionRecord, MessageRecord } from "../../src/server/sql/rows.js";
import * as connections from "../../src/server/sql/connections.js";
import * as messages from "../../src/server/sql/messages.js";

type ConnectionRow = z.infer<typeof ConnectionRecord>;
type ConnectionSeed = Pick<
  ConnectionRow,
  "id" | "owner_id" | "secret" | "models" | "created_at"
> &
  Partial<Pick<ConnectionRow, "provider" | "label" | "status" | "metadata">>;

/** Current valid rows only; historical and corrupt storage fixtures stay explicit. */
export function seedConnection(db: Database.Database, input: ConnectionSeed) {
  const row = ConnectionRecord.parse({
    provider: "openai",
    label: "Fixture",
    status: "connected",
    metadata: "{}",
    ...input,
  });
  connections.insert(
    db,
    row.id,
    row.owner_id,
    row.provider,
    row.label,
    row.secret,
    row.status,
    row.models,
    row.metadata,
    row.created_at,
  );
  return row;
}

const MessageSeedRecord = MessageRecord.pick({
  id: true,
  owner_id: true,
  conversation_id: true,
  run_id: true,
  role: true,
  content: true,
  metadata: true,
  created_at: true,
});
type MessageSeedRow = z.infer<typeof MessageSeedRecord>;
type MessageSeed = Omit<MessageSeedRow, "run_id" | "metadata"> &
  Partial<Pick<MessageSeedRow, "run_id" | "metadata">>;

/** Ordinals and revisions stay database-managed; imported rowids stay explicit. */
export function seedMessage(db: Database.Database, input: MessageSeed) {
  const row = MessageSeedRecord.parse({
    run_id: null,
    metadata: "{}",
    ...input,
  });
  messages.insert(
    db,
    row.id,
    row.owner_id,
    row.conversation_id,
    row.run_id,
    row.role,
    row.content,
    row.metadata,
    row.created_at,
  );
  return row;
}
