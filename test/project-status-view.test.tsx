import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectStatusCard } from "../src/client/ProjectStatus";
import type { ProjectStatus } from "../src/shared/project-status";
afterEach(() => vi.unstubAllGlobals());
function render(overrides: Partial<ProjectStatus> = {}, fresh = true) {
  vi.stubGlobal("location", new URL("https://loop.test/"));
  const item: ProjectStatus = {
    id: "project",
    name: "Loop",
    status: "idle",
    last_activity_at: 1000,
    older: false,
    counts: { needs: 0, working: 0, queued: 0 },
    actions: [],
    evidence: null,
    pulls: [],
    brief: {
      state: "never",
      headline: null,
      synthesized_at: null,
      pending: 0,
      unfinished: null,
      questions: null,
      blockers: null,
    },
    ...overrides,
  };
  return renderToStaticMarkup(
    <ProjectStatusCard
      item={item}
      fresh={fresh}
      observedAt={1000}
      sourceId="docker:one"
      busy={false}
      onAction={() => {}}
      onEvidence={() => {}}
      onPulls={() => {}}
    />,
  );
}
it("labels last-seen counts instead of claiming live zeroes after a failed source refresh", () => {
  const html = render(
    { status: "needs_you", counts: { needs: 2, working: 1, queued: 3 } },
    false,
  );
  expect(html).toContain("Last seen");
  expect(html).toContain("2 needs you");
  expect(html).not.toContain("status-live");
  expect(html).not.toContain("No active work");
});
it("keeps missing brief counts unknown and waiting approval ahead of enable", () => {
  const html = render({
    status: "needs_you",
    counts: { needs: 1, working: 0, queued: 0 },
    actions: [
      {
        key: "approval:a",
        kind: "approve",
        ref: "a",
        conversation: "c",
        message: null,
        at: 1,
      },
    ],
  });
  expect(html).toContain("Approve request");
  expect(html).toContain("Enable brief");
  expect(html.indexOf("Approve request")).toBeLessThan(
    html.indexOf("Enable brief"),
  );
  expect(html).not.toContain("0 unfinished");
  expect(html).toContain("Blockers not recorded");
  expect(html).toContain("source=docker%3Aone");
});
it("hides empty compact chips but distinguishes uncaptured and unavailable observations", () => {
  let html = render();
  expect(html).toContain("No captured run or linked PR");
  expect(html).not.toContain("changes-chip");
  const evidence: NonNullable<ProjectStatus["evidence"]> = {
    run_id: "run",
    conversation: "c",
    agent: "venus",
    task: "Fix reconnect",
    checkout: null,
    checkout_at: null,
    verification: null,
    verification_at: 1000,
    telemetry: "unavailable",
  };
  html = render({ evidence });
  expect(html).toContain("Checkout not captured");
  expect(html).toContain("Verification telemetry unavailable");
  expect(html).not.toContain("No checks observed");
  expect(
    render({ evidence: { ...evidence, telemetry: "observed" } }),
  ).toContain("No checks observed");
});
