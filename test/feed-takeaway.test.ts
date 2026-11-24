import { describe, expect, it } from "vitest";
import { cardTakeaway, feedTakeaway } from "../src/client/feedTakeaway";

describe("feedTakeaway", () => {
  it("returns the opening paragraph of an answer that continues in prose", () => {
    expect(
      feedTakeaway(
        "The build fails because the lockfile is stale.\r\n\r\nRegenerating it fixes the install.",
      ),
    ).toBe("The build fails because the lockfile is stale.");
    expect(
      feedTakeaway("First line\nsecond line of the lead.\n\nRest of it."),
    ).toBe("First line\nsecond line of the lead.");
  });

  it("keeps the ordinary preview for short, structured or long openings", () => {
    expect(feedTakeaway("Just one paragraph.")).toBeNull();
    for (const opening of [
      "## Summary",
      "- first point",
      "1. step",
      "> quoted",
      "| a | b |",
      "```spec",
      "<details>",
      "![chart](x.png)",
      "---",
      "$$x^2$$",
      "::: note",
      "[ref]: https://example.com",
      "    indented code",
      "a | b\n--|--",
    ])
      expect(feedTakeaway(`${opening}\n\nMore.`)).toBeNull();
    expect(feedTakeaway(`${"word ".repeat(50)}\n\nMore.`)).toBeNull();
  });

  it("does not show a lead-in without what it introduces", () => {
    expect(feedTakeaway("Here is the plan:\n\nStep one.")).toBeNull();
    expect(feedTakeaway("Working through it…\n\nDone.")).toBeNull();
    for (const next of ["```spec\n{}\n```", "- a", "## Plan", "| a |"])
      expect(feedTakeaway(`I found two approaches.\n\n${next}`)).toBeNull();
  });
});

describe("cardTakeaway", () => {
  const answer = {
    last_message: {
      role: "assistant",
      content: "The fix is in.\n\nDetails follow here.",
    },
    run: { state: "completed" },
  };

  it("shows a finished assistant answer's takeaway on a reading card", () => {
    expect(cardTakeaway(answer, true)).toBe("The fix is in.");
    expect(cardTakeaway({ ...answer, run: null }, true)).toBe("The fix is in.");
  });

  it("never shortens replies, questions, unfinished work or other cards", () => {
    expect(cardTakeaway(answer, false)).toBeNull();
    expect(
      cardTakeaway(
        {
          ...answer,
          reply: { id: "r" },
          last_message: {
            role: "assistant",
            content: "I found two approaches.\n\nWhich should I use, A or B?",
          },
        },
        true,
      ),
    ).toBeNull();
    for (const state of ["queued", "running", "awaiting_approval"])
      expect(cardTakeaway({ ...answer, run: { state } }, true)).toBeNull();
    expect(cardTakeaway({ ...answer, card: {} }, true)).toBeNull();
    expect(
      cardTakeaway({ ...answer, live_preview: "Writing" }, true),
    ).toBeNull();
    expect(
      cardTakeaway(
        { ...answer, last_message: { ...answer.last_message, role: "user" } },
        true,
      ),
    ).toBeNull();
  });
});
