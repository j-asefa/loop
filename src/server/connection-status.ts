import * as connectionsQueries from "./sql/connections.js";
import { db, emit } from "./db.js";

/** Persist status and its secret-free notification in the same transaction. */
export function writeConnectionStatus<T>(id: string, write: () => T): T {
  return db
    .transaction(() => {
      const result = write();
      const row = connectionsQueries.ownerStatus(db, id);
      if (row)
        emit(row.owner_id, { kind: "connection", id }, "connection.status", {
          status: row.status,
        });
      return result;
    })
    .immediate();
}
