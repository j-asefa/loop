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
  offsetTop: number,
  top: number,
) {
  if (gap == null) return null;
  const delta = offsetTop + gap - top;
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return previous;
  return previous + delta;
}

/** Measure the modal's own viewport origin: iOS can pan the top layer
 * independently of the page when focusing a field in a tall conversation. */
export function useSheetViewport(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    const viewport = window.visualViewport;
    if (!dialog || !viewport) return;
    let frame = 0;
    let correction = 0;
    const clear = () => {
      correction = 0;
      dialog.style.removeProperty("--sheet-top-correction");
    };
    const align = () => {
      if (
        !dialog.open ||
        dialog.classList.contains("side-panel") ||
        document.documentElement.dataset.keyboard !== "open"
      )
        return clear();
      if (
        dialog.classList.contains("dragging") ||
        dialog.classList.contains("dismissing")
      )
        return;
      const next = sheetCorrection(
        correction,
        sheetGap(dialog),
        viewport.offsetTop,
        dialog.getBoundingClientRect().top,
      );
      if (next == null) return clear();
      correction = next;
      dialog.style.setProperty("--sheet-top-correction", `${correction}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    };
    const attributes = new MutationObserver(schedule);
    attributes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-keyboard", "style"],
    });
    const size = new ResizeObserver(schedule);
    size.observe(dialog);
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      attributes.disconnect();
      size.disconnect();
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      dialog.style.removeProperty("--sheet-top-correction");
    };
  }, [ref]);
}
