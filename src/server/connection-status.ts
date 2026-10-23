import { changes, db, now } from "./db.js";
import { parseEmission } from "../shared/workspace-events.js";

/** Persist status and its secret-free notification in the same transaction. */
export function writeConnectionStatus<T>(id: string, write: () => T): T {
  return db
    .transaction(() => {
      const result = write();
      const row = db
        .prepare("SELECT owner_id,status FROM connections WHERE id=?")
        .get(id) as { owner_id: string; status: string } | undefined;
      if (row) {
        const payload = { status: row.status };
        parseEmission(null, "connection.status", payload, id);
        db.prepare(
          `INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
        VALUES(?,NULL,'connection',?,'connection.status',?,?)`,
        ).run(row.owner_id, id, JSON.stringify(payload), now());
        changes.wake();
      }
      return result;
    })
    .immediate();
}
