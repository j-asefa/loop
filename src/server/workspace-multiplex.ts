import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { z } from "zod";
import type { EventSocket } from "../event-socket.js";
import { invalidate } from "../shared/workspace-events.js";
import {
  FLEET_EVENT_BYTES,
  FLEET_EVENT_BUFFER_BYTES,
  fleetEventProjection,
} from "../shared/fleet-workspace-events.js";
import {
  WorkspaceMuxRequest,
  WorkspaceSourceFrame,
  WorkspaceSubscription,
} from "../shared/workspace-multiplex.js";

type Subscription = z.infer<typeof WorkspaceSubscription>;
type Frame = WorkspaceSourceFrame;
type Listener = {
  request: Subscription;
  send: (frame: Frame) => void;
  close: (reason: string) => void;
  /** Set once this viewer has been sent a frame for its current position. */
  current?: boolean;
  /** The capabilities last announced to this viewer, serialized. */
  capabilities?: string;
};
const announced = (frame: Frame) => {
  const capabilities = (frame as { capabilities?: unknown }).capabilities;
  return capabilities === undefined ? undefined : JSON.stringify(capabilities);
};
type Entry = {
  source: string;
  listeners: Map<string, Listener>;
  socket?: LogicalSocket;
  reset?: Extract<Frame, { type: "reset" }>;
  clockAt: number;
  epoch: string;
  cursor: number;
  floor: number;
  cache: { frame: Frame; bytes: number }[];
  bytes: number;
  selection: string;
  binding: string;
  closing: boolean;
};

class LogicalSocket extends EventEmitter implements EventSocket {
  readyState: number = WebSocket.OPEN;
  readonly bufferedAmount = 0;
  constructor(private readonly write: (text: string) => void) {
    super();
  }
  send(text: string) {
    if (this.readyState === WebSocket.OPEN) this.write(text);
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
    this.removeAllListeners();
  }
}

/** Per gateway owner, bounded replay transport for the existing source stream.
 * It has no Feed store or global event cursor. The last viewer releases the
 * source immediately; slow sources and slow browsers cannot stall the others. */
export class WorkspaceMultiplex {
  private readonly sources = new Map<string, Entry>();
  private readonly browsers = new Set<WebSocket>();
  private viewers = 0;
  private next = 0;
  private stopped = false;
  constructor(
    private readonly open: (
      socket: EventSocket,
      source: string,
      query: URLSearchParams,
    ) => Promise<void | (() => void)> | void | (() => void),
    private readonly current: (source: string) => string = (source) => source,
  ) {}

