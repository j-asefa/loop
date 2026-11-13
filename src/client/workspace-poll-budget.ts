import { ownerSession } from "./ownerSession";

function newPool() {
  return { active: 0, tokens: 8, at: Date.now(), waiting: new Set<symbol>() };
}
let pool = newPool();
ownerSession.registerCache(() => {
  pool = newPool();
});
export function cancelWorkspacePoll(key: symbol) {
  pool.waiting.delete(key);
}
/** Fair bounded fallback across the page, used only while a source lacks push.
 * An obsolete owner releases its own pool, never the next owner's counters. */
export function acquireWorkspacePoll(key: symbol): (() => void) | undefined {
  const state = pool,
    now = Date.now();
  if (state.waiting.size >= 256 && !state.waiting.has(key)) return;
  state.waiting.add(key);
  state.tokens = Math.min(
    8,
    state.tokens + Math.max(0, now - state.at) * 0.004,
  );
  state.at = now;
  if (
    state.active >= 4 ||
    state.tokens < 1 ||
    state.waiting.values().next().value !== key
  )
    return;
  state.waiting.delete(key);
  state.tokens--;
  state.active++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      state.active--;
    }
  };
}
