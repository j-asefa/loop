import { viewGeneration } from "./viewCache";

const pending = new Map<string, Promise<unknown>>();
let versionGeneration = viewGeneration();
const ownUnreadVersions = new Map<string, number>();
const groupUnreadVersions = new Map<string, Record<string, number>>();
function versionsKey(source: string, id: string) {
  if (versionGeneration !== viewGeneration()) {
    ownUnreadVersions.clear();
    groupUnreadVersions.clear();
    versionGeneration = viewGeneration();
  }
  return JSON.stringify([source, id]);
}

/** Only our own completed unread choices can advance a queued read's version.
 * Fetching a fresh remote version here would erase a newer remote decision. */
export function doneReadVersion(source: string, card: string, observed = 0) {
  return Math.max(
    observed,
    ownUnreadVersions.get(versionsKey(source, card)) ?? 0,
  );
}
export function doneThreadReadVersions(
  source: string,
  group: string,
  observed: Record<string, number> = {},
) {
  const local = groupUnreadVersions.get(versionsKey(source, group)) ?? {};
  return Object.fromEntries(
    [...new Set([...Object.keys(observed), ...Object.keys(local)])].map(
      (card) => [card, doneReadVersion(source, card, observed[card] ?? 0)],
    ),
  );
}

export function writeDoneUnreadState<
  T extends { unreadVersions?: Record<string, number> },
>(source: string, write: () => Promise<T>, group?: string): Promise<T> {
  const generation = viewGeneration();
  return writeDoneReadState(source, async () => {
    const result = await write();
    if (generation === viewGeneration() && result.unreadVersions) {
      for (const [card, version] of Object.entries(result.unreadVersions))
        ownUnreadVersions.set(versionsKey(source, card), version);
      if (group)
        groupUnreadVersions.set(
          versionsKey(source, group),
          result.unreadVersions,
        );
    }
    return result;
  });
}

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
