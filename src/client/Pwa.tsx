import { useEffect, useState } from "react";
import { SHEET_SETTLE_MS, visibleViewportTop } from "../shared/sheet-viewport";
export function PwaStatus() {
  const [online, setOnline] = useState(navigator.onLine),
    [update, setUpdate] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    // Catch a network transition between the initial render and subscription.
    changed();
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          if (reg.waiting) setUpdate(reg.waiting);
          reg.addEventListener("updatefound", () => {
            const worker = reg.installing;
            worker?.addEventListener("statechange", () => {
              if (
                worker.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setUpdate(worker);
            });
          });
        })
        .catch(() => {});
    // Keep the pre-keyboard height: iOS can resize innerHeight along with the
    // visual viewport. Their difference alone then reports a closed keyboard.
    // Reset for width/orientation changes; browser chrome may change the height
    // at the same width, so retain the largest unzoomed height seen there.
    let viewportWidth = innerWidth;
    let layoutHeight = Math.max(
      innerHeight,
      document.documentElement.clientHeight,
    );
    const viewport = () => {
      const v = window.visualViewport;
      const visibleTop = v ? visibleViewportTop(v, window.scrollY) : 0;
      const currentHeight = Math.max(
        innerHeight,
        document.documentElement.clientHeight,
      );
      if (viewportWidth !== innerWidth) {
        viewportWidth = innerWidth;
        layoutHeight = currentHeight;
      } else if (Math.abs((v?.scale || 1) - 1) < 0.01) {
        layoutHeight = Math.max(layoutHeight, currentHeight);
      }
      const obscuredHeight = layoutHeight - (v?.height || innerHeight);
      // A resized fixed viewport already avoids part (or all) of the keyboard.
      const inset = Math.max(
        0,
        innerHeight - (v?.height || innerHeight) - visibleTop,
      );
      const active = document.activeElement;
      const textEntryFocused =
        ((active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLInputElement &&
            [
              "text",
              "search",
              "email",
              "url",
              "tel",
              "password",
              "number",
            ].includes(active.type))) &&
          !active.readOnly &&
          !active.disabled) ||
        (active instanceof HTMLElement && active.isContentEditable);
      // Safari can retain the keyboard's viewport size after blur without a
      // resize event. Don't leave the dock raised when no text field is focused.
      // Panning to the focused field changes offsetTop, not the keyboard's
      // height. Using the bottom inset here expands the sheet off-screen as
      // Safari pans, hiding the original message and agent header.
      const keyboardOpen =
        textEntryFocused &&
        obscuredHeight > 100 &&
        Math.abs((v?.scale || 1) - 1) < 0.01;
      document.documentElement.dataset.keyboard = keyboardOpen
        ? "open"
        : "closed";
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        (keyboardOpen ? v!.height : innerHeight) + "px",
      );
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        (keyboardOpen ? inset : 0) + "px",
      );
      // Top-layer dialogs can have a different fixed bottom than the page.
      // Use the visual viewport's top directly while the keyboard is open.
      document.documentElement.style.setProperty(
        "--visual-viewport-top",
        (keyboardOpen ? visibleTop : 0) + "px",
      );
      fold(keyboardOpen);
    };
    // Fixed bars sit on the bottom of Safari's layout viewport, which after
    // the keyboard or an app switch can end above the bottom of what you
    // see. Move them down by that gap, so they stay on the screen's bottom
    // edge even when Safari ignores the fold below. The probe is a fixed,
    // empty element whose top is the layout viewport's bottom.
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none";
    document.body.append(probe);
    let dropped = 0;
    const place = (
      keyboardOpen = document.documentElement.dataset.keyboard === "open",
    ) => {
      // Safari can restore the probe's viewport before it restores a fixed
      // composited bar. Measure the bar that actually needs moving, removing
      // our previous translation so repeated checks converge without drift.
      const nav = document.querySelector<HTMLElement>(".mobile-nav");
      const navStyle = nav && getComputedStyle(nav);
      const bottom =
        nav && navStyle?.position === "fixed" && navStyle.display !== "none"
          ? nav.getBoundingClientRect().bottom - dropped
          : probe.getBoundingClientRect().top;
      const drop = viewportDrop(
        window.visualViewport,
        bottom,
        keyboardOpen,
        window.scrollY,
        innerHeight,
      );
      if (drop === dropped) return;
      dropped = drop;
      document.documentElement.style.setProperty(
        "--viewport-drop",
        drop + "px",
      );
    };
    // Safari can leave the visible area panned after the keyboard closes.
    // Fixed bars stay on the page's own bottom edge, so they then float in
    // the middle of the screen. Fold the pan back into the page scroll: what
    // you see stays put and the bars return to the bottom. After a scroll or
    // touch only this runs; the keyboard state is left as it is.
    const fold = (
      keyboardOpen = document.documentElement.dataset.keyboard === "open",
    ) => {
      place(keyboardOpen);
      const pan = leftoverPan(
        window.visualViewport,
        keyboardOpen,
        window.scrollY,
      );
      const top = foldTarget(pan, touching, window.scrollY, foldedTo);
      // Forget the last fold once the pan is gone.
      foldedTo = top ?? (pan ? foldedTo : null);
      if (top !== null)
        window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
    };
    // Where the last fold scrolled the page, so a fold that already worked
    // is not repeated while Safari catches up (each fold scrolls, which
    // checks again).
    let foldedTo: number | null = null;
    let viewportFrame = 0;
    const scheduleViewport = () => {
      cancelAnimationFrame(viewportFrame);
      // Let focus settle first, including showModal() and dialog restoration.
      viewportFrame = requestAnimationFrame(viewport);
    };
    let touching = false;
    const touched = (event: Event) => {
      touching = event.type === "touchstart";
    };
    const touchEvents = ["touchstart", "touchend", "touchcancel"];
    for (const type of touchEvents)
      window.addEventListener(type, touched, { passive: true });
    viewport();
    const stopWatching = watchViewport(window, document, scheduleViewport, () =>
      fold(),
    );
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
      cancelAnimationFrame(viewportFrame);
      stopWatching();
      probe.remove();
      document.documentElement.style.removeProperty("--viewport-drop");
      document.documentElement.style.removeProperty("--visual-viewport-top");
      for (const type of touchEvents) window.removeEventListener(type, touched);
    };
  }, []);
  if (online && !update) return null;
  return (
    <div className="pwa-status" role="status">
      {!online
        ? "You’re offline. This screen and drafts stay here; reconnect to send new work."
        : "An update is ready."}
      {online && update && (
        <button
          onClick={() => {
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              () => location.reload(),
              { once: true },
            );
            update.postMessage({ type: "ACTIVATE" });
          }}
        >
          Reload to update
        </button>
      )}
    </div>
  );
}

