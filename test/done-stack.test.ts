import { describe, expect, it } from "vitest";
import {
  highlightSnippet,
  resolveCarouselCardHeader,
  searchThreadCards,
  stackDoneCards,
  stepMatchIndex,
  type SearchableThreadCard,
} from "../src/shared/done-stack.js";

describe("done-stack", () => {
  it("stacks standalone Done cards by conversation with newest on top and preserves manual Saved Groups", () => {
    const stacked = stackDoneCards([
      {
        key: "c1-new",
        item: { id: "c1-new" },
        isManualGroup: false,
        conversationKey: ":conv-1",
        unread: true,
      },
      {
        key: "c2-only",
        item: { id: "c2-only" },
        isManualGroup: false,
        conversationKey: ":conv-2",
        unread: false,
      },
      {
        key: "c1-mid",
        item: { id: "c1-mid" },
        isManualGroup: false,
        conversationKey: ":conv-1",
        unread: true,
      },
      {
        key: "group-1",
        item: { id: "group-1" },
        isManualGroup: true,
        conversationKey: ":conv-1",
        unread: false,
      },
      {
        key: "c1-old",
        item: { id: "c1-old" },
        isManualGroup: false,
        conversationKey: ":conv-1",
        unread: false,
      },
    ]);

    expect(stacked).toHaveLength(3);
    expect(stacked[0]).toEqual({
      key: "c1-new",
      top: { id: "c1-new" },
      cards: [{ id: "c1-new" }, { id: "c1-mid" }, { id: "c1-old" }],
      unreadCount: 2,
      isManualGroup: false,
    });
    expect(stacked[1]).toEqual({
      key: "c2-only",
      top: { id: "c2-only" },
      cards: [{ id: "c2-only" }],
      unreadCount: 0,
      isManualGroup: false,
    });
    expect(stacked[2]).toEqual({
      key: "group-1",
      top: { id: "group-1" },
      cards: [{ id: "group-1" }],
      unreadCount: 0,
      isManualGroup: true,
    });
  });

  it("searches discrete cards across title, prompt, and body with highlighted snippets in carousel order", () => {
    const cards: SearchableThreadCard[] = [
      {
        id: "card-0",
        title: "EU hosting pick",
        body: "Option B uses Hetzner + Bunny CDN for about €38/month.",
        createdAt: 3000,
        saved: false,
        unread: true,
      },
      {
        id: "card-1",
        title: "Mobile scroll audit",
        body: "CSS scroll-snap keeps swiping smooth at 60fps.",
        createdAt: 2000,
        saved: false,
        unread: false,
      },
      {
        id: "card-2",
        title: "Three-region breakdown",
        prompt: "Compare Hetzner against Fly.io",
        body: "Hetzner EU nodes cut monthly spend by 35% with lower EU latency.",
        createdAt: 1000,
        saved: true,
        unread: false,
      },
    ];

    const hits = searchThreadCards(cards, "hetzner eu");
    expect(hits.map((h) => [h.cardId, h.index])).toEqual([
      ["card-0", 0],
      ["card-2", 2],
    ]);
    expect(hits[0].snippet.some((seg) => seg.hit)).toBe(true);
    expect(hits[1].saved).toBe(true);

    expect(stepMatchIndex(hits, 0, "next")).toBe(2);
    expect(stepMatchIndex(hits, 2, "next")).toBe(0);
    expect(stepMatchIndex(hits, 0, "prev")).toBe(2);
    expect(stepMatchIndex(hits, 1, "next")).toBe(2);
    expect(stepMatchIndex(hits, 1, "prev")).toBe(0);
  });

  it("centers snippet excerpts around late matches without leaking raw HTML", () => {
    const long =
      "Intro paragraph ".repeat(12) +
      "Critical finding: <script>alert(1)</script> Hetzner Falkenstein keeps EU data local.";
    const segments = highlightSnippet(long, ["hetzner"]);
    const joined = segments.map((s) => s.text).join("");
    expect(joined.startsWith("…")).toBe(true);
    expect(
      segments.some((s) => s.hit && s.text.toLowerCase() === "hetzner"),
    ).toBe(true);
  });

  it("resolves short titles, long single-line prompts, and promoted Markdown headings cleanly", () => {
    expect(
      resolveCarouselCardHeader({
        prompt: "Compare Hetzner vs Fly.io",
        body: "### Hosting comparison\n\nDetails...",
        fallback: "Fallback",
      }),
    ).toEqual({
      title: "Compare Hetzner vs Fly.io",
      compactTitle: false,
      promptQuote: undefined,
      titleSource: "prompt",
    });

    const multiLinePrompt =
      "Audit mobile feed latency and card ergonomics on a 390px phone screen.\nFocus on keeping tool traces out of feed cards and avoiding clipped titles.";
    expect(
      resolveCarouselCardHeader({
        prompt: multiLinePrompt,
        body: "### Mobile reading ergonomics\n\nTwo changes made the biggest difference.",
        fallback: "Fallback",
      }),
    ).toEqual({
      title: "Mobile reading ergonomics",
      compactTitle: false,
      promptQuote: multiLinePrompt,
      titleSource: "heading",
    });

    const longSingleLine =
      "Can you break down EU data residency guarantees, Frankfurt vs Falkenstein latency, egress pricing at 2 TB/month, and how Hetzner + Bunny CDN compares against Fly.io?";
    expect(
      resolveCarouselCardHeader({
        prompt: longSingleLine,
        body: "EU data residency stays cleanly in Frankfurt with Hetzner + Bunny CDN.",
        fallback: "Fallback",
      }),
    ).toEqual({
      title: longSingleLine,
      compactTitle: true,
      promptQuote: undefined,
      titleSource: "prompt",
    });
  });
});
