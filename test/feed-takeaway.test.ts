import { describe, expect, it } from "vitest";
import { feedTakeaway } from "../src/client/feedTakeaway";

describe("feedTakeaway", () => {
  it("returns the opening paragraph of an answer that continues", () => {
    expect(
      feedTakeaway(
        "The build fails because the lockfile is stale.\r\n\r\n## Details\n\nMore text.",
      ),
    ).toBe("The build fails because the lockfile is stale.");
    expect(feedTakeaway("First line\nsecond line of the lead.\n\nRest.")).toBe(
      "First line\nsecond line of the lead.",
    );
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
    ])
      expect(feedTakeaway(`${opening}\n\nMore.`)).toBeNull();
    expect(feedTakeaway(`${"word ".repeat(100)}\n\nMore.`)).toBeNull();
  });
});
