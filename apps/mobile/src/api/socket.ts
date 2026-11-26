import type {
  ApiAgent,
  ApiConnection,
  ApiFeedItem,
  PairedSession,
} from "./types";

export type SocketStatus = "connecting" | "live" | "reconnecting" | "offline";

export type LiveStreamEvent =
  | {
      kind: "delta";
      runId?: string;
      conversationId?: string;
      messageId?: string;
      text: string;
      replace?: boolean;
      offset?: number;
      revision?: number;
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
    }
  | {
      kind: "reset";
    };

export type LiveStreamOverlay = {
  runId?: string;
  text: string;
  messageId?: string;
  activity?: string;
  state?: string;
  revision?: number;
  /** Cumulative UTF-8 byte offset at the end of the received message stream. */
  byteEnd?: number;
  /** True once we have observed the start of the message (offset 0, full upsert, or run start). */
  anchored?: boolean;
  /** True if text was received mid-stream without an anchor or after a byte-offset gap. */
  gapped?: boolean;
  updatedAt: number;
};

/** Exact UTF-8 byte length of a JS UTF-16 string (matches server `Buffer.byteLength` / `TextEncoder`). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Return the suffix of `text` starting after `skipBytes` UTF-8 bytes (or null if mid-codepoint). */
function sliceAfterUtf8Bytes(text: string, skipBytes: number): string | null {
  if (skipBytes <= 0) return text;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes === skipBytes) return text.slice(i);
    if (bytes > skipBytes) return null;
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes === skipBytes ? "" : null;
}

type RNWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

const ACTIVITY_LABELS = new Map<string, string>([
  ["plan", "Updating plan…"],
  ["tool", "Running tool…"],
  ["file_change", "Editing files…"],
  ["output", "Streaming response…"],
  ["commands", "Running command…"],
  ["settings", "Configuring session…"],
  ["capabilities", "Checking capabilities…"],
]);

