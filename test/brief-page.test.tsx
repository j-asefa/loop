import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProjectBriefView } from "../src/client/ProjectBrief";
import { BriefItemCard } from "../src/client/ProjectBriefView";
import { BriefAcknowledgements, briefSourceUrl } from "../src/client/briefView";
import type { BriefPage, Item } from "../src/shared/briefs";

function fixture(): BriefPage {
  const item: Item = {
    id: "dec_1",
    kind: "decision",
    text: "Use SQLite",
    why: "Durable local state",
    status: "active",
    cite: [{ ref: "res_1", quote: "SQLite" }],
    cite_stale: true,
    pinned: true,
    author: "owner",
    evidence: "owner_saved",
    decided_by: "you",
    first_version: 1,
    last_version: 2,
  };
  return {
    format: "loop.brief/v1",
    project: "project",
    version: 2,
    acknowledged_version: 1,
    basis: {
      since: 1,
      through: 44,
      pending: 3,
      synth_at: 1000,
      unincorporated_before: 1,
      window: "Recorded work as of today",
    },
    status: "needs_you",
    goal: { text: "Ship the release" },
    headline: { text: "Storage is ready for review", cite: [{ ref: "res_1" }] },
    state: [],
    decisions: Array.from({ length: 20 }, (_, n) => ({
      ...item,
      id: "dec_" + n,
    })),
    open_questions: [],
    unfinished: [],
    needs_you: [{ kind: "approval", ref: "approval", conversation: "thread" }],
    artifacts: [],
    changes: [
      {
        op: "changed",
        field: "decisions",
        id: "dec_0",
        since_version: 2,
        pinned: true,
      },
    ],
    overflow: { state: 0, decisions: 1, open_questions: 0, unfinished: 0 },
    pins: ["dec_0"],
    settings: {
      enabled: true,
      connectionId: "connection",
      model: "fixture-model",
      lastError: null,
    },
    sources: {
      res_1: {
        ref: "res_1",
        title: "Storage discussion",
        conversation: "thread",
        message: "answer",
        artifact: "1",
        at: 1,
        excerpt: "Use SQLite",
      },
    },
    attention: {
      approval: { conversation: "thread", message: "approval-answer" },
    },
    coverage: { results: 40, threads: 3, model: "fixture-model" },
  };
}
const actions = {
  onNavigate: vi.fn(),
  onItem: vi.fn(),
  onAll: vi.fn(),
  onGoal: vi.fn(),
  onSettings: vi.fn(),
  onHistory: vi.fn(),
  onDecision: vi.fn(),
};
it("counts the current record including overflow without rendering every category", () => {
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={fixture()} {...actions} />,
  );
  expect(html).toContain("Decisions<span>21</span>");
  expect(html).toContain("No current state recorded.");
  expect(html).toContain("View full state record");
  expect(html).not.toContain("Use SQLite");
  expect(html).toContain("Goal · you");
  expect(html).toContain("40 results · 3 threads");
  expect(html).toContain("3 newer events are waiting to be incorporated.");
  expect(html).not.toContain("Updating…");
  expect(html).toContain(
    "Older project history has not been fully incorporated.",
  );
});
it("keeps pin, evidence and change markers on the actual item", () => {
  const brief = fixture();
  const html = renderToStaticMarkup(
    <BriefItemCard
      item={brief.decisions[0]}
      sources={brief.sources}
      workspace=""
      author={(id) => id}
      onNavigate={actions.onNavigate}
      onItem={actions.onItem}
      changed
    />,
  );
  expect(html).toContain("Source changed");
  expect(html).toContain("Pinned");
  expect(html).toContain('class="brief-new">Updated');
  expect(html).toContain("Decided by you");
});
it("uses existing conversation/message anchors for citations and pending approvals", () => {
  const html = renderToStaticMarkup(
    <ProjectBriefView
      brief={fixture()}
      workspace="docker:fixture"
      {...actions}
    />,
  );
  expect(html).toContain(
    "source=docker%3Afixture&amp;conversation=thread&amp;message=answer",
  );
  expect(html).toContain(
    "source=docker%3Afixture&amp;conversation=thread&amp;message=approval-answer",
  );
  expect(
    briefSourceUrl(
      { conversation: null, message: null, artifact: "file" },
      "docker:fixture",
    ),
  ).toBe("/?source=docker%3Afixture&artifact=file");
  expect(
    briefSourceUrl({ conversation: null, message: null, artifact: null }),
  ).toBeNull();
});
it("renders superseded wording struck through and missing sources without broken links", () => {
  const brief = fixture();
  brief.decisions[0].status = "superseded";
  brief.sources = {};
  const html = renderToStaticMarkup(
    <BriefItemCard
      item={brief.decisions[0]}
      sources={brief.sources}
      workspace=""
      author={(id) => id}
      onNavigate={actions.onNavigate}
      onItem={actions.onItem}
    />,
  );
  expect(html).toContain('class="brief-superseded"');
  expect(html).toContain("Source unavailable");
  expect(html).not.toContain("message=answer");
});

