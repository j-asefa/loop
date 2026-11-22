import {
  feedItemOrder,
  type FeedPosition as DonePosition,
} from "../shared/feed-order";
export type DoneRefresh = {
  before: string;
  after: DonePosition;
  floor?: DonePosition;
  continuation?: string | null;
  restart?: boolean;
  head?: DonePosition;
  rescan?: boolean;
};
const key = (item: DonePosition) =>
  JSON.stringify([
    item.conversation_id,
    item.reply_card_key ?? item.done_card_key ?? null,
  ]);
type Page<T> = { items: T[]; next: string | null };

/** Refresh the newest page and one page of loaded history per source. Each
 * page replaces only its covered interval; untouched history stays visible.
 * History reconciliation continues on subsequent refreshes, without an
 * unbounded request chain on every poll. */
export async function refreshDonePage<
  T extends DonePosition,
  P extends Page<T>,
>(
  read: (before?: string) => Promise<P>,
  previous: Page<T>,
  progress: DoneRefresh | undefined,
  current: () => boolean,
): Promise<{ page: P; progress?: DoneRefresh; error?: Error }> {
  const first = await read();
  if (
    !current() ||
    !previous.items.length ||
    !first.next ||
    !first.items.length
  )
    return { page: first };
  const retained = [...previous.items].sort(feedItemOrder);
  const oldest = retained.at(-1)!;
  // A temporary gap cursor must not replace the loaded window's continuation.
  // Only an append extending below the old floor commits a new continuation.
  // Moving or removing the oldest row must not promote a temporary gap cursor.
  const continuation =
    progress?.floor &&
    feedItemOrder(oldest, progress.floor) <= 0 &&
    progress.continuation !== undefined
      ? progress.continuation
      : previous.next;
  const items = new Map(retained.map((item) => [key(item), item]));
  const apply = (page: P, after?: DonePosition, floor?: DonePosition) => {
    const last = page.items.at(-1);
    for (const [id, item] of items) {
      if (
        (!after || feedItemOrder(item, after) > 0) &&
        (!page.next || (last && feedItemOrder(item, last) <= 0))
      )
        items.delete(id);
    }
    for (const item of page.items)
      if (!floor || feedItemOrder(item, floor) <= 0) items.set(key(item), item);
  };
  apply(first);
  const firstLast = first.items.at(-1)!;
  // Restart after a new front-page gap or removals that let the first page
  // reach the old floor. A stale history read must not erase that new page.
  if (
    !progress ||
    progress.restart ||
    (!progress.head && feedItemOrder(firstLast, retained[0]) < 0) ||
    feedItemOrder(firstLast, oldest) >= 0
  )
    progress = {
      head: firstLast,
      before: first.next,
      after: firstLast,
      floor: oldest,
      continuation,
    };
  // Finish this sweep before revisiting intervals changed by a moving head.
  // Rewinding on every live update can starve the oldest loaded pages.
  const rescan =
    progress.rescan ||
    (!!progress.head && feedItemOrder(firstLast, progress.head) < 0);
  // The newest page can itself reach or extend a formerly exhausted window.
  // Its continuation must become visible even when no history read is needed.
  let next = feedItemOrder(firstLast, oldest) >= 0 ? first.next : continuation;
  if (feedItemOrder(progress.after, oldest) < 0 && current()) {
    let history: P;
    try {
      history = await read(progress.before);
    } catch (error) {
      return {
        page: {
          ...first,
          items: [...items.values()].sort(feedItemOrder),
          next,
        },
        progress: { ...progress, rescan },
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    if (!current()) return { page: first };
    const last = history.items.at(-1);
    if (
      history.next &&
      (history.next === progress.before ||
        !last ||
        feedItemOrder(last, progress.after) <= 0)
    )
      throw new Error("History pagination did not advance. Try again.");
    apply(history, progress.after, oldest);
    if (last && feedItemOrder(last, oldest) > 0) {
      // Newly imported history can arrive below a previously exhausted window.
      // Reuse the server cursor; append deduplicates any overlap.
      next ||= progress.before;
    } else if (!history.next || (last && feedItemOrder(last, oldest) === 0)) {
      next = history.next;
    }
    progress =
      history.next && last && feedItemOrder(last, oldest) < 0
        ? {
            head: firstLast,
            rescan,
            before: history.next,
            after: last,
            floor: oldest,
            continuation,
          }
        : undefined;
  } else {
    progress = undefined;
  }
  if (!progress && rescan && feedItemOrder(firstLast, oldest) < 0)
    progress = {
      head: firstLast,
      before: first.next,
      after: firstLast,
      floor: oldest,
      continuation: next,
    };
  // A burst can leave unseen results between the two fresh pages and the
  // retained window. Let Load more reach that gap immediately.
  if (progress && feedItemOrder(progress.after, retained[0]) < 0)
    next = progress.before;
  return {
    page: { ...first, items: [...items.values()].sort(feedItemOrder), next },
    progress,
  };
}
