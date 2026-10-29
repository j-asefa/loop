import { workspaceApi } from "../shared/workspace-api.js";
import { WebSocket } from "ws";
import { db, changes, ensureWorkspaceOwner, workspaceClock } from "./db.js";
import { publicBuild } from "../shared/build.js";
import { observedBuild } from "./build-runtime.js";
import {
  historicalEvent,
  invalidate,
  COMPLETE_WORKSPACE_CAPABILITIES,
  type WorkspaceEvent,
} from "../shared/workspace-events.js";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 512 * 1024;

/** The transport owns authentication and confirmation; this drain only offers
 * canonical frames. Browser and token sockets share these operations. */
export interface WorkspaceEventConnection {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

// Publications wake reconciliation; each socket retains its own replay cursor.
export function connectWorkspaceEvents(
  socket: WorkspaceEventConnection,
  url: URL,
  owner: string,
  epoch: string,
  build?: string,
  contract = workspaceApi.channels.events,
) {
  // Use the first v value as before; absent/other versions retain v2 replay.
  const v3 = contract.query.safeParse({ v: url.searchParams.get("v") }).success;
  // Already-loaded v3 clients strictly reject new reset keys. Advertise the
  // clock extension only when this client (and any proxy) negotiates it.
  const clockV3 = v3 && url.searchParams.get("clock") === "1";
  const projectionV3 = v3 && url.searchParams.get("projection") === "1";
  let cursor = Number(url.searchParams.get("cursor"));
  let initial = true;
  let stopped = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const read = db.transaction(() => {
    const bounds = db
      .prepare(
        `SELECT
      (SELECT id FROM events WHERE owner_id=? ORDER BY id LIMIT 1) first,
      last_event_id last, epoch FROM change_watermark WHERE owner_id=?
    `,
      )
      .get(owner, owner) as { first: number | null; last: number; epoch: string };
    const currentEpoch = v3 ? bounds.epoch : epoch;
    let reset =
      (v3 && !initial && currentEpoch !== epoch) ||
      (initial &&
        (url.searchParams.get("epoch") !== currentEpoch ||
          cursor < (bounds.first || 1) - 1)) ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > bounds.last;
    epoch = currentEpoch;
    if (reset) cursor = bounds.last;
    let events = reset
      ? []
      : (db
          .prepare(
            `SELECT id,run_id,subject_kind,subject_id,type,
              CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END payload
             FROM events WHERE owner_id=? AND id>? ORDER BY id LIMIT 100`,
          )
          .all(MAX_EVENT_BYTES, owner, cursor) as {
          id: number;
          run_id: string | null;
          subject_kind: string;
          subject_id: string;
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
      // Reserve space for the frame envelope. A full
      // page yields to another read instead of resetting past unread rows.
      let bytes = 4096;
      for (const row of events) {
        let entry = { id: row.id, event: historicalEvent(row) };
        if (Buffer.byteLength(JSON.stringify(entry)) > MAX_EVENT_BYTES)
          entry = { id: row.id, event: invalidate(entry.event.scope,
            entry.event.subject?.kind === "message" ? entry.event.subject : undefined) };
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + size > MAX_REPLAY_BYTES) break;
        typed.push(entry);
        bytes += size;
      }
      if (typed.length) cursor = typed.at(-1)!.id;
      // A healthy reconnect at the current tip still carries an actionable
      // reconciliation signal; synthetic entries intentionally reuse the cursor.
      if (!reset && initial && !typed.length)
        typed.push({ id: cursor, event: invalidate() });
    } else if (events.length) cursor = events.at(-1)!.id;
    // A cascade can remove the log tip, but never its durable watermark. Once
    // all surviving rows are consumed, advance over the hole without spinning
    // or sending an empty events frame. Tombstones make deletion actionable.
    if (!reset && events.length < 100 && (!v3 || typed.length >= events.length) && cursor < bounds.last) {
      cursor = bounds.last;
      if (!events.length) reset = true;
    }
    if (!v3 && initial && !events.length) reset = true;
    const changed = initial || reset || events.length > 0;
    const capabilities = { ...COMPLETE_WORKSPACE_CAPABILITIES, deadlines: clockV3 };
    const announce = initial && projectionV3;
    initial = false;
    const frame = changed
      ? v3
        ? reset
          ? {
              v: 3,
              type: "reset",
              build: build || observedBuild().id,
              buildIdentity: publicBuild(observedBuild()),
              capabilities,
              ...(clockV3 ? workspaceClock(owner) : { epoch, cursor }),
            }
          : { v: 3, type: "events", epoch, cursor, events: typed, ...(announce ? { capabilities } : {}) }
        : {
            v: 2,
            type: reset ? "reset" : "events",
            epoch,
            cursor,
            events: events.map(({ subject_id: _subject, subject_kind: _kind, ...event }) => event),
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
      if (frame) {
        // Check the canonical contract, but serialize the original object:
        // parsing must not change property order or the established wire bytes.
        if (v3) contract.frames.parse(frame);
        socket.send(JSON.stringify(frame));
      }
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
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (scheduled) clearImmediate(scheduled);
    socket.off("close", stop);
  };
  socket.once("close", stop);
  try {
    ensureWorkspaceOwner(owner);
    pump();
  } catch {
    stop();
    socket.close(1011, "Workspace updates unavailable");
  }
  return stop;
}
