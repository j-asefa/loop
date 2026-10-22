import { CardPager, type CardWindow } from "./card-pager";
import { cardReader } from "../shared/card-client";
import type { CardSelection } from "../shared/cards";

/** One source/owner/selection. Unsupported sources retain the legacy Done path. */
export class DoneCardsReader {
  readonly pager = new CardPager();
  hasMore = false;
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
    try {
      await this.pager.load(
        this.key,
        "done",
        append,
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
      return this.pager.snapshot();
    } catch (error) {
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
    }
  }
}
