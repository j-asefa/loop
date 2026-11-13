import { ownerSession } from "./ownerSession";

const views = new Map<string, unknown>();
ownerSession.registerCache(() => views.clear());

export function setViewOwner(next: string | undefined) {
  ownerSession.change(next);
}

export function viewOwner() {
  return ownerSession.current.owner;
}

/** Distinguish logout/login even when the same owner returns. */
export function viewGeneration() {
  return ownerSession.current.generation;
}

export function cachedView<T>(key: string): T | undefined {
  return viewOwner() ? (views.get(key) as T | undefined) : undefined;
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
  if (!viewOwner() || forOwner !== viewOwner()) return;
  views.delete(key);
  views.set(key, value);
  if (views.size > 40) views.delete(views.keys().next().value!);
}
