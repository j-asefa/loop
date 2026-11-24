import { useLayoutEffect, useRef } from "react";

/**
 * Structural equality for JSON-like values: primitives, arrays and plain
 * objects. Anything else (functions, class instances) is equal only to itself.
 * A property set to `undefined` equals a missing property, as in JSON.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

function isPlain(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Keeps one object per key while its content is unchanged, so a memoised
 * component receives the same reference across refreshes that rebuild equal
 * data. `sweep` forgets keys not kept since the previous sweep.
 */
export class IdentityCache {
  private entries = new Map<string, unknown>();
  private kept = new Set<string>();

  keep<T>(key: string, value: T): T {
    this.kept.add(key);
    if (value === undefined) {
      this.entries.delete(key);
      return value;
    }
    const previous = this.entries.get(key);
    if (previous !== undefined && sameValue(previous, value))
      return previous as T;
    this.entries.set(key, value);
    return value;
  }

  sweep() {
    for (const key of this.entries.keys())
      if (!this.kept.has(key)) this.entries.delete(key);
    this.kept.clear();
  }

  get size() {
    return this.entries.size;
  }
}

type Callbacks = Record<string, ((...args: never[]) => unknown) | undefined>;

/**
 * Stable props for a list of memoised cards.
 *
 * `keep(key, value)` returns the previous object for `key` while its content
 * is unchanged. `handlers(key, callbacks)` returns one stable function per
 * callback name. Each calls the closure from the latest committed render, so
 * a card that skipped a render never acts on stale state (for example an old
 * view generation). A callback that is absent stays `undefined`, so a card
 * still re-renders when a callback appears or disappears.
 *
 * Call the hook unconditionally, and call `keep` and `handlers` during the
 * same render; the latest closures take effect when that render commits.
 */
export function useStableCardProps() {
  const values = useRef(new IdentityCache());
  const slots = useRef(
    new Map<string, { latest: Callbacks; stable: Callbacks }>(),
  );
  const rendered = new Map<string, Callbacks>();
  useLayoutEffect(() => {
    for (const [key, latest] of rendered) {
      const slot = slots.current.get(key);
      if (slot) slot.latest = latest;
    }
    for (const key of slots.current.keys())
      if (!rendered.has(key)) slots.current.delete(key);
    values.current.sweep();
  });
  return {
    keep: <T>(key: string, value: T) => values.current.keep(key, value),
    handlers: <T extends Callbacks>(key: string, callbacks: T): T => {
      rendered.set(key, callbacks);
      let slot = slots.current.get(key);
      if (!slot) {
        slot = { latest: callbacks, stable: {} };
        slots.current.set(key, slot);
      }
      const current = slot;
      const stable: Callbacks = {};
      for (const name of Object.keys(callbacks)) {
        if (!callbacks[name]) continue;
        stable[name] = current.stable[name] ??= (...args: never[]) =>
          current.latest[name]?.(...args);
      }
      return stable as T;
    },
  };
}
