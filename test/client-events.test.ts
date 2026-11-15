import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emitClientEvent,
  listenClientEvent,
  type ClientEvents,
} from "../src/client/clientEvents";

beforeEach(() => vi.stubGlobal("window", new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

it("delivers toast payloads synchronously without losing action callbacks and unsubscribes", async () => {
  const undo = vi.fn();
  const toast: ClientEvents["loop-toast"] = {
    id: "toast",
    text: "Saved",
    undo,
  };
  const received: ClientEvents["loop-toast"][] = [];
  const stop = listenClientEvent("loop-toast", (value) => received.push(value));
  emitClientEvent("loop-toast", toast);
  expect(received).toEqual([toast]);
  expect(received[0]).toBe(toast);
  await received[0].undo?.();
  expect(undo).toHaveBeenCalledTimes(1);
  stop();
  stop();
  emitClientEvent("loop-toast", toast);
  expect(received).toHaveLength(1);
});

it("preserves payload-free DOM events and listens to existing event producers", () => {
  const received = vi.fn();
  const nativeEvents: Event[] = [];
  window.addEventListener("loop-auth-expired", (event) =>
    nativeEvents.push(event),
  );
  const stop = listenClientEvent("loop-auth-expired", received);
  emitClientEvent("loop-auth-expired");
  window.dispatchEvent(new Event("loop-auth-expired"));
  expect(received.mock.calls).toEqual([
    [undefined, nativeEvents[0]],
    [undefined, nativeEvents[1]],
  ]);
  expect(received.mock.calls[0][1]).toBe(nativeEvents[0]);
  expect(received.mock.calls[1][1]).toBe(nativeEvents[1]);
  expect(nativeEvents).toHaveLength(2);
  expect(nativeEvents.every((event) => !(event instanceof CustomEvent))).toBe(
    true,
  );
  stop();
  emitClientEvent("loop-auth-expired");
  expect(received).toHaveBeenCalledTimes(2);
});
