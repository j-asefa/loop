import { viewGeneration } from "./viewCache";

const pending = new Map<string, Promise<unknown>>();

/** Keep successive read choices ordered, including overlapping saved groups.
 * The queue outlives a Feed mount, but never dispatches into another session.
 * A failed predecessor also stops its queued successors; it is not retried. */
export function writeDoneReadState<T>(
  source: string,
  cardIds: readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  const generation = viewGeneration();
  const keys = cardIds.map((id) => JSON.stringify([generation, source, id]));
  const predecessors = new Set(
    keys.map((key) => pending.get(key)).filter((value) => value !== undefined),
  );
  const result = Promise.all(predecessors).then(() => {
    if (generation !== viewGeneration())
      throw new DOMException("The workspace changed.", "AbortError");
    return write();
  });
  for (const key of keys) pending.set(key, result);
  const clear = () => {
    for (const key of keys)
      if (pending.get(key) === result) pending.delete(key);
  };
  void result.then(clear, clear);
  return result;
}
