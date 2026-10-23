import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchWorkspaceEvents } from "../src/client/workspace-events";
import { setViewOwner, viewGeneration } from "../src/client/viewCache";
import { PARTIAL_WORKSPACE_CAPABILITIES } from "../src/shared/workspace-events";
import {
  WorkspaceChangeQueue,
  listenWorkspaceChanges,
} from "../src/client/workspace-changes";

class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  close(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frame(cursor = 0, epoch = "epoch", type = "events") {
    this.onmessage?.({ data: JSON.stringify({ v: 2, type, epoch, cursor }) });
  }
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function subscribe(
  read = vi.fn(
    async (_after: number, _signal: AbortSignal) => [] as { id: number }[],
  ),
  source = "",
) {
  const changed = vi.fn(),
    expired = vi.fn(),
    connected = vi.fn(),
    frame = vi.fn();
  stops.push(
    watchWorkspaceEvents({
      url: new URL("ws://loop/api/events/ws"),
      source,
      read,
      changed,
      expired,
      connected,
      frame,
    }),
  );
  return {
    read,
    changed,
    expired,
    connected,
    frame,
    socket: Socket.instances.at(-1)!,
  };
}
it("uses push while connected and catches up with the source cursor after reconnect", async () => {
  const s = subscribe();
  s.socket.frame(41, "source-epoch", "reset");
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.read).not.toHaveBeenCalled();
  expect(s.changed).toHaveBeenCalledTimes(1);
  s.socket.close();
  await vi.advanceTimersByTimeAsync(800);
  const next = Socket.instances.at(-1)!;
  expect(next.url.searchParams.get("cursor")).toBe("41");
  expect(next.url.searchParams.get("epoch")).toBe("source-epoch");
  const before = s.changed.mock.calls.length;
  next.frame(42, "source-epoch");
  expect(s.changed).toHaveBeenCalledTimes(before + 1);
});

it("requests v3 and routes a collection invalidation only to that source's pager", () => {
  const s = subscribe();
  expect(s.socket.url.searchParams.get("v")).toBe("3");
  expect(s.socket.url.searchParams.get("clock")).toBe("1");
  const queue = new WorkspaceChangeQueue();
  const feed = vi.fn(),
    thread = vi.fn(),
    results = vi.fn(),
    runs = vi.fn(),
    otherFeed = vi.fn();
  stops.push(listenWorkspaceChanges("feed", feed, "one"));
  stops.push(listenWorkspaceChanges("thread", thread, "one", "thread"));
  stops.push(listenWorkspaceChanges("results", results, "one"));
  stops.push(listenWorkspaceChanges("runs", runs, "one"));
  stops.push(listenWorkspaceChanges("feed", otherFeed, "two"));
  s.changed.mockImplementation((events) => {
    queue.add("one", events);
    window.dispatchEvent(
      new CustomEvent("loop-workspace-change", { detail: queue.drain() }),
    );
  });
  const send = (event: unknown, id: number) =>
    s.socket.onmessage?.({
      data: JSON.stringify({
        v: 3,
        type: "events",
        epoch: "one",
        cursor: id,
        events: [{ id, event }],
      }),
    });
  send({ type: "invalidate", scope: { kind: "collection", id: "feed" } }, 1);
  expect(feed).toHaveBeenCalledTimes(1);
  expect(thread).not.toHaveBeenCalled();
  expect(results).not.toHaveBeenCalled();
  expect(runs).not.toHaveBeenCalled();
  expect(otherFeed).not.toHaveBeenCalled();
  // Watermark-only notifications reuse the cursor but still carry new work.
  send({ type: "invalidate", scope: { kind: "collection", id: "saved" } }, 1);
  expect(feed).toHaveBeenCalledTimes(1);
  send({ type: "invalidate", scope: { kind: "collection", id: "runs" } }, 1);
  expect(runs).toHaveBeenCalledTimes(1);
  expect(feed).toHaveBeenCalledTimes(1);
  expect(thread).not.toHaveBeenCalled();
  send(
    { type: "a.future.event", scope: { kind: "collection", id: "feed" } },
    2,
  );
  expect(feed).toHaveBeenCalledTimes(2);
  expect(thread).toHaveBeenCalledTimes(1);
  expect(results).toHaveBeenCalledTimes(1);
  expect(runs).toHaveBeenCalledTimes(2);
  expect(otherFeed).not.toHaveBeenCalled();
});

