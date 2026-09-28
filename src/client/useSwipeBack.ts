import { useEffect, useRef } from "react";

function ownsHorizontalGesture(target: Element) {
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const composer = target.closest(".composer");
  if (composer && target.closest("dialog") === composer.closest("dialog"))
    return true;
  if (
    target.closest(
      "input,textarea,select,iframe,video,audio,canvas,[role=slider],[contenteditable=true]",
    )
  )
    return true;
  // Ordinary buttons and links still allow a page swipe. A completed Back
  // gesture suppresses their click; inputs and horizontal scrollers own theirs.
  for (
    let element: Element | null = target;
    element;
    element = element.parentElement
  ) {
    if (
      element.scrollWidth > element.clientWidth + 1 &&
      /auto|scroll/.test(getComputedStyle(element).overflowX)
    )
      return true;
  }
  return false;
}

export function useSwipeBack(enabled: boolean, onBack: () => boolean) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    let gesture: {
      id: number;
      x: number;
      y: number;
      dx: number;
      dy: number;
      time: number;
    } | null = null;
    let suppressClickUntil = 0;
    const cancel = () => {
      gesture = null;
    };
    const start = (event: TouchEvent) => {
      cancel();
      suppressClickUntil = 0;
      if (
        event.touches.length !== 1 ||
        !(event.target instanceof Element) ||
        ownsHorizontalGesture(event.target) ||
        window.getSelection()?.toString()
      )
        return;
      const touch = event.touches[0];
      gesture = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        dx: 0,
        dy: 0,
        time: performance.now(),
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== gesture.id)
        return cancel();
      gesture.dx = touch.clientX - gesture.x;
      gesture.dy = touch.clientY - gesture.y;
      if (Math.hypot(gesture.dx, gesture.dy) < 12) return;
      // Lock only a deliberate leftward motion. Vertical reading, rightward
      // motion, selection and nested horizontal scrollers retain their gestures.
      if (
        gesture.dx >= 0 ||
        Math.abs(gesture.dy) * 2 > -gesture.dx ||
        !event.cancelable
      )
        return cancel();
      event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const swipe = gesture;
      cancel();
      if (
        !swipe ||
        event.touches.length ||
        -swipe.dx < Math.min(96, window.innerWidth * 0.24) ||
        Math.abs(swipe.dy) * 2 > -swipe.dx ||
        performance.now() - swipe.time > 1200 ||
        window.getSelection()?.toString()
      )
        return;
      if (back.current()) {
        suppressClickUntil = performance.now() + 400;
        if (event.cancelable) event.preventDefault();
      }
    };
    const click = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end, { passive: false });
    document.addEventListener("touchcancel", cancel);
    document.addEventListener("click", click, true);
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", cancel);
      document.removeEventListener("click", click, true);
    };
  }, [enabled]);
}
