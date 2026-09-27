import { useEffect, type RefObject } from "react";

export function useSheetDrag(
  ref: RefObject<HTMLDialogElement | null>,
  enabled: boolean,
  onClose: RefObject<() => void>,
) {
  useEffect(() => {
    const dialog = ref.current;
    if (!enabled || !dialog) return;
    let start: { x: number; y: number; time: number; handle: boolean } | null =
      null;
    let distance = 0,
      dragging = false,
      suppressClickUntil = 0;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      start = null;
      distance = 0;
      dragging = false;
      dialog.classList.remove("dragging");
      dialog.style.removeProperty("--sheet-drag-y");
    };
    const begin = (target: EventTarget | null, x: number, y: number) => {
      if (
        !(target instanceof Element) ||
        target.closest("dialog") !== dialog ||
        closeTimer
      )
        return;
      const handle = target.closest(".sheet-grip");
      const scrollable = target.closest(".messages, .sheet-body");
      if (
        !handle &&
        (dialog.scrollTop > 0 ||
          (scrollable?.scrollTop || 0) > 0 ||
          target.closest(
            "button,a,input,textarea,select,summary,pre,iframe,[role=button]",
          ) ||
          window.getSelection()?.toString())
      )
        return;
      // Content gestures belong to their scroller. Only the handle dismisses
      // the sheet, so selecting text and reading earlier messages stay safe.
      if (!handle) return;
      start = { x, y, time: performance.now(), handle: true };
      distance = 0;
    };
    const move = (event: Event, x: number, y: number) => {
      if (!start) return;
      const dy = y - start.y,
        dx = x - start.x;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 8) return;
        // Commit only to a downward pull begun at the top. Upward, sideways
        // and nested-control gestures retain their normal browser behavior.
        if (
          dy <= 0 ||
          Math.abs(dx) > dy ||
          (dialog.scrollTop > 0 && !start.handle)
        ) {
          reset();
          return;
        }
        dragging = true;
        dialog.classList.add("dragging");
      }
      if (!event.cancelable) {
        reset();
        return;
      }
      event.preventDefault();
      distance = Math.max(0, dy);
      dialog.style.setProperty("--sheet-drag-y", distance + "px");
    };
    const end = (cancelled = false) => {
      const elapsed = start ? performance.now() - start.time : 0;
      const close =
        !cancelled &&
        dragging &&
        (distance > Math.min(120, dialog.clientHeight * 0.25) ||
          (distance > 45 && distance / Math.max(elapsed, 1) > 0.65));
      if (dragging) suppressClickUntil = performance.now() + 500;
      if (close) {
        start = null;
        dragging = false;
        dialog.classList.remove("dragging");
        dialog.style.setProperty("--sheet-drag-y", window.innerHeight + "px");
        closeTimer = setTimeout(
          () => onClose.current(),
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? 0
            : 160,
        );
      } else reset();
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        end(true);
        return;
      }
      begin(event.target, event.touches[0].clientX, event.touches[0].clientY);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        end(true);
        return;
      }
      move(event, event.touches[0].clientX, event.touches[0].clientY);
    };
    const touchEnd = () => end();
    const cancel = () => end(true);
    const pointerDown = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" ||
        event.button !== 0 ||
        !(event.target as Element)?.closest(".sheet-grip")
      )
        return;
      begin(event.target, event.clientX, event.clientY);
      if (start) dialog.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch")
        move(event, event.clientX, event.clientY);
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      end();
      if (dialog.hasPointerCapture(event.pointerId))
        dialog.releasePointerCapture(event.pointerId);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== "touch") cancel();
    };
    const click = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    dialog.addEventListener("touchstart", touchStart, { passive: true });
    dialog.addEventListener("touchmove", touchMove, { passive: false });
    dialog.addEventListener("touchend", touchEnd);
    dialog.addEventListener("touchcancel", cancel);
    dialog.addEventListener("pointerdown", pointerDown);
    dialog.addEventListener("pointermove", pointerMove);
    dialog.addEventListener("pointerup", pointerUp);
    dialog.addEventListener("pointercancel", pointerCancel);
    dialog.addEventListener("click", click, true);
    return () => {
      clearTimeout(closeTimer);
      dialog.removeEventListener("touchstart", touchStart);
      dialog.removeEventListener("touchmove", touchMove);
      dialog.removeEventListener("touchend", touchEnd);
      dialog.removeEventListener("touchcancel", cancel);
      dialog.removeEventListener("pointerdown", pointerDown);
      dialog.removeEventListener("pointermove", pointerMove);
      dialog.removeEventListener("pointerup", pointerUp);
      dialog.removeEventListener("pointercancel", pointerCancel);
      dialog.removeEventListener("click", click, true);
      reset();
    };
  }, [enabled, ref, onClose]);
}
