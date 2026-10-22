import { CardPager, type CardWindow } from "./card-pager";
import { cardReader } from "../shared/card-client";
import type { CardSelection } from "../shared/cards";

/** One source/owner/selection. Unsupported sources retain the legacy Done path. */
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
  private supported: boolean | null = null;
  constructor(
    readonly key: string,
    saved?: CardWindow,
  ) {
    if (saved) {
      this.pager.restore(key, saved);
      this.supported = true;
    }
  }
  private isUnsupported() {
    return this.supported === false;
  }
  async load(
    request: (path: string) => Promise<unknown>,
    selection: CardSelection,
    append: boolean,
    allowResync = true,
  ): Promise<CardWindow | null> {
    if (this.supported === false) {
      // Re-probe on refresh: a paired source can upgrade without a page reload.
      this.supported = null;
      this.pager.reset(this.key);
    }
    const reader = cardReader(request);
    const generation = this.generation;
    const effectiveAppend = append || this.pendingAppend;
    if (effectiveAppend) this.activeAppends++;
    try {
      await this.pager.load(
        this.key,
        "done",
        effectiveAppend,
        async (before) => {
          try {
            const page = await reader.list({
              ...selection,
              before: before ?? undefined,
            });
            if (page.items.some((entry) => entry.card.type !== "done"))
              throw new Error("The source returned an invalid Done collection");
            this.supported = true;
            return page;
          } catch (error) {
            // Only a first-page capability probe may use the old contract.
            // A failed cursor, expired session or outage must retain its window.
            if (
              this.supported === null &&
              before === null &&
              [400, 404].includes((error as { status?: number }).status ?? 0)
            )
              this.supported = false;
            throw error;
          }
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
      // reset. Only an explicit unsupported probe may return null to Feed.
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
      if (this.isUnsupported()) return null;
      if ([400, 404].includes((error as { status?: number }).status ?? 0)) {
        // A cursor failure alone is not a capability failure. Confirm against
        // a fresh list before changing contracts after a source replacement.
        try {
          await reader.list(selection);
        } catch (probe) {
          if ([400, 404].includes((probe as { status?: number }).status ?? 0)) {
            this.supported = false;
            this.pager.reset(this.key);
            return null;
          }
        }
      }
      throw error;
    } finally {
      if (effectiveAppend) this.activeAppends--;
    }
  }
}
