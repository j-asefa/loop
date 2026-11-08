import { readRoute } from "../src/client/workspace-api";
import { workspaceApi } from "../src/shared/workspace-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchWorkspaceEvents } from "../src/client/workspace-events";
import {
  listenWorkspaceChanges,
  WorkspaceChangeQueue,
} from "../src/client/workspace-changes";
import { setViewOwner, viewGeneration } from "../src/client/viewCache";
import { COMPLETE_WORKSPACE_CAPABILITIES } from "../src/shared/workspace-events";

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
  close() {
    this.readyState = Socket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  reset(epoch: string) {
    this.onmessage?.({
      data: JSON.stringify({
        v: 3,
        type: "reset",
        epoch,
        cursor: 4,
        serverNow: 1000,
        nextDeadline: null,
        build: "",
        buildIdentity: null,
        capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
      }),
    });
  }
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  setViewOwner("fallback-windows");
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  setViewOwner(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function view() {
  let stored = "initial";
  let displayed = stored;
  const refresh = vi.fn(() => {
    displayed = stored;
  });
  const read = vi.fn(async (_after: number, _signal: AbortSignal) => [
    { id: 5 },
  ]);
  const queue = new WorkspaceChangeQueue();
  const frame = vi.fn();
  stops.push(listenWorkspaceChanges("results", refresh, "source"));
  stops.push(
    watchWorkspaceEvents({
      url: new URL("ws://loop/api/events/ws"),
      source: "source",
      read,
      frame,
      changed: (events) => {
        queue.add("source", events);
        window.dispatchEvent(
          new CustomEvent("loop-workspace-change", { detail: queue.drain() }),
        );
      },
    }),
  );
  return {
    read,
    refresh,
    frame,
    change: (value: string) => {
      stored = value;
    },
    displayed: () => displayed,
  };
}
it("refreshes a view through shared HTTP polling before the first socket frame, then stops polling when push is ready", async () => {
  const current = view();
  current.change("before first frame");
  await vi.advanceTimersByTimeAsync(1800);
  expect(current.displayed()).toBe("before first frame");
  expect(current.read).toHaveBeenCalledExactlyOnceWith(
    0,
    expect.any(AbortSignal),
  );
  expect(current.frame).not.toHaveBeenCalled();
  Socket.instances[0].reset("first");
  current.read.mockClear();
  await vi.advanceTimersByTimeAsync(5400);
  expect(current.read).not.toHaveBeenCalled();
  current.change("after sleep");
  window.dispatchEvent(new Event("pageshow"));
  expect(current.displayed()).toBe("after sleep");
});
it("refreshes after an HTTP-only database replacement while its new socket has not sent a frame", async () => {
  const current = view();
  const old = Socket.instances[0];
  old.reset("old");
  old.close();
  current.change("replacement snapshot");
  window.dispatchEvent(
    new CustomEvent("loop-workspace-clock", {
      detail: {
        source: "source",
        generation: viewGeneration(),
        requestId: 1,
        clock: {
          epoch: "replacement",
          cursor: 1,
          serverNow: 1000,
          nextDeadline: 1500,
        },
      },
    }),
  );
  expect(current.displayed()).toBe("replacement snapshot");
  current.change("deadline change");
  await vi.advanceTimersByTimeAsync(500);
  expect(current.displayed()).toBe("deadline change");
  current.change("later HTTP change");
  await vi.advanceTimersByTimeAsync(1300);
  expect(current.displayed()).toBe("later HTTP change");
  expect(current.read).toHaveBeenCalledExactlyOnceWith(
    1,
    expect.any(AbortSignal),
  );
  expect(Socket.instances.at(-1)?.url.searchParams.get("epoch")).toBe(
    "replacement",
  );
  expect(current.frame).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "recovers exhausted snapshot reads on an empty poll (socket ready: %s)",
  async (ready) => {
    const controller = new AbortController();
    stops.push(() => controller.abort());
    let unavailable = true;
    const fetcher = vi.fn(async () =>
      unavailable
        ? Response.json({ error: "Unavailable" }, { status: 503 })
        : Response.json([]),
    );
    vi.stubGlobal("fetch", fetcher);
    let displayed = false;
    const refresh = () =>
      void readRoute(workspaceApi.nativeDecisions, {}, "", controller.signal)
        .then(() => {
          displayed = true;
        })
        .catch(() => {});
    const poll = vi.fn(async () => []);
    const changed = vi.fn(refresh);
    stops.push(
      watchWorkspaceEvents({
        url: new URL("ws://loop/api/events/ws"),
        read: poll,
        changed,
      }),
    );
    if (ready) Socket.instances[0].reset("first");
    else refresh();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(displayed).toBe(false);
    unavailable = false;
    await vi.advanceTimersByTimeAsync(1200);
    expect(displayed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const changes = changed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5400);
    expect(changed).toHaveBeenCalledTimes(changes);
    expect(fetcher).toHaveBeenCalledTimes(4);
  },
);

it.each(["abort", "owner", "source", "permanent"])(
  "does not recover snapshots across %s boundaries",
  async (boundary) => {
    const controller = new AbortController();
    stops.push(() => controller.abort());
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: "Unavailable" },
        { status: boundary === "permanent" ? 403 : 503 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const failed = readRoute(
      workspaceApi.nativeDecisions,
      {},
      "",
      controller.signal,
    ).catch(() => {});
    await vi.advanceTimersByTimeAsync(6000);
    await failed;
    if (boundary === "abort") controller.abort();
    if (boundary === "owner") setViewOwner("another-owner");
    const changed = vi.fn();
    stops.push(
      watchWorkspaceEvents({
        url: new URL("ws://loop/api/events/ws"),
        source: boundary === "source" ? "another-source" : "",
        read: async () => [],
        changed,
      }),
    );
    await vi.advanceTimersByTimeAsync(1800);
    expect(changed).not.toHaveBeenCalled();
  },
);

it("clears snapshot recovery after success while preserving another failed read on the same view signal", async () => {
  const controller = new AbortController();
  stops.push(() => controller.abort());
  const fetcher = vi.fn(async () => {
    throw new TypeError("Network unavailable");
  });
  vi.stubGlobal("fetch", fetcher);
  const decisions = () =>
    readRoute(workspaceApi.nativeDecisions, {}, "", controller.signal);
  const unread = () =>
    readRoute(workspaceApi.socialUnread, {}, "", controller.signal);
  await decisions().catch(() => {});
  await unread().catch(() => {});
  const poll = vi.fn(async () => {
    throw new Error("Event endpoint unavailable");
  });
  stops.push(
    watchWorkspaceEvents({
      url: new URL("ws://loop/api/events/ws"),
      read: poll,
      changed: () => {},
    }),
  );
  Socket.instances[0].reset("first");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([])),
  );
  await decisions();
  await vi.advanceTimersByTimeAsync(1800);
  expect(poll).toHaveBeenCalledTimes(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ unread: 0 })),
  );
  await unread();
  await vi.advanceTimersByTimeAsync(5400);
  expect(poll).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "ignores an older read settlement when the newest read failed: %s",
  async (newestFailed) => {
    const controller = new AbortController();
    stops.push(() => controller.abort());
    let resolveOld!: (value: Response) => void;
    let rejectOld!: (reason: unknown) => void;
    const oldResponse = new Promise<Response>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(oldResponse)
        .mockImplementation(async () => {
          if (newestFailed) throw new TypeError("Network unavailable");
          return Response.json([]);
        }),
    );
    const read = () =>
      readRoute(workspaceApi.nativeDecisions, {}, "", controller.signal).catch(
        () => {},
      );
    const old = read();
    await read();
    if (newestFailed) resolveOld(Response.json([]));
    else rejectOld(new TypeError("Old network failure"));
    await old;
    const poll = vi.fn(async () => []);
    stops.push(
      watchWorkspaceEvents({
        url: new URL("ws://loop/api/events/ws"),
        read: poll,
        changed: () => {},
      }),
    );
    Socket.instances[0].reset("first");
    await vi.advanceTimersByTimeAsync(1800);
    expect(poll).toHaveBeenCalledTimes(newestFailed ? 1 : 0);
  },
);

