import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
const { loginDeadline, LoginTimeoutError, LOGIN_START_MS, LOGIN_COMPLETE_MS } =
  await import(resolve("runtime/login-deadline.mjs"));

afterEach(() => vi.useRealTimers());

it("stops a native login that never supplies a link and explains how to retry", () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const deadline = loginDeadline(cancel);
  expect(deadline.expiresAt).toBe(Date.now() + LOGIN_START_MS);
  vi.advanceTimersByTime(LOGIN_START_MS - 1);
  expect(cancel).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(LoginTimeoutError));
  expect(cancel.mock.calls[0][0].message).toMatch(
    /sign-in link within 45 seconds/,
  );
  deadline.ready();
  vi.advanceTimersByTime(LOGIN_COMPLETE_MS);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("gives the browser a full ten minutes after the link arrives, without extending on duplicates", () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const deadline = loginDeadline(cancel);
  vi.advanceTimersByTime(20_000);
  deadline.ready();
  const expiry = Date.now() + LOGIN_COMPLETE_MS;
  expect(deadline.expiresAt).toBe(expiry);
  vi.advanceTimersByTime(LOGIN_COMPLETE_MS - 1);
  deadline.ready();
  expect(deadline.expiresAt).toBe(expiry);
  expect(cancel).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(cancel.mock.calls[0][0].message).toMatch(/Sign-in expired/);
});

it.each([false, true])(
  "completion or cancellation clears the deadline (link received: %s)",
  (ready) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const deadline = loginDeadline(cancel);
    if (ready) deadline.ready();
    deadline.clear();
    deadline.ready();
    vi.advanceTimersByTime(LOGIN_START_MS + LOGIN_COMPLETE_MS);
    expect(cancel).not.toHaveBeenCalled();
  },
);
