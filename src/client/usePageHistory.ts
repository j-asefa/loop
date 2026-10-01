import { useEffect, useLayoutEffect, useRef } from "react";

type Visit<T> = { key: string; value: T; scroll: number };

// Loop's views share one document. Keep their in-app back path separately from
// the browser history entry used by the modal stack, and never leave the app.
export function usePageHistory<T>(
  key: string,
  value: T,
  owner: string | undefined,
  restore: (value: T, scroll: number) => void,
) {
  const current = useRef<Visit<T>>({ key, value, scroll: window.scrollY });
  const visits = useRef<Visit<T>[]>([]);
  const returning = useRef(false);
  const previousOwner = useRef(owner);
  useLayoutEffect(() => {
    if (!owner || previousOwner.current !== owner) visits.current = [];
    else if (current.current.key !== key && !returning.current) {
      const previous = visits.current.findLastIndex(
        (visit) => visit.key === key,
      );
      // Explicit Back buttons and returning to a tab unwind the same path.
      if (previous >= 0) visits.current.splice(previous);
      else visits.current = [...visits.current.slice(-49), current.current];
    }
    current.current = { key, value, scroll: window.scrollY };
    previousOwner.current = owner;
    returning.current = false;
  });
  useEffect(() => {
    const scrolled = () => {
      current.current.scroll = window.scrollY;
    };
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => window.removeEventListener("scroll", scrolled);
  }, []);
  return () => {
    const previous = visits.current.pop();
    if (!previous) return false;
    returning.current = true;
    restore(previous.value, previous.scroll);
    return true;
  };
}

/**
 * Return the page to a saved position. Lists often finish loading after the
 * page is shown, so keep the position while the page grows, until it is
 * reached and settled or you touch, scroll or type.
 */
export function restoreScroll(top: number) {
  const inputs = ["touchstart", "wheel", "keydown", "pointerdown"] as const;
  let settled = 0;
  const observer = new ResizeObserver(() => attempt());
  const timer = setTimeout(stop, 3000);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
    for (const input of inputs) removeEventListener(input, stop);
  }
  function attempt() {
    window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
    if (Math.abs(window.scrollY - top) < 2 && ++settled > 2) stop();
  }
  for (const input of inputs)
    addEventListener(input, stop, { passive: true, capture: true });
  observer.observe(document.body);
  attempt();
}