it.each(["disconnect", "malformed", "abort", "refusal"])(
  "handles a %s while consuming a successful response body",
  async (failure) => {
    const controller = new AbortController();
    stops.push(() => controller.abort());
    const response =
      failure === "malformed"
        ? new Response("not JSON", { status: 200 })
        : new Response(
            new ReadableStream({
              start(stream) {
                stream.error(new TypeError("Response connection lost"));
              },
            }),
            { status: failure === "refusal" ? 403 : 200 },
          );
    if (failure === "abort")
      vi.spyOn(response, "json").mockImplementation(async () => {
        controller.abort();
        throw new TypeError("Response connection lost");
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await readRoute(
      workspaceApi.nativeDecisions,
      {},
      "",
      controller.signal,
    ).catch(() => {});
    const poll = vi.fn(async () => []);
    const changed = vi.fn();
    stops.push(
      watchWorkspaceEvents({
        url: new URL("ws://loop/api/events/ws"),
        read: poll,
        changed,
      }),
    );
    Socket.instances[0].reset("first");
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(1800);
    expect(poll).toHaveBeenCalledTimes(failure === "disconnect" ? 1 : 0);
    expect(changed).toHaveBeenCalledTimes(failure === "disconnect" ? 1 : 0);
  },
);

it("keeps network read recovery pending through failed HTTP probes", async () => {
  const controller = new AbortController();
  stops.push(() => controller.abort());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Network unavailable");
    }),
  );
  await readRoute(
    workspaceApi.nativeDecisions,
    {},
    "",
    controller.signal,
  ).catch(() => {});
  const read = vi
    .fn<() => Promise<{ id: number }[]>>()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue([]);
  const changed = vi.fn();
  stops.push(
    watchWorkspaceEvents({
      url: new URL("ws://loop/api/events/ws"),
      read,
      changed,
    }),
  );
  await vi.advanceTimersByTimeAsync(1800);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1800);
  expect(changed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1800);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("finishes a recovery probe while unrelated socket frames keep arriving", async () => {
  const controller = new AbortController();
  stops.push(() => controller.abort());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Network unavailable");
    }),
  );
  const changed = vi.fn();
  let finish!: (events: { id: number }[]) => void;
  let signal!: AbortSignal;
  stops.push(
    watchWorkspaceEvents({
      url: new URL("ws://loop/api/events/ws"),
      read: async (_cursor, currentSignal) => {
        signal = currentSignal;
        return await new Promise((resolve) => {
          finish = resolve;
        });
      },
      changed,
    }),
  );
  const socket = Socket.instances[0];
  socket.reset("first");
  changed.mockClear();
  await readRoute(
    workspaceApi.nativeDecisions,
    {},
    "",
    controller.signal,
  ).catch(() => {});
  await vi.advanceTimersByTimeAsync(1800);
  for (let n = 0; n < 5; n++) {
    socket.onmessage?.({
      data: JSON.stringify({
        v: 3,
        type: "events",
        epoch: "first",
        cursor: 4,
        serverNow: 1000 + n,
        nextDeadline: null,
        events: [
          {
            id: 4,
            event: {
              type: "invalidate",
              scope: { kind: "collection", id: "activities" },
            },
          },
        ],
        capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
      }),
    });
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(socket.readyState).toBe(Socket.OPEN);
  expect(signal.aborted).toBe(false);
  changed.mockClear();
  finish([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenCalledTimes(1);
});
