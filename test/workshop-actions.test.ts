import { describe, expect, it } from "vitest";
import {
  buildStreamActionPrompt,
  canReplyFromDoneSheet,
  DEFAULT_DONE_QUICK_REPLIES,
  DEFAULT_STREAM_ACTIONS,
  snippetLabel,
  snippetTitle,
} from "../src/shared/workshop-actions.js";
import {
  socialStoryToStreamItem,
  type StreamItem,
} from "../src/shared/stream-item.js";
import type { FeedEntry, SocialStory } from "../src/shared/news.js";

const feed: FeedEntry = {
  id: "hackernews",
  name: "Hacker News",
  category: "Tech news",
  description: "HN",
  home: "news.ycombinator.com",
  url: "https://news.ycombinator.com/rss",
  color: "#ff6600",
  kind: "story",
  mark: "hn",
};

const story: SocialStory = {
  id: "hackernews:42",
  title: "Designing Resilient Queues",
  url: "https://example.com/queues",
  site: "example.com",
  comments_url: "https://news.ycombinator.com/item?id=42",
  published_at: 1_700_000_000_000,
  community: null,
  author: "bob",
  points: 120,
  comments: 45,
  summary: "Idempotency keys prevent double execution.",
  image: null,
  media: null,
  feed: "hackernews",
  first_seen_at: 1_700_000_000_000,
  read: false,
};

describe("workshop-actions", () => {
  it("builds attribution-preserving prompts for RSS and Email StreamItems", () => {
    const rss = socialStoryToStreamItem(story, feed);
    const prompt = buildStreamActionPrompt(
      rss,
      DEFAULT_STREAM_ACTIONS[0].instruction,
    );
    expect(prompt).toContain(
      "About this Hacker News story: Designing Resilient Queues",
    );
    expect(prompt).toContain("https://example.com/queues");
    expect(prompt).toContain(
      "Discussion: https://news.ycombinator.com/item?id=42",
    );
    expect(prompt).toContain(
      "Excerpt: Idempotency keys prevent double execution.",
    );
    expect(prompt).toContain(DEFAULT_STREAM_ACTIONS[0].instruction);

    const email: StreamItem = {
      ...rss,
      id: "email:e1",
      rawId: "e1",
      kind: "email",
      sourceLabel: "Alex",
      agentPromptContext: {
        kind: "email",
        sourceLabel: "Alex",
        itemKindLabel: "email",
        title: "Launch checklist",
        url: "javascript:evil()",
        discussionUrl: null,
        excerpt: "Please review items 1-3 before Friday.",
      },
    };
    const emailPrompt = buildStreamActionPrompt(email, "Draft a brief reply.");
    expect(emailPrompt).toContain(
      "About this email from Alex: Launch checklist",
    );
    expect(emailPrompt).not.toContain("javascript:");
    expect(emailPrompt).toContain(
      "Excerpt: Please review items 1-3 before Friday.",
    );
    expect(emailPrompt).toContain("Draft a brief reply.");
  });

  it("bounds oversized excerpts cleanly", () => {
    const rss = socialStoryToStreamItem(
      { ...story, summary: "a".repeat(2500) },
      feed,
    );
    const prompt = buildStreamActionPrompt(rss, "Summarize.");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(1600);
  });

  it("falls back to default ask prompt when instruction is blank", () => {
    const rss = socialStoryToStreamItem(story, feed);
    const prompt = buildStreamActionPrompt(rss, "   ");
    expect(prompt.endsWith("\n\n")).toBe(true);
  });

  it("formats snippet titles and labels cleanly", () => {
    expect(snippetTitle("  Check   edge\ncases  ")).toBe(
      "Snippet: Check edge cases",
    );
    expect(snippetTitle("x".repeat(80)).length).toBeLessThanOrEqual(
      "Snippet: ".length + 60,
    );
    expect(snippetLabel("Snippet: Steelman", "body")).toBe("Steelman");
    expect(snippetLabel("", "Short body")).toBe("Short body");
    expect(DEFAULT_DONE_QUICK_REPLIES.length).toBeGreaterThanOrEqual(3);
  });

  it("only enables Done reading sheet ReplyButton on finished non-writing answers", () => {
    expect(
      canReplyFromDoneSheet({
        isFinished: true,
        writing: false,
        hasReplyHandler: true,
      }),
    ).toBe(true);
    expect(
      canReplyFromDoneSheet({
        isFinished: true,
        writing: true,
        hasReplyHandler: true,
      }),
    ).toBe(false);
    expect(
      canReplyFromDoneSheet({
        isFinished: false,
        writing: false,
        hasReplyHandler: true,
      }),
    ).toBe(false);
    expect(
      canReplyFromDoneSheet({
        isFinished: true,
        writing: false,
        hasReplyHandler: false,
      }),
    ).toBe(false);
    expect(
      canReplyFromDoneSheet({
        isFinished: true,
        writing: false,
        hasReplyHandler: true,
        isAssistant: false,
      }),
    ).toBe(false);
  });
});
