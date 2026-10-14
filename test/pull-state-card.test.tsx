import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PullStateChip } from "../src/client/PullState";
import type { PullState } from "../src/shared/pull-state";

const observed: PullState = {
  repo_owner: "acme",
  repo_name: "web",
  number: 42,
  watch: "watching",
  ended_reason: null,
  error: null,
  head_sha: "abcdef1234567890",
  ci: { sha: "abcdef1234567890", conclusion: "success" },
  pending: false,
  checked_at: 1_000_000,
};

it("omits the compact PR badge when no PR is linked", () => {
  expect(renderToStaticMarkup(<PullStateChip state={null} compact />)).toBe("");
});

it("keeps a linked PR visible and navigable before CI reports a result", () => {
  const html = renderToStaticMarkup(
    <PullStateChip state={{ ...observed, ci: null, pending: true }} onOpen={() => {}} compact />,
  );
  expect(html).toContain("<button");
  expect(html).toContain("<span>#42</span>");
  expect(html).not.toContain("CI passed");
});

const cases: { name: string; patch: Partial<PullState>; label: string; tone: string }[] = [
  { name: "current success", patch: {}, label: "CI passed", tone: "passed" },
  {
    name: "current failure",
    patch: { ci: { sha: observed.head_sha!, conclusion: "failure" } },
    label: "CI failed", tone: "failed",
  },
  { name: "new head", patch: { head_sha: "fedcba0987654321" }, label: "CI stale", tone: "pending" },
  { name: "same-head rerun", patch: { pending: true }, label: "CI rerun", tone: "pending" },
  { name: "unknown freshness", patch: { checked_at: null }, label: "CI unknown", tone: "pending" },
  { name: "unknown head", patch: { head_sha: null }, label: "CI unknown", tone: "pending" },
  { name: "paused watch", patch: { watch: "paused" }, label: "CI paused", tone: "pending" },
  { name: "failed refresh", patch: { error: "Read failed" }, label: "CI stale", tone: "pending" },
  { name: "merged PR", patch: { watch: "stopped", ended_reason: "merged" }, label: "merged", tone: "stopped" },
];

it.each(cases)("renders $name without overstating the recorded CI result", ({ patch, label, tone }) => {
  const html = renderToStaticMarkup(<PullStateChip state={{ ...observed, ...patch }} compact />);
  expect(html).toContain(`<span>#42 · ${label}</span>`);
  expect(html).toContain(`pull-state-${tone}`);
  expect(html).toContain("PR #42");
  expect(html).not.toContain("<button");
});

it("offers PR navigation only when its caller supplies an authorized destination", () => {
  const html = renderToStaticMarkup(
    <PullStateChip state={observed} onOpen={() => {}} compact />,
  );
  expect(html).toContain("<button");
  expect(html).toContain('aria-label="Pull request: CI passed · PR #42');
  expect(html).toContain("checks passed for abcdef1");
});
