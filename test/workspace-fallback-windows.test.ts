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