  private selection(entry: Entry, extra?: Listener) {
    const listeners = [...entry.listeners.values(), ...(extra ? [extra] : [])];
    const conversations = [
      ...new Set(listeners.flatMap((item) => item.request.conversations)),
    ].sort();
    const runs = [
      ...new Set(listeners.flatMap((item) => item.request.runs)),
    ].sort();
    if (conversations.length > 16 || runs.length > 16)
      throw new Error("Too many open source details. Close an unused view.");
    return JSON.stringify({ conversations, runs });
  }
  private restart(entry: Entry) {
    if (this.stopped || entry.closing) return;
    const selection = this.selection(entry);
    if (entry.socket && entry.selection === selection) return;
    const old = entry.socket;
    entry.socket = undefined;
    old?.close();
    entry.selection = selection;
    const socket = new LogicalSocket((text) => {
      if (entry.socket !== socket || socket.readyState !== WebSocket.OPEN)
        return;
      try {
        this.receive(entry, text);
      } catch {
        socket.close();
      }
    });
    entry.socket = socket;
    socket.once("close", () => {
      if (entry.socket !== socket) return;
      entry.socket = undefined;
      entry.closing = true;
      // Every source listener gets its own explicit resync signal. Other
      // sources keep their socket, cursor, cache and active viewers.
      for (const listener of [...entry.listeners.values()])
        listener.close("Source updates unavailable. Reconcile and reconnect.");
    });
    const selected = JSON.parse(selection) as {
      conversations: string[];
      runs: string[];
    };
    const query = new URLSearchParams({
      v: "3",
      epoch: entry.epoch,
      cursor: String(entry.cursor),
      conversations: JSON.stringify(selected.conversations),
      runs: JSON.stringify(selected.runs),
    });
    void Promise.resolve()
      .then(() => {
        if (socket.readyState === WebSocket.OPEN)
          return this.open(socket, entry.source, query);
      })
      .then((stop) => {
        if (!stop) return;
        if (socket.readyState !== WebSocket.OPEN) stop();
        else socket.once("close", stop);
      })
      .catch(() => socket.close());
  }
  private receive(entry: Entry, text: string) {
    if (this.current(entry.source) !== entry.binding)
      throw new Error("Source authority changed");
    if (Buffer.byteLength(text) > FLEET_EVENT_BYTES) throw new Error();
    const frame = WorkspaceSourceFrame.parse(JSON.parse(text));
    if (frame.type === "events" && entry.epoch && frame.epoch !== entry.epoch)
      throw new Error("A replaced source must reset before replay");
    if (frame.type === "events" && frame.cursor < entry.cursor)
      throw new Error();
    if (
      frame.type === "events" &&
      frame.events.some(
        (item, index) =>
          item.id > frame.cursor ||
          (index > 0 && item.id < frame.events[index - 1].id),
      )
    )
      throw new Error();
    entry.clockAt = performance.now();
    entry.epoch = frame.epoch;
    entry.cursor = frame.cursor;
    if (frame.type === "reset") {
      entry.reset = frame;
      entry.cache = [];
      entry.bytes = 0;
      entry.floor = frame.cursor;
    } else {
      // A newly demanded source can resume directly at its first viewer's
      // cursor. Retain enough source metadata to reset a later, older viewer
      // if this bounded replay ring no longer covers its cursor.
      const capabilities = frame.capabilities ?? entry.reset?.capabilities;
      if (!capabilities)
        throw new Error("Source replay must announce capabilities");
      entry.reset = {
        v: 3,
        type: "reset",
        epoch: frame.epoch,
        cursor: frame.cursor,
        build: entry.reset?.build ?? "",
        buildIdentity: entry.reset?.buildIdentity ?? null,
        capabilities,
        serverNow: frame.serverNow,
        nextDeadline: frame.nextDeadline,
      };
      const bytes = Buffer.byteLength(text);
      entry.cache.push({ frame, bytes });
      entry.bytes += bytes;
      while (entry.bytes > FLEET_EVENT_BYTES || entry.cache.length > 32) {
        const first = entry.cache.shift()!;
        entry.bytes -= first.bytes;
        entry.floor = first.frame.cursor;
      }
    }
    for (const listener of [...entry.listeners.values()])
      this.deliver(entry, listener, frame);
  }
  private deliver(
    entry: Entry,
    listener: Listener,
    frame: Frame,
    replay = false,
  ) {
    if (this.current(entry.source) !== entry.binding)
      throw new Error("Source authority changed");
    const request = listener.request;
    if (
      frame.type === "events" &&
      (request.epoch !== frame.epoch || request.cursor < entry.floor)
    ) {
      this.reset(entry, listener);
      return;
    }
    if (frame.type === "events" && frame.cursor < request.cursor) return;
    const capabilities = announced(frame);
    let output = replay ? { ...frame, ...this.clock(entry) } : frame;
    if (frame.type === "events") {
      const events = frame.events
        .filter((item) => item.id > request.cursor)
        .map((item) => ({
          ...item,
          event: fleetEventProjection(item.event, request),
        }));
      // A restarted upstream (a changed selection) reports its unchanged
      // position; a viewer already current there with the same capabilities
      // has nothing to reconcile. Its first frame, or a capability change,
      // still carries the reconciliation signal.
      if (
        listener.current &&
        !events.length &&
        frame.cursor === request.cursor &&
        (capabilities === undefined || capabilities === listener.capabilities)
      )
        return;
      output = {
        ...frame,
        ...(replay ? this.clock(entry) : {}),
        events: events.length
          ? events
          : [{ id: frame.cursor, event: invalidate() }],
      };
    }
    request.epoch = frame.epoch;
    request.cursor = frame.cursor;
    listener.current = true;
    if (capabilities !== undefined) listener.capabilities = capabilities;
    listener.send(output);
  }
  private clock(entry: Entry) {
    if (!entry.reset) throw new Error("Source clock unavailable");
    // Advance a source-relative clock by monotonic elapsed time. Replaying an
    // old timestamp unchanged would postpone a deadline for each new viewer.
    return {
      serverNow:
        entry.reset.serverNow +
        Math.max(0, Math.floor(performance.now() - entry.clockAt)),
      nextDeadline: entry.reset.nextDeadline,
    };
  }
  private reset(entry: Entry, listener: Listener) {
    if (!entry.reset) {
      listener.close("Source snapshot unavailable. Reconnect.");
      return;
    }
    const frame = WorkspaceSourceFrame.parse({
      ...entry.reset,
      ...this.clock(entry),
      epoch: entry.epoch,
      cursor: entry.cursor,
    });
    listener.request.epoch = frame.epoch;
    listener.request.cursor = frame.cursor;
    listener.current = true;
    const capabilities = announced(frame);
    if (capabilities !== undefined) listener.capabilities = capabilities;
    listener.send(frame);
  }
  private attach(key: string, listener: Listener) {
    if (this.stopped || this.viewers >= 1024)
      throw new Error("Too many active source views.");
    const binding = this.current(listener.request.source);
    let entry = this.sources.get(listener.request.source);
    if (entry && entry.binding !== binding) {
      entry.closing = true;
      entry.socket?.close();
      for (const previous of [...entry.listeners.values()])
        previous.close("Source authority changed. Reconcile.");
      this.sources.delete(entry.source);
      entry = undefined;
    }
    if (!entry) {
      if (this.sources.size >= 128) throw new Error("Too many active sources.");
      entry = {
        source: listener.request.source,
        listeners: new Map(),
        clockAt: 0,
        epoch: listener.request.epoch,
        cursor: listener.request.cursor,
        floor: listener.request.cursor,
        cache: [],
        bytes: 0,
        selection: "",
        binding,
        closing: false,
      };
      this.sources.set(entry.source, entry);
    }
    try {
      this.selection(entry, listener);
    } catch (error) {
      if (!entry.listeners.size) this.sources.delete(entry.source);
      throw error;
    }
    entry.listeners.set(key, listener);
    this.viewers++;
    const attached = entry;
    queueMicrotask(() => {
      if (attached.listeners.get(key) !== listener) return;
      try {
        if (this.current(attached.source) !== attached.binding)
          throw new Error();
        const entry = attached;
        if (entry.reset) {
          if (
            listener.request.epoch !== entry.epoch ||
            listener.request.cursor < entry.floor ||
            listener.request.cursor > entry.cursor
          )
            this.reset(entry, listener);
          else {
            const pending = entry.cache.filter(
              (item) => item.frame.cursor > listener.request.cursor,
            );
            // The shared upstream announces capabilities once. A returning
            // viewer still needs that metadata when its first frame is replay.
            if (pending.length)
              for (const [index, item] of pending.entries())
                this.deliver(
                  entry,
                  listener,
                  index === 0 && entry.reset.type === "reset"
                    ? { ...item.frame, capabilities: entry.reset.capabilities }
                    : item.frame,
                  true,
                );
            else this.reset(entry, listener);
          }
        }
      } catch {
        listener.close("Source authority changed. Reconcile.");
      }
    });
    this.restart(entry);
    const stop = () => {
      if (!entry!.listeners.delete(key)) return;
      this.viewers--;
      if (!entry!.listeners.size) {
        this.sources.delete(entry!.source);
        const socket = entry!.socket;
        entry!.socket = undefined;
        socket?.close();
      } else this.restart(entry!);
    };
    const update = (request: Subscription) => {
      if (
        attached.closing ||
        attached.listeners.get(key) !== listener ||
        this.current(attached.source) !== attached.binding
      )
        throw new Error("Source authority changed");
      const before = listener.request;
      // The wire is ordered. Updating open details cannot rewind frames that
      // this viewer has already been sent while its request was in flight.
      listener.request = {
        ...request,
        epoch: before.epoch,
        cursor: before.cursor,
      };
      try {
        this.selection(attached);
      } catch (error) {
        listener.request = before;
        throw error;
      }
      this.restart(attached);
    };
    return { stop, update };
  }
  connect(ws: WebSocket) {
    if (this.stopped) {
      ws.close(1012, "Workspace stopping");
      return () => {};
    }
    this.browsers.add(ws);
    const viewer = ++this.next;
    const subscriptions = new Map<
      string,
      {
        source: string;
        stop: () => void;
        update: (request: Subscription) => void;
      }
    >();
    let tokens = 256,
      at = performance.now();
    const send = (value: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const text = JSON.stringify(value);
      if (
        ws.bufferedAmount + Buffer.byteLength(text) >
        FLEET_EVENT_BUFFER_BYTES
      ) {
        ws.close(4008, "Reconnect to reconcile source state.");
        return;
      }
      ws.send(text);
    };
    const remove = (id: string) => {
      const previous = subscriptions.get(id);
      subscriptions.delete(id);
      previous?.stop();
    };
    const message = (raw: import("ws").RawData, binary: boolean) => {
      const now = performance.now();
      tokens = Math.min(256, tokens + Math.max(0, now - at) * 0.016);
      at = now;
      if (
        binary ||
        !Buffer.isBuffer(raw) ||
        raw.length > 40 * 1024 ||
        tokens-- < 1
      ) {
        ws.close(1008, "Invalid source subscription");
        return;
      }
      let request: z.infer<typeof WorkspaceMuxRequest>;
      try {
        request = WorkspaceMuxRequest.parse(JSON.parse(raw.toString()));
      } catch {
        ws.close(1008, "Invalid source subscription");
        return;
      }
      if (request.type === "unsubscribe") {
        remove(request.id);
        return;
      }
      const previous = subscriptions.get(request.id);
      if (previous?.source === request.source) {
        try {
          previous.update(request);
        } catch {
          remove(request.id);
          send({
            v: 1,
            type: "closed",
            id: request.id,
            source: request.source,
            code: 1013,
            reason: "This source is unavailable or has too many open views.",
          });
        }
        return;
      }
      remove(request.id);
      if (subscriptions.size >= 128) {
        ws.close(1008, "Too many source subscriptions");
        return;
      }
      const { id, source } = request;
      const close = (reason: string) => {
        remove(id);
        send({ v: 1, type: "closed", id, source, code: 1013, reason });
      };
      try {
        const attached = this.attach(`${viewer}:${id}`, {
          request,
          send: (frame) => send({ v: 1, type: "frame", id, source, frame }),
          close,
        });
        subscriptions.set(id, { source, ...attached });
      } catch {
        close("This source is unavailable or has too many open views.");
      }
    };
    ws.on("message", message);
    const stop = () => {
      for (const id of [...subscriptions.keys()]) remove(id);
      ws.off("message", message);
      ws.off("close", stop);
      this.browsers.delete(ws);
    };
    ws.once("close", stop);
    return stop;
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const browser of this.browsers)
      browser.close(1012, "Workspace stopping");
    for (const entry of this.sources.values()) entry.socket?.close();
    this.sources.clear();
  }
}
