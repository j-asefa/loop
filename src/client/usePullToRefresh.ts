import { useEffect, useRef, useState } from "react";

// How far the indicator follows the finger, and how far is far enough.
const MAX_PULL = 96;
const TRIGGER = 64;

function ownsVerticalGesture(target: Element) {
  // Sheets, fields and inner scrollers keep their own vertical scrolling.
  if (
    target.closest("dialog[open],input,textarea,select,[contenteditable=true]")
  )
    return true;
  for (
    let element: Element | null = target;
    element && element !== document.body;
    element = element.parentElement
  ) {
    // Cheapest test first: only a scrolled element can own the gesture, so
    // computed style is read for almost none of the ancestors.
    if (
      element.scrollTop > 0 &&
      element.scrollHeight > element.clientHeight + 1 &&
      /auto|scroll/.test(getComputedStyle(element).overflowY)
    )
      return true;
  }
  return false;
}

/**
 * Pull down from the top of a page to refresh it. Returns a ref for the
 * indicator and whether a refresh is running. While the finger moves, the
 * indicator is shown and updated directly (`--pull`, `data-pull` and its
 * label), so a move never re-renders React; state changes only when a
 * refresh starts and ends.
 */
export function usePullToRefresh(
  enabled: boolean,
  onRefresh: () => Promise<unknown>,
) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const indicator = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let gesture: { id: number; x: number; y: number; pulling: boolean } | null =
      null;
    let distance = 0;
    const show = (pulled: number) => {
      const element = indicator.current;
      if (!element) return;
      if (!pulled) {
        element.hidden = true;
        element.style.removeProperty("--pull");
        delete element.dataset.pull;
        element.removeAttribute("aria-label");
        return;
      }
      const ready = pulled >= TRIGGER;
      element.hidden = false;
      element.style.setProperty("--pull", `${pulled}px`);
      element.dataset.pull = ready ? "ready" : "pulling";
      element.setAttribute(
        "aria-label",
        ready ? "Release to refresh" : "Pull to refresh",
      );
    };
    const reset = () => {
      gesture = null;
      distance = 0;
      show(0);
    };
    const start = (event: TouchEvent) => {
      gesture = null;
      if (
        busy.current ||
        event.touches.length !== 1 ||
        window.scrollY > 0 ||
        document.querySelector("dialog[open]") ||
        !(event.target instanceof Element) ||
        ownsVerticalGesture(event.target)
      )
        return;
      const touch = event.touches[0];
      gesture = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        pulling: false,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== gesture.id)
        return reset();
      const dx = touch.clientX - gesture.x,
        dy = touch.clientY - gesture.y;
      if (!gesture.pulling) {
        if (Math.hypot(dx, dy) < 10) return;
        // Only a deliberate downward pull at the very top; anything else is
        // ordinary scrolling or a sideways swipe.
        if (dy <= 0 || Math.abs(dx) * 1.5 > dy || window.scrollY > 0)
          return reset();
        gesture.pulling = true;
      }
      if (event.cancelable) event.preventDefault();
      // Resistance: the indicator moves less than the finger.
      distance = Math.min(MAX_PULL, Math.max(0, dy) * 0.5);
      show(distance);
    };
    const end = () => {
      const pulled = gesture?.pulling ? distance : 0;
      reset();
      if (pulled < TRIGGER) return;
      busy.current = true;
      setRefreshing(true);
      const started = performance.now();
      void Promise.resolve()
        .then(() => refresh.current())
        .catch(() => {})
        .finally(() => {
          // Keep the spinner long enough to read as a refresh.
          const wait = Math.max(0, 450 - (performance.now() - started));
          setTimeout(() => {
            busy.current = false;
            setRefreshing(false);
          }, wait);
        });
    };
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", reset);
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", reset);
    };
  }, [enabled]);
  return { indicator, refreshing };
}
