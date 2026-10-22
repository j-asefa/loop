import { WebSocket } from "ws";
import { db } from "./db.js";
import { publicBuild } from "../shared/build.js";
import { observedBuild } from "./build-runtime.js";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 512 * 1024;

// Both API and worker processes commit to SQLite. Observe their durable
// watermarks, including edits which do not emit a run event (save/dismiss).
// The browser keeps its own pagers; these frames only prompt reconciliation.
export function connectWorkspaceEvents(
  socket: WebSocket,
  url: URL,
  owner: string,
  epoch: string,
  build?: string,
) {
  let cursor = Number(url.searchParams.get("cursor"));
  let revision = "";
  let initial = true;
  const read = db.transaction(() => {
    const bounds = db
      .prepare(
        `SELECT
      (SELECT id FROM events WHERE owner_id=? ORDER BY id LIMIT 1) first,
      COALESCE((SELECT id FROM events WHERE owner_id=? ORDER BY id DESC LIMIT 1),0) last
    `,
      )
      .get(owner, owner) as { first: number | null; last: number };
    const cards = db
      .prepare(
        `SELECT
      (SELECT epoch FROM card_revision_domain WHERE singleton=1) domain,
      (SELECT COALESCE(max(revision),0) FROM feed_revisions WHERE owner_id=?) cards,
      (SELECT COALESCE(max(revision),0) FROM done_card_revisions WHERE owner_id=?) done
    `,
      )
      .get(owner, owner);
    const nextRevision = JSON.stringify(cards);
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
          payload: string | null;
        }[]);
    // These frames prompt HTTP reconciliation. Keep ordinary v2 replay, but
    // reset to the current watermark when a batch would exceed its byte budget.
    // Bound each selected payload before materializing it in JS; the durable
    // event stays intact for HTTP readers. This also fits the linked gateway.
    if (
      events.some((event) => event.payload === null) ||
      Buffer.byteLength(JSON.stringify(events)) > MAX_REPLAY_BYTES
    ) {
      reset = true;
      cursor = bounds.last;
      events = [];
    }
    if (events.length) cursor = events.at(-1)!.id;
    const changed =
      initial || reset || events.length > 0 || revision !== nextRevision;
    revision = nextRevision;
    initial = false;
    return changed
      ? {
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
  });
  const poll = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close(4008, "Reconnect for current workspace state");
      return;
    }
    try {
      const frame = read();
      if (frame) socket.send(JSON.stringify(frame));
    } catch {
      // A failed read must never establish a cursor. Reconnect and reconcile.
      socket.close(1011, "Workspace updates unavailable");
    }
  };
  poll();
  const timer = setInterval(poll, 250);
  return () => clearInterval(timer);
}
