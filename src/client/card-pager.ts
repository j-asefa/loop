import type {
  CardChanges,
  CardEntry,
  CardPage,
  CardView,
} from "../shared/cards";
import { compareCardOrder } from "../shared/cards";

type ReadPage = (before: string | null) => Promise<CardPage>;
type ReadChanges = (after: string, through?: number) => Promise<CardChanges>;
type Window = {
  items: Map<string, CardEntry>;
  next: string | null;
  revision: string | null;
  boundary: CardEntry["order"] | null;
  active: Promise<CardPage | null> | null;
  trailing: Promise<CardPage | null> | null;
  append: boolean;
};
const empty = (): Window => ({
  items: new Map(),
  next: null,
  revision: null,
  boundary: null,
  active: null,
  trailing: null,
  append: false,
});
export type CardWindow = {
  page: CardPage;
  boundary: CardEntry["order"] | null;
};
/** A bounded visible window. Keys include owner, source and selection. The full
 * archive synchronizer deliberately has different backfill behavior. */
export class CardPager {
  key = "";
  private window = empty();
  reset(key = "") {
    this.key = key;
    this.window = empty();
  }
  snapshot(): CardWindow | null {
    if (this.window.revision === null) return null;
    return {
      page: {
        items: [...this.window.items.values()].sort((a, b) =>
          compareCardOrder(b.order, a.order),
        ),
        next: this.window.next,
        revision: this.window.revision,
      },
      boundary: this.window.boundary,
    };
  }
  restore(key: string, saved: CardWindow) {
    this.reset(key);
    Object.assign(this.window, {
      items: new Map(saved.page.items.map((entry) => [entry.card.id, entry])),
      next: saved.page.next,
      revision: saved.page.revision,
      boundary: saved.boundary,
    });
  }
  load(
    key: string,
    view: CardView,
    append: boolean,
    page: ReadPage,
    changes: ReadChanges,
    recovery = false,
  ): Promise<CardPage | null> {
    if (key !== this.key) this.reset(key);
    const current = this.window;
    if (current.active) {
      current.append ||= append;
      if (!current.trailing) {
        const follow = () => {
          if (this.window !== current) return null;
          const append = current.append;
          current.append = false;
          current.trailing = null;
          return this.load(key, view, append, page, changes);
        };
        current.trailing = current.active.then(follow, follow);
      }
      return current.trailing;
    }
    const work = (async () => {
      const items = new Map(current.items);
      let { next, boundary, revision } = current;
      let changed = current.revision === null;
      if (revision === null || (append && next !== null)) {
        const result = await page(revision === null ? null : next);
        if (this.window !== current) return null;
        changed ||= result.items.length > 0 || result.next !== next;
        for (const entry of result.items) items.set(entry.card.id, entry);
        next = result.next;
        boundary =
          result.next === null ? null : result.items.at(-1)?.order || boundary;
        // Never skip edits that arrived during an older-page request.
        revision ??= result.revision;
      }
      // A single notification can represent many bounded pages. Drain it now;
      // a background timer is no longer responsible for finishing the window.
      for (let batch = 0; ; batch++) {
        const delta = await changes(revision!, view === "results" ? boundary?.[0] || 0 : undefined);
        if (this.window !== current) return null;
        for (const id of delta.removed) changed = items.delete(id) || changed;
        for (const entry of delta.items) {
        if (
          items.has(entry.card.id) ||
          !boundary ||
          compareCardOrder(entry.order, boundary) >= 0
        ) {
          changed =
            JSON.stringify(items.get(entry.card.id)) !==
              JSON.stringify(entry) || changed;
          items.set(entry.card.id, entry);
        }
        }
        if (delta.more && delta.revision === revision) throw new Error("Card updates did not advance");
        revision = delta.revision;
        if (!delta.more) break;
        if (batch >= 99) {
          this.reset(key);
          if (recovery) throw new Error("Cards changed too quickly. Refresh to load the latest view.");
          return this.load(key, view, false, page, changes, true);
        }
      }
      // Commit the page and its reconciliation together. A failed changes
      // request cannot silently advance pagination before the UI sees the page.
      Object.assign(current, {
        items,
        next,
        boundary,
        revision,
      });
      if (!changed) return null;
      return {
        items: [...items.values()].sort((a, b) =>
          compareCardOrder(b.order, a.order),
        ),
        next,
        revision: revision!,
      };
    })().catch((error) => {
      if (
        this.window === current &&
        (error as { status?: number }).status === 409
      )
        this.reset(key);
      throw error;
    });
    current.active = work;
    const finish = () => {
      if (current.active === work) current.active = null;
    };
    void work.then(finish, finish);
    return work;
  }
}
