import { afterEach, expect, it, vi } from "vitest";
import {
  idleDeadline,
  TURN_IDLE_MS,
  IdleTimeoutError,
} from "../runtime/idle-deadline.mjs";
afterEach(() => vi.useRealTimers());
it("stops a silent turn once and cannot restart after expiry", () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const idle = idleDeadline(cancel);
  vi.advanceTimersByTime(TURN_IDLE_MS);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(IdleTimeoutError));
  idle.progress();
  vi.advanceTimersByTime(TURN_IDLE_MS);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("allows progressing turns to exceed the idle window and clears on completion", () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const idle = idleDeadline(cancel);
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(TURN_IDLE_MS - 1);
    idle.progress();
  }
  expect(cancel).not.toHaveBeenCalled();
  idle.clear();
  idle.progress();
  vi.advanceTimersByTime(TURN_IDLE_MS);
  expect(cancel).not.toHaveBeenCalled();
});
