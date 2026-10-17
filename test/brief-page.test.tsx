import {
  BriefEvidence,
  BriefHistoryList,
  BriefItemSummary,
} from "../src/client/BriefItemContent";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProjectBriefView } from "../src/client/ProjectBrief";
import { BriefItemCard } from "../src/client/ProjectBriefView";
import { BriefAcknowledgements, briefSourceUrl } from "../src/client/briefView";
import type { BriefPage, Item } from "../src/shared/briefs";
import { ReadableTextProvider } from "../src/client/ReadableText";
import { readableAuthor } from "../src/shared/readable-text";

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
  section: "state" as const,
  onSectionChange: vi.fn(),
  onNavigate: vi.fn(),
  onItem: vi.fn(),
  onAll: vi.fn(),
  onGoal: vi.fn(),
  onSettings: vi.fn(),
  onHistory: vi.fn(),
  onDecision: vi.fn(),
};
it("uses readable names across old brief content and evidence without rewriting source links or records", () => {
  const agent = "3dd35f59-14de-44cb-9914-d991edfc28ce";
  const thread = "2c20ef58-0ba2-4ef6-b87c-a74e724432f5";
  const payload = "YWJj".repeat(100);
  const agents = [{ id: agent, name: "forest" }];
  const brief = fixture();
  brief.headline!.text = `@${agent} is reviewing thread ${thread}.`;
  brief.goal!.text = `Review ${payload} with @${agent}.`;
  brief.sources.res_1.title = `Review from @${agent}`;
  brief.sources.res_1.conversation = thread;
  const item: Item = {
    ...brief.decisions[0],
    text: `Review snapshot ${thread}`,
    why: `@${agent} found a layout issue`,
    decided_by: agent,
    next: `Ask @${agent} to test`,
    blocker: `Upload ${payload}`,
    cite: [{ ref: "res_1", quote: `@${agent} reviewed ${payload}` }],
  };
  brief.decisions = [item];
  const original = structuredClone(brief);
  const html = renderToStaticMarkup(
    <ReadableTextProvider agents={agents}>
      <ProjectBriefView brief={brief} {...actions} section="decisions" />
      <BriefItemCard
        item={item}
        sources={brief.sources}
        workspace="docker:fixture"
        author={(id) => readableAuthor(id, agents)}
        onNavigate={actions.onNavigate}
        onItem={actions.onItem}
      />
      <BriefItemSummary
        item={item}
        author={(id) => readableAuthor(id, agents)}
        replacement={`Review by @${agent}`}
      />
      <BriefEvidence
        item={item}
        sources={brief.sources}
        workspace="docker:fixture"
        onNavigate={actions.onNavigate}
      />
    </ReadableTextProvider>,
  );
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("@forest is reviewing the conversation");
  expect(text).toContain("Decided by @forest");
  expect(text).toContain("Ask @forest to test");
  expect(text).toContain("Review from @forest");
  expect(text).toContain("Open the source for the original wording.");
  for (const token of [agent, thread, payload])
    expect(text).not.toContain(token);
  expect(html).toContain('aria-label="Open source: Review from @forest"');
  expect(html).toContain(`conversation=${thread}&amp;message=answer`);
  expect(brief).toEqual(original);
});
it("counts the current record including overflow without rendering every category", () => {
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={fixture()} {...actions} />,
  );
  expect(html).toContain("Decisions<span>21</span>");
  expect(html).toContain("No current state recorded.");
  expect(html).toContain("View full update record");
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
    briefSourceUrl(
      { conversation: "thread", message: null, artifact: "file" },
      "docker:fixture",
    ),
  ).toBe("/?source=docker%3Afixture&artifact=file");
  expect(
    briefSourceUrl(
      {
        conversation: "thread",
        message: "answer",
        artifact: null,
        kind: "checkout",
        run: "run",
      },
      "docker:fixture",
    ),
  ).toBe(
    "/?source=docker%3Afixture&conversation=thread&message=answer&checkout=run",
  );
  expect(
    briefSourceUrl({
      conversation: "thread",
      message: "answer",
      artifact: null,
      kind: "verification",
      run: "run",
    }),
  ).toBe("/?conversation=thread&message=answer&verification=run");
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
it("shares a pending acknowledgement failure with overlapping refreshes and allows retry", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const ack = new BriefAcknowledgements(),
    failure = new Error("Acknowledgement unavailable"),
    send = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
  const outcomes = Promise.allSettled([
    ack.acknowledge(2, 1, send),
    ack.acknowledge(2, 1, send),
  ]);
  reject(failure);
  expect(await outcomes).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
  expect(send).toHaveBeenCalledTimes(1);
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

it("shows each original evidence destination and answer context without inventing missing sources", () => {
  const brief = fixture();
  const item = {
    ...brief.decisions[0],
    kind: "question" as const,
    asked_by: "agent",
    decided_by: undefined,
    cite: [
      { ref: "res_1", quote: "Original words" },
      { ref: "missing", quote: "A retained quotation" },
    ],
    answered_cite: { ref: "answer", quote: "The answer" },
    status: "answered",
  };
  const sources = {
    ...brief.sources,
    answer: {
      ...brief.sources.res_1,
      ref: "answer",
      title: "Answer source",
      at: 0,
      message: "exact-answer",
    },
  };
  const html = renderToStaticMarkup(
    <BriefEvidence
      item={item}
      sources={sources}
      workspace="docker:fixture"
      onNavigate={actions.onNavigate}
    />,
  );
  expect(html).toContain("message=answer");
  expect(html).toContain("message=exact-answer");
  expect(html.match(/href=/g)).toHaveLength(2);
  expect(html).toContain("Source unavailable");
  expect(html).toContain("A retained quotation");
  expect(html).toContain("Answer evidence");
  expect(html).toContain('dateTime="1970-01-01T00:00:00.000Z"');
  const summary = renderToStaticMarkup(
    <BriefItemSummary
      item={item}
      author={() => "@Author"}
      replacement="Current direction"
    />,
  );
  expect(summary).toContain("Asked by @Author");
  expect(summary).toContain("answered");
  expect(summary).toContain("Pinned wording");
  expect(summary).toContain("Current direction");
  expect(summary).toContain("A source has changed");
});

it("keeps history pagination reachable when loaded versions do not concern this item", () => {
  const history = {
    items: [{ version: 50, at: 1, changes: fixture().changes }],
    before: 50,
  };
  const html = renderToStaticMarkup(
    <BriefHistoryList
      history={history}
      pending={false}
      error=""
      itemId="retired-item"
      onMore={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(html).toContain("No matching changes in these versions");
  expect(html).toContain("Older versions");
  expect(html).not.toContain("No recorded changes for this item");
  const full = renderToStaticMarkup(
    <BriefHistoryList
      history={history}
      pending={false}
      error=""
      onMore={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(full).toContain("Updated · Decision");
  expect(full).toContain("pinned wording");
  const unloaded = renderToStaticMarkup(
    <BriefHistoryList
      history={null}
      pending={false}
      error=""
      onMore={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(unloaded).toContain("Load history");
  expect(unloaded).not.toContain("No recorded");
});

it("labels thread fallbacks and repeated answer references according to available context", () => {
  const brief = fixture();
  const item = {
    ...brief.decisions[0],
    answered_cite: { ref: "res_1", quote: "Answer in the same source" },
  };
  const html = renderToStaticMarkup(
    <BriefEvidence
      item={item}
      sources={{
        res_1: { ...brief.sources.res_1, title: "", at: null, message: null },
      }}
      workspace=""
      onNavigate={actions.onNavigate}
    />,
  );
  expect(html).toContain("Untitled source");
  expect(html).toContain("Open source thread");
  expect(html).not.toContain("original message");
  expect(html).not.toContain("<time");
  expect(html.match(/Answer evidence/g)).toHaveLength(1);
});

it("shows generation tokens with a breakdown, retries and unavailable historical usage", () => {
  const brief = fixture();
  expect(
    renderToStaticMarkup(<ProjectBriefView brief={brief} {...actions} />),
  ).toContain("Token usage unavailable");
  brief.generation_usage = {
    at: 1000,
    model: "fixture-model",
    outcome: "published",
    attempts: 2,
    reported_attempts: 2,
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
  };
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={brief} {...actions} />,
  );
  expect(html).toContain("1,200 tokens");
  expect(html).toContain("Input tokens");
  expect(html).toContain("Output tokens");
  expect(html).toContain("2 requests, including retries.");
  brief.generation_usage.reported_attempts = 1;
  expect(
    renderToStaticMarkup(<ProjectBriefView brief={brief} {...actions} />),
  ).toContain("At least 1,200 tokens");
});

it("shows short titles and qualified updates, with the original wording and full detail one level deeper", () => {
  const brief = fixture();
  const item: Item = {
    ...brief.decisions[0],
    kind: "state",
    pinned: false,
    cite_stale: false,
    text: "Detailed provenance: forest reports the implementation and push; the running app has not yet been updated.",
    summary: {
      title: "Make everything clickable",
      update: "forest reports source links on main. App update pending.",
      stage: "awaiting_update",
      request: { ref: "msg_request", quote: "Everything should be clickable" },
    },
  };
  brief.state = [item];
  brief.sources.msg_request = {
    ref: "msg_request",
    title: "Source links",
    at: 1,
    conversation: "thread",
    message: "request",
    artifact: null,
    excerpt: "Everything should be clickable",
    owner_message: true,
    verified_quotes: ["Everything should be clickable"],
  };
  const html = renderToStaticMarkup(
    <ProjectBriefView brief={brief} {...actions} />,
  );
  expect(html).toContain("Make everything clickable");
  expect(html).toContain("App update pending.");
  expect(html).toContain("Waiting for an app update");
  expect(html).not.toContain("Detailed provenance");
  expect(html).toContain("projectTab=brief&amp;briefEvidence=headline");
  const evidence = renderToStaticMarkup(
    <BriefEvidence
      item={item}
      sources={brief.sources}
      workspace="docker:one"
      onNavigate={() => {}}
    />,
  );
  expect(evidence).toContain("In your words");
  expect(evidence).toContain("Everything should be clickable");
  expect(evidence).toContain("message=request");
  const details = renderToStaticMarkup(
    <BriefItemSummary item={item} author={(s) => s} />,
  );
  expect(details).toContain("More context");
  expect(details).toContain("Detailed provenance");
  brief.sources.msg_request.verified_quotes = [];
  const changed = renderToStaticMarkup(
    <BriefEvidence
      item={item}
      sources={brief.sources}
      workspace=""
      onNavigate={() => {}}
    />,
  );
  expect(changed).not.toContain("In your words");
  expect(changed).toContain("The original request is no longer available.");
});
