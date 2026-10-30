import { viewGeneration } from "./viewCache";

const pending = new Map<string, Promise<unknown>>();

/** Order read choices within each workspace. A saved group's server membership
 * can differ from the cached list, so it may touch any pending result there.
 * The queue outlives a Feed mount, but never dispatches into another session.
 * A failed predecessor also stops its queued successors; it is not retried. */
export function writeDoneReadState<T>(
  source: string,
  write: () => Promise<T>,
): Promise<T> {
  const generation = viewGeneration();
  const key = JSON.stringify([generation, source]);
  const result = Promise.resolve(pending.get(key)).then(() => {
    if (generation !== viewGeneration())
      throw new DOMException("The workspace changed.", "AbortError");
    return write();
  });
  pending.set(key, result);
  const clear = () => {
    if (pending.get(key) === result) pending.delete(key);
  };
  void result.then(clear, clear);
  return result;
}