it("keeps every attention destination and distinguishes pending inputs from running work", () => {
  const brief = fixture();
  brief.needs_you.push({
    kind: "question",
    ref: "question",
    conversation: "second-thread",
  });
  brief.attention.question = {
    conversation: "second-thread",
    message: "original-question",
  };
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={brief} workspace="docker:fixture" {...actions} />,
  );
  expect(html).toContain("2 requests");
  expect(html).toContain("1 more request");
  expect(html).toContain(
    "source=docker%3Afixture&amp;conversation=second-thread&amp;message=original-question",
  );
  expect(html).toContain("Review approval");
  expect(html).toContain("Answer question");
});
it("posts acknowledgement once per rendered version even across overlapping refreshes", async () => {
  const ack = new BriefAcknowledgements(),
    send = vi.fn(async (_version: number) => ({}));
  await Promise.all([ack.acknowledge(2, 1, send), ack.acknowledge(2, 1, send)]);
  await ack.acknowledge(2, 1, send);
  await ack.acknowledge(3, 2, send);
  await ack.acknowledge(4, 4, send);
  expect(send.mock.calls).toEqual([[2], [3]]);
});
it("allows an acknowledgement to retry after a failed request", async () => {
  const ack = new BriefAcknowledgements(),
    send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({});
  await expect(ack.acknowledge(2, 1, send)).rejects.toThrow("offline");
  await ack.acknowledge(2, 1, send);
  await ack.acknowledge(2, 1, send);
  expect(send).toHaveBeenCalledTimes(2);
});

it("links failed sends without a thread to the workspace's Scheduled item", () => {
  const brief = fixture();
  brief.needs_you = [
    { kind: "not_sent", ref: "scheduled-id", conversation: "" },
  ];
  brief.attention = {};
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={brief} workspace="docker:fixture" {...actions} />,
  );
  expect(html).toContain(
    "page=profile&amp;later=scheduled&amp;laterItem=scheduled-id&amp;source=docker%3Afixture",
  );
  expect(html).toContain("Message not sent");
});

it("distinguishes a general pull-request destination from an individual published file", () => {
  const brief = fixture();
  brief.artifacts = [
    { kind: "pr", ref: "watch-one", state: "open" },
    { kind: "pr", ref: "watch-two", state: "merged" },
    { kind: "file", ref: "file-one", state: "published" },
  ];
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={brief} workspace="docker:fixture" {...actions} />,
  );
  expect(html).toContain("2 linked pull requests");
  expect(html.match(/Browse all pull requests/g)).toHaveLength(1);
  expect(html).toContain("page=pulls&amp;source=docker%3Afixture");
  expect(html).toContain("artifact=file-one&amp;source=docker%3Afixture");
  expect(html).not.toContain("artifact=watch-one");
});
