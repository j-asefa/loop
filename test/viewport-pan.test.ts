import { expect, it, vi } from "vitest";
import { leftoverPan } from "../src/client/Pwa";

it("folds a pan Safari leaves after the keyboard closes back into the page", () => {
  // Keyboard closed, but the visible area is still panned 240px down: the
  // fixed composer and tabs would sit 240px above the bottom of the screen.
  expect(leftoverPan({ offsetTop: 240, scale: 1 }, false)).toBe(240);
  // Nothing to fix when the view is not panned.
  expect(leftoverPan({ offsetTop: 0, scale: 1 }, false)).toBe(0);
  expect(leftoverPan({ offsetTop: 0.4, scale: 1 }, false)).toBe(0);
  // While typing, Safari pans to keep the field visible; leave it.
  expect(leftoverPan({ offsetTop: 240, scale: 1 }, true)).toBe(0);
  // Pinch zoom pans on purpose; leave it.
  expect(leftoverPan({ offsetTop: 240, scale: 2 }, false)).toBe(0);
  expect(leftoverPan(undefined, false)).toBe(0);
});

it("folds again once a scroll or touch ends, leaving the keyboard state alone", async () => {
  const { watchViewport } = await import("../src/client/Pwa");
  vi.useFakeTimers();
  try {
    const win = Object.assign(new EventTarget(), {
      visualViewport: new EventTarget(),
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
      clearTimeout: (timer: any) => clearTimeout(timer),
    });
    const doc = new EventTarget();
    const check = vi.fn();
    const refold = vi.fn();
    const stop = watchViewport(win, doc, check, refold, 150);
    // Safari can leave the view panned mid-scroll, when a fold would be
    // ignored: it is tried once the scroll has settled, not per event.
    for (let i = 0; i < 5; i++) {
      win.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(50);
    }
    expect(refold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(refold).toHaveBeenCalledTimes(1);
    for (const type of ["touchend", "touchcancel", "scrollend"])
      win.dispatchEvent(new Event(type));
    expect(refold).toHaveBeenCalledTimes(4);
    // Scrolls and touches never recompute the keyboard state.
    expect(check).not.toHaveBeenCalled();
    for (const type of ["pageshow", "resize"])
      win.dispatchEvent(new Event(type));
    win.visualViewport.dispatchEvent(new Event("scroll"));
    win.visualViewport.dispatchEvent(new Event("resize"));
    doc.dispatchEvent(new Event("focusin"));
    doc.dispatchEvent(new Event("focusout"));
    // Returning from another app rechecks too.
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(7);
    expect(refold).toHaveBeenCalledTimes(4);
    // Stopping removes every listener and any pending settle.
    win.dispatchEvent(new Event("scroll"));
    stop();
    vi.advanceTimersByTime(500);
    win.dispatchEvent(new Event("touchend"));
    doc.dispatchEvent(new Event("focusin"));
    expect(refold).toHaveBeenCalledTimes(4);
    expect(check).toHaveBeenCalledTimes(7);
  } finally {
    vi.useRealTimers();
  }
});

it("folds once, retries a fold Safari ignored, and never folds mid-touch", async () => {
  const { foldTarget } = await import("../src/client/Pwa");
  expect(foldTarget(0, false, 500, null)).toBe(null);
  expect(foldTarget(240, false, 500, null)).toBe(740);
  // During a touch Safari ignores the scroll; wait for the touch to end.
  expect(foldTarget(240, true, 500, null)).toBe(null);
  // The fold landed but Safari still reports the pan: do not fold again,
  // or each fold's scroll would trigger another and run down the page.
  expect(foldTarget(240, false, 740, 740)).toBe(null);
  // The fold was ignored (the page did not move): try again.
  expect(foldTarget(240, false, 500, 740)).toBe(740);
  // The person scrolled elsewhere since: fold from there.
  expect(foldTarget(240, false, 1200, 740)).toBe(1440);
});

it("moves the bottom bars down to what you see when Safari's layout viewport ends above it", async () => {
  const { viewportDrop } = await import("../src/client/Pwa");
  // Panned 372px after the keyboard closed: bars move down 372px.
  expect(viewportDrop({ offsetTop: 372, height: 932, scale: 1 }, 932, false)).toBe(372);
  // Layout viewport left at the keyboard's height (after an app switch).
  expect(viewportDrop({ offsetTop: 0, height: 932, scale: 1 }, 560, false)).toBe(372);
  // Nothing to correct when they line up.
  expect(viewportDrop({ offsetTop: 0, height: 932, scale: 1 }, 932, false)).toBe(0);
  // A stale keyboard height after blur leaves the bars where they are.
  expect(viewportDrop({ offsetTop: 0, height: 582, scale: 1 }, 932, false)).toBe(0);
  // While typing or pinch-zoomed, never.
  expect(viewportDrop({ offsetTop: 372, height: 932, scale: 1 }, 932, true)).toBe(0);
  expect(viewportDrop({ offsetTop: 372, height: 466, scale: 2 }, 932, false)).toBe(0);
  expect(viewportDrop(undefined, 932, false)).toBe(0);
  expect(viewportDrop({ offsetTop: 0, height: 932, scale: 1 }, 0, false)).toBe(0);
});

it("walks a panned sheet to the gap its own CSS rule leaves, then stops", async () => {
  const { sheetCorrection } = await import("../src/client/useSheetViewport");
  // Keyboard open, viewport panned 240px down, but Safari still lays the
  // top-layer sheet out at the page's top: pull it down to 240 + 8.
  expect(sheetCorrection(0, 8, 240, 0)).toBe(248);
  // Measured again after it moved: already in place, so hold the correction
  // instead of accumulating a second one.
  expect(sheetCorrection(248, 8, 240, 248)).toBe(248);
  expect(sheetCorrection(248, 8, 240, 248.4)).toBe(248);
  // The sheet overshot (or the pan shrank): fold the remainder back in.
  expect(sheetCorrection(248, 8, 100, 148)).toBe(208);
  // No gap means no rule consumes the correction at this width, so there is
  // nothing to correct: never measure a delta the layout will ignore.
  expect(sheetCorrection(248, null, 240, 0)).toBe(null);
  expect(sheetCorrection(0, 8, Number.NaN, 0)).toBe(0);
});

it("takes the sheet's gap from the rule that moves it, and nothing else", async () => {
  const { sheetGap } = await import("../src/client/useSheetViewport");
  const styles = (value: string) =>
    ({
      getPropertyValue: () => value,
    }) as unknown as CSSStyleDeclaration;
  const original = globalThis.getComputedStyle;
  const el = {} as Element;
  try {
    for (const [declared, gap] of [
      [" 8px ", 8],
      ["12px", 12],
      ["0px", 0],
      ["", null],
      ["auto", null],
    ] as const) {
      globalThis.getComputedStyle = () => styles(declared);
      expect(sheetGap(el)).toBe(gap);
    }
  } finally {
    globalThis.getComputedStyle = original;
  }
});
