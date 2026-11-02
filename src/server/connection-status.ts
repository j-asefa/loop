import * as connectionsQueries from "./sql/connections.js";
import * as eventsQueries from "./sql/events.js";
import { changes, db, now } from "./db.js";
import { parseEmission } from "../shared/workspace-events.js";

/** Persist status and its secret-free notification in the same transaction. */
export function writeConnectionStatus<T>(id: string, write: () => T): T {
  return db
    .transaction(() => {
      const result = write();
      const row = connectionsQueries.ownerStatus(db, id) as
        { owner_id: string; status: string } | undefined;
      if (row) {
        const payload = { status: row.status };
        parseEmission(null, "connection.status", payload, id);
        eventsQueries.connectionStatus(
          db,
          row.owner_id,
          id,
          JSON.stringify(payload),
          now(),
        );
        changes.wake();
      }
      return result;
    })
    .immediate();
}