type Events = Pick<EventTarget, "addEventListener" | "removeEventListener">;
/**
 * Calls `check` (keyboard state and fold) on viewport, focus and page-show
 * changes, and `refold` (the fold alone) once a scroll or touch ends: Safari
 * can leave the view panned mid-scroll (the fixed tab bar then floats above
 * the bottom) and ignores a fold made during the scroll, so only one after
 * it can fold that back. Returns a function that stops watching.
 */
export function watchViewport(
  win: Events & {
    visualViewport?: Events | null;
    setTimeout: (run: () => void, ms: number) => unknown;
    clearTimeout: (timer: any) => void;
  },
  doc: Events,
  check: () => void,
  refold: () => void,
  settleMs = 150,
) {
  let settle: unknown;
  let checks: unknown[] = [];
  let folds: unknown[] = [];
  const clear = (timers: unknown[]) => {
    for (const timer of timers) win.clearTimeout(timer);
  };
  const checked = () => {
    check();
    clear(checks);
    // iOS can finish restoring the viewport after its last focus/resize event.
    // Sample that short transition, then stop; no idle polling loop.
    checks = SHEET_SETTLE_MS.map((ms) => win.setTimeout(check, ms));
  };
  const refolded = () => {
    refold();
    clear(folds);
    folds = SHEET_SETTLE_MS.map((ms) => win.setTimeout(refold, ms));
  };
  // Scroll events arrive throughout a scroll; fold once it has stopped.
  const scrolled = () => {
    win.clearTimeout(settle);
    settle = win.setTimeout(refolded, settleMs);
  };
  const viewport = win.visualViewport;
  const checkEvents: [Events | null | undefined, string][] = [
    [viewport, "resize"],
    [viewport, "scroll"],
    [win, "resize"],
    [win, "pageshow"],
    // Coming back from another app, which can leave the viewport stale.
    [doc, "visibilitychange"],
    [doc, "focusin"],
    [doc, "focusout"],
  ];
  const refolds: [Events, string][] = [
    [win, "scrollend"],
    [win, "touchend"],
    [win, "touchcancel"],
  ];
  for (const [target, type] of checkEvents)
    target?.addEventListener(type, checked);
  for (const [target, type] of refolds) target.addEventListener(type, refolded);
  win.addEventListener("scroll", scrolled, { passive: true });
  return () => {
    win.clearTimeout(settle);
    clear(checks);
    clear(folds);
    for (const [target, type] of checkEvents)
      target?.removeEventListener(type, checked);
    for (const [target, type] of refolds)
      target.removeEventListener(type, refolded);
    win.removeEventListener("scroll", scrolled);
  };
}

