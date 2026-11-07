import * as changeWatermarkQueries from "./sql/change-watermark.js";
import * as eventsQueries from "./sql/events.js";
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
  project: (event: WorkspaceEvent) => WorkspaceEvent = (event) => event,
) {
  if (!contract.query.safeParse({ v: url.searchParams.get("v") }).success) {
    socket.close(1008, "Workspace events require v=3");
    return () => {};
  }
  let cursor = Number(url.searchParams.get("cursor"));
  let initial = true;
  let stopped = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const read = db.transaction(() => {
    const bounds = changeWatermarkQueries.bounds(db, owner, owner) as { first: number | null; last: number; epoch: string };
    let reset =
      (!initial && bounds.epoch !== epoch) ||
      (initial &&
        (url.searchParams.get("epoch") !== bounds.epoch ||
          cursor < (bounds.first || 1) - 1)) ||
      !Number.isSafeInteger(cursor) || cursor < 0 || cursor > bounds.last;
    epoch = bounds.epoch;
    if (reset) cursor = bounds.last;
    const events = reset ? [] : eventsQueries.boundedReplay(db, MAX_EVENT_BYTES, owner, cursor) as {
      id: number; run_id: string | null; subject_kind: string;
      subject_id: string; type: string; payload: string | null;
    }[];
    const typed: { id: number; event: WorkspaceEvent }[] = [];
    // Reserve the envelope budget; full pages yield without skipping unread rows.
    let bytes = 4096;
    for (const row of events) {
      let entry = { id: row.id, event: project(historicalEvent(row)) };
      if (Buffer.byteLength(JSON.stringify(entry)) > MAX_EVENT_BYTES)
        entry = { id: row.id, event: invalidate(entry.event.scope,
          entry.event.subject?.kind === "message" ? entry.event.subject : undefined) };
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes + size > MAX_REPLAY_BYTES) break;
      typed.push(entry);
      bytes += size;
    }
    if (typed.length) cursor = typed.at(-1)!.id;
    if (!reset && initial && !typed.length)
      typed.push({ id: cursor, event: invalidate() });
    // Cascades can remove rows but never the durable watermark.
    if (!reset && events.length < 100 && typed.length >= events.length && cursor < bounds.last) {
      cursor = bounds.last;
      if (!events.length) reset = true;
    }
    const changed = initial || reset || events.length > 0;
    const announce = initial;
    initial = false;
    const clock = changed ? workspaceClock(owner) : undefined;
    const frame = !clock ? null : reset ? {
      v: 3, type: "reset", ...clock,
      build: build || observedBuild().id,
      buildIdentity: publicBuild(observedBuild()),
      capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
    } : {
      v: 3, type: "events", epoch, cursor,
      serverNow: clock.serverNow, nextDeadline: clock.nextDeadline,
      events: typed,
      ...(announce ? { capabilities: COMPLETE_WORKSPACE_CAPABILITIES } : {}),
    };
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
        contract.frames.parse(frame);
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
