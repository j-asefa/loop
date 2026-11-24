import { useEffect, useRef, useState } from "react";

// Results that land above the reader while they are scrolled down are
// counted, not announced by moving the page: a floating "↑ N new results"
// pill takes the reader back to the top when they choose.

const AWAY_FROM_TOP = 200;
const AT_TOP = 48;

/** How many rows now lead the list that the previous list did not have. */
export function newRowsAtTop(previous: ReadonlySet<string>, keys: string[]) {
  let count = 0;
  for (const key of keys) {
    if (previous.has(key)) break;
    count++;
  }
  // A list with nothing in common is a different view, not new results.
  return count === keys.length ? 0 : count;
}

export function useNewResultsPill(active: boolean, keys: string[]) {
  const seen = useRef<Set<string> | null>(null);
  const [count, setCount] = useState(0);
  const signature = keys.join("\n");
  useEffect(() => {
    if (!active) {
      seen.current = null;
      setCount(0);
      return;
    }
    const previous = seen.current;
    seen.current = new Set(keys);
    if (!previous) return;
    const added = newRowsAtTop(previous, keys);
    if (added && window.scrollY > AWAY_FROM_TOP)
      setCount((current) => current + added);
  }, [active, signature]);
  useEffect(() => {
    if (!count) return;
    const onScroll = () => {
      if (window.scrollY < AT_TOP) setCount(0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [count]);
  const showNewResults = () => {
    setCount(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return { count, showNewResults };
}
