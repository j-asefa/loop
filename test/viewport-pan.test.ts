import { expect, it, vi } from "vitest";
import { leftoverPan, sheetKeyboardInset } from "../src/client/Pwa";

it("anchors keyboard-open dialogs to the measured fixed viewport, even after Safari pans it", () => {
  const viewport = { offsetTop: 0, height: 430, scale: 1 };
  expect(sheetKeyboardInset(viewport, 844, true)).toBe(414);
  // Safari pans to the input while the fixed layout viewport stays tall.
  expect(sheetKeyboardInset({ ...viewport, offsetTop: 370 }, 844, true)).toBe(44);
  // The fixed containing block has shrunk independently of innerHeight.
  // The old 44px inset would leave almost the entire dialog above the screen.
  expect(sheetKeyboardInset({ ...viewport, offsetTop: 370 }, 430, true)).toBe(-370);
  expect(sheetKeyboardInset(viewport, 430, true)).toBe(0);
  expect(sheetKeyboardInset(viewport, 844, false)).toBe(0);
  expect(sheetKeyboardInset({ ...viewport, scale: 2 }, 844, true)).toBe(0);
  expect(sheetKeyboardInset(undefined, 844, true)).toBe(0);
  expect(sheetKeyboardInset(viewport, 0, true)).toBe(0);
});

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
