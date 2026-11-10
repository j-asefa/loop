import { db } from "./db.js";
import { withoutBusyWait } from "./busy-wait.js";

const delayed = new Set<string>();

/** Heartbeats describe liveness; they must never wait behind another writer or
 * replay work. Leave the old timestamp on contention and try the next tick. */
export function heartbeatWrite(label: string, write: () => unknown) {
  return withoutBusyWait(db, () => {
    try {
      write();
      delayed.delete(label);
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "SQLITE_BUSY" && !code?.startsWith("SQLITE_BUSY_"))
        throw error;
      if (!delayed.has(label)) {
        delayed.add(label);
        console.warn(
          JSON.stringify({
            diagnostic: "heartbeat-delayed",
            heartbeat: label,
            code,
          }),
        );
      }
      return false;
    }
  });
}
