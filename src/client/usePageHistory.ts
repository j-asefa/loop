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
