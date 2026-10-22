export type WorkspaceFrame = {
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
  read: (after: number, signal: AbortSignal) => Promise<{ id: number }[]>;
  changed: () => void;
  frame?: (frame: WorkspaceFrame) => void;
  connected?: (connected: boolean) => void;
  expired?: () => void;
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
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const connect = () => {
    if (stopped) return;
    clearTimeout(retry);
    const url = new URL(options.url);
    url.searchParams.set("epoch", epoch);
    url.searchParams.set("cursor", String(cursor));
    const current = (socket = new WebSocket(url));
    current.onmessage = (event) => {
      if (stopped || current !== socket) return;
      try {
        const m = JSON.parse(event.data) as WorkspaceFrame;
        if (
          m.v !== 2 ||
          !["reset", "events"].includes(m.type) ||
          typeof m.epoch !== "string" ||
          !m.epoch ||
          m.epoch.length > 200 ||
          !Number.isSafeInteger(m.cursor) ||
          m.cursor < 0 ||
          (m.type === "events" && m.epoch === epoch && m.cursor < cursor)
        )
          throw new Error("Invalid workspace event");
        // Both transports read the same durable event IDs. A reset replaces
        // both cursors so fallback neither replays old history nor keeps a
        // cursor from a database the socket has already replaced. Within an
        // epoch, preserve HTTP progress while the socket replays older events.
        pollCursor =
          m.type === "reset" || m.epoch !== epoch
            ? m.cursor
            : Math.max(pollCursor, m.cursor);
        epoch = m.epoch;
        cursor = m.cursor;
        attempt = 0;
        if (!ready) options.connected?.(true);
        ready = true;
        // Polling stops while push is healthy. Its last success cannot prove
        // connectivity after this socket subsequently disconnects.
        pollHealthy = false;
        request?.abort();
        options.frame?.(m);
        options.changed();
      } catch {
        current.close();
      }
    };
    current.onclose = (event) => {
      if (stopped || current !== socket) return;
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
    if (stopped || ready || polling) return;
    polling = true;
    const controller = (request = new AbortController());
    const deadline = setTimeout(() => controller.abort(), 12_000);
    try {
      const events = await options.read(pollCursor, controller.signal);
      if (stopped || ready || controller.signal.aborted) return;
      pollHealthy = true;
      options.connected?.(true);
      if (events.length) pollCursor = events.at(-1)!.id;
      // Older servers do not publish Cards revisions. Keep their edits and
      // removals current even when no new run event accompanies the mutation.
      if (events.length || Date.now() - lastRefresh >= 15_000) {
        lastRefresh = Date.now();
        options.changed();
      }
    } catch {
      /* Cached content remains readable during an outage. */
      if (!stopped && !ready) {
        pollHealthy = false;
        options.connected?.(false);
      }
    } finally {
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
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  if (options.connected)
    window.addEventListener("loop-reconnecting", restarting);
  document.addEventListener("visibilitychange", visible);
  function stop() {
    stopped = true;
    clearTimeout(retry);
    clearInterval(fallback);
    request?.abort();
    socket?.close();
    window.removeEventListener("online", wake);
    window.removeEventListener("pageshow", wake);
    window.removeEventListener("loop-reconnecting", restarting);
    document.removeEventListener("visibilitychange", visible);
  }
  connect();
  return stop;
}
