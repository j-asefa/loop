export type ResultsPage<T> = {
  items: T[];
  next: number | null;
  revision: number;
};
export type ResultsUpdates<T> = {
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
  active: Promise<ResultsPage<T> | null> | null;
  trailing: Promise<ResultsPage<T> | null> | null;
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
export class ResultsPager<T extends Card> {
  key = "";
  private window = empty<T>();

  load(
    key: string,
    append: boolean,
    fetchPage: (before: number | null) => Promise<ResultsPage<T>>,
    fetchUpdates: (
      after: number,
      through: number,
    ) => Promise<ResultsUpdates<T>>,
    recovery = false,
  ): Promise<ResultsPage<T> | null> {
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
        const items = new Map(window.items);
        let revision = window.revision;
        for (let page = 0; ; page++) {
          const changes = await fetchUpdates(revision, window.through);
          if (this.window !== window) return null;
          changed ||=
            changes.items.length > 0 ||
            changes.removed.some((id) => items.has(id));
          for (const id of changes.removed) items.delete(id);
          for (const item of changes.items) items.set(item.id, item);
          if (changes.more && changes.revision <= revision)
            throw new Error("Results updates did not advance");
          revision = changes.revision;
          if (!changes.more) break;
          if (page >= 99) {
            this.window = empty<T>();
            if (recovery)
              throw new Error(
                "Results changed too quickly. Refresh to load the latest view.",
              );
            return this.load(key, false, fetchPage, fetchUpdates, true);
          }
        }
        window.items = items;
        window.revision = revision;
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
