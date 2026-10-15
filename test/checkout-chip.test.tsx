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

it.each(["main", "feature/long-descriptive-branch-name", "loop/agent-custom-branch", "loop/agent-abcd"])(
  "preserves the branch label %s",
  (branch) => {
    const html = renderToStaticMarkup(
      <CheckoutChip summary={{ ...summary, branch }} onOpen={() => {}} />,
    );
    expect(html).toContain(`${branch} · 1 commit ahead`);
  },
);
