import type Database from "better-sqlite3";
import type { createChangeBus } from "./changes.js";

const MAX_DELAY = 2_147_483_647;

export function changeClock(db: Database.Database, owner: string) {
  const next = db
    .prepare(
      "SELECT min(expires_at) next FROM change_expiries WHERE owner_id=? AND processed=0",
    )
    .get(owner) as { next: number | null };
  return { serverNow: Date.now(), nextDeadline: next.next };
}

/** One scheduler per process, one timer per owner; SQLite arbitrates processes. */
export function createDeadlineScheduler(
  db: Database.Database,
  changes: ReturnType<typeof createChangeBus>,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Set<string>();
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let stopped = false;
  const insert =
    db.prepare(`INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)
    VALUES(?,NULL,'collection',?,?,?,?)`);
  const inspect = db.transaction((owner: string) => {
    const clock = changeClock(db, owner);
    const prior = db
      .prepare("SELECT next_deadline FROM change_deadlines WHERE owner_id=?")
      .get(owner) as { next_deadline: number | null } | undefined;
    return {
      clock,
      needsWrite:
        (clock.nextDeadline !== null &&
          clock.nextDeadline <= clock.serverNow) ||
        Boolean(
          (prior || clock.nextDeadline !== null) &&
          prior?.next_deadline !== clock.nextDeadline,
        ),
    };
  });
  const reconcile = db.transaction((owner: string) => {
    const clock = changeClock(db, owner);
    const due = db
      .prepare(
        "SELECT kind,subject_id FROM change_expiries WHERE owner_id=? AND processed=0 AND expires_at<=?",
      )
      .all(owner, clock.serverNow) as {
      kind: "approval" | "watch";
      subject_id: string;
    }[];
    if (due.length) {
      db.prepare(
        "UPDATE change_expiries SET processed=1 WHERE owner_id=? AND processed=0 AND expires_at<=?",
      ).run(owner, clock.serverNow);
      // Approval expiry has always been a read-time refusal, not permission to
      // fail a run or replay an external effect. Watch expiry hides its display.
      // The persisted processed bit makes the notification restart-safe while
      // leaving both source timestamps and their existing consequences intact.
      const affected = new Set(["feed", "results"]);
      for (const row of due)
        affected.add(row.kind === "approval" ? "approvals" : "pulls");
      const scopes = [...affected].map((id) => ({ kind: "collection", id }));
      insert.run(
        owner,
        "feed",
        "invalidate",
        JSON.stringify({ scope: scopes[0], scopes: scopes.slice(1) }),
        clock.serverNow,
      );
      clock.nextDeadline = changeClock(db, owner).nextDeadline;
    }
    const prior = db
      .prepare("SELECT next_deadline FROM change_deadlines WHERE owner_id=?")
      .get(owner) as { next_deadline: number | null } | undefined;
    if (
      due.length ||
      ((prior || clock.nextDeadline !== null) &&
        prior?.next_deadline !== clock.nextDeadline)
    ) {
      db.prepare(
        "INSERT INTO change_deadlines VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_deadline=excluded.next_deadline",
      ).run(owner, clock.nextDeadline);
      insert.run(
        owner,
        "all",
        "deadline",
        JSON.stringify(clock),
        clock.serverNow,
      );
      changes.wake();
    }
    return clock;
  });
  function close() {
    stopped = true;
    unsubscribe();
    if (scheduled) clearImmediate(scheduled);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
  }
  function flush() {
    scheduled = undefined;
    if (stopped) return;
    if (!db.open) return close();
    for (const owner of [...pending]) {
      pending.delete(owner);
      const previous = timers.get(owner);
      if (previous) clearTimeout(previous);
      timers.delete(owner);
      try {
        // Ordinary streaming updates need no write lock. Recheck inside the
        // immediate transaction only if the read snapshot found work; producer
        // events still wake us when another process changes an expiry later.
        const observed = inspect(owner);
        const clock = observed.needsWrite
          ? reconcile.immediate(owner)
          : observed.clock;
        if (clock.nextDeadline !== null) {
          const timer = setTimeout(
            () => {
              if (timers.get(owner) !== timer) return;
              timers.delete(owner);
              enqueue(owner);
            },
            Math.max(
              1,
              Math.min(MAX_DELAY, clock.nextDeadline - clock.serverNow),
            ),
          );
          timer.unref();
          timers.set(owner, timer);
        }
      } catch {
        // A busy database cannot drop an expiry obligation. It remains durable.
        const timer = setTimeout(() => {
          timers.delete(owner);
          enqueue(owner);
        }, 250);
        timer.unref();
        timers.set(owner, timer);
      }
    }
  }
  function enqueue(owner: string) {
    if (stopped) return;
    pending.add(owner);
    if (!scheduled) scheduled = setImmediate(flush);
  }
  const unsubscribe = changes.subscribe(null, (events) => {
    for (const event of events) enqueue(event.owner_id);
  });
  // Seed from durable rows, not only future timers or events since this start.
  for (const row of db
    .prepare(
      "SELECT owner_id FROM change_expiries UNION SELECT owner_id FROM change_deadlines",
    )
    .all() as { owner_id: string }[])
    enqueue(row.owner_id);
  return { close };
}
