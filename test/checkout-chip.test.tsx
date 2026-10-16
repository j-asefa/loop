import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CheckoutChip } from "../src/client/Checkout";
import type { CheckoutSummary } from "../src/shared/checkout";

const summary: CheckoutSummary = {
  id: "checkout-1",
  state: "captured",
  branch: "loop/agent-aaa95995d3c7ac663708fc2a33faabf46433f0de58e0b4161ec60cbd6e7f0246",
  base_ref: "main",
  ahead: 1,
  behind: 0,
  files: 5,
  additions: 99,
  deletions: 17,
  untracked: 0,
  remote: "contains",
  started_dirty: false,
  overlap: 0,
  late: false,
  error: null,
};

it("shows four agent ID characters in the checkout chip", () => {
  const html = renderToStaticMarkup(<CheckoutChip summary={summary} onOpen={() => {}} />);
  expect(html).toContain("loop/agent-aaa9 · 1 commit ahead · 5 files +99 −17 · on remote");
  expect(html).not.toContain(summary.branch);
});

it("does not present a historical cumulative diff as this run's edits", () => {
  const html = renderToStaticMarkup(<CheckoutChip summary={{ ...summary, additions: 40472, deletions: 3059 }} onOpen={() => {}} compact />);
  expect(html).toContain("Earlier checkout");
  expect(html).toContain("changes during this run were not captured");
  expect(html).not.toContain("40.5K");
  expect(html).not.toContain("diff-add-count");
});

it("shows the run-scoped counts on feed cards", () => {
  const html = renderToStaticMarkup(<CheckoutChip summary={{ ...summary, scope: "run" }} onOpen={() => {}} compact />);
  expect(html).toContain("+99");
  expect(html).toContain("−17");
  expect(html).not.toContain("Earlier checkout");
});

it.each(["main", "feature/long-descriptive-branch-name", "loop/agent-custom-branch", "loop/agent-abcd"])(
  "preserves the branch label %s",
  (branch) => {
    const html = renderToStaticMarkup(
      <CheckoutChip summary={{ ...summary, branch }} onOpen={() => {}} />,
    );
    expect(html).toContain(`${branch} · 1 commit ahead`);
  },
);
