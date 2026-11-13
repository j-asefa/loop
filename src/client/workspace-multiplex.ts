import { ownerSession } from "./ownerSession";
import {
  WORKSPACE_MULTIPLEX_PATH,
  WorkspaceMuxResponse,
} from "../shared/workspace-multiplex";
import { viewGeneration } from "./viewCache";

export interface WorkspaceSocket {
  readonly readyState: number;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
type Detail = { conversation?: string; run?: string };
const details = new Map<string, Map<symbol, Detail>>();
const transports = new Map<string, MultiplexTransport>();
ownerSession.registerCache(() => details.clear());
function selection(source: string) {
  const values = [...(details.get(source)?.values() ?? [])];
  return {
    conversations: [
      ...new Set(
        values.flatMap((value) =>
          value.conversation ? [value.conversation] : [],
        ),
      ),
    ],
    runs: [
      ...new Set(values.flatMap((value) => (value.run ? [value.run] : []))),
    ],
  };
}
/** Open detail lifetime is source/owner-bound, including stale React cleanup. */
export function watchWorkspaceDetail(source: string, detail: Detail) {
  const generation = viewGeneration(),
    key = Symbol();
  let group = details.get(source);
  if (!group) details.set(source, (group = new Map()));
  group.set(key, detail);
  for (const transport of transports.values()) transport.update(source);
  let closed = false;
  return () => {
    if (closed || generation !== viewGeneration()) return;
    closed = true;
    group!.delete(key);
    if (!group!.size) details.delete(source);
    for (const transport of transports.values()) transport.update(source);
  };
}
class SourceSocket implements WorkspaceSocket {
  readonly id = crypto.randomUUID();
  readyState: number = WebSocket.CONNECTING;
  onmessage: WorkspaceSocket["onmessage"] = null;
  onclose: WorkspaceSocket["onclose"] = null;
  onerror: WorkspaceSocket["onerror"] = null;
  epoch: string;
  cursor: number;
  constructor(
    readonly transport: MultiplexTransport,
    readonly source: string,
    url: URL,
  ) {
    this.epoch = url.searchParams.get("epoch") ?? "";
    this.cursor = Number(url.searchParams.get("cursor") ?? 0);
  }
  closed(code: number, reason = "Source disconnected", notify = true) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.transport.remove(this, notify);
    queueMicrotask(() =>
      this.onclose?.(new CloseEvent("close", { code, reason })),
    );
  }
  close() {
    this.closed(1000);
  }
}
class MultiplexTransport {
  readonly generation = viewGeneration();
  private readonly socket: WebSocket;
  private readonly sources = new Map<string, SourceSocket>();
  private readonly pending = new Map<string, object>();
  private readonly subscribed = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private tokens = 32;
  private at = Date.now();
  constructor(
    private readonly key: string,
    url: URL,
  ) {
    const target = new URL(WORKSPACE_MULTIPLEX_PATH, url);
    this.socket = new WebSocket(target);
    this.socket.onopen = () => {
      if (!this.current()) return;
      for (const source of this.sources.values()) this.subscribe(source);
    };
    this.socket.onmessage = (event) => {
      if (!this.current()) return;
      try {
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).length > 512 * 1024 + 4096
        )
          throw new Error();
        const packet = WorkspaceMuxResponse.parse(JSON.parse(event.data));
        const source = this.sources.get(packet.id);
        if (!source || source.source !== packet.source) return;
        if (packet.type === "closed")
          source.closed(packet.code, packet.reason, false);
        else {
          source.readyState = WebSocket.OPEN;
          source.epoch = packet.frame.epoch;
          source.cursor = packet.frame.cursor;
          source.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(packet.frame) }),
          );
        }
      } catch {
        this.socket.close();
      }
    };
    this.socket.onerror = () => this.socket.close();
    this.socket.onclose = (event) => {
      clearTimeout(this.timer);
      this.pending.clear();
      this.subscribed.clear();
      if (transports.get(key) === this) transports.delete(key);
      for (const source of [...this.sources.values()])
        source.closed(event.code, event.reason, false);
    };
  }
  current() {
    if (this.generation === viewGeneration()) return true;
    this.socket.close();
    return false;
  }
  add(source: string, url: URL) {
    const logical = new SourceSocket(this, source, url);
    this.sources.set(logical.id, logical);
    if (this.socket.readyState === WebSocket.OPEN) this.subscribe(logical);
    return logical;
  }
  private subscribe(source: SourceSocket) {
    if (!this.current() || this.socket.readyState !== WebSocket.OPEN) return;
    this.enqueue(source.id, {
      v: 1,
      type: "subscribe",
      id: source.id,
      source: source.source,
      epoch: source.epoch,
      cursor: source.cursor,
      ...selection(source.source),
    });
  }
  private enqueue(id: string, packet: object) {
    if (!this.pending.has(id) && this.pending.size >= 256) {
      this.socket.close();
      return;
    }
    this.pending.set(id, packet);
    this.flush();
  }
  private flush = () => {
    clearTimeout(this.timer);
    if (!this.current() || this.socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    this.tokens = Math.min(
      32,
      this.tokens + Math.max(0, now - this.at) * 0.016,
    );
    this.at = now;
    while (this.tokens >= 1 && this.pending.size) {
      if (this.socket.bufferedAmount > 256 * 1024) {
        this.socket.close();
        return;
      }
      const [id, queued] = this.pending.entries().next().value!;
      this.pending.delete(id);
      this.tokens--;
      let value = queued;
      if ((value as { type: string }).type === "subscribe") {
        const source = this.sources.get(id);
        if (!source) continue;
        value = {
          ...value,
          epoch: source.epoch,
          cursor: source.cursor,
          ...selection(source.source),
        };
        this.subscribed.add(id);
      } else this.subscribed.delete(id);
      this.socket.send(JSON.stringify(value));
    }
    if (this.pending.size)
      this.timer = setTimeout(
        this.flush,
        Math.max(1, Math.ceil((1 - this.tokens) / 0.016)),
      );
  };
  update(source: string) {
    if (!this.current()) return;
    for (const logical of this.sources.values())
      if (logical.source === source) this.subscribe(logical);
  }
  remove(source: SourceSocket, notify = true) {
    if (!this.sources.delete(source.id)) return;
    this.pending.delete(source.id);
    if (
      notify &&
      this.subscribed.has(source.id) &&
      this.socket.readyState === WebSocket.OPEN &&
      this.current()
    )
      this.enqueue(source.id, { v: 1, type: "unsubscribe", id: source.id });
    this.subscribed.delete(source.id);
    if (!this.sources.size) {
      if (transports.get(this.key) === this) transports.delete(this.key);
      clearTimeout(this.timer);
      this.pending.clear();
      this.socket.close();
    }
  }
}
export function multiplexWorkspaceSocket(
  url: URL,
  source: string,
): WorkspaceSocket {
  // Retire obsolete owner connections before considering this owner's cache.
  for (const value of transports.values()) value.current();
  const key = JSON.stringify([url.origin, viewGeneration()]);
  let transport = transports.get(key);
  if (!transport)
    transports.set(key, (transport = new MultiplexTransport(key, url)));
  return transport.add(source, url);
}
