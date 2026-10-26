import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationPullCard } from "../src/client/ConversationPulls";

it("shows PR reviews and GitHub totals, with earlier-commit reviews labelled", () => {
  const html = renderToStaticMarkup(<ConversationPullCard pull={{
    owner: "acme", repo: "api", number: 42, title: "Fix <script>oops</script>", state: "open",
    headSha: "new", review: "review_required", requested: ["@lee"],
    reviews: [{ author: "kim", state: "approved", headSha: "old" }],
    additions: 212, deletions: 9, changedFiles: 3, fetchedAt: 1000,
  }} onOpen={() => {}} />);
  expect(html).toContain("Review required");
  expect(html).toContain("@kim: Approved (earlier commit)");
  expect(html).toContain("@lee");
  expect(html).toContain("+212");
  expect(html).toContain("Open pull request");
  expect(html).toContain('href="https://github.com/acme/api/pull/42"');
  expect(html).not.toContain("<script>");
  expect(html).not.toMatch(/CI|checkout|branch|checks passed|No PR linked/);
});

it("retains a usable link when details cannot be refreshed", () => {
  const html = renderToStaticMarkup(<ConversationPullCard pull={{ owner: "acme", repo: "api", number: 42, error: "Refresh failed" }} />);
  expect(html).toContain("Refresh failed");
  expect(html).toContain('href="https://github.com/acme/api/pull/42"');
  expect(html).not.toContain("No reviews yet");
});
