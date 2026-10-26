import { db } from "./db.js";

const delayed = new Set<string>();

/** Heartbeats describe liveness; they must never wait behind another writer or
 * replay work. Leave the old timestamp on contention and try the next tick. */
export function heartbeatWrite(label: string, write: () => unknown) {
  const timeout = db.pragma("busy_timeout", { simple: true }) as number;
  try {
    db.pragma("busy_timeout = 0");
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
  } finally {
    // This callback is synchronous, so no other request observes the temporary
    // timeout. Ordinary writes keep their existing contention policy.
    db.pragma(`busy_timeout = ${timeout}`);
  }
}
