import { SHEET_SETTLE_MS, visibleViewportTop } from "../shared/sheet-viewport";
import { useEffect, type RefObject } from "react";

/** The gap the sheet's keyboard-open rule leaves above the visible top, or
 * null when no such rule applies. The rule declares it, so the breakpoint and
 * the offset live in CSS only: this hook cannot disagree with what moves. */
export function sheetGap(dialog: Element) {
  const raw = getComputedStyle(dialog)
    .getPropertyValue("--sheet-top-gap")
    .trim();
  const gap = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(gap) ? gap : null;
}

/** The sheet's next top correction, or null when there is nothing to correct.
 * Converges on `gap` below the visible top; sub-pixel deltas are left alone so
 * rounding cannot make it drift. */
export function sheetCorrection(
  previous: number,
  gap: number | null,
  visibleTop: number,
  top: number,
) {
  if (gap == null) return null;
  const delta = visibleTop + gap - top;
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return previous;
  return previous + delta;
}

/** Measure the modal's own viewport origin: iOS can pan the top layer
 * independently of the page when focusing a field in a tall conversation. */
export function useSheetViewport(ref: RefObject<HTMLDialogElement | null>) {
  useKeyboardViewport(ref, true);
}

export function useComposerViewport(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useKeyboardViewport(ref, enabled);
}

function useKeyboardViewport(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const dialog = ref.current;
    const viewport = window.visualViewport;
    if (!enabled || !dialog || !viewport) return;
    let frame = 0;
    let settling: ReturnType<typeof setTimeout>[] = [];
    let correction = 0;
    const clear = () => {
      correction = 0;
      dialog.style.removeProperty("--sheet-top-correction");
    };
    const align = () => {
      if (
        (dialog instanceof HTMLDialogElement
          ? !dialog.open
          : !dialog.classList.contains("expanded")) ||
        dialog.classList.contains("side-panel") ||
        document.documentElement.dataset.keyboard !== "open"
      )
        return clear();
      if (
        dialog.classList.contains("dragging") ||
        dialog.classList.contains("dismissing") ||
        // A canceled/short drag removes its class before the return transition
        // finishes. Its translated bounds are motion, not viewport drift.
        (dialog.classList.contains("swipe-sheet") &&
          getComputedStyle(dialog).transform !== "none")
      )
        return;
      const next = sheetCorrection(
        correction,
        sheetGap(dialog),
        visibleViewportTop(viewport, window.scrollY),
        dialog.getBoundingClientRect().top,
      );
      if (next == null) return clear();
      if (next === correction) return;
      correction = next;
      dialog.style.setProperty("--sheet-top-correction", `${correction}px`);
    };
    const nextFrame = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    };
    const schedule = () => {
      nextFrame();
      for (const timer of settling) clearTimeout(timer);
      // Keyboard/focus panning can finish after the viewport event, without
      // resizing the sheet or reporting another visualViewport change. Sample
      // the settled position too; never leave a polling loop running while idle.
      settling = SHEET_SETTLE_MS.map((ms) => setTimeout(nextFrame, ms));
    };
    const attributes = new MutationObserver(schedule);
    attributes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-keyboard", "style"],
    });
    attributes.observe(dialog, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const size = new ResizeObserver(schedule);
    size.observe(dialog);
    const events: [EventTarget, string][] = [
      [viewport, "resize"],
      [viewport, "scroll"],
      // The layout viewport may scroll independently of the visual viewport.
      [window, "scroll"],
      [window, "scrollend"],
      [dialog, "focusin"],
      [dialog, "focusout"],
      [dialog, "touchend"],
      [dialog, "touchcancel"],
    ];
    for (const [target, type] of events)
      target.addEventListener(type, schedule, { passive: true });
    const transition = (event: TransitionEvent) => {
      if (event.target === dialog && event.propertyName === "transform")
        schedule();
    };
    dialog.addEventListener("transitionend", transition);
    dialog.addEventListener("transitioncancel", transition);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of settling) clearTimeout(timer);
      attributes.disconnect();
      size.disconnect();
      for (const [target, type] of events)
        target.removeEventListener(type, schedule);
      dialog.removeEventListener("transitionend", transition);
      dialog.removeEventListener("transitioncancel", transition);
      dialog.style.removeProperty("--sheet-top-correction");
    };
  }, [ref, enabled]);
}
