import { changes, db } from "./db.js";
import { Problem } from "../shared/problem.js";
import type { Run } from "./queue.js";
import type { WorkspaceEvent } from "../shared/workspace-events.js";

type EventType = WorkspaceEvent["type"] | "children" | "fallback" | "*";
type Identity = Pick<Run, "id" | "owner_id">;
const active = new Map<string, ReturnType<typeof subscribe>>();

function subscribe(run: Identity) {
  const controller = new AbortController();
  const listeners = new Map<EventType, Set<() => void>>();
  let revision = 0;
  let references = 0;
  let state: string | undefined;
  const publish = (type: EventType) => {
    revision++;
    for (const listener of new Set([
      ...(listeners.get(type) || []),
      ...(listeners.get("*") || []),
    ])) {
      try {
        listener();
      } catch {
        /* One consumer cannot suppress another. */
      }
    }
  };
  function check() {
    const row = db
      .prepare(
        `SELECT r.state,
      CASE WHEN r.kind='agent' THEN json_extract(r.payload,'$.connectionId') END connection_id,c.status
      FROM runs r LEFT JOIN connections c
      ON c.id=json_extract(r.payload,'$.connectionId') AND c.owner_id=r.owner_id
      WHERE r.id=? AND r.owner_id=?`,
      )
      .get(run.id, run.owner_id) as
      | { state: string; connection_id: string | null; status: string | null }
      | undefined;
    state = row?.state;
    if (!row || ["cancelled", "interrupted", "failed"].includes(row.state))
      controller.abort(
        new Problem(
          409,
          row
            ? `This run was ${row.state}.`
            : "This run is no longer available.",
        ),
      );
    else if (row.connection_id && row.status !== "connected")
      controller.abort(
        new Problem(
          409,
          "The provider connection was disconnected. Reconnect it and review partial work before retrying.",
          { cause: "connection_disconnected" },
        ),
      );
    return row;
  }
  const unsubscribe = changes.subscribe(run.owner_id, (events) => {
    const relevant = events.filter((event) => event.run_id === run.id);
    const connection = events.some(
      (event) => event.subject_kind === "connection",
    );
    if (relevant.length || connection) {
      const row = check();
      for (const event of relevant) publish(event.type as EventType);
      if (
        events.some(
          (event) =>
            event.subject_kind === "connection" &&
            event.subject_id === row?.connection_id,
        )
      )
        publish("connection.status");
    }
    // Delegation completion belongs to the child run. Wake its waiting parent
    // without manufacturing a parent event or replaying a tool effect.
    if (
      events.some(
        (event) =>
          event.run_id &&
          ["completed", "failed", "cancelled", "interrupted"].includes(
            event.type,
          ) &&
          db
            .prepare(
              "SELECT 1 FROM delegations WHERE parent_run_id=? AND child_run_id=?",
            )
            .get(run.id, event.run_id),
      )
    )
      publish("children");
  });
  const fallback = setInterval(() => {
    if (!db.open || db.inTransaction) return;
    try {
      check();
      publish("fallback");
    } catch {
      /* Retry at the next shared fallback. */
    }
  }, 2000);
  fallback.unref();
  if (!db.inTransaction) check();
  return {
    owner: run.owner_id,
    acquire() {
      references++;
      let released = false;
      const removers = new Set<() => void>();
      function on(type: EventType, listener: () => void) {
        if (released) throw new Error("Run subscription has been released");
        const set = listeners.get(type) || new Set();
        set.add(listener);
        listeners.set(type, set);
        const remove = () => {
          set.delete(listener);
          removers.delete(remove);
        };
        removers.add(remove);
        return remove;
      }
      return {
        signal: controller.signal,
        get revision() {
          return revision;
        },
        get state() {
          return state;
        },
        on,
        // Capture revision before starting a known pending operation. Register
        // first, then recheck, so a completion during the operation is not lost.
        wait(after: number, signal?: AbortSignal) {
          return new Promise<void>((resolve, reject) => {
            const abort = () =>
              finish(
                signal?.aborted ? signal.reason : controller.signal.reason,
              );
            const finish = (error?: unknown) => {
              remove();
              signal?.removeEventListener("abort", abort);
              controller.signal.removeEventListener("abort", abort);
              error === undefined ? resolve() : reject(error);
            };
            const remove = on("*", () => finish());
            signal?.addEventListener("abort", abort, { once: true });
            controller.signal.addEventListener("abort", abort, { once: true });
            if (signal?.aborted || controller.signal.aborted) abort();
            else if (revision !== after) finish();
          });
        },
        release() {
          if (released) return;
          released = true;
          for (const remove of removers) remove();
          if (--references) return;
          clearInterval(fallback);
          unsubscribe();
          active.delete(run.id);
        },
      };
    },
  };
}

/** One committed subscription and one recovery timer per held run in a process. */
export function watchRun(run: Identity) {
  let shared = active.get(run.id);
  if (shared && shared.owner !== run.owner_id)
    throw new Problem(404, "Run is not available in this workspace");
  if (!shared) {
    shared = subscribe(run);
    active.set(run.id, shared);
  }
  return shared.acquire();
}
