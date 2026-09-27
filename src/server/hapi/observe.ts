import { db, now } from "../db.js";
import { environment, hub } from "./environments.js";
import { reconcile } from "./adapter.js";
import type { NativeSession } from "./contracts.js";
// SSE is a low-latency wake-up. REST remains authoritative, with compound
// cursors, so lost/replayed frames never bypass durable projection.
const streams = new Map<string, AbortController>();
export function observeEnvironments() {
  const environments = db
    .prepare("SELECT * FROM execution_environments WHERE revoked_at IS NULL")
    .all() as any[];
  for (const [id, controller] of streams)
    if (!environments.some((e) => e.host_id === id)) {
      controller.abort();
      streams.delete(id);
    }
  for (const e of environments) {
    if (streams.has(e.host_id)) continue;
    const controller = new AbortController();
    streams.set(e.host_id, controller);
    const client = hub(environment(e.owner_id, e.host_id));
    void client
      .events(e.event_cursor, controller.signal, async (event, cursor) => {
        if (event.type === "heartbeat") return;
        const sessions = db
          .prepare("SELECT * FROM native_sessions WHERE environment_id=?")
          .all(e.host_id) as NativeSession[];
        for (const s of sessions) await reconcile(s);
        // Commit only after all affected projections/permissions are durable. A
        // failed reconnect restarts from the old cursor or Hub's REST gap verdict.
        if (cursor)
          db.prepare(
            "UPDATE execution_environments SET event_cursor=? WHERE host_id=? AND revoked_at IS NULL",
          ).run(cursor, e.host_id);
      })
      .catch(() => {})
      .finally(() => {
        if (streams.get(e.host_id) === controller) streams.delete(e.host_id);
      });
  }
}

export function stopObservingEnvironments() {
  for (const controller of streams.values()) controller.abort();
  streams.clear();
}
