export type FeedPage<T> = { items: T[]; next: number | null; revision: number };
export type FeedUpdates<T> = {
  items: T[];
  removed: string[];
  revision: number;
  more: boolean;
};
type Card = { id: string; cursor: number };
type Window<T> = {
  items: Map<string, T>;
  next: number | null;
  through: number;
  revision: number | null;
  active: Promise<FeedPage<T> | null> | null;
  trailing: Promise<FeedPage<T> | null> | null;
  append: boolean;
};
const empty = <T>(): Window<T> => ({
  items: new Map(),
  next: null,
  through: 0,
  revision: null,
  active: null,
  trailing: null,
  append: false,
});

// Pagination fetches one older page. Refreshes fetch a bounded batch of changes,
// independent of how many pages are loaded. Same-feed callers share one active
// request and at most one trailing request; only an owner/filter change invalidates it.
export class FeedPager<T extends Card> {
  key = "";
  private window = empty<T>();

  load(
    key: string,
    append: boolean,
    fetchPage: (before: number | null) => Promise<FeedPage<T>>,
    fetchUpdates: (after: number, through: number) => Promise<FeedUpdates<T>>,
  ): Promise<FeedPage<T> | null> {
    if (this.key !== key) {
      this.key = key;
      this.window = empty<T>();
    }
    const window = this.window;
    if (window.active) {
      window.append ||= append;
      if (!window.trailing) {
        const follow = () => {
          if (this.window !== window) return null;
          const append = window.append;
          window.append = false;
          window.trailing = null;
          return this.load(key, append, fetchPage, fetchUpdates);
        };
        window.trailing = window.active.then(follow, follow);
      }
      return window.trailing;
    }
    const work = (async () => {
      let changed = window.revision === null;
      if (window.revision === null || append) {
        if (window.revision === null || window.next !== null) {
          const page = await fetchPage(
            window.revision === null ? null : window.next,
          );
          if (this.window !== window) return null;
          changed ||= page.items.length > 0 || window.next !== page.next;
          for (const item of page.items) window.items.set(item.id, item);
          window.next = page.next;
          // Appending must not skip concurrent updates to already loaded cards.
          if (window.revision === null) window.revision = page.revision;
          if (page.next === null) window.through = 0;
          else if (page.items.length)
            window.through = page.items.at(-1)!.cursor;
        }
      } else {
        const changes = await fetchUpdates(window.revision, window.through);
        if (this.window !== window) return null;
        changed =
          changes.items.length > 0 ||
          changes.removed.some((id) => window.items.has(id));
        for (const id of changes.removed) window.items.delete(id);
        for (const item of changes.items) window.items.set(item.id, item);
        window.revision = changes.revision;
      }
      // Advance the watermark silently for no-op polls, avoiding downstream
      // refreshes of conversations, saved items and search results in App.
      if (!changed) return null;
      return {
        items: [...window.items.values()].sort((a, b) => b.cursor - a.cursor),
        next: window.next,
        revision: window.revision!,
      };
    })();
    window.active = work;
    const finish = () => {
      if (window.active === work) window.active = null;
    };
    void work.then(finish, finish);
    return work;
  }
}