it("exposes reset capabilities separately for each source and clears removed sources", () => {
  const one = subscribe(),
    two = subscribe();
  const queue = new WorkspaceChangeQueue();
  const complete = {
    ...PARTIAL_WORKSPACE_CAPABILITIES,
    invalidations: "complete",
    deadlines: true,
    transcript: "delta",
  };
  for (const [source, s, capabilities] of [
    ["one", one, complete],
    ["two", two, PARTIAL_WORKSPACE_CAPABILITIES],
  ] as const) {
    s.frame.mockImplementation((frame) =>
      queue.capabilities.set(source, frame.capabilities),
    );
    s.changed.mockImplementation((events) => queue.add(source, events));
    s.socket.onmessage?.({
      data: JSON.stringify({
        v: 3,
        type: "reset",
        epoch: source,
        cursor: 0,
        build: source,
        buildIdentity: null,
        capabilities,
      }),
    });
  }
  expect(queue.drain().changes).toEqual([
    expect.objectContaining({ source: "one", capabilities: complete }),
    expect.objectContaining({
      source: "two",
      capabilities: PARTIAL_WORKSPACE_CAPABILITIES,
    }),
  ]);
  queue.delete("one");
  expect(queue.capabilities.has("one")).toBe(false);
  expect(queue.capabilities.get("two")).toEqual(PARTIAL_WORKSPACE_CAPABILITIES);
  queue.clear();
  expect(queue.capabilities.size).toBe(0);
});
it("falls back for old servers and cancels a pending read when push recovers", async () => {
  let finish!: (value: { id: number }[]) => void;
  const read = vi.fn(
    (_after: number, _signal: AbortSignal) =>
      new Promise<{ id: number }[]>((resolve) => {
        finish = resolve;
      }),
  );
  const s = subscribe(read);
  s.socket.close();
  await vi.advanceTimersByTimeAsync(1800);
  expect(read).toHaveBeenCalledTimes(1);
  const next = Socket.instances.at(-1)!;
  next.frame(10, "new-process", "reset");
  expect(read.mock.calls[0][1].aborted).toBe(true);
  finish([{ id: 500 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.changed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
});
it("refreshes on phone wake and rejects stale callbacks after owner/source teardown", async () => {
  const s = subscribe();
  s.socket.frame();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(s.changed).toHaveBeenCalledTimes(2);
  stops.pop()!();
  s.socket.frame(1);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.changed).toHaveBeenCalledTimes(2);
  expect(s.read).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(1);
});
it("ends the subscription on session expiry without replaying or polling", async () => {
  const s = subscribe();
  s.socket.frame();
  s.socket.close(4003);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.expired).toHaveBeenCalledTimes(1);
  expect(s.read).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(1);
});

it("reports healthy HTTP fallback across socket retries and detects a later outage", async () => {
  const s = subscribe();
  s.socket.close();
  expect(s.connected).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(true);
  Socket.instances.at(-1)!.close();
  expect(s.connected).toHaveBeenLastCalledWith(true);
  s.read.mockRejectedValueOnce(new Error("Workspace unavailable"));
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(true);
  expect(s.expired).not.toHaveBeenCalled();
});

it("expires fallback health when push recovers so a later disconnect is visible immediately", async () => {
  const s = subscribe();
  s.socket.close();
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(true);
  const recovered = Socket.instances.at(-1)!;
  recovered.frame(1, "recovered", "reset");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.read).toHaveBeenCalledTimes(1);
  recovered.close();
  expect(s.connected).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(true);
});

