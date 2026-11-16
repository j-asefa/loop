import { useEffect, useRef, useState } from "react";

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
 * Horizontal swipe on a row or message. Returns the live offset for styling and
 * pointer handlers. `onLeft`/`onRight` fire past 72px when the gesture is
 * clearly horizontal; vertical scrolling is never captured.
 */
export function useSwipe({
  onLeft,
  onRight,
}: {
  onLeft?: () => void;
  onRight?: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);
  // A horizontal drag must not also count as a tap on the row it moved.
  const dragged = useRef(false);
  const threshold = 72;
  const reset = () => {
    start.current = null;
    horizontal.current = null;
    setOffset(0);
  };
  return {
    offset,
    armed: offset >= threshold ? "right" : offset <= -threshold ? "left" : null,
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
        setOffset(allowed ? Math.max(-120, Math.min(120, dx)) : 0);
      },
      onPointerUp: () => {
        if (offset >= threshold) onRight?.();
        else if (offset <= -threshold) onLeft?.();
        reset();
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
