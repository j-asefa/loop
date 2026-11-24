import { useCallback, useEffect, useRef } from "react";

const HOLD_MS = 500;
const SLOP_PX = 10;

export function useLongPress(
  onPress: () => void,
  enabled = true,
  { onControls = false }: { onControls?: boolean } = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, [enabled]);
  if (!enabled) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (
        e.button !== 0 ||
        (!onControls &&
          (e.target as HTMLElement).closest(
            "a,button,summary,input,textarea,select,pre,.table-scroll",
          ))
      )
        return;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        onPress();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) >
        SLOP_PX
      )
        clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a,pre,code,img")) return;
      e.preventDefault();
      clear();
      fired.current = true;
      onPress();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

/**
 * Horizontal swipe on a row or message. Attach `ref` to the swipe container.
 * During a drag the offset is written to that element as the `--swipe-x`
 * variable with `data-swipe` ("left" or "right") and, past the threshold,
 * `data-armed`, so a move never re-renders React. CSS moves the container's
 * `.swipe-track` child (or the container itself when it has that class).
 * `onLeft`/`onRight` fire past 72px when the gesture is clearly horizontal;
 * vertical scrolling is never captured.
 */
export function useSwipe({
  onLeft,
  onRight,
}: {
  onLeft?: () => void;
  onRight?: () => void;
}) {
  const element = useRef<HTMLElement | null>(null);
  const offset = useRef(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);
  // A horizontal drag must not also count as a tap on the row it moved.
  const dragged = useRef(false);
  const threshold = 72;
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node;
  }, []);
  const show = (dx: number) => {
    offset.current = dx;
    const target = element.current;
    if (!target) return;
    if (!dx) {
      target.style.removeProperty("--swipe-x");
      delete target.dataset.swipe;
      delete target.dataset.armed;
      return;
    }
    target.style.setProperty("--swipe-x", `${dx}px`);
    target.dataset.swipe = dx > 0 ? "right" : "left";
    const armed = dx >= threshold ? "right" : dx <= -threshold ? "left" : "";
    if (armed) target.dataset.armed = armed;
    else delete target.dataset.armed;
  };
  const reset = () => {
    start.current = null;
    horizontal.current = null;
    show(0);
  };
  return {
    ref,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        // Any new press, even a mouse click after a touch swipe, is a tap
        // until it drags.
        dragged.current = false;
        if (e.pointerType === "mouse") return;
        if (
          (e.target as HTMLElement).closest("pre,.table-scroll,input,textarea")
        )
          return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        horizontal.current = null;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x,
          dy = e.clientY - s.y;
        if (horizontal.current === null && Math.hypot(dx, dy) > SLOP_PX)
          horizontal.current = Math.abs(dx) > Math.abs(dy) * 1.5;
        if (!horizontal.current) return;
        dragged.current = true;
        const allowed = (dx > 0 && onRight) || (dx < 0 && onLeft);
        show(allowed ? Math.max(-120, Math.min(120, dx)) : 0);
      },
      onPointerUp: () => {
        const released = offset.current;
        reset();
        if (released >= threshold) onRight?.();
        else if (released <= -threshold) onLeft?.();
      },
      onPointerCancel: reset,
      onClickCapture: (e: React.MouseEvent) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}
