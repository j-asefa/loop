// What a page last showed, so going back returns to it as you left it instead
// of an empty list that reloads. Entries belong to the signed-in owner and are
// dropped when the owner changes, so one account never sees another's views.
let owner: string | undefined;
let generation = 0;
const views = new Map<string, unknown>();

export function setViewOwner(next: string | undefined) {
  if ((next || undefined) === owner) return;
  owner = next || undefined;
  generation++;
  views.clear();
}

/** The owner whose views are cached now. Capture it when a request starts. */
export function viewOwner() {
  return owner;
}

/** Distinguish logout/login even when the same owner returns. */
export function viewGeneration() {
  return generation;
}

export function cachedView<T>(key: string): T | undefined {
  return owner ? (views.get(key) as T | undefined) : undefined;
}

/**
 * Cache a view for the owner it was loaded for. A response that arrives after
 * the account changed carries the previous owner and is dropped, so it can
 * never become part of the next account's views.
 */
export function cacheView<T>(
  key: string,
  value: T,
  forOwner: string | undefined,
) {
  if (!owner || forOwner !== owner) return;
  // Keep a bounded number of views; the oldest entry is replaced first.
  views.delete(key);
  views.set(key, value);
  if (views.size > 40) views.delete(views.keys().next().value!);
}
