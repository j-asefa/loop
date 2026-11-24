import { describe, expect, it } from "vitest";
import {
  shouldShowFeedStarter,
  STARTER_FEED_IDS,
  starterDismissKey,
  starterFeeds,
  type FeedStarterVisibilityInput,
} from "../src/shared/feed-starter.js";

const emptyFreshFeed: FeedStarterVisibilityInput = {
  showSocialStream: true,
  effectiveStreamSource: "all",
  doneFiltered: false,
  hasAgentRows: false,
  hasActiveWork: false,
  hasNeedsYou: false,
  socialLoaded: true,
  hasFollowedFeeds: false,
  hasSocialError: false,
  dismissed: false,
};

describe("feed-starter", () => {
  it("resolves every curated starter feed from feedCatalog", () => {
    const feeds = starterFeeds();
    expect(feeds.map((feed) => feed.id)).toEqual([...STARTER_FEED_IDS]);
    expect(feeds.length).toBeGreaterThanOrEqual(3);
  });

  it("shows starter card only on a genuinely fresh empty Feed", () => {
    expect(shouldShowFeedStarter(emptyFreshFeed)).toBe(true);
  });

  it("hides starter card when any existing work, feeds, filters, errors, or dismissal exist", () => {
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, showSocialStream: false }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({
        ...emptyFreshFeed,
        effectiveStreamSource: "agents",
      }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({
        ...emptyFreshFeed,
        effectiveStreamSource: "feeds",
      }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, doneFiltered: true }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, hasAgentRows: true }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, hasActiveWork: true }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, hasNeedsYou: true }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, socialLoaded: false }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, hasFollowedFeeds: true }),
    ).toBe(false);
    expect(
      shouldShowFeedStarter({ ...emptyFreshFeed, hasSocialError: true }),
    ).toBe(false);
    expect(shouldShowFeedStarter({ ...emptyFreshFeed, dismissed: true })).toBe(
      false,
    );
  });

  it("scopes dismissal storage keys by owner and source", () => {
    expect(starterDismissKey("owner-a", "")).not.toBe(
      starterDismissKey("owner-b", ""),
    );
    expect(starterDismissKey("owner-a", "")).not.toBe(
      starterDismissKey("owner-a", "peer:1"),
    );
  });
});
