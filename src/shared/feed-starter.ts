import type { FeedSourceFilter } from "./feed-interleave.js";
import { feedCatalog, type FeedEntry } from "./news.js";

/** Curated starter feeds drawn from Loop's checked-in feed catalog. */
export const STARTER_FEED_IDS = [
  "hackernews",
  "lobsters",
  "ars-technica",
] as const;

export function starterFeeds(): FeedEntry[] {
  const byId = new Map(feedCatalog.map((entry) => [entry.id, entry]));
  return STARTER_FEED_IDS.flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
}

export function starterDismissKey(owner: string, source: string): string {
  return `loop-feed-starter-dismissed:${owner}:${source}`;
}

export type FeedStarterVisibilityInput = {
  showSocialStream: boolean;
  effectiveStreamSource: FeedSourceFilter;
  doneFiltered: boolean;
  hasAgentRows: boolean;
  hasActiveWork: boolean;
  hasNeedsYou: boolean;
  socialLoaded: boolean;
  hasFollowedFeeds: boolean;
  hasSocialError: boolean;
  dismissed: boolean;
};

/**
 * Shows the opt-in starter card ONLY on a genuinely fresh, empty top-level Feed:
 * no agent rows, no historical/active work, no Needs you items, no followed feeds,
 * Social state loaded without error, no active filters, and not dismissed.
 */
export function shouldShowFeedStarter(
  input: FeedStarterVisibilityInput,
): boolean {
  return (
    input.showSocialStream &&
    input.effectiveStreamSource === "all" &&
    !input.doneFiltered &&
    !input.hasAgentRows &&
    !input.hasActiveWork &&
    !input.hasNeedsYou &&
    input.socialLoaded &&
    !input.hasFollowedFeeds &&
    !input.hasSocialError &&
    !input.dismissed
  );
}