/**
 * Where to scroll the page to fold a leftover pan back in, or null to leave
 * it. Safari ignores a programmatic scroll while a finger is down or the page
 * is still coasting, so nothing is tried during a touch, and a fold that was
 * ignored (the page is not where it was sent) is tried again. A fold that
 * landed is not repeated: Safari may report the old pan for a moment.
 */
export function foldTarget(
  pan: number,
  touching: boolean,
  scrollY: number,
  foldedTo: number | null,
) {
  if (!pan || touching) return null;
  if (foldedTo !== null && Math.abs(scrollY - foldedTo) < 1) return null;
  return scrollY + pan;
}

/**
 * How far the visible area is still panned below the page's own viewport
 * once no keyboard is open (0 when there is nothing to correct). Pinch zoom
 * pans on purpose, so it is left alone.
 */
export function leftoverPan(
  v:
    | (Pick<VisualViewport, "offsetTop" | "scale"> &
        Partial<Pick<VisualViewport, "pageTop">>)
    | null
    | undefined,
  keyboardOpen: boolean,
  scrollY = 0,
) {
  if (!v || keyboardOpen || (v.scale || 1) !== 1) return 0;
  const top = visibleViewportTop(v, scrollY);
  return top >= 1 ? Math.round(top) : 0;
}

/**
 * How far the bottom of what you see sits below the bottom of the layout
 * viewport (where fixed bars rest), once no keyboard is open: the distance
 * to move those bars down. 0 while typing (the keyboard owns the bottom) and
 * while pinch-zoomed. Once focus leaves text entry, a stale keyboard-sized
 * visual viewport must not override the window's restored height.
 */
export function viewportDrop(
  v:
    | (Pick<VisualViewport, "offsetTop" | "height" | "scale"> &
        Partial<Pick<VisualViewport, "pageTop">>)
    | null
    | undefined,
  layoutBottom: number,
  keyboardOpen: boolean,
  scrollY = 0,
  windowHeight = 0,
) {
  if (!v || keyboardOpen || (v.scale || 1) !== 1 || !(layoutBottom > 0))
    return 0;
  const drop = Math.round(
    Math.max(visibleViewportTop(v, scrollY) + v.height, windowHeight) -
      layoutBottom,
  );
  return drop >= 1 ? drop : 0;
}
