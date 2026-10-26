export type DonePosition = {
  conversation_id: string;
  done_card_key?: string;
  reply_card_key?: string;
  last_activity_at: number;
};
export type DoneRefresh = { before: string; after: DonePosition };
const descendingId = (a: string, b: string) => (a === b ? 0 : a < b ? 1 : -1);
export const feedItemOrder = (a: DonePosition, b: DonePosition) =>
  b.last_activity_at - a.last_activity_at ||
  descendingId(a.conversation_id, b.conversation_id) ||
  descendingId(
    a.reply_card_key || a.done_card_key || "",
    b.reply_card_key || b.done_card_key || "",
  );
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
): Promise<{ page: P; progress?: DoneRefresh }> {
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
    feedItemOrder(firstLast, retained[0]) < 0 ||
    feedItemOrder(firstLast, oldest) >= 0
  )
    progress = { before: first.next, after: firstLast };
  // The newest page can itself reach or extend a formerly exhausted window.
  // Its continuation must become visible even when no history read is needed.
  let next = feedItemOrder(firstLast, oldest) >= 0 ? first.next : previous.next;
  if (feedItemOrder(progress.after, oldest) < 0 && current()) {
    const history = await read(progress.before);
    if (!current()) return { page: first };
    apply(history, progress.after, oldest);
    const last = history.items.at(-1);
    if (last && feedItemOrder(last, oldest) > 0) {
      // Newly imported history can arrive below a previously exhausted window.
      // Reuse the server cursor; append deduplicates any overlap.
      next ||= progress.before;
    } else if (!history.next || (last && feedItemOrder(last, oldest) === 0)) {
      next = history.next;
    }
    progress =
      history.next && last && feedItemOrder(last, oldest) < 0
        ? { before: history.next, after: last }
        : undefined;
  } else {
    progress = undefined;
  }
  // A burst can leave unseen results between the two fresh pages and the
  // retained window. Let Load more reach that gap immediately.
  if (progress && feedItemOrder(progress.after, retained[0]) < 0)
    next = progress.before;
  return {
    page: { ...first, items: [...items.values()].sort(feedItemOrder), next },
    progress,
  };
}
