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
  private activeReads = new Map<AbortController, boolean>();
  private pendingAppend = false;
  private refreshHeadFirst = false;
  get hasPendingAppend() {
    return this.pendingAppend;
  }
  invalidateForAction() {
    this.generation++;
    this.pendingAppend ||= [...this.activeReads.values()].some(Boolean);
  }
  restartRefresh() {
    this.invalidateForAction();
    this.refreshHeadFirst = true;
    for (const controller of this.activeReads.keys()) controller.abort();
    this.activeReads.clear();
    const saved = this.pager.snapshot();
    // Detach stalled reads from the committed window. Their late responses
    // cannot replace the new pager window or block an explicit refresh.
    if (saved) this.pager.restore(this.key, saved);
    else this.pager.reset(this.key);
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
    const controller = new AbortController();
    const reader = contractCardReader((contract, input) =>
      request(contract, input, controller.signal),
    );
    const generation = this.generation;
    const headFirst = this.refreshHeadFirst;
    if (headFirst && append) this.pendingAppend = true;
    const effectiveAppend = !headFirst && (append || this.pendingAppend);
    this.activeReads.set(controller, effectiveAppend);
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
          if (controller.signal.aborted)
            throw new DOMException("Obsolete Done read", "AbortError");
          this.hasMore = delta.more;
          return delta;
        },
      );
      if (generation === this.generation && effectiveAppend)
        this.pendingAppend = false;
      if (generation === this.generation && headFirst)
        this.refreshHeadFirst = false;
      const window = this.pager.snapshot();
      // A concurrent caller can finish against a window replaced by a 409
      // reset. Retry within the same contract before publishing a window.
      if (!window) {
        if (generation !== this.generation || controller.signal.aborted)
          throw new DOMException("Obsolete Done read", "AbortError");
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
      this.activeReads.delete(controller);
    }
  }
}
