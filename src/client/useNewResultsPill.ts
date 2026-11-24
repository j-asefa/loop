import { useEffect, useRef, useState } from "react";

// Results that land above the reader while they are scrolled down are
// counted, not announced by moving the page: an "↑ N new results" pill
// takes the reader back to the top when they choose.
//
// The baseline is every row seen in the current scope (source, project,
// filters), so a row that drops out of one poll and returns is not new,
// and changing the scope starts a fresh baseline instead of counting the
// rows a broader view adds. A thread that moves up with a newer answer
// keeps its key and is not counted: the pill reports new cards only.

const AWAY_FROM_TOP = 200;
const AT_TOP = 48;

/** How many rows now lead the list that have not been seen before. */
export function newRowsAtTop(seen: ReadonlySet<string>, keys: string[]) {
  let count = 0;
  for (const key of keys) {
    if (seen.has(key)) break;
    count++;
  }
  // A list with nothing seen before is a different view, not new results.
  return count === keys.length ? 0 : count;
}

export function useNewResultsPill(
  active: boolean,
  scope: string,
  keys: string[],
) {
  const seen = useRef<{ scope: string; keys: Set<string> } | null>(null);
  const [count, setCount] = useState(0);
  const signature = keys.join("\n");
  useEffect(() => {
    if (!active) {
      seen.current = null;
      setCount(0);
      return;
    }
    if (seen.current?.scope !== scope) {
      seen.current = { scope, keys: new Set(keys) };
      setCount(0);
      return;
    }
    const added = newRowsAtTop(seen.current.keys, keys);
    for (const key of keys) seen.current.keys.add(key);
    if (added && window.scrollY > AWAY_FROM_TOP)
      setCount((current) => current + added);
  }, [active, scope, signature]);
  useEffect(() => {
    if (!count) return;
    const onScroll = () => {
      if (window.scrollY < AT_TOP) setCount(0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [count]);
  const showNewResults = (focus?: () => void) => {
    setCount(0);
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    focus?.();
  };
  return { count, showNewResults };
}
