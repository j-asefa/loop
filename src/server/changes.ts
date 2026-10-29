import { withoutPassiveWorkspaceRead } from "./workspace-read-context.js";
import type { WorkspaceSubject } from "../shared/workspace-events.js";
import type Database from "better-sqlite3";
import { withoutFleetAction } from "./fleet-action-context.js";

// Publications identify durable rows. Payloads stay in SQLite so a large event
// cannot bypass the consumer's replay byte limits merely by waking it.
export type CommittedEvent = Readonly<{
  id: number;
  owner_id: string;
  run_id: string | null;
  subject_kind: WorkspaceSubject["kind"];
  subject_id: string;
  type: string;
}>;
type Subscriber = (events: readonly CommittedEvent[]) => void;

/** One instance on the process database connection; separate fixtures may own one. */
export function createChangeBus(
  db: Database.Database,
  { pollMs = 250, pageSize = 256 } = {},
) {
  if (db.inTransaction)
    throw new Error("Create the change bus outside a transaction");
  const subscribers = new Map<string | null, Set<Subscriber>>();
  const select = db.prepare(
    "SELECT id,owner_id,run_id,subject_kind,subject_id,type FROM events WHERE id>? ORDER BY id LIMIT ?",
  );
  const localChanges = db.prepare("SELECT total_changes() n");
  let localVersion = (localChanges.get() as { n: number }).n;
  let version = db.pragma("data_version", { simple: true });
  // Existing history belongs to consumer snapshots/replay. Establish the live
  // starting cursor from a committed row, after the version sample so a foreign
  // commit around startup cannot disappear between the baseline and first poll.
  let cursor =
    (
      db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").get() as
        { id: number } | undefined
    )?.id ?? 0;
  let dirty = false;
  let draining = false;
  let closed = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const limit = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 256;
  const interval =
    Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= 2 ** 31 - 1
      ? pollMs
      : 250;

  function close() {
    closed = true;
    clearInterval(poller);
    if (scheduled) clearImmediate(scheduled);
    if (retry) clearTimeout(retry);
    scheduled = undefined;
    subscribers.clear();
  }
  function wake() {
    if (closed) return;
    dirty = true;
    if (retry) clearTimeout(retry);
    retry = undefined;
    if (!draining && !scheduled)
      scheduled = setImmediate(() =>
        withoutFleetAction(() => withoutPassiveWorkspaceRead(drain)),
      );
  }
  function retryLater() {
    if (closed || retry) return;
    dirty = true;
    retry = setTimeout(() => {
      retry = undefined;
      wake();
    }, 100);
    retry.unref();
  }
  function drain() {
    scheduled = undefined;
    if (retry) clearTimeout(retry);
    retry = undefined;
    if (closed) return;
    if (!db.open) return close();
    // Transactions are synchronous. If a caller nonetheless holds one across
    // a macrotask, retain the wake rather than reading its uncommitted writes.
    if (db.inTransaction) return retryLater();
    draining = true;
    dirty = false;
    let more = false;
    try {
      // Sample BEFORE reading: a foreign commit after this sample is either in
      // this page or still changes data_version for the next poll. Never set the
      // baseline after reading and accidentally absorb an unread foreign row.
      version = db.pragma("data_version", { simple: true });
      localVersion = (localChanges.get() as { n: number }).n;
      const rows = select.all(cursor, limit) as CommittedEvent[];
      const through = rows.at(-1)?.id;
      const byOwner = new Map<string | null, CommittedEvent[]>();
      for (const row of rows) {
        Object.freeze(row);
        const events = byOwner.get(row.owner_id) || [];
        events.push(row);
        byOwner.set(row.owner_id, events);
      }
      byOwner.set(null, rows);
      // Snapshot subscribers before invoking any of them. A subscription made
      // during delivery starts with the next page, not halfway through this one.
      const deliveries = [...subscribers].map(([owner, callbacks]) => ({
        owner,
        registered: callbacks,
        events: Object.freeze(byOwner.get(owner) || []),
        callbacks: [...callbacks],
      }));
      for (const { owner, registered, events, callbacks } of deliveries) {
        if (!events.length) continue;
        for (const callback of callbacks) {
          if (
            subscribers.get(owner) !== registered ||
            !registered.has(callback)
          )
            continue;
          try {
            void Promise.resolve(callback(events)).catch(() => {});
          } catch {
            // A subscriber cannot fail a committed mutation or other delivery.
          }
        }
      }
      if (through !== undefined) cursor = through;
      more = rows.length === limit;
    } catch {
      // Retry a failed read even if its sampled data_version stays unchanged.
      retryLater();
      return;
    } finally {
      draining = false;
    }
    // Each page yields. Writes by a subscriber wake this same drain, never a
    // direct publication that could overtake a lower-id foreign commit.
    if (more || dirty) wake();
  }
  const poller = setInterval(() => {
    if (!db.open) return close();
    if (db.inTransaction) return;
    try {
      const next = db.pragma("data_version", { simple: true });
      const local = (localChanges.get() as { n: number }).n;
      if (next !== version || local !== localVersion || dirty) {
        localVersion = local;
        version = next;
        wake();
      }
    } catch {
      retryLater();
    }
  }, interval);
  poller.unref();
  return {
    wake,
    close,
    /** null is reserved for process-wide consumers such as the worker. */
    subscribe(owner: string | null, callback: Subscriber) {
      if (closed) throw new Error("Change bus is closed");
      const callbacks = subscribers.get(owner) || new Set<Subscriber>();
      callbacks.add(callback);
      subscribers.set(owner, callbacks);
      wake();
      return () => {
        if (!callbacks.delete(callback)) return;
        if (!callbacks.size && subscribers.get(owner) === callbacks)
          subscribers.delete(owner);
      };
    },
    get subscriberCount() {
      return [...subscribers.values()].reduce(
        (count, set) => count + set.size,
        0,
      );
    },
  };
}
