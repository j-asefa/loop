import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchWorkspaceEvents } from "../src/client/workspace-events";
import { setViewOwner, viewGeneration } from "../src/client/viewCache";
import {
  PARTIAL_WORKSPACE_CAPABILITIES,
  COMPLETE_WORKSPACE_CAPABILITIES,
} from "../src/shared/workspace-events";
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
    this.onmessage?.({
      data: JSON.stringify({
        v: 3,
        type,
        epoch,
        cursor,
        serverNow: Date.now(),
        nextDeadline: null,
        ...(type === "reset"
          ? {
              build: "",
              buildIdentity: null,
              capabilities: PARTIAL_WORKSPACE_CAPABILITIES,
            }
          : {
              events: [
                {
                  id: cursor,
                  event: {
                    type: "invalidate",
                    scope: { kind: "collection", id: "all" },
                  },
                },
              ],
            }),
      }),
    });
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

it("extends a scoped batch when a later broad invalidation arrives", async () => {
  const one = subscribe(),
    two = subscribe();
  const queue = new WorkspaceChangeQueue(),
    published = vi.fn();
  stops.push(() => queue.clear());
  for (const [source, stream] of [
    ["one", one],
    ["two", two],
  ] as const)
    stream.changed.mockImplementation((events) => {
      queue.add(source, events);
      queue.schedule(published);
    });
  let id = 0;
  const send = (stream: typeof one, scope: "feed" | "all") =>
    stream.socket.onmessage?.({
      data: JSON.stringify({
        serverNow: Date.now(),
        nextDeadline: null,
        v: 3,
        type: "events",
        epoch: "epoch",
        cursor: ++id,
        events: [
          {
            id,
            event: {
              type: "invalidate",
              scope: { kind: "collection", id: scope },
            },
          },
        ],
      }),
    });
  send(one, "feed");
  await vi.advanceTimersByTimeAsync(0);
  expect(published).toHaveBeenCalledTimes(1);
  for (let cycle = 0; cycle < 3; cycle++) {
    send(one, "feed");
    await vi.advanceTimersByTimeAsync(500);
    send(two, "all");
    await vi.advanceTimersByTimeAsync(1500);
    expect(published).toHaveBeenCalledTimes(cycle + 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(published).toHaveBeenCalledTimes(cycle + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toHaveBeenCalledTimes(cycle + 2);
    expect(published.mock.lastCall![0]).toMatchObject({
      sources: ["one", "two"],
      changes: [
        {
          source: "one",
          events: [{ scope: { kind: "collection", id: "feed" } }],
        },
        {
          source: "two",
          events: [{ scope: { kind: "collection", id: "all" } }],
        },
      ],
    });
  }
});

it("keeps scoped batches at two seconds and cancels removed-source work", async () => {
  const queue = new WorkspaceChangeQueue(),
    published = vi.fn();
  const add = () => {
    queue.add("one", [
      { type: "invalidate", scope: { kind: "collection", id: "feed" } },
    ]);
    queue.schedule(published);
  };
  stops.push(() => queue.clear());
  add();
  await vi.advanceTimersByTimeAsync(0);
  expect(published).toHaveBeenCalledTimes(1);
  add();
  await vi.advanceTimersByTimeAsync(1999);
  expect(published).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(published).toHaveBeenCalledTimes(2);
  add();
  queue.delete("one");
  await vi.advanceTimersByTimeAsync(3000);
  expect(published).toHaveBeenCalledTimes(2);
  add();
  await vi.advanceTimersByTimeAsync(0);
  expect(published).toHaveBeenCalledTimes(3);
  add();
  queue.clear();
  await vi.advanceTimersByTimeAsync(3000);
  expect(published).toHaveBeenCalledTimes(3);
});

it("restores the scoped deadline when removing a broad source", async () => {
  const queue = new WorkspaceChangeQueue(),
    published = vi.fn();
  stops.push(() => queue.clear());
  queue.add("one");
  queue.schedule(published);
  await vi.advanceTimersByTimeAsync(0);
  queue.add("one");
  queue.schedule(published);
  queue.add("two", [
    { type: "invalidate", scope: { kind: "collection", id: "feed" } },
  ]);
  queue.schedule(published);
  await vi.advanceTimersByTimeAsync(500);
  queue.delete("one");
  await vi.advanceTimersByTimeAsync(1499);
  expect(published).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(published).toHaveBeenCalledTimes(2);
  expect(published.mock.lastCall![0]).toMatchObject({ sources: ["two"] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(published).toHaveBeenCalledTimes(2);
});
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
  expect(s.socket.url.searchParams.has("clock")).toBe(false);
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
        serverNow: Date.now(),
        nextDeadline: null,
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
        serverNow: Date.now(),
        nextDeadline: null,
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
it("polls while the socket is unavailable and cancels a pending read when push recovers", async () => {
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
  s.read.mockRejectedValueOnce(
    Object.assign(new Error("busy"), {
      status: 429,
      retryAt: Date.now() + 12_000,
    }),
  );
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

function clockFrame(
  s: ReturnType<typeof subscribe>,
  next: number | null,
  cursor = 1,
  epoch = "clock",
  serverNow = 1000,
) {
  s.socket.onmessage?.({
    data: JSON.stringify({
      v: 3,
      type: "reset",
      epoch,
      cursor,
      build: "fixture",
      buildIdentity: null,
      capabilities: { ...PARTIAL_WORKSPACE_CAPABILITIES, deadlines: true },
      serverNow,
      nextDeadline: next,
    }),
  });
}
function deadlineEvent(
  s: ReturnType<typeof subscribe>,
  next: number | null,
  cursor: number,
  serverNow = 1000,
) {
  s.socket.onmessage?.({
    data: JSON.stringify({
      serverNow,
      nextDeadline: next,
      v: 3,
      type: "events",
      epoch: "clock",
      cursor,
      events: [
        {
          id: cursor,
          event: {
            type: "deadline",
            subject: { kind: "collection", id: "all" },
            scope: { kind: "collection", id: "all" },
            serverNow,
            nextDeadline: next,
          },
        },
      ],
    }),
  });
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
  expect(s.changed.mock.calls[0][0]).toEqual(
    expect.arrayContaining([
      { type: "invalidate", scope: { kind: "collection", id: "approvals" } },
      { type: "invalidate", scope: { kind: "collection", id: "pulls" } },
    ]),
  );
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
  const one = subscribe(undefined, "one"),
    two = subscribe(undefined, "two");
  clockFrame(one, 2000);
  clockFrame(two, 3000);
  one.changed.mockClear();
  two.changed.mockClear();
  window.dispatchEvent(
    new CustomEvent("loop-workspace-clock", {
      detail: {
        source: "one",
        generation: viewGeneration(),
        clock: {
          epoch: "clock",
          cursor: 2,
          serverNow: 1000,
          nextDeadline: 4000,
        },
      },
    }),
  );
  // An older HTTP response must not restore the superseded earlier deadline.
  window.dispatchEvent(
    new CustomEvent("loop-workspace-clock", {
      detail: {
        source: "one",
        generation: viewGeneration(),
        clock: {
          epoch: "clock",
          cursor: 1,
          serverNow: 1100,
          nextDeadline: 1200,
        },
      },
    }),
  );
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
  queue.add("one", [
    {
      type: "invalidate",
      subject: { kind: "message", id: "m" },
      scope: { kind: "collection", id: "feed" },
      scopes: [
        { kind: "collection", id: "saved" },
        { kind: "conversation", id: "thread" },
      ],
    },
  ]);
  expect(queue.drain().changes?.[0].events).toEqual([
    { type: "invalidate", scope: { kind: "collection", id: "feed" } },
    { type: "invalidate", scope: { kind: "collection", id: "saved" } },
    { type: "invalidate", scope: { kind: "conversation", id: "thread" } },
  ]);
});

it("resets projections and cursors on an HTTP-only epoch replacement and rejects late old responses", async () => {
  const s = subscribe(undefined, "one");
  clockFrame(s, 20_000, 10, "old");
  const obsoleteFrame = s.socket.onmessage;
  s.socket.close();
  s.changed.mockClear();
  s.frame.mockClear();
  const received = (requestId: number, epoch: string, nextDeadline: number) =>
    window.dispatchEvent(
      new CustomEvent("loop-workspace-clock", {
        detail: {
          source: "one",
          generation: viewGeneration(),
          requestId,
          clock: { epoch, cursor: 1, serverNow: 1000, nextDeadline },
        },
      }),
    );
  received(2, "replacement", 1500);
  expect(s.frame).toHaveBeenCalledExactlyOnceWith({
    v: 3,
    type: "reset",
    epoch: "replacement",
    cursor: 1,
    serverNow: 1000,
    nextDeadline: 1500,
    capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
  });
  expect(s.changed).toHaveBeenCalledExactlyOnceWith();
  received(1, "old", 20_000);
  obsoleteFrame?.({
    data: JSON.stringify({
      v: 3,
      type: "reset",
      epoch: "old",
      cursor: 20,
      serverNow: Date.now(),
      nextDeadline: null,
      build: "",
      buildIdentity: null,
      capabilities: PARTIAL_WORKSPACE_CAPABILITIES,
    }),
  });
  expect(s.frame).toHaveBeenCalledTimes(1);
  s.changed.mockClear();
  await vi.advanceTimersByTimeAsync(500);
  expect(s.changed).toHaveBeenCalledTimes(1);
  expect(s.changed.mock.calls[0][0]).toEqual(
    expect.arrayContaining([
      { type: "invalidate", scope: { kind: "collection", id: "approvals" } },
    ]),
  );
  const replacement = Socket.instances.at(-1)!;
  expect(replacement.url.searchParams.get("epoch")).toBe("replacement");
  expect(replacement.url.searchParams.get("cursor")).toBe("1");
  await vi.advanceTimersByTimeAsync(1300);
  expect(s.read).toHaveBeenCalledWith(1, expect.any(AbortSignal));
});

it("delivers typed rows only to the subscribed source and drops a previous owner's late socket frame", async () => {
  const { publishProjectionFrame, listenProjectionFrames } =
    await import("../src/client/workspace-projections");
  setViewOwner("old-projection-owner");
  const s = subscribe(undefined, "one"),
    other = vi.fn(),
    one = vi.fn();
  s.frame.mockImplementation((frame) => publishProjectionFrame("one", frame));
  stops.push(
    listenProjectionFrames("one", one),
    listenProjectionFrames("two", other),
  );
  s.socket.frame(1, "one", "reset");
  expect(one).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  setViewOwner("new-projection-owner");
  const next = vi.fn();
  stops.push(listenProjectionFrames("one", next));
  s.socket.frame(2, "one");
  expect(next).not.toHaveBeenCalled();
  expect(one).toHaveBeenCalledTimes(1);
});

it("keeps complete streamed messages out of broad refreshes but retains explicit, deadline and socket-down invalidations", async () => {
  const { COMPLETE_WORKSPACE_CAPABILITIES, invalidate } =
    await import("../src/shared/workspace-events");
  const { broadWorkspaceChange } =
    await import("../src/client/workspace-changes");
  const queue = new WorkspaceChangeQueue();
  queue.capabilities.set("one", COMPLETE_WORKSPACE_CAPABILITIES);
  queue.add("one", [
    {
      type: "message.delta",
      scope: { kind: "conversation", id: "thread" },
      payload: { messageId: "message", text: "A" },
    },
  ]);
  expect(queue.size).toBe(0);
  queue.add("one", [invalidate({ kind: "collection", id: "feed" })]);
  let event = new CustomEvent("loop-workspace-change", {
    detail: queue.drain(),
  });
  expect(broadWorkspaceChange(event)).toBe(false);
  queue.add("one");
  event = new CustomEvent("loop-workspace-change", { detail: queue.drain() });
  expect(broadWorkspaceChange(event)).toBe(true);
  expect(broadWorkspaceChange(new Event("loop-workspace-change"))).toBe(true);
});

it.each([
  ["activity records and session controls", "activities", 5000],
  ["usage receipts and run deletion", "usage", 5000],
  ["native decision lifecycle", "decisions", 3000],
  ["Feed membership, Social counts and deadline wakes", "feed", 30000],
  ["workspace metadata and global approvals", "metadata", 15000],
  ["Results edits, removals and continued pages", "results", 1800],
  ["Social unread counts and digest status", "social", 30000],
  ["run progress", "runs", 1800],
  ["conversation memory preference changes", "metadata", 4000],
  ["reminders, labels and worker deadlines", "later", 30000],
  ["scheduled sends and failures", "scheduled", 30000],
  ["pull watch state and visibility deadlines", "pulls", 60000],
  ["saved membership, edits and removals", "saved", 2000],
] as const)(
  "refreshes %s from scoped push and wake signals",
  async (_name, collection, interval) => {
    const { publishProjectionFrame } =
      await import("../src/client/workspace-projections");
    const { COMPLETE_WORKSPACE_CAPABILITIES, invalidate } =
      await import("../src/shared/workspace-events");
    setViewOwner("responsibility-" + collection);
    const complete = subscribe(undefined, "complete");
    const reads = vi.fn();
    const queue = new WorkspaceChangeQueue();
    for (const [source, subscription] of [["complete", complete]] as const) {
      subscription.frame.mockImplementation((frame) => {
        publishProjectionFrame(source, frame);
        if (frame.type === "reset")
          queue.capabilities.set(
            source,
            frame.v === 3 ? frame.capabilities : PARTIAL_WORKSPACE_CAPABILITIES,
          );
      });
      subscription.changed.mockImplementation((events) => {
        queue.add(source, events);
        if (queue.size)
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: queue.drain(),
            }),
          );
      });
    }
    complete.socket.onmessage?.({
      data: JSON.stringify({
        v: 3,
        type: "reset",
        epoch: "complete",
        cursor: 0,
        build: "",
        buildIdentity: null,
        capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
        serverNow: Date.now(),
        nextDeadline: null,
      }),
    });
    stops.push(listenWorkspaceChanges(collection, reads, "complete"));
    await vi.advanceTimersByTimeAsync(interval + 1);
    expect(reads).not.toHaveBeenCalled();
    complete.socket.onmessage?.({
      data: JSON.stringify({
        serverNow: Date.now(),
        nextDeadline: null,
        v: 3,
        type: "events",
        epoch: "complete",
        cursor: 1,
        events: [
          { id: 1, event: invalidate({ kind: "collection", id: collection }) },
        ],
      }),
    });
    expect(reads).toHaveBeenCalledTimes(1);
    // Sleep/wake and an HTTP-only outage retain authoritative reconciliation.
    window.dispatchEvent(new Event("pageshow"));
    expect(reads).toHaveBeenCalledTimes(2);
  },
);

it("routes Social unread changes to Feed and run changes to usage without refreshing unrelated metadata", async () => {
  const { COMPLETE_WORKSPACE_CAPABILITIES, invalidate } =
    await import("../src/shared/workspace-events");
  const { workspaceChangeAffects } =
    await import("../src/client/workspace-changes");
  const queue = new WorkspaceChangeQueue();
  queue.capabilities.set("one", COMPLETE_WORKSPACE_CAPABILITIES);
  queue.add("one", [
    invalidate({ kind: "collection", id: "social" }),
    invalidate({ kind: "collection", id: "runs" }),
  ]);
  const event = new CustomEvent("loop-workspace-change", {
    detail: queue.drain(),
  });
  expect(workspaceChangeAffects(event, "feed", "one")).toBe(true);
  expect(workspaceChangeAffects(event, "usage", "one")).toBe(true);
  expect(workspaceChangeAffects(event, "metadata", "one")).toBe(false);
});
