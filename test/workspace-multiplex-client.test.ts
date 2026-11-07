import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchWorkspaceEvents } from "../src/client/workspace-events";
import {
  multiplexWorkspaceSocket,
  watchWorkspaceDetail,
} from "../src/client/workspace-multiplex";
import { setViewOwner } from "../src/client/viewCache";
import { COMPLETE_WORKSPACE_CAPABILITIES } from "../src/shared/workspace-events";

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(id: string, source: string, epoch: string, cursor: number) {
    this.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "frame",
        id,
        source,
        frame: {
          serverNow: Date.now(),
          nextDeadline: null,
          v: 3,
          type: "reset",
          epoch,
          cursor,
          build: "fixture",
          buildIdentity: null,
          capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
        },
      }),
    });
  }
  close(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: "Fixture closed" });
  }
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  setViewOwner(undefined);
  setViewOwner("fixture");
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal(
    "CloseEvent",
    class extends Event {
      code: number;
      reason: string;
      constructor(type: string, init: { code: number; reason: string }) {
        super(type);
        this.code = init.code;
        this.reason = init.reason;
      }
    },
  );
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function subscribe(
  source: string,
  read = vi.fn(async () => [] as { id: number }[]),
) {
  const frame = vi.fn(),
    changed = vi.fn();
  stops.push(
    watchWorkspaceEvents({
      url: new URL("wss://gateway.example/api/events/ws"),
      source,
      read,
      changed,
      frame,
      socket: (url) => multiplexWorkspaceSocket(url, source),
    }),
  );
  return { frame, changed, read };
}
it("one browser socket keeps independent source clocks, detail lifetimes, hidden suspension and owner fences", async () => {
  const a = subscribe("peer:one"),
    b = subscribe("peer:two");
  expect(Socket.instances).toHaveLength(1);
  const socket = Socket.instances[0];
  socket.open();
  const first = socket.sent.find((p) => p.source === "peer:one"),
    second = socket.sent.find((p) => p.source === "peer:two");
  socket.frame(first.id, first.source, "one-epoch", 10);
  socket.frame(second.id, second.source, "two-epoch", 91);
  expect(a.frame.mock.calls.at(-1)?.[0]).toMatchObject({
    epoch: "one-epoch",
    cursor: 10,
  });
  expect(b.frame.mock.calls.at(-1)?.[0]).toMatchObject({
    epoch: "two-epoch",
    cursor: 91,
  });
  const closeDetail = watchWorkspaceDetail("peer:one", {
    conversation: "opened-thread",
  });
  stops.push(closeDetail);
  expect(socket.sent.at(-1)).toMatchObject({
    source: "peer:one",
    cursor: 10,
    conversations: ["opened-thread"],
  });
  closeDetail();
  expect(socket.sent.at(-1)).toMatchObject({
    source: "peer:one",
    conversations: [],
  });
  Object.assign(document, { visibilityState: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.readyState).toBe(3);
  expect(Socket.instances).toHaveLength(1);
  expect(a.read).not.toHaveBeenCalled();
  expect(b.read).not.toHaveBeenCalled();
  Object.assign(document, { visibilityState: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(Socket.instances).toHaveLength(2);
  const next = Socket.instances[1];
  next.open();
  expect(next.sent.find((p) => p.source === "peer:one")).toMatchObject({
    epoch: "one-epoch",
    cursor: 10,
  });
  expect(next.sent.find((p) => p.source === "peer:two")).toMatchObject({
    epoch: "two-epoch",
    cursor: 91,
  });
  const before = a.frame.mock.calls.length;
  setViewOwner("different-owner");
  const packet = next.sent.find((p) => p.source === "peer:one");
  next.frame(packet.id, packet.source, "old-owner", 100);
  expect(a.frame).toHaveBeenCalledTimes(before);
  subscribe("peer:one");
  expect(Socket.instances).toHaveLength(3);
});
it("fallback polling shares a fair concurrency budget across unavailable sources", async () => {
  let active = 0,
    peak = 0;
  const finish: (() => void)[] = [];
  const read = vi.fn(
    () =>
      new Promise<{ id: number }[]>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        finish.push(() => {
          active--;
          resolve([]);
        });
      }),
  );
  for (let index = 0; index < 12; index++) subscribe("peer:" + index, read);
  await vi.advanceTimersByTimeAsync(1800);
  expect(active).toBe(4);
  expect(peak).toBe(4);
  finish.splice(0).forEach((done) => done());
  await vi.advanceTimersByTimeAsync(1800);
  expect(read).toHaveBeenCalledTimes(8);
  expect(peak).toBe(4);
  finish.splice(0).forEach((done) => done());
  await vi.advanceTimersByTimeAsync(1800);
  expect(read).toHaveBeenCalledTimes(12);
  expect(peak).toBe(4);
  finish.splice(0).forEach((done) => done());
});

it.each(["malformed", "oversized", "backpressure"])(
  "reconnects both logical sources after %s without accepting a bad cursor",
  async (fault) => {
    const a = subscribe("peer:one"),
      b = subscribe("peer:two");
    const socket = Socket.instances[0];
    socket.open();
    const first = socket.sent.find((p) => p.source === "peer:one");
    const second = socket.sent.find((p) => p.source === "peer:two");
    socket.frame(first.id, first.source, "one-epoch", 10);
    socket.frame(second.id, second.source, "two-epoch", 91);
    if (fault === "backpressure") {
      socket.bufferedAmount = 256 * 1024 + 1;
      stops.push(
        watchWorkspaceDetail("peer:one", { conversation: "opened-thread" }),
      );
    } else {
      socket.onmessage?.({
        data: fault === "malformed" ? "{" : " ".repeat(512 * 1024 + 4097),
      });
    }
    expect(socket.readyState).toBe(Socket.CLOSED);
    expect(a.frame).toHaveBeenCalledTimes(1);
    expect(b.frame).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(800);
    expect(Socket.instances).toHaveLength(2);
    const next = Socket.instances[1];
    next.open();
    const resumedA = next.sent.find((p) => p.source === "peer:one");
    const resumedB = next.sent.find((p) => p.source === "peer:two");
    expect(resumedA).toMatchObject({ epoch: "one-epoch", cursor: 10 });
    expect(resumedB).toMatchObject({ epoch: "two-epoch", cursor: 91 });
    next.frame(resumedA.id, resumedA.source, "one-epoch", 11);
    next.frame(resumedB.id, resumedB.source, "two-epoch", 92);
    expect(a.frame.mock.calls.at(-1)?.[0]).toMatchObject({
      epoch: "one-epoch",
      cursor: 11,
    });
    expect(b.frame.mock.calls.at(-1)?.[0]).toMatchObject({
      epoch: "two-epoch",
      cursor: 92,
    });
  },
);