// Excludes "queued" so newly queued follow-ups never overwrite or clear an active run's stream overlay.
const RUN_STATE_TYPES = new Set([
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

const ACTIVE_STREAM_STATES = new Set([
  "running",
  "pausing",
  "paused",
  "awaiting_approval",
  "waiting_children",
]);

const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const MAX_STREAM_TEXT_CHARS = 80_000;

export function isNativeHarnessConnection(
  connection?: Pick<ApiConnection, "metadata"> | null,
): boolean {
  if (!connection?.metadata) return false;
  try {
    const parsed = JSON.parse(connection.metadata) as {
      loopHarness?: unknown;
    };
    return parsed != null && parsed.loopHarness != null;
  } catch {
    return false;
  }
}

/**
 * Matches server `controlRun` (`src/server/run-attention.ts`): active native-harness
 * turns cannot be paused mid-turn (the server returns 409 and advises interrupting instead).
 */
export function canPauseRun(
  run:
    | { state: string; agent_id?: string | null; connection_id?: string | null }
    | null
    | undefined,
  agents: Array<Pick<ApiAgent, "id" | "connection_id">>,
  connections: Array<Pick<ApiConnection, "id" | "metadata">>,
): boolean {
  if (!run) return false;
  if (run.state !== "running" && run.state !== "waiting_children") {
    return false;
  }
  // Matches `src/server/run-attention.ts`: native-owned turns cannot be paused while `running`.
  if (run.state === "running") {
    const agent = run.agent_id
      ? agents.find((a) => a.id === run.agent_id)
      : undefined;
    const connId = run.connection_id ?? agent?.connection_id ?? null;
    const conn = connId ? connections.find((c) => c.id === connId) : undefined;
    if (isNativeHarnessConnection(conn)) {
      return false;
    }
  }
  return true;
}

export type QueuedRunView = {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  input: string;
  state: string;
  created_at: number;
  queue_position: number | null;
  can_move_up: boolean;
  can_move_down: boolean;
  threadTitle?: string;
};

/**
 * Assemble an agent's complete queued run list in server `queue_position` order by
 * combining `item.queued_runs` (which includes queued follow-ups on currently working threads),
 * `item.run` (when queued), and any remaining queued `activeRuns` not yet reflected in the feed.
 */
export function buildAgentQueuedRuns(
  agentId: string | null | undefined,
  openConversationId: string | null,
  feedItems: readonly ApiFeedItem[],
  activeRuns: ReadonlyArray<{
    id: string;
    agent_id: string;
    conversation_id: string | null;
    input: string;
    state: string;
    created_at: number;
  }>,
): QueuedRunView[] {
  const byId = new Map<string, QueuedRunView>();
  if (agentId) {
    for (const item of feedItems) {
      if (item.agent_id !== agentId) continue;
      const threadTitle =
        openConversationId && item.conversation_id !== openConversationId
          ? item.title
          : undefined;

      if (Array.isArray(item.queued_runs)) {
        for (const qr of item.queued_runs) {
          byId.set(qr.id, {
            id: qr.id,
            agent_id: agentId,
            conversation_id: item.conversation_id,
            input: qr.input || item.title || "Queued task",
            state: "queued",
            created_at: qr.created_at,
            queue_position: qr.queue_position ?? null,
            can_move_up: Boolean(qr.can_move_up),
            can_move_down: Boolean(qr.can_move_down),
            threadTitle,
          });
        }
      }

      if (item.run && item.run.state === "queued" && !byId.has(item.run.id)) {
        byId.set(item.run.id, {
          id: item.run.id,
          agent_id: agentId,
          conversation_id: item.conversation_id,
          input: item.run.input || item.title || "Queued task",
          state: "queued",
          created_at: item.run.created_at ?? item.last_activity_at,
          queue_position: item.run.queue_position ?? null,
          can_move_up: Boolean(item.run.can_move_up),
          can_move_down: Boolean(item.run.can_move_down),
          threadTitle,
        });
      }
    }
  }

  for (const run of activeRuns) {
    if (run.state !== "queued") continue;
    const matchesAgent = agentId ? run.agent_id === agentId : false;
    const matchesConv =
      openConversationId && run.conversation_id === openConversationId;
    if (!matchesAgent && !matchesConv) continue;
    if (!byId.has(run.id)) {
      byId.set(run.id, {
        id: run.id,
        agent_id: run.agent_id,
        conversation_id: run.conversation_id,
        input: run.input || "Queued task",
        state: "queued",
        created_at: run.created_at,
        queue_position: null,
        can_move_up: false,
        can_move_down: false,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const aPos = a.queue_position;
    const bPos = b.queue_position;
    if (aPos !== null && bPos !== null && aPos !== bPos) {
      return aPos - bPos;
    }
    if (aPos !== null && bPos === null) return -1;
    if (aPos === null && bPos !== null) return 1;
    return a.created_at - b.created_at;
  });
}

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
    type?: unknown;
    events?: Array<{ event?: Record<string, unknown> }>;
    event?: Record<string, unknown>;
  };
  if (root.type === "reset") {
    return [{ kind: "reset" }];
  }
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
          offset:
            typeof payload.offset === "number" &&
            Number.isSafeInteger(payload.offset) &&
            payload.offset >= 0
              ? payload.offset
              : undefined,
          revision:
            typeof payload.revision === "number" &&
            Number.isSafeInteger(payload.revision) &&
            payload.revision >= 0
              ? payload.revision
              : undefined,
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
      const label = ACTIVITY_LABELS.get(payload.kind);
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
  if (event.kind === "reset") {
    return null;
  }

  if (event.kind === "state") {
    if (TERMINAL_RUN_STATES.has(event.state)) {
      return null;
    }
    const observedStart =
      event.state === "running" && (!prev || prev.text.length === 0);
    return {
      runId: event.runId ?? prev?.runId,
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
      revision: prev?.revision,
      byteEnd: prev?.byteEnd,
      anchored: prev?.anchored || observedStart,
      gapped: prev?.gapped,
      updatedAt: now,
    };
  }

  if (event.kind === "activity") {
    return {
      runId: event.runId ?? prev?.runId,
      text: prev?.text ?? "",
      messageId: prev?.messageId,
      activity: event.label,
      state: prev?.state ?? "running",
      revision: prev?.revision,
      byteEnd: prev?.byteEnd,
      anchored: prev?.anchored,
      gapped: prev?.gapped,
      updatedAt: now,
    };
  }

  // Delta or full assistant upsert
  const sameMessage =
    !prev?.messageId || !event.messageId || prev.messageId === event.messageId;
  const runId = event.runId ?? prev?.runId;
  const eventBytes = utf8ByteLength(event.text);

  if (event.replace) {
    const bounded =
      event.text.length > MAX_STREAM_TEXT_CHARS
        ? event.text.slice(event.text.length - MAX_STREAM_TEXT_CHARS)
        : event.text;
    return {
      runId,
      text: bounded,
      messageId: event.messageId ?? prev?.messageId,
      activity: prev?.activity ?? "Streaming response…",
      state: prev?.state ?? "running",
      revision: event.revision,
      byteEnd: eventBytes,
      anchored: true,
      gapped: false,
      updatedAt: now,
    };
  }

  if (
    sameMessage &&
    event.revision !== undefined &&
    prev?.revision !== undefined &&
    event.revision < prev.revision
  ) {
    return prev;
  }

  const baseText = sameMessage ? (prev?.text ?? "") : "";
  const prevGapped = sameMessage ? Boolean(prev?.gapped) : false;
  const prevAnchored = sameMessage ? Boolean(prev?.anchored) : false;
  const prevByteEnd = sameMessage
    ? (prev?.byteEnd ?? (baseText ? utf8ByteLength(baseText) : undefined))
    : undefined;

  // Server `message.delta` offsets are UTF-8 byte offsets (see `src/shared/transcript-projection.ts`).
  if (event.offset !== undefined) {
    // Clean start from byte offset 0.
    if (event.offset === 0) {
      const bounded =
        event.text.length > MAX_STREAM_TEXT_CHARS
          ? event.text.slice(event.text.length - MAX_STREAM_TEXT_CHARS)
          : event.text;
      return {
        runId,
        text: bounded,
        messageId: event.messageId ?? prev?.messageId,
        activity: prev?.activity ?? "Streaming response…",
        state: prev?.state ?? "running",
        revision: event.revision ?? prev?.revision,
        byteEnd: eventBytes,
        anchored: true,
        gapped: false,
        updatedAt: now,
      };
    }

    // Offset > 0 with no prior text (e.g. after reconnect reset or mid-reply join):
    // mark gapped instead of presenting a mid-stream fragment as the full card body.
    if (prevByteEnd === undefined || prevGapped) {
      return {
        runId,
        text: baseText,
        messageId: event.messageId ?? prev?.messageId,
        activity: prev?.activity ?? "Streaming response…",
        state: prev?.state ?? "running",
        revision: event.revision ?? prev?.revision,
        byteEnd: prevByteEnd,
        anchored: false,
        gapped: true,
        updatedAt: now,
      };
    }

    // Exact UTF-8 byte continuation (still accurate past MAX_STREAM_TEXT_CHARS truncation).
    if (event.offset === prevByteEnd) {
      const combined = baseText + event.text;
      const bounded =
        combined.length > MAX_STREAM_TEXT_CHARS
          ? combined.slice(combined.length - MAX_STREAM_TEXT_CHARS)
          : combined;
      return {
        runId,
        text: bounded,
        messageId: event.messageId ?? prev?.messageId,
        activity: prev?.activity ?? "Streaming response…",
        state: prev?.state ?? "running",
        revision: event.revision ?? prev?.revision,
        byteEnd: prevByteEnd + eventBytes,
        anchored: true,
        gapped: false,
        updatedAt: now,
      };
    }

    // Overlapping or duplicate replay: skip already-received prefix by UTF-8 byte count.
    if (event.offset < prevByteEnd) {
      const overlapBytes = prevByteEnd - event.offset;
      if (overlapBytes >= eventBytes) {
        return prev!;
      }
      const suffix = sliceAfterUtf8Bytes(event.text, overlapBytes);
      if (suffix === null) {
        return {
          runId,
          text: baseText,
          messageId: event.messageId ?? prev?.messageId,
          activity: prev?.activity ?? "Streaming response…",
          state: prev?.state ?? "running",
          revision: event.revision ?? prev?.revision,
          byteEnd: prevByteEnd,
          anchored: false,
          gapped: true,
          updatedAt: now,
        };
      }
      const combined = baseText + suffix;
      const bounded =
        combined.length > MAX_STREAM_TEXT_CHARS
          ? combined.slice(combined.length - MAX_STREAM_TEXT_CHARS)
          : combined;
      return {
        runId,
        text: bounded,
        messageId: event.messageId ?? prev?.messageId,
        activity: prev?.activity ?? "Streaming response…",
        state: prev?.state ?? "running",
        revision: event.revision ?? prev?.revision,
        byteEnd: event.offset + eventBytes,
        anchored: true,
        gapped: false,
        updatedAt: now,
      };
    }

    // event.offset > prevByteEnd: genuine missed chunk -> mark gapped until next full upsert.
    return {
      runId,
      text: baseText,
      messageId: event.messageId ?? prev?.messageId,
      activity: prev?.activity ?? "Streaming response…",
      state: prev?.state ?? "running",
      revision: event.revision ?? prev?.revision,
      byteEnd: prevByteEnd,
      anchored: false,
      gapped: true,
      updatedAt: now,
    };
  }

  // Offset-less deltas (e.g. native harness streaming): only treat as complete body text
  // when anchored from the run's start or a full item/upsert; if joined mid-turn or after
  // a reconnect reset, mark gapped so a mid-stream fragment never replaces the card body.
  if (prevGapped || !prevAnchored) {
    return {
      runId,
      text: baseText,
      messageId: event.messageId ?? prev?.messageId,
      activity: prev?.activity ?? "Streaming response…",
      state: prev?.state ?? "running",
      revision: event.revision ?? prev?.revision,
      byteEnd: prevByteEnd,
      anchored: false,
      gapped: true,
      updatedAt: now,
    };
  }

  const combined = baseText + event.text;
  const bounded =
    combined.length > MAX_STREAM_TEXT_CHARS
      ? combined.slice(combined.length - MAX_STREAM_TEXT_CHARS)
      : combined;
  return {
    runId,
    text: bounded,
    messageId: event.messageId ?? prev?.messageId,
    activity: prev?.activity ?? "Streaming response…",
    state: prev?.state ?? "running",
    revision: event.revision ?? prev?.revision,
    byteEnd: (prevByteEnd ?? 0) + eventBytes,
    anchored: true,
    gapped: false,
    updatedAt: now,
  };
}

/**
 * Pure reducer that applies a batch of live stream events to the `run:` / `conv:` overlay map.
 * - `reset` clears all overlays so reconnected sockets never append onto stale partial text.
 * - Terminal states for a `runId` clear both `run:<id>` and any `conv:*` overlay owned by that run,
 *   even when the terminal frame omits `conversationId`, while never wiping a different active run's overlay.
 */
export function applyLiveStreamBatch(
  map: Map<string, LiveStreamOverlay>,
  events: LiveStreamEvent[],
  activeRuns: Array<{
    id: string;
    conversation_id: string | null;
    state: string;
  }>,
  now = Date.now(),
): boolean {
  let changed = false;
  for (const ev of events) {
    if (ev.kind === "reset") {
      if (map.size > 0) {
        map.clear();
        changed = true;
      }
      continue;
    }

    const matchedRun = ev.runId
      ? activeRuns.find((r) => r.id === ev.runId)
      : ev.conversationId
        ? activeRuns.find(
            (r) =>
              r.conversation_id === ev.conversationId &&
              ACTIVE_STREAM_STATES.has(r.state),
          )
        : undefined;
    const runId = ev.runId ?? matchedRun?.id;
    const convId =
      ev.conversationId ?? matchedRun?.conversation_id ?? undefined;
    const runKey = runId ? `run:${runId}` : undefined;
    const convKey = convId ? `conv:${convId}` : undefined;
    if (!runKey && !convKey) continue;

    // Terminal state: delete run:<id> and any conv:* entry belonging to this run
    // (or unattributed entry for convKey), without clobbering another active run in the same thread.
    if (ev.kind === "state" && TERMINAL_RUN_STATES.has(ev.state)) {
      if (runKey && map.delete(runKey)) changed = true;
      if (runId) {
        for (const [key, entry] of Array.from(map.entries())) {
          if (key.startsWith("conv:") && entry.runId === runId) {
            map.delete(key);
            changed = true;
          }
        }
      }
      if (convKey) {
        const existingConv = map.get(convKey);
        if (
          existingConv &&
          (!runId || !existingConv.runId || existingConv.runId === runId)
        ) {
          map.delete(convKey);
          changed = true;
        }
      }
      continue;
    }

    // Ignore late delta/activity events (e.g. a stale message.upsert) belonging to an older
    // non-active run when we know another run is currently active in the same conversation.
    if (
      (ev.kind === "delta" || ev.kind === "activity") &&
      ev.runId &&
      convId &&
      activeRuns.some(
        (r) =>
          r.conversation_id === convId &&
          r.id !== ev.runId &&
          ACTIVE_STREAM_STATES.has(r.state),
      ) &&
      !activeRuns.some(
        (r) => r.id === ev.runId && ACTIVE_STREAM_STATES.has(r.state),
      )
    ) {
      continue;
    }

    const runExisting = runKey ? map.get(runKey) : undefined;
    const convExisting = convKey ? map.get(convKey) : undefined;
    const convMatchesRun =
      convExisting &&
      (!runId || !convExisting.runId || convExisting.runId === runId);
    // If both exist (e.g. `conv:` kept advancing while `activeRuns` lagged behind a new run),
    // choose the fresher / further-advanced overlay so we never regress byteEnd and false-gap.
    const existing =
      runExisting && convMatchesRun && convExisting
        ? (convExisting.byteEnd ?? 0) > (runExisting.byteEnd ?? 0) ||
          ((convExisting.byteEnd ?? 0) === (runExisting.byteEnd ?? 0) &&
            convExisting.updatedAt > runExisting.updatedAt)
          ? convExisting
          : runExisting
        : (runExisting ?? (convMatchesRun ? convExisting : undefined));
    const next = applyLiveStreamEvent(existing, { ...ev, runId }, now);
    if (next === null) continue;

    if (runKey) {
      map.set(runKey, next);
      changed = true;
    }
    if (convKey) {
      const existingConv = map.get(convKey);
      // Do not let a different run overwrite a conversation's active overlay unless
      // the previous run is no longer active or no runId was recorded.
      const canUpdateConv =
        !existingConv ||
        !existingConv.runId ||
        !runId ||
        existingConv.runId === runId ||
        !activeRuns.some(
          (r) =>
            r.id === existingConv.runId && ACTIVE_STREAM_STATES.has(r.state),
        );
      if (canUpdateConv) {
        map.set(convKey, next);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Remove overlays for runs/conversations that are no longer active after a workspace refresh.
 * Never prunes overlays updated at or after `snapshotStartedAt`, so a slow refresh that read
 * an older snapshot cannot delete a newly started run's live deltas.
 */
export function pruneLiveStreams(
  map: Map<string, LiveStreamOverlay>,
  activeRuns: Array<{
    id: string;
    conversation_id: string | null;
    state: string;
  }>,
  snapshotStartedAt = Infinity,
): boolean {
  const activeRunIds = new Set(
    activeRuns
      .filter((r) => ACTIVE_STREAM_STATES.has(r.state))
      .map((r) => r.id),
  );
  const activeConvIds = new Set(
    activeRuns
      .filter((r) => ACTIVE_STREAM_STATES.has(r.state) && r.conversation_id)
      .map((r) => r.conversation_id!),
  );
  let changed = false;
  for (const [key, entry] of Array.from(map.entries())) {
    if (entry.updatedAt >= snapshotStartedAt) continue;
    if (key.startsWith("run:")) {
      const id = key.slice(4);
      if (!activeRunIds.has(id)) {
        map.delete(key);
        changed = true;
      }
    } else if (key.startsWith("conv:")) {
      const cid = key.slice(5);
      if (
        !activeConvIds.has(cid) ||
        (entry.runId && !activeRunIds.has(entry.runId))
      ) {
        map.delete(key);
        changed = true;
      }
    }
  }
  return changed;
}

/** Immediately purge overlays for a locally cancelled or resumed run. */
export function clearRunFromLiveStreams(
  map: Map<string, LiveStreamOverlay>,
  runId: string,
  conversationId?: string | null,
): boolean {
  let changed = false;
  if (map.delete(`run:${runId}`)) changed = true;
  for (const [key, entry] of Array.from(map.entries())) {
    if (key.startsWith("conv:") && entry.runId === runId) {
      map.delete(key);
      changed = true;
    }
  }
  if (conversationId) {
    const convKey = `conv:${conversationId}`;
    const existing = map.get(convKey);
    if (existing && (!existing.runId || existing.runId === runId)) {
      map.delete(convKey);
      changed = true;
    }
  }
  return changed;
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
        const reconnected = this.attempt > 0;
        this.attempt = 0;
        this.onStatus("live");
        if (reconnected) {
          this.onStreamEvents?.([{ kind: "reset" }]);
          this.scheduleRefresh();
        }
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