it("shows an HTTP restart immediately while connecting and ignores it after teardown", async () => {
  const s = subscribe();
  s.socket.readyState = 0;
  window.dispatchEvent(new Event("loop-reconnecting"));
  expect(s.connected).toHaveBeenLastCalledWith(false);
  expect(s.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(true);
  window.dispatchEvent(new Event("loop-reconnecting"));
  expect(s.connected).toHaveBeenLastCalledWith(false);
  s.socket.close();
  expect(s.connected).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.connected).toHaveBeenLastCalledWith(true);
  const next = Socket.instances.at(-1)!;
  next.frame(1);
  window.dispatchEvent(new Event("loop-reconnecting"));
  expect(s.connected).toHaveBeenLastCalledWith(true);
  stops.pop()!();
  s.connected.mockClear();
  window.dispatchEvent(new Event("loop-reconnecting"));
  expect(s.connected).not.toHaveBeenCalled();
});

it("does not let an older fallback response clear a newer restart notice", async () => {
  let finish!: (value: { id: number }[]) => void;
  const s = subscribe(
    vi.fn(
      (_after: number, _signal: AbortSignal) =>
        new Promise<{ id: number }[]>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  s.socket.readyState = 0;
  await vi.advanceTimersByTimeAsync(1800);
  window.dispatchEvent(new Event("loop-reconnecting"));
  expect(s.connected).toHaveBeenLastCalledWith(false);
  finish([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.connected).toHaveBeenCalledTimes(1);
  expect(s.connected).toHaveBeenLastCalledWith(false);
});

it("resumes HTTP fallback from accepted socket cursors and replaces them on epoch reset", async () => {
  const s = subscribe();
  s.socket.frame(12_000, "first-process", "reset");
  s.socket.close();
  s.read.mockResolvedValueOnce([{ id: 15_000 }]);
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.read.mock.calls.at(-1)?.[0]).toBe(12_000);
  const next = Socket.instances.at(-1)!;
  next.frame(12_001, "first-process");
  next.close();
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.read.mock.calls.at(-1)?.[0]).toBe(15_000);
  const restarted = Socket.instances.at(-1)!;
  restarted.frame(5, "replacement-process", "reset");
  restarted.close();
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.read.mock.calls.at(-1)?.[0]).toBe(5);
});

it("backs off fallback reads and reconnect attempts until Retry-After without losing the cursor", async () => {
  const s = subscribe();
  s.socket.frame(17, "limited", "reset");
  s.socket.close();
  s.read.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 429, retryAt: Date.now() + 12_000 }));
  await vi.advanceTimersByTimeAsync(1800);
  expect(s.read).toHaveBeenCalledTimes(1);
  Socket.instances.at(-1)!.close();
  const attempts = Socket.instances.length;
  await vi.advanceTimersByTimeAsync(10_199);
  expect(s.read).toHaveBeenCalledTimes(1);
  expect(Socket.instances).toHaveLength(attempts);
  await vi.advanceTimersByTimeAsync(1801);
  expect(s.read).toHaveBeenCalledTimes(2);
  expect(s.read.mock.calls.at(-1)?.[0]).toBe(17);
  expect(Socket.instances.length).toBeGreaterThan(attempts);
});


