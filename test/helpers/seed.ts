import type Database from "better-sqlite3";
import type { z } from "zod";
import { ConnectionRecord } from "../../src/server/sql/rows.js";
import * as connections from "../../src/server/sql/connections.js";

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
