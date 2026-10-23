import { WebSocket } from "ws";
import { db, changes } from "./db.js";
import { publicBuild } from "../shared/build.js";
import { observedBuild } from "./build-runtime.js";
import {
  historicalEvent,
  invalidate,
  PARTIAL_WORKSPACE_CAPABILITIES,
  WORKSPACE_COLLECTIONS,
  type WorkspaceEvent,
} from "../shared/workspace-events.js";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 512 * 1024;

type RevisionListener = (failed: boolean) => void;
const revisions = new Map<
  string,
  { value: string; listeners: Set<RevisionListener> }
>();
let revisionTimer: ReturnType<typeof setInterval> | undefined;
function readRevision(owner: string) {
  return JSON.stringify(
    db
      .prepare(
        `SELECT
    (SELECT epoch FROM card_revision_domain WHERE singleton=1) domain,
    (SELECT COALESCE(max(revision),0) FROM feed_revisions WHERE owner_id=?) cards,
    (SELECT COALESCE(max(revision),0) FROM done_card_revisions WHERE owner_id=?) done
  `,
      )
      .get(owner, owner),
  );
}
// Save/dismiss revisions do not all have events yet. One process timer checks
// each subscribed owner once and shares the result across that owner's sockets.
function watchRevisions(owner: string, listener: RevisionListener) {
  let record = revisions.get(owner);
  if (!record) {
    record = { value: readRevision(owner), listeners: new Set() };
    revisions.set(owner, record);
  }
  record.listeners.add(listener);
  if (!revisionTimer) {
    revisionTimer = setInterval(() => {
      for (const [owner, record] of revisions) {
        let failed = false;
        try {
          const next = readRevision(owner);
          if (next === record.value) continue;
          record.value = next;
        } catch {
          failed = true;
        }
        for (const notify of [...record.listeners]) notify(failed);
      }
    }, 5000);
    revisionTimer.unref();
  }
  return () => {
    if (!record.listeners.delete(listener)) return;
    if (!record.listeners.size) revisions.delete(owner);
    if (!revisions.size && revisionTimer) {
      clearInterval(revisionTimer);
      revisionTimer = undefined;
    }
  };
}

// Publications wake reconciliation; each socket retains its own replay cursor.
export function connectWorkspaceEvents(
  socket: WebSocket,
  url: URL,
  owner: string,
  epoch: string,
  build?: string,
) {
  const v3 = url.searchParams.get("v") === "3";
  let cursor = Number(url.searchParams.get("cursor"));
  let revisionChanged = false;
  let initial = true;
  let stopped = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const read = db.transaction(() => {
    const bounds = db
      .prepare(
        `SELECT
      (SELECT id FROM events WHERE owner_id=? ORDER BY id LIMIT 1) first,
      COALESCE((SELECT id FROM events WHERE owner_id=? ORDER BY id DESC LIMIT 1),0) last
    `,
      )
      .get(owner, owner) as { first: number | null; last: number };
    let reset =
      (initial &&
        (url.searchParams.get("epoch") !== epoch ||
          cursor < (bounds.first || 1) - 1)) ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > bounds.last;
    if (reset) cursor = bounds.last;
    let events = reset
      ? []
      : (db
          .prepare(
            `SELECT id,run_id,type,
              CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END payload
             FROM events WHERE owner_id=? AND id>? ORDER BY id LIMIT 100`,
          )
          .all(MAX_EVENT_BYTES, owner, cursor) as {
          id: number;
          run_id: string;
          type: string;
          payload: string | null;
        }[]);
    // These frames prompt HTTP reconciliation. Keep ordinary v2 replay, but
    // reset to the current watermark when a batch would exceed its byte budget.
    // Bound each selected payload before materializing it in JS; the durable
    // event stays intact for HTTP readers. This also fits the linked gateway.
    if (
      !v3 &&
      (events.some((event) => event.payload === null) ||
        Buffer.byteLength(JSON.stringify(events)) > MAX_REPLAY_BYTES)
    ) {
      reset = true;
      cursor = bounds.last;
      events = [];
    }
    const typed: { id: number; event: WorkspaceEvent }[] = [];
    if (v3) {
      // Reserve space for every revision hint and the frame envelope. A full
      // page yields to another read instead of resetting past unread rows.
      let bytes = 4096;
      for (const row of events) {
        let entry = { id: row.id, event: historicalEvent(row) };
        if (Buffer.byteLength(JSON.stringify(entry)) > MAX_EVENT_BYTES)
          entry = { id: row.id, event: invalidate(entry.event.scope) };
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + size > MAX_REPLAY_BYTES) break;
        typed.push(entry);
        bytes += size;
      }
      if (typed.length) cursor = typed.at(-1)!.id;
      if (!reset && revisionChanged)
        for (const collection of WORKSPACE_COLLECTIONS)
          typed.push({
            id: cursor,
            event: invalidate({ kind: "collection", id: collection }),
          });
      // A healthy reconnect at the current tip still carries an actionable
      // reconciliation signal; synthetic entries intentionally reuse the cursor.
      if (!reset && initial && !typed.length)
        typed.push({ id: cursor, event: invalidate() });
    } else if (events.length) cursor = events.at(-1)!.id;
    const changed = initial || reset || events.length > 0 || revisionChanged;
    revisionChanged = false;
    initial = false;
    const frame = changed
      ? v3
        ? reset
          ? {
              v: 3,
              type: "reset",
              epoch,
              cursor,
              build: build || observedBuild().id,
              buildIdentity: publicBuild(observedBuild()),
              capabilities: PARTIAL_WORKSPACE_CAPABILITIES,
            }
          : { v: 3, type: "events", epoch, cursor, events: typed }
        : {
            v: 2,
            type: reset ? "reset" : "events",
            epoch,
            cursor,
            events,
            ...(reset
              ? {
                  build: build || observedBuild().id,
                  buildIdentity: publicBuild(observedBuild()),
                }
              : {}),
          }
      : null;
    return { frame, more: !reset && cursor < bounds.last };
  });
  const pump = () => {
    scheduled = undefined;
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close(4008, "Reconnect for current workspace state");
      return;
    }
    try {
      const { frame, more } = read();
      if (frame) socket.send(JSON.stringify(frame));
      if (more) schedule();
    } catch {
      // A failed read must never establish a cursor. Reconnect and reconcile.
      socket.close(1011, "Workspace updates unavailable");
    }
  };
  const schedule = () => {
    if (!stopped && !scheduled) scheduled = setImmediate(pump);
  };
  // Subscribe before the initial read so catch-up and live wakeups have no gap.
  const unsubscribe = changes.subscribe(owner, schedule);
  let unwatch = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    unwatch();
    if (scheduled) clearImmediate(scheduled);
    socket.off("close", stop);
  };
  socket.once("close", stop);
  try {
    unwatch = watchRevisions(owner, (failed) => {
      if (failed) socket.close(1011, "Workspace updates unavailable");
      else {
        revisionChanged = true;
        schedule();
      }
    });
    pump();
  } catch {
    stop();
    socket.close(1011, "Workspace updates unavailable");
  }
  return stop;
}
