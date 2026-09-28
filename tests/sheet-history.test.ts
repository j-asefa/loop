import { afterEach, beforeEach, expect, it, vi } from "vitest";

let browser: EventTarget;
let entries: { url: string; state: unknown }[];
let position: number;
let pending: boolean;
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const pop = () => {
  position--;
  location.href = entries[position].url;
  browser.dispatchEvent(new Event("popstate"));
  pending = false;
};
beforeEach(() => {
  vi.resetModules();
  browser = new EventTarget();
  entries = [
    {
      url: "https://loop.test/?project=one#pair=fixture",
      state: { route: "project" },
    },
  ];
  position = 0;
  pending = false;
  vi.stubGlobal("window", browser);
  vi.stubGlobal("location", { href: entries[0].url });
  vi.stubGlobal("history", {
    get state() {
      return entries[position].state;
    },
    pushState: vi.fn((state, _title, url) => {
      entries.splice(++position, Infinity, { url, state });
      location.href = url;
    }),
    replaceState: vi.fn((state, _title, url) => {
      entries[position] = { url, state };
      location.href = url;
    }),
    back: vi.fn(() => {
      pending = true;
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("waits for dialog history and browser restoration before scrolling to a profile", async () => {
  const { registerSheet, afterSheetsClose } =
    await import("../src/client/sheetHistory");
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  const close = registerSheet(() => {});
  await settle();
  const scroll = vi.fn();
  afterSheetsClose(scroll);
  await settle();
  expect(frames).toHaveLength(0);
  close();
  await settle();
  expect(pending).toBe(true);
  expect(frames).toHaveLength(0);
  pop();
  await settle();
  expect(scroll).not.toHaveBeenCalled();
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  expect(scroll).toHaveBeenCalledOnce();
});

it("uses one Back entry for a stack and closes only its top sheet", async () => {
  const { registerSheet } = await import("../src/client/sheetHistory");
  const outerClose = vi.fn(() => outer());
  const outer = registerSheet(outerClose);
  await settle();
  const innerClose = vi.fn(() => inner());
  const inner = registerSheet(innerClose);
  await settle();
  expect(position).toBe(1);
  pop();
  await settle();
  expect(innerClose).toHaveBeenCalledOnce();
  expect(outerClose).not.toHaveBeenCalled();
  expect(position).toBe(1);
  expect(history.state).toMatchObject({ route: "project", loopSheet: true });
  pop();
  await settle();
  expect(outerClose).toHaveBeenCalledOnce();
  expect(position).toBe(0);
  expect(pending).toBe(false);
});

it("coalesces replacing a sheet and an immediate effect cleanup", async () => {
  const { registerSheet } = await import("../src/client/sheetHistory");
  const transient = registerSheet(() => {});
  transient();
  await settle();
  expect(history.pushState).not.toHaveBeenCalled();
  const first = registerSheet(() => {});
  await settle();
  first();
  registerSheet(() => {});
  await settle();
  expect(history.pushState).toHaveBeenCalledOnce();
  expect(history.back).not.toHaveBeenCalled();
});

it("preserves navigation on close and waits for pending Back before reopening", async () => {
  const { registerSheet } = await import("../src/client/sheetHistory");
  const close = registerSheet(() => {});
  await settle();
  const destination = "https://loop.test/?project=two&agent=scout#attachment";
  history.replaceState(history.state, "", destination);
  close();
  await settle();
  expect(pending).toBe(true);
  const reopened = vi.fn();
  registerSheet(reopened);
  await settle();
  expect(history.pushState).toHaveBeenCalledOnce();
  pop();
  await settle();
  expect(location.href).toBe(destination);
  expect(entries[0].url).toBe(destination);
  expect(position).toBe(1);
  expect(reopened).not.toHaveBeenCalled();
});
