import { workspaceApi } from "../shared/workspace-api";
import {
  type WorkspaceFrameV3,
  WorkspaceClock,
  invalidate,
  PARTIAL_WORKSPACE_CAPABILITIES,
  type WorkspaceEvent,
} from "../shared/workspace-events";
import { viewGeneration } from "./viewCache";
import { retryAfter } from "./api";
import type { WorkspaceSocket } from "./workspace-multiplex";
import {
  acquireWorkspacePoll,
  cancelWorkspacePoll,
} from "./workspace-poll-budget";

export type WorkspaceFrame =
  | WorkspaceFrameV3
  // A clock observed over HTTP can reset a replaced source, but cannot make
  // claims about that deployment's build or delta capabilities.
  | (Omit<
      Extract<WorkspaceFrameV3, { type: "reset" }>,
      "build" | "buildIdentity"
    > & {
      build?: undefined;
      buildIdentity?: undefined;
    })
  | {
      v: 2;
      type: "reset" | "events";
      epoch: string;
      cursor: number;
      build?: string;
      buildIdentity?: unknown;
    };

/** One source and owner per subscription. Only reads may be retried. */
export function watchWorkspaceEvents(options: {
  url: URL;
  source?: string;
  read: (after: number, signal: AbortSignal) => Promise<{ id: number }[]>;
  changed: (events?: readonly WorkspaceEvent[]) => void;
  frame?: (frame: WorkspaceFrame) => void;
  connected?: (connected: boolean) => void;
  expired?: () => void;
  socket?: (url: URL) => WorkspaceSocket;
}) {
  let stopped = false,
    ready = false,
    polling = false,
    pollHealthy = false;
  let epoch = "",
    cursor = 0,
    pollCursor = 0,
    attempt = 0;
  let lastRefresh = 0;
  let pollAfter = 0;
  let socket: WorkspaceSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const ownerGeneration = viewGeneration();
  const pollKey = Symbol();
  let deadlineGeneration = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineClock: WorkspaceClock | undefined;
  let lastClockRequest = 0;
  function armDeadline(clock: WorkspaceClock, reset = false) {
    if (stopped || viewGeneration() !== ownerGeneration) return;
    if (
      !reset &&
      deadlineClock?.epoch === clock.epoch &&
      (clock.cursor < deadlineClock.cursor ||
        (clock.cursor === deadlineClock.cursor &&
          clock.serverNow < deadlineClock.serverNow))
    )
      return;
    clearTimeout(deadlineTimer);
    const generation = ++deadlineGeneration;
    deadlineClock = clock;
    if (clock.nextDeadline === null) return;
    const due =
      performance.now() + Math.max(0, clock.nextDeadline - clock.serverNow);
    const fire = () => {
      if (
        stopped ||
        generation !== deadlineGeneration ||
        viewGeneration() !== ownerGeneration ||
        deadlineClock?.epoch !== clock.epoch
      )
        return;
      const remaining = due - performance.now();
      if (remaining > 0)
        deadlineTimer = setTimeout(fire, Math.min(2_147_483_647, remaining));
      else
        options.changed(
          ["feed", "results", "approvals", "pulls"].map((id) =>
            invalidate({
              kind: "collection",
              id: id as "feed" | "results" | "approvals" | "pulls",
            }),
          ),
        );
    };
    deadlineTimer = setTimeout(
      fire,
      Math.min(2_147_483_647, Math.max(0, due - performance.now())),
    );
  }
  const snapshotClock = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        source: string;
        generation: number;
        requestId?: number;
        clock: WorkspaceClock;
      }>
    ).detail;
    if (
      !detail ||
      detail.generation !== ownerGeneration ||
      detail.source !== (options.source ?? "")
    )
      return;
    const parsed = WorkspaceClock.safeParse(detail.clock);
    if (!parsed.success) return;
    // A healthy socket owns the epoch. During an outage, a newer HTTP request
    // can discover a replacement database; an earlier response cannot undo it.
    if (ready && epoch && parsed.data.epoch !== epoch) return;
    if (
      deadlineClock?.epoch !== parsed.data.epoch &&
      detail.requestId !== undefined &&
      detail.requestId < lastClockRequest
    )
      return;
    lastClockRequest = Math.max(lastClockRequest, detail.requestId ?? 0);
    if (!ready && epoch !== parsed.data.epoch) {
      const replaced = !!epoch;
      epoch = parsed.data.epoch;
      cursor = pollCursor = parsed.data.cursor;
      if (replaced) {
        // Invalidate the old socket before closing it: a late frame must not
        // put the client back into the database that HTTP just replaced.
        const obsolete = socket;
        socket = undefined;
        obsolete?.close();
        clearTimeout(retry);
        retry = setTimeout(connect, 0);
        options.frame?.({
          v: 3,
          type: "reset",
          ...parsed.data,
          capabilities: PARTIAL_WORKSPACE_CAPABILITIES,
        });
        options.changed();
      }
    }
    armDeadline(parsed.data);
  };
  const connect = () => {
    if (stopped) return;
    clearTimeout(retry);
    if (document.visibilityState === "hidden") return;
    if (Date.now() < pollAfter) {
      retry = setTimeout(
        connect,
        Math.min(2_147_483_647, pollAfter - Date.now()),
      );
      return;
    }
    const url = new URL(options.url);
    url.searchParams.set("epoch", epoch);
    url.searchParams.set("cursor", String(cursor));
    url.searchParams.set(
      "v",
      workspaceApi.channels.events.query.parse({ v: "3" }).v,
    );
    url.searchParams.set("clock", "1");
    url.searchParams.set("projection", "1");
    let firstFrame = true;
    const current = (socket = options.socket
      ? options.socket(url)
      : new WebSocket(url));
    current.onmessage = (event) => {
      if (stopped || current !== socket || viewGeneration() !== ownerGeneration)
        return;
      try {
        const value = JSON.parse(event.data);
        const m: WorkspaceFrame =
          value?.v === 3
            ? workspaceApi.channels.events.frames.parse(value)
            : value;
        // A resumed connection may not reset its cursor. Older servers do
        // not announce capabilities on replay, so conservatively restore
        // fallback instead of retaining a previous deployment's promises.
        if (firstFrame && m?.v === 3 && m.type === "events" && !m.capabilities)
          m.capabilities = PARTIAL_WORKSPACE_CAPABILITIES;
        if (
          !m ||
          (m.v !== 2 && m.v !== 3) ||
          !["reset", "events"].includes(m.type) ||
          typeof m.epoch !== "string" ||
          !m.epoch ||
          m.epoch.length > 200 ||
          !Number.isSafeInteger(m.cursor) ||
          m.cursor < 0 ||
          (m.type === "events" && m.epoch === epoch && m.cursor < cursor)
        )
          throw new Error("Invalid workspace event");
        if (
          m.v === 3 &&
          m.type === "events" &&
          m.events.some(
            (entry, index) =>
              entry.id > m.cursor ||
              (index > 0 && entry.id < m.events[index - 1].id),
          )
        )
          throw new Error("Invalid workspace event order");
        // Both transports read the same durable event IDs. A reset replaces
        // both cursors so fallback neither replays old history nor keeps a
        // cursor from a database the socket has already replaced. Within an
        // epoch, preserve HTTP progress while the socket replays older events.
        pollCursor =
          m.type === "reset" || m.epoch !== epoch
            ? m.cursor
            : Math.max(pollCursor, m.cursor);
        if (
          m.v === 3 &&
          m.type === "reset" &&
          m.serverNow !== undefined &&
          m.nextDeadline !== undefined
        )
          armDeadline(
            {
              epoch: m.epoch,
              cursor: m.cursor,
              serverNow: m.serverNow,
              nextDeadline: m.nextDeadline,
            },
            true,
          );
        else if (m.type === "reset" || m.epoch !== epoch) {
          clearTimeout(deadlineTimer);
          deadlineGeneration++;
          deadlineClock = undefined;
        }
        if (m.v === 3 && m.type === "events")
          for (const entry of m.events)
            if (entry.event.type === "deadline")
              armDeadline({ ...entry.event, epoch: m.epoch, cursor: entry.id });
        epoch = m.epoch;
        cursor = m.cursor;
        attempt = 0;
        if (!ready) options.connected?.(true);
        ready = true;
        cancelWorkspacePoll(pollKey);
        // Polling stops while push is healthy. Its last success cannot prove
        // connectivity after this socket subsequently disconnects.
        pollHealthy = false;
        firstFrame = false;
        request?.abort();
        options.frame?.(m);
        const notifications =
          m.v === 3 && m.type === "events"
            ? m.events
                .map((entry) => entry.event)
                .filter((event) => event.type !== "deadline")
            : [invalidate()];
        if (notifications.length) options.changed(notifications);
      } catch {
        current.close();
      }
    };
    current.onclose = (event) => {
      if (stopped || current !== socket || viewGeneration() !== ownerGeneration)
        return;
      ready = false;
      // A blocked upgrade must not hide a healthy HTTP fallback behind a
      // persistent reconnect notice, including subsequent socket retries.
      options.connected?.(pollHealthy);
      if (event.code === 4003 && options.expired) {
        stop();
        options.expired();
        return;
      }
      retry = setTimeout(
        connect,
        Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) +
          Math.random() * 250,
      );
    };
    current.onerror = () => current.close();
  };
  const poll = async () => {
    if (
      stopped ||
      document.visibilityState === "hidden" ||
      viewGeneration() !== ownerGeneration ||
      ready ||
      polling ||
      Date.now() < pollAfter
    ) {
      cancelWorkspacePoll(pollKey);
      return;
    }
    const releasePoll = acquireWorkspacePoll(pollKey);
    if (!releasePoll) return;
    polling = true;
    const requestEpoch = epoch;
    const controller = (request = new AbortController());
    const deadline = setTimeout(() => controller.abort(), 12_000);
    try {
      const events = await options.read(pollCursor, controller.signal);
      if (
        stopped ||
        viewGeneration() !== ownerGeneration ||
        ready ||
        controller.signal.aborted
      )
        return;
      pollHealthy = true;
      options.connected?.(true);
      if (events.length && epoch === requestEpoch)
        pollCursor = events.at(-1)!.id;
      // Older servers do not publish Cards revisions. Keep their edits and
      // removals current even when no new run event accompanies the mutation.
      if (events.length || Date.now() - lastRefresh >= 15_000) {
        lastRefresh = Date.now();
        options.changed();
      }
    } catch (error) {
      if (!stopped && !controller.signal.aborted)
        pollAfter = Math.max(pollAfter, Date.now() + retryAfter(error));
      /* Cached content remains readable during an outage. */
      if (!stopped && !ready) {
        pollHealthy = false;
        options.connected?.(false);
      }
    } finally {
      releasePoll();
      clearTimeout(deadline);
      polling = false;
    }
  };
  const wake = () => {
    if (stopped) return;
    // Refresh after phone sleep even if its TCP connection appears open.
    options.changed();
    if (!socket || socket.readyState === WebSocket.CLOSED) connect();
  };
  const visible = () => {
    if (document.visibilityState === "visible") wake();
    else {
      cancelWorkspacePoll(pollKey);
      request?.abort();
      clearTimeout(retry);
      socket?.close();
    }
  };
  const restarting = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN) return;
    // The connection service can report a restart before an upgrade closes.
    // Its current failure supersedes an earlier successful fallback poll.
    request?.abort();
    pollHealthy = false;
    options.connected?.(false);
  };
  const fallback = setInterval(() => void poll(), 1800);
  window.addEventListener("loop55-workspace-clock", snapshotClock);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  if (options.connected)
    window.addEventListener("loop55-reconnecting", restarting);
  document.addEventListener("visibilitychange", visible);
  function stop() {
    stopped = true;
    cancelWorkspacePoll(pollKey);
    clearTimeout(retry);
    clearTimeout(deadlineTimer);
    deadlineGeneration++;
    clearInterval(fallback);
    request?.abort();
    socket?.close();
    window.removeEventListener("loop55-workspace-clock", snapshotClock);
    window.removeEventListener("online", wake);
    window.removeEventListener("pageshow", wake);
    window.removeEventListener("loop55-reconnecting", restarting);
    document.removeEventListener("visibilitychange", visible);
  }
  connect();
  return stop;
}