function clockFrame(s: ReturnType<typeof subscribe>, next: number | null, cursor = 1, epoch = "clock", serverNow = 1000) {
  s.socket.onmessage?.({ data: JSON.stringify({ v: 3, type: "reset", epoch, cursor,
    build: "fixture", buildIdentity: null, capabilities: { ...PARTIAL_WORKSPACE_CAPABILITIES, deadlines: true },
    serverNow, nextDeadline: next }) });
}
function deadlineEvent(s: ReturnType<typeof subscribe>, next: number | null, cursor: number, serverNow = 1000) {
  s.socket.onmessage?.({ data: JSON.stringify({ v: 3, type: "events", epoch: "clock", cursor,
    events: [{ id: cursor, event: { type: "deadline", subject: { kind: "collection", id: "all" },
      scope: { kind: "collection", id: "all" }, serverNow, nextDeadline: next } }] }) });
}
it("uses server-relative deadlines despite clock skew, replaces timers, and learns the second expiry", async () => {
  const s = subscribe();
  clockFrame(s, 2000);
  s.changed.mockClear();
  // The browser clock is decades ahead of the source; only the received delta matters.
  await vi.advanceTimersByTimeAsync(999);
  expect(s.changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.changed).toHaveBeenCalledTimes(1);
  expect(s.changed.mock.calls[0][0]).toEqual(expect.arrayContaining([
    { type: "invalidate", scope: { kind: "collection", id: "approvals" } },
    { type: "invalidate", scope: { kind: "collection", id: "pulls" } },
  ]));
  deadlineEvent(s, 4000, 2, 2000);
  await vi.advanceTimersByTimeAsync(500);
  deadlineEvent(s, 5000, 3, 2500); // extend earliest; original timer is replaced
  await vi.advanceTimersByTimeAsync(1500);
  expect(s.changed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.changed).toHaveBeenCalledTimes(2);
  deadlineEvent(s, 6000, 4, 5000);
  deadlineEvent(s, null, 5, 5000); // deleting earliest/last clears it
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.changed).toHaveBeenCalledTimes(2);
  expect(s.read).not.toHaveBeenCalled();
});
it("keeps source/epoch/owner deadline generations separate and rejects stale snapshot clocks", async () => {
  setViewOwner("clock-owner");
  const one = subscribe(undefined, "one"), two = subscribe(undefined, "two");
  clockFrame(one, 2000); clockFrame(two, 3000);
  one.changed.mockClear(); two.changed.mockClear();
  window.dispatchEvent(new CustomEvent("loop-workspace-clock", { detail: { source: "one", generation: viewGeneration(),
    clock: { epoch: "clock", cursor: 2, serverNow: 1000, nextDeadline: 4000 } } }));
  // An older HTTP response must not restore the superseded earlier deadline.
  window.dispatchEvent(new CustomEvent("loop-workspace-clock", { detail: { source: "one", generation: viewGeneration(),
    clock: { epoch: "clock", cursor: 1, serverNow: 1100, nextDeadline: 1200 } } }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(one.changed).not.toHaveBeenCalled();
  expect(two.changed).toHaveBeenCalledTimes(1);
  clockFrame(one, null, 0, "replacement");
  one.changed.mockClear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(one.changed).not.toHaveBeenCalled();
  clockFrame(two, 2000);
  two.changed.mockClear();
  setViewOwner("another-owner");
  await vi.advanceTimersByTimeAsync(1000);
  expect(two.changed).not.toHaveBeenCalled();
  setViewOwner(undefined);
});
it("coalesces every advertised scope without losing the conversation or refreshing another source", () => {
  const queue = new WorkspaceChangeQueue();
  queue.add("one", [{ type: "invalidate", subject: { kind: "message", id: "m" },
    scope: { kind: "collection", id: "feed" }, scopes: [{ kind: "collection", id: "saved" }, { kind: "conversation", id: "thread" }] }]);
  expect(queue.drain().changes?.[0].events).toEqual([
    { type: "invalidate", scope: { kind: "collection", id: "feed" } },
    { type: "invalidate", scope: { kind: "collection", id: "saved" } },
    { type: "invalidate", scope: { kind: "conversation", id: "thread" } },
  ]);
});

it("learns a replacement epoch through HTTP while sockets are unavailable and ignores the earlier response", async () => {
  const s = subscribe(undefined, "one");
  clockFrame(s, 20_000, 10, "old");
  s.socket.close(); s.changed.mockClear();
  const received = (requestId: number, epoch: string, nextDeadline: number) => window.dispatchEvent(new CustomEvent("loop-workspace-clock", {
    detail: { source: "one", generation: viewGeneration(), requestId, clock: { epoch, cursor: 1, serverNow: 1000, nextDeadline } },
  }));
  received(2, "replacement", 1500);
  received(1, "old", 20_000);
  await vi.advanceTimersByTimeAsync(500);
  expect(s.changed).toHaveBeenCalledTimes(1);
  expect(s.changed.mock.calls[0][0]).toEqual(expect.arrayContaining([
    { type: "invalidate", scope: { kind: "collection", id: "approvals" } },
  ]));
});
