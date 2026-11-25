import type { PairedSession } from "./types";

export type SocketStatus = "connecting" | "live" | "reconnecting" | "offline";

type RNWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

/**
 * Connects to Loop's paired WebSocket event stream (`wss://<host>/ws?v=3`) with
 * exponential backoff reconnection and coalesced update callbacks.
 */
export class LoopEventSocket {
  private session: PairedSession;
  private onEvent: () => void;
  private onStatus: (status: SocketStatus) => void;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    session: PairedSession,
    onEvent: () => void,
    onStatus: (status: SocketStatus) => void,
  ) {
    this.session = session;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.onStatus("offline");
  }

  private wsUrl(): string {
    const url = new URL(this.session.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "?v=3";
    return url.toString();
  }

  private scheduleRefresh() {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onEvent();
    }, 280);
  }

  private connect() {
    if (this.stopped) return;
    this.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    try {
      const headers: Record<string, string> = {
        Origin: this.session.origin,
      };
      if (this.session.cookie) headers.Cookie = this.session.cookie;

      const WS = WebSocket as unknown as RNWebSocketConstructor;
      const ws = new WS(this.wsUrl(), null, { headers });
      this.ws = ws;

      ws.onopen = () => {
        if (this.stopped) {
          ws.close();
          return;
        }
        this.attempt = 0;
        this.onStatus("live");
      };

      ws.onmessage = () => {
        if (!this.stopped) this.scheduleRefresh();
      };

      ws.onerror = () => {
        // Let onclose handle backoff cleanly
      };

      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (this.stopped) return;
        this.attempt += 1;
        this.onStatus("reconnecting");
        const delay = Math.min(
          15_000,
          1200 * Math.pow(1.6, Math.min(this.attempt, 6)),
        );
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      };
    } catch {
      this.onStatus("offline");
    }
  }
}
