import { expect, it, vi } from "vitest";

// A history whose back() is cancelled: no traversal, no popstate. WebKit can
// do this when the page replaces its URL while a back is pending.
const entries: { state: any; url: string }[] = [{ state: null, url: "/" }];
let index = 0;
const back = vi.fn(() => {});
(globalThis as any).location = {
  get href() {
    return entries[index].url;
  },
};
(globalThis as any).history = {
  get state() {
    return entries[index].state;
  },
  pushState(state: any, _: string, url: string) {
    entries.splice(index + 1);
    entries.push({ state, url });
    index++;
  },
  replaceState(state: any, _: string, url: string) {
    entries[index] = { state, url };
  },
  back,
};
const { registerSheet } = await import("../src/client/sheetHistory");
const settle = () =>
  new Promise((resolve) => queueMicrotask(() => resolve(null)));

it("recovers when closing a sheet's history.back() never completes", async () => {
  vi.useFakeTimers();
  const unregister = registerSheet(() => {});
  await settle();
  expect(history.state).toMatchObject({ loopSheet: true });
  unregister();
  await settle();
  expect(back).toHaveBeenCalledTimes(1);
  // popstate never arrives. After the watchdog, the sheet entry is released
  // in place instead of blocking every later sheet.
  vi.advanceTimersByTime(1000);
  expect(history.state?.loopSheet).toBe(false);
  // The next sheet gets its own history entry again.
  registerSheet(() => {});
  await settle();
  expect(history.state).toMatchObject({ loopSheet: true });
  expect(entries).toHaveLength(3);
  // Only one back was ever requested: the app never steps out of itself.
  expect(back).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
