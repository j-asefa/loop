import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectStatusCard } from "../src/client/ProjectStatus";
import type { ProjectStatus } from "../src/shared/project-status";
afterEach(() => vi.unstubAllGlobals());
function render(
  overrides: Partial<ProjectStatus> = {},
  fresh = true,
  agents: { id: string; name: string }[] = [],
) {
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
      agents={agents}
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
  expect(html).toContain("2 waiting for you");
  expect(html).not.toContain("status-live");
  expect(html).not.toContain("No agents working");
});

it("keeps identifiers and payloads out of all card text while retaining navigation targets", () => {
  const agent = "3dd35f59-14de-44cb-9914-d991edfc28ce";
  const project = "2c20ef58-0ba2-4ef6-b87c-a74e724432f5";
  const payload = "YWJj".repeat(100);
  const html = render(
    {
      id: project,
      evidence: {
        run_id: project,
        conversation: project,
        agent,
        task: `Review ${payload} with @${agent}`,
        checkout: null,
        checkout_at: null,
        verification: null,
        verification_at: null,
        telemetry: "unavailable",
      },
      brief: {
        state: "ready",
        headline: `@${agent} is reviewing thread ${project}`,
        synthesized_at: 1000,
        pending: 0,
        unfinished: 1,
        questions: 1,
        blockers: 1,
        highlights: {
          updated_at: 1000,
          progress: [{ id: project, text: `Review by ${agent} is ready.` }],
          task: {
            id: project,
            text: `Review snapshot ${project}`,
            next: `Ask @${agent}`,
            blocker: `Waiting on ${payload}`,
          },
          question: { id: project, text: `Should @${agent} proceed?` },
        },
      },
    },
    true,
    [{ id: agent, name: "forest" }],
  );
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("@forest is reviewing the conversation");
  expect(text).toContain("Latest task · @forest");
  expect(text).not.toContain("@@forest");
  for (const token of [project, agent, payload])
    expect(text).not.toContain(token);
  expect(html).toContain(`projectView=${project}`);
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
  expect(html).toContain("No blocker information");
  expect(html).toContain("source=docker%3Aone");
});
it("hides empty compact chips but distinguishes uncaptured and unavailable observations", () => {
  let html = render();
  expect(html).toContain("No task details or pull requests recorded");
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
  expect(html).toContain("File changes not recorded");
  expect(html).toContain("Check results unavailable");
  expect(html).not.toContain("No checks recorded");
  expect(
    render({ evidence: { ...evidence, telemetry: "observed" } }),
  ).toContain("No checks recorded");
});

it("shows useful brief context before the collapsed technical details", () => {
  const html = render({
    brief: {
      state: "ready",
      headline: "Tabs need a repair",
      synthesized_at: 1000,
      pending: 0,
      unfinished: 145,
      questions: 97,
      blockers: 141,
      highlights: {
        updated_at: 2000,
        progress: [{ id: "s", text: "The tab reset is confirmed." }],
        task: {
          id: "t",
          text: "Fix tab persistence",
          next: "Save the selection and test reloads.",
          blocker: "Selection is lost on reload.",
        },
        question: { id: "q", text: "Should filters also be remembered?" },
      },
    },
  });
  const visible = html.slice(0, html.indexOf("<details"));
  for (const text of [
    "Where things stand",
    "The tab reset is confirmed.",
    "Next up",
    "Fix tab persistence",
    "Blocked by",
    "Selection is lost on reload.",
    "Save the selection and test reloads.",
    "Should filters also be remembered?",
  ])
    expect(visible).toContain(text);
  expect(visible).not.toContain("141 recorded");
  expect(render()).not.toContain('aria-label="Brief summary"');
});
