import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchWorkspaceEvents } from "../src/client/workspace-events";

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
) {
  const changed = vi.fn(),
    expired = vi.fn(),
    connected = vi.fn();
  stops.push(
    watchWorkspaceEvents({
      url: new URL("ws://loop/api/events/ws"),
      read,
      changed,
      expired,
      connected,
    }),
  );
  return {
    read,
    changed,
    expired,
    connected,
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
