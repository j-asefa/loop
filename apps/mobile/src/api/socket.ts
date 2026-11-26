import type { PairedSession } from "./types";

export type SocketStatus = "connecting" | "live" | "reconnecting" | "offline";

export type LiveStreamEvent =
  | {
      kind: "delta";
      runId?: string;
      conversationId?: string;
      messageId?: string;
      text: string;
      replace?: boolean;
    }
  | {
      kind: "activity";
      runId?: string;
      conversationId?: string;
      label: string;
    }
  | {
      kind: "state";
      runId?: string;
      conversationId?: string;
      state: string;
    };

export type LiveStreamOverlay = {
  text: string;
  messageId?: string;
  activity?: string;
  state?: string;
  updatedAt: number;
};

type RNWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

const ACTIVITY_LABELS: Record<string, string> = {
  plan: "Updating plan…",
  tool: "Running tool…",
  file_change: "Editing files…",
  output: "Streaming response…",
  commands: "Running command…",
  settings: "Configuring session…",
  capabilities: "Checking capabilities…",
};

const RUN_STATE_TYPES = new Set([
  "queued",
  "running",
  "pausing",
  "paused",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "waiting_children",
]);

const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const MAX_STREAM_TEXT_CHARS = 80_000;

export function extractLiveStreamEvents(raw: unknown): LiveStreamEvent[] {
  if (typeof raw !== "string" || !raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as {
    events?: Array<{ event?: Record<string, unknown> }>;
    event?: Record<string, unknown>;
  };
  const envelopes: Array<Record<string, unknown>> = [];
  if (Array.isArray(root.events)) {
    for (const entry of root.events) {
      if (entry?.event && typeof entry.event === "object") {
        envelopes.push(entry.event);
      }
    }
  } else if (root.event && typeof root.event === "object") {
    envelopes.push(root.event);
  }

  const out: LiveStreamEvent[] = [];
  for (const ev of envelopes) {
    const type = typeof ev.type === "string" ? ev.type : "";
    const payload =
      ev.payload && typeof ev.payload === "object"
        ? (ev.payload as Record<string, unknown>)
        : {};
    const scope =
      ev.scope && typeof ev.scope === "object"
        ? (ev.scope as { kind?: unknown; id?: unknown })
        : undefined;
    const subject =
      ev.subject && typeof ev.subject === "object"
        ? (ev.subject as { kind?: unknown; id?: unknown })
        : undefined;

    const scopeRunId =
      scope?.kind === "run" && typeof scope.id === "string"
        ? scope.id
        : subject?.kind === "run" && typeof subject.id === "string"
          ? subject.id
          : typeof payload.runId === "string"
            ? payload.runId
            : undefined;
    const scopeConvId =
      scope?.kind === "conversation" && typeof scope.id === "string"
        ? scope.id
        : subject?.kind === "conversation" && typeof subject.id === "string"
          ? subject.id
          : typeof payload.conversationId === "string"
            ? payload.conversationId
            : undefined;

    if (type === "message.delta") {
      if (typeof payload.text === "string" && payload.text.length > 0) {
        out.push({
          kind: "delta",
          runId: scopeRunId,
          conversationId: scopeConvId,
          messageId:
            typeof payload.messageId === "string"
              ? payload.messageId
              : undefined,
          text: payload.text,
          replace: false,
        });
      }
      continue;
    }

    if (type === "message.upsert") {
      const msg =
        payload.message && typeof payload.message === "object"
          ? (payload.message as Record<string, unknown>)
          : null;
      if (
        msg &&
        msg.role === "assistant" &&
        typeof msg.content === "string" &&
        msg.content.length > 0
      ) {
        out.push({
          kind: "delta",
          runId: typeof msg.run_id === "string" ? msg.run_id : scopeRunId,
          conversationId:
            typeof msg.conversation_id === "string"
              ? msg.conversation_id
              : scopeConvId,
          messageId: typeof msg.id === "string" ? msg.id : undefined,
          text: msg.content,
          replace: true,
        });
      }
      continue;
    }

    if (type === "native.event") {
      const inner =
        payload.event && typeof payload.event === "object"
          ? (payload.event as Record<string, unknown>)
          : null;
      if (!inner) continue;
      const innerType = typeof inner.type === "string" ? inner.type : "";
      if (
        innerType === "delta" &&
        typeof inner.text === "string" &&
        inner.text
      ) {
        out.push({
          kind: "delta",
          runId: scopeRunId,
          conversationId: scopeConvId,
          messageId: typeof inner.id === "string" ? inner.id : undefined,
          text: inner.text,
          replace: false,
        });
      } else if (
        innerType === "item" &&
        inner.item &&
        typeof inner.item === "object"
      ) {
        const item = inner.item as Record<string, unknown>;
        if (
          item.kind === "assistant" &&
          typeof item.text === "string" &&
          item.text
        ) {
          out.push({
            kind: "delta",
            runId: scopeRunId,
            conversationId: scopeConvId,
            messageId: typeof item.id === "string" ? item.id : undefined,
            text: item.text,
            replace: true,
          });
        } else if (item.kind === "tool") {
          const title =
            typeof item.title === "string" && item.title.trim()
              ? item.title.trim()
              : "Running tool…";
          out.push({
            kind: "activity",
            runId: scopeRunId,
            conversationId: scopeConvId,
            label: title,
          });
        }
      } else if (innerType === "status") {
        const detail =
          typeof inner.detail === "string" && inner.detail.trim()
            ? inner.detail.trim()
            : typeof inner.status === "string"
              ? inner.status
              : "";
        if (detail) {
          out.push({
            kind: "activity",
            runId: scopeRunId,
            conversationId: scopeConvId,
            label: detail,
          });
        }
      }
      continue;
    }

    if (
      type === "progress" &&
      typeof payload.message === "string" &&
      payload.message.trim()
    ) {
      out.push({
        kind: "activity",
        runId: scopeRunId,
        conversationId: scopeConvId,
        label: payload.message.trim(),
      });
      continue;
    }

    if (type === "activity.updated" && typeof payload.kind === "string") {
      const label = ACTIVITY_LABELS[payload.kind];
      if (label) {
        out.push({
          kind: "activity",
          runId: scopeRunId,
          conversationId: scopeConvId,
          label,
        });
      }
      continue;
    }

    if (type === "steering.pending" || type === "steering.delivered") {
      out.push({
        kind: "activity",
        runId: scopeRunId,
        conversationId: scopeConvId,
        label:
          type === "steering.delivered"
            ? "Following your steering…"
            : "Delivering steering…",
      });
      continue;
    }

    if (RUN_STATE_TYPES.has(type)) {
      out.push({
        kind: "state",
        runId: scopeRunId,
        conversationId: scopeConvId,
        state: type,
      });
    }
  }
  return out;
}

export function applyLiveStreamEvent(
  prev: LiveStreamOverlay | undefined,
  event: LiveStreamEvent,
  now = Date.now(),
): LiveStreamOverlay | null {
  if (event.kind === "state") {
    if (TERMINAL_RUN_STATES.has(event.state)) {
      return null;
    }
    return {
      text: prev?.text ?? "",
      messageId: prev?.messageId,
      activity:
        event.state === "paused"
          ? "Paused"
          : event.state === "pausing"
            ? "Pausing…"
            : event.state === "awaiting_approval"
              ? "Waiting for your approval"
              : prev?.activity,
      state: event.state,
      updatedAt: now,
    };
  }

  if (event.kind === "activity") {
    return {
      text: prev?.text ?? "",
      messageId: prev?.messageId,
      activity: event.label,
      state: prev?.state ?? "running",
      updatedAt: now,
    };
  }

  // Delta or full assistant upsert
  const sameMessage =
    !prev?.messageId || !event.messageId || prev.messageId === event.messageId;
  const baseText = event.replace || !sameMessage ? "" : (prev?.text ?? "");
  const combined = baseText + event.text;
  const bounded =
    combined.length > MAX_STREAM_TEXT_CHARS
      ? combined.slice(combined.length - MAX_STREAM_TEXT_CHARS)
      : combined;
  return {
    text: bounded,
    messageId: event.messageId ?? prev?.messageId,
    activity: prev?.activity ?? "Streaming response…",
    state: prev?.state ?? "running",
    updatedAt: now,
  };
}

const IGNORED_TYPES = new Set([
  "ping",
  "pong",
  "hello",
  "ack",
  "clock",
  "heartbeat",
  "cursor",
  "progress",
  "import.progress",
  "activity",
  "activity.updated",
  "trace",
  "traces",
  "trace.updated",
  "message.delta",
  "native.usage",
  "provider.receipt",
]);

export function shouldRefreshForFrame(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      kind?: string;
      event?: { type?: string; kind?: string };
      events?: Array<{
        id?: number;
        type?: string;
        kind?: string;
        event?: { type?: string; kind?: string };
      }>;
    };
    const topType = (parsed.type || parsed.kind || "").toLowerCase();
    if (topType && IGNORED_TYPES.has(topType)) return false;
    if (Array.isArray(parsed.events)) {
      if (parsed.events.length === 0) return false;
      return parsed.events.some((entry) => {
        const t = (
          entry.event?.type ||
          entry.event?.kind ||
          entry.type ||
          entry.kind ||
          ""
        ).toLowerCase();
        return Boolean(t && !IGNORED_TYPES.has(t));
      });
    }
    const innerType = (
      parsed.event?.type ||
      parsed.event?.kind ||
      ""
    ).toLowerCase();
    if (innerType && IGNORED_TYPES.has(innerType)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Connects to Loop's paired WebSocket event stream (`wss://<host>/ws?v=3`) with
 * exponential backoff reconnection, heartbeat filtering, and coalesced silent refreshes.
 */
export class LoopEventSocket {
  private session: PairedSession;
  private onEvent: () => void;
  private onStatus: (status: SocketStatus) => void;
  private onStreamEvents?: (events: LiveStreamEvent[]) => void;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;

  constructor(
    session: PairedSession,
    onEvent: () => void,
    onStatus: (status: SocketStatus) => void,
    onStreamEvents?: (events: LiveStreamEvent[]) => void,
  ) {
    this.session = session;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onStreamEvents = onStreamEvents;
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
    const elapsed = Date.now() - this.lastEmitAt;
    const delay = Math.max(850, 1600 - elapsed);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.lastEmitAt = Date.now();
      this.onEvent();
    }, delay);
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

      ws.onmessage = (event) => {
        if (this.stopped) return;
        if (this.onStreamEvents) {
          const streamEvents = extractLiveStreamEvents(event.data);
          if (streamEvents.length > 0) {
            this.onStreamEvents(streamEvents);
          }
        }
        if (shouldRefreshForFrame(event.data)) {
          this.scheduleRefresh();
        }
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
