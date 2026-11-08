import { CardPager, type CardWindow } from "./card-pager";
import { contractCardReader } from "../shared/card-client";
import type { CardSelection } from "../shared/cards";

/** One source/owner/selection with a retained paging window. */
export class DoneCardsReader {
  readonly pager = new CardPager();
  hasMore = false;
  resetVersion = 0;
  discardPrior = false;
  private generation = 0;
  private activeAppends = 0;
  private pendingAppend = false;
  invalidateForAction() {
    this.generation++;
    this.pendingAppend ||= this.activeAppends > 0;
  }
  constructor(
    readonly key: string,
    saved?: CardWindow,
  ) {
    if (saved) this.pager.restore(key, saved);
  }
  async load(
    request: Parameters<typeof contractCardReader>[0],
    selection: CardSelection,
    append: boolean,
    allowResync = true,
  ): Promise<CardWindow> {
    const reader = contractCardReader(request);
    const generation = this.generation;
    const effectiveAppend = append || this.pendingAppend;
    if (effectiveAppend) this.activeAppends++;
    try {
      await this.pager.load(
        this.key,
        "done",
        effectiveAppend,
        async (before) => {
          const page = await reader.list({
            ...selection,
            before: before ?? undefined,
          });
          if (page.items.some((entry) => entry.card.type !== "done"))
            throw new Error("The source returned an invalid Done collection");
          return page;
        },
        async (after) => {
          const delta = await reader.changes({ ...selection, after });
          this.hasMore = delta.more;
          return delta;
        },
      );
      if (generation === this.generation && effectiveAppend)
        this.pendingAppend = false;
      const window = this.pager.snapshot();
      // A concurrent caller can finish against a window replaced by a 409
      // reset. Retry within the same contract before publishing a window.
      if (!window) {
        if (allowResync)
          return this.load(request, selection, effectiveAppend, false);
        throw new Error(
          "The Done collection changed while loading; retrying is required",
        );
      }
      return window;
    } catch (error) {
      if (generation !== this.generation) throw error;
      if ((error as { status?: number }).status === 409) {
        this.resetVersion++;
        this.discardPrior = true;
      }
      if (allowResync && (error as { status?: number }).status === 409)
        return this.load(request, selection, false, false);
      throw error;
    } finally {
      if (effectiveAppend) this.activeAppends--;
    }
  }
}
