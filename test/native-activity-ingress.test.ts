import { seedConnection, seedConversation } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { harnessIds } from "../src/shared/harnesses.js";
import { NativeItemState } from "../src/shared/native-item-state.js";
import type { Live } from "../src/server/native-sessions";
import type { AdapterEvent } from "../src/adapters/events";
import { Codex } from "../src/adapters/codex";
import { Claude } from "../src/adapters/claude";
import { DirectControls } from "../src/adapters/direct-controls";
import { directActivityUpdate } from "../src/activity-bridge";
import { afterAll, expect, it } from "vitest";

import { normalizeItemStatus } from "../src/shared/native-item-state.js";
const dir = testDirectory();

const { db } = await import("../src/server/db");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { activityRoutes } = await import("../src/server/activities");
const { conversationUsage } = await import("../src/server/mobile-return");

// The real activity route, authenticated as the conversation owner.
const app = await productionApp("owner", [activityRoutes], {
  ownerHeader: "x-owner",
  json: false,
});
const base = app.url + "/api";
const snapshot = async (
  conversation: string,
  after?: number,
  owner = "owner",
) => {
  const res = await fetch(
    `${base}/conversations/${conversation}/activities${after ? "?after=" + after : ""}`,
    { headers: { "x-owner": owner } },
  );
  return { status: res.status, body: (await res.json()) as any };
};
afterAll(async () => {
  await app.close();
  db.close();
});

for (const c of ["conv", "other"])
  seedConversation(db, {
    id: c,
    owner_id: "owner",
    title: "t",
    created_at: 0,
  });
db.prepare(
  "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,updated_at) VALUES('fixture-agent','conv','codex',?,0)",
).run(dir);

function turn(conversation: string, key: string) {
  enqueue("owner", "t", key, { conversation });
  return claim("w")!;
}
// Installs a live session in NativeSessions exactly as session() does: the
// map entry plus the companion_sessions generation written before start().
function start(
  sessions: InstanceType<typeof NativeSessions>,
  generation: string,
  bootstrap: any,
  conversation = "conv",
  harness: import("../src/shared/protocol").Harness = "codex",
) {
  const live: Live = sessions.state.attach({
    binding: {
      worktree_source: null,
      worktree_agent_id: "fixture-agent",
      conversation_id: conversation,
      harness,
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    },
    adapter: new Codex(
      {
        harness: "codex",
        executable: "",
        version: "fixture",
        project: dir,
        billing: "existing",
      },
      () => {},
    ),
    generation,
    ready: Promise.resolve(),
    bootstrapRun: bootstrap,
  });
  db.prepare(
    "UPDATE companion_sessions SET generation=?,state='starting' WHERE conversation_id=?",
  ).run(generation, conversation);
  // The direct adapters' real control publisher, wired to the ingress.
  const controls = new DirectControls("codex", (e: AdapterEvent) =>
    sessions.projector.event(live, e),
  );
  return {
    live,
    controls,
    emit: (e: AdapterEvent) => sessions.projector.event(live, e),
  };
}
const events = () =>
  db
    .prepare(
      "SELECT run_id,subject_kind,subject_id,type,payload FROM events ORDER BY id",
    )
    .all() as {
    run_id: string | null;
    subject_kind: string;
    subject_id: string;
    type: string;
    payload: string;
  }[];
const byKind = (items: any[], kind: string) =>
  items.filter((i) => i.kind === kind);
it("records native turn tokens through adapter ingress without replay or cross-turn inflation", () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "usage-first");
  const current = start(sessions, "usage-generation", run);
  sessions.state.startTurn(current.live, run);
  const adapter = new Codex(
    {
      harness: "codex",
      executable: "",
      project: dir,
      version: "fixture",
      billing: "existing",
    },
    current.emit,
  ) as any;
  adapter.thread = "thread-usage";
  const send = (method: string, params: any) =>
    adapter.message({
      method,
      params: { threadId: "thread-usage", ...params },
    });
  const usage = (
    turnId: string,
    input: number,
    output: number,
    lastInput = 100,
    lastOutput = 20,
  ) =>
    send("thread/tokenUsage/updated", {
      turnId,
      tokenUsage: {
        total: {
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: input / 2,
        },
        last: {
          inputTokens: lastInput,
          outputTokens: lastOutput,
          cachedInputTokens: lastInput / 2,
        },
      },
    });
  // Historical usage is not assigned to the next run.
  usage("old", 1000, 200);
  send("turn/started", { turn: { id: "turn-1" } });
  usage("turn-1", 1100, 220);
  usage("turn-1", 1300, 260, 200, 40);
  usage("turn-1", 1300, 260, 200, 40);
  usage("turn-1", 1100, 220);
  usage("wrong-turn", 9999, 9999);
  send("thread/tokenUsage/updated", {
    threadId: "foreign",
    turnId: "turn-1",
    tokenUsage: { total: { inputTokens: 9999, outputTokens: 9999 } },
  });
  expect(conversationUsage("owner", "conv").runs[run.id]).toEqual({
    input_tokens: 300,
    output_tokens: 60,
    cache_read_tokens: 150,
  });

  const next = turn("conv", "usage-second");
  sessions.state.startTurn(current.live, next);
  send("turn/started", { turn: { id: "turn-2" } });
  usage("turn-2", 1350, 270, 50, 10);
  expect(conversationUsage("owner", "conv").runs[next.id]).toEqual({
    input_tokens: 50,
    output_tokens: 10,
    cache_read_tokens: 25,
  });
  // A cached count in only one of total and last leaves this turn's cached
  // share unknown; the next turn has a full baseline again.
  const reported: any[] = [];
  const partial = new Codex(
    {
      harness: "codex",
      executable: "",
      project: dir,
      version: "fixture",
      billing: "existing",
    },
    (event: any) => reported.push(event),
  ) as any;
  partial.thread = "thread-partial";
  const note = (method: string, params: any) =>
    partial.message({
      method,
      params: { threadId: "thread-partial", ...params },
    });
  note("turn/started", { turn: { id: "partial-1" } });
  note("thread/tokenUsage/updated", {
    turnId: "partial-1",
    tokenUsage: {
      total: { inputTokens: 900, outputTokens: 90, cachedInputTokens: 800 },
      last: { inputTokens: 100, outputTokens: 10 },
    },
  });
  note("turn/started", { turn: { id: "partial-2" } });
  note("thread/tokenUsage/updated", {
    turnId: "partial-2",
    tokenUsage: {
      total: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 860 },
      last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 },
    },
  });
  expect(
    reported.filter((e) => e.type === "usage").map((e) => e.usage),
  ).toEqual([
    { input_tokens: 100, output_tokens: 10 },
    { input_tokens: 100, output_tokens: 10, cache_read_tokens: 60 },
  ]);
  const before = events().length;
  current.emit({
    type: "usage",
    usage: { input_tokens: NaN, output_tokens: 1 },
  });
  current.emit({
    type: "usage",
    usage: { input_tokens: -1, output_tokens: 1 },
  });
  sessions.state.startTurn(current.live, turn("other", "usage-foreign"));
  current.emit({
    type: "usage",
    usage: { input_tokens: 9000, output_tokens: 9000 },
  });
  sessions.state.startTurn(current.live, next);
  db.prepare(
    "UPDATE companion_sessions SET generation='replacement' WHERE conversation_id='conv'",
  ).run();
  current.emit({
    type: "usage",
    usage: { input_tokens: 9000, output_tokens: 9000 },
  });
  // The foreign run's enqueue/claim events are unrelated to usage.
  expect(
    events()
      .slice(before)
      .filter((e) => e.type === "native.usage"),
  ).toHaveLength(0);
  expect(() => conversationUsage("intruder", "conv")).toThrow();
});

it("records Claude result usage including cached inputs, excluding foreign results", () => {
  const run = turn("conv", "usage-claude");
  const sessions = new NativeSessions();
  const current = start(sessions, "usage-claude-generation", run);
  sessions.state.startTurn(current.live, run);
  const adapter = new Claude(
    {
      harness: "claude",
      executable: "",
      project: dir,
      version: "fixture",
      billing: "existing",
      resume: "claude-usage",
    },
    current.emit,
  ) as any;
  adapter.active = true;
  const result = {
    type: "result",
    session_id: "claude-usage",
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
      output_tokens: 20,
    },
  };
  adapter.message({ ...result, parent_tool_use_id: "child" });
  adapter.message({ ...result, session_id: "other-session" });
  expect(conversationUsage("owner", "conv").runs[run.id]).toBeUndefined();
  adapter.message(result);
  expect(conversationUsage("owner", "conv").runs[run.id]).toEqual({
    input_tokens: 175,
    output_tokens: 20,
    cache_read_tokens: 50,
  });
  adapter.message(result);
  expect(conversationUsage("owner", "conv").runs[run.id]).toEqual({
    input_tokens: 175,
    output_tokens: 20,
    cache_read_tokens: 50,
  });
});

// The projector picks the last non-commentary assistant item with text as a
// completed run's answer (projectOutput), so child-session output must carry
// phase "commentary" at ingress to stay out of that selection.
const retainedAnswer = (live: Live) =>
  [...live.items.values()].findLast(
    (i) => i.kind === "assistant" && i.phase !== "commentary" && i.text.trim(),
  );

it("marks Claude child-session assistant messages as commentary so they cannot become the run's answer", () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "claude-child-commentary");
  const current = start(sessions, "claude-child-generation", run);
  sessions.state.startTurn(current.live, run);
  const adapter = new Claude(
    {
      harness: "claude",
      executable: "",
      project: dir,
      version: "fixture",
      billing: "existing",
      resume: "claude-child-commentary",
    },
    current.emit,
  ) as any;
  adapter.active = true;
  const send = (m: any) =>
    adapter.message({ session_id: "claude-child-commentary", ...m });
  send({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "parent-msg",
      role: "assistant",
      content: [{ type: "text", text: "Parent final" }],
    },
  });
  send({
    type: "assistant",
    parent_tool_use_id: "task-1",
    message: {
      id: "child-msg",
      role: "assistant",
      content: [{ type: "text", text: "Child text" }],
    },
  });
  // Parent-session items keep their exact shape; the child is commentary.
  expect(current.live.items.get("parent-msg")).toEqual({
    id: "parent-msg",
    kind: "assistant",
    text: "Parent final",
  });
  expect(current.live.items.get("child-msg")).toEqual({
    id: "child-msg",
    kind: "assistant",
    text: "Child text",
    phase: "commentary",
  });
  expect(retainedAnswer(current.live)?.id).toBe("parent-msg");
});

it("establishes a commentary item before a child stream's first delta", () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "claude-child-delta");
  const current = start(sessions, "claude-child-delta-generation", run);
  sessions.state.startTurn(current.live, run);
  const adapter = new Claude(
    {
      harness: "claude",
      executable: "",
      project: dir,
      version: "fixture",
      billing: "existing",
      resume: "claude-child-delta",
    },
    current.emit,
  ) as any;
  adapter.active = true;
  const send = (m: any) =>
    adapter.message({ session_id: "claude-child-delta", ...m });
  send({
    type: "stream_event",
    parent_tool_use_id: "task-2",
    event: { type: "message_start", message: { id: "child-stream" } },
  });
  send({
    type: "stream_event",
    parent_tool_use_id: "task-2",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Child stream text" },
    },
  });
  // The delta merged into the commentary item the adapter established first;
  // a turn ending here (no parent text) must not select the child stream.
  expect(current.live.items.get("child-stream")).toEqual({
    id: "child-stream",
    kind: "assistant",
    text: "Child stream text",
    phase: "commentary",
  });
  expect(retainedAnswer(current.live)).toBeUndefined();
});

it("merges a child delta into an earlier child assistant message instead of replacing its text", () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "claude-child-late-delta");
  const current = start(sessions, "claude-child-late-delta-generation", run);
  sessions.state.startTurn(current.live, run);
  const adapter = new Claude(
    {
      harness: "claude",
      executable: "",
      project: dir,
      version: "fixture",
      billing: "existing",
      resume: "claude-child-late-delta",
    },
    current.emit,
  ) as any;
  adapter.active = true;
  const send = (m: any) =>
    adapter.message({ session_id: "claude-child-late-delta", ...m });
  // Full child assistant message arrives first, then its stream's delta.
  send({
    type: "assistant",
    parent_tool_use_id: "task-3",
    message: {
      id: "child-late",
      role: "assistant",
      content: [{ type: "text", text: "Full child text" }],
    },
  });
  send({
    type: "stream_event",
    parent_tool_use_id: "task-3",
    event: { type: "message_start", message: { id: "child-late" } },
  });
  send({
    type: "stream_event",
    parent_tool_use_id: "task-3",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: " and more" },
    },
  });
  // The delta merged into the existing commentary item; the earlier text is
  // not overwritten by an empty re-established item.
  expect(current.live.items.get("child-late")).toEqual({
    id: "child-late",
    kind: "assistant",
    text: "Full child text and more",
    phase: "commentary",
  });
  expect(retainedAnswer(current.live)).toBeUndefined();
});

const option = (id: string, confirmed: string) => ({
  id,
  label: id,
  type: "select" as const,
  choices: [{ value: confirmed, label: confirmed }],
  confirmed,
});
const planEvent = (generation: string, statuses: string[]): AdapterEvent => ({
  type: "activity",
  activity: directActivityUpdate(
    {
      kind: "plan",
      id: "plan-1",
      steps: statuses.map((status, i) => ({
        id: "s" + i,
        text: "Step " + i,
        status,
      })),
    } as any,
    // The adapter's own notion of generation is never trusted.
    { harness: "codex", generation },
  ),
});

it.each(["codex", "claude", "pi", "opencode", "acp"])(
  "watches a %s PR through the production native activity ingress",
  async (harness) => {
    const { id, now } = await import("../src/server/db");
    const { seal } = await import("../src/server/secrets");
    const { createAgent } = await import("../src/server/domain");
    const { createGithubClient, withGithubClient } =
      await import("../src/server/github-api");
    const connection = id();
    seedConnection(db, {
      id: connection,
      owner_id: "owner",
      secret: "",
      models: '[{"id":"fixture"}]',
      created_at: now(),
    });
    const agent = createAgent("owner", {
      name: harness + "-watch",
      connectionId: connection,
      model: "fixture",
    });
    const conversation = id();
    seedConversation(db, {
      id: conversation,
      owner_id: "owner",
      title: "PR creation",
      created_at: now(),
    });
    db.prepare(
      "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,updated_at) VALUES('fixture-agent',?,?,?,?)",
    ).run(conversation, harness, dir, now());
    db.prepare(
      "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,'owner','GitHub','https://api.githubcopilot.com/mcp/',?,'connected','{}',?)",
    ).run(
      id(),
      seal(JSON.stringify({ type: "bearer", token: "fixture" }), "owner"),
      now(),
    );
    const run = turn(conversation, "pr-create-" + harness);
    run.conversation_id = conversation;
    run.agent_id = agent.id;
    db.prepare("UPDATE runs SET conversation_id=?,agent_id=? WHERE id=?").run(
      conversation,
      agent.id,
      run.id,
    );
    const sessions = new NativeSessions();
    const { live, emit } = start(
      sessions,
      "pr-gen-" + harness,
      run,
      conversation,
      harness as import("../src/shared/protocol").Harness,
    );
    sessions.state.startTurn(live, run);
    const number =
      50 + ["codex", "claude", "pi", "opencode", "acp"].indexOf(harness);
    const githubClient = createGithubClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            state: "open",
            created_at: new Date(now()).toISOString(),
            head: { sha: "a".repeat(40) },
          }),
        ),
      base: undefined,
    });
    const source = {
      transport: harness === "acp" ? ("acp" as const) : ("native" as const),
      harness,
      origin: "direct",
    };
    const output = {
      v: 1 as const,
      kind: "output" as const,
      id: "create",
      source,
    };
    await withGithubClient(githubClient, async () => {
      emit({
        type: "activity",
        activity: {
          ...output,
          patch: {
            command: "gh pr create --fill",
            replace: [
              {
                stream: "combined",
                text: `https://github.com/acme/api/pull/${number}`,
              },
            ],
            status: "running",
          },
        },
      });
      expect(
        db.prepare("SELECT 1 FROM pr_watches WHERE number=?").get(number),
      ).toBeUndefined();
      // ACP may send command input, output and completion in separate frames.
      emit({
        type: "activity",
        activity: { ...output, patch: { status: "exited" } },
      });
      const record = db
        .prepare(
          "SELECT record FROM agent_activities WHERE run_id=? AND kind='output'",
        )
        .get(run.id) as { record: string } | undefined;
      expect(record && JSON.parse(record.record).data).toMatchObject({
        command: "gh pr create --fill",
        status: "exited",
      });
      await expect
        .poll(() =>
          db
            .prepare("SELECT agent_id,state FROM pr_watches WHERE number=?")
            .get(number),
        )
        .toEqual({ agent_id: agent.id, state: "watching" });
    });
  },
);

it("persists native activity events through restarts and serves them to reloads without leaking payloads", async () => {
  const bootstrap = turn("conv", "bootstrap");
  let sessions = new NativeSessions();
  const first = start(sessions, "gen-1", bootstrap);
  const before = events().length;

  // Pre-turn: session/load reports catalogs and capabilities before any turn.
  first.controls.publish(
    [option("model", "gpt-a"), option("sandbox", "workspace-write")],
    [
      {
        name: "review",
        token: "/review",
        kind: "prompt",
        description: "Review",
      },
    ],
  );
  // A replayed tool before a turn has no Loop turn and must not become work.
  first.emit({
    type: "activity",
    activity: {
      v: 1,
      kind: "tool",
      id: "replayed",
      replay: true,
      source: { transport: "native", harness: "codex", origin: "direct" },
      patch: { title: "Edit", status: "completed" },
    },
  });
  let page = (await snapshot("conv")).body;
  expect(byKind(page.items, "tool")).toEqual([]);
  const settings1 = byKind(page.items, "settings")[0];
  expect(settings1).toMatchObject({ run: null });
  expect(settings1.record).toMatchObject({
    generation: "gen-1",
    data: { revision: 1 },
  });
  expect(settings1.record.data.options.map((o: any) => o.id)).toEqual([
    "model",
    "sandbox",
  ]);
  expect(
    byKind(page.items, "commands")[0].record.data.commands[0],
  ).toMatchObject({ token: "/review" });
  const caps1 = byKind(page.items, "capabilities")[0];
  expect(caps1.key).toBe("capabilities:native:codex");
  expect(caps1.record).toMatchObject({
    generation: "gen-1",
    source: { transport: "native", harness: "codex" },
    capabilities: {
      plans: { state: "supported" },
      settings: { state: "supported" },
    },
  });

  // Session-only refresh signals are content-free conversation subjects;
  // the raw adapter payload never reaches the events stream.
  const signals = events()
    .slice(before)
    .filter((e) => e.type === "activity.updated");
  expect(signals.length).toBeGreaterThan(0);
  expect(
    signals.every(
      (e) =>
        e.run_id === null &&
        e.subject_kind === "conversation" &&
        e.subject_id === "conv",
    ),
  ).toBe(true);
  for (const e of signals) {
    expect(Object.keys(JSON.parse(e.payload)).sort()).toEqual([
      "key",
      "kind",
      "sequence",
    ]);
    expect(e.payload).not.toContain("gpt-a");
  }

  // A turn: adapter-stamped generations are replaced by the server's.
  const run = turn("conv", "turn-1");
  sessions.state.startTurn(first.live, run);
  first.emit(planEvent("adapter-private-id", ["in_progress", "pending"]));
  first.emit(planEvent("adapter-private-id", ["completed", "in_progress"]));
  // Duplicate delivery of an unchanged record writes nothing and signals nothing.
  const signalCount = events().length;
  first.emit({
    type: "activity_capabilities",
    capabilities: first.controls.capabilities,
  });
  expect(events().length).toBe(signalCount);
  first.controls.publish([
    option("model", "gpt-b"),
    option("sandbox", "workspace-write"),
  ]);
  page = (await snapshot("conv")).body;
  const plans = byKind(page.items, "plan");
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ run: run.id });
  expect(plans[0].record).toMatchObject({ generation: "gen-1", revision: 2 });
  expect(plans[0].record.data.steps.map((s: any) => s.status)).toEqual([
    "completed",
    "in_progress",
  ]);
  expect(byKind(page.items, "settings")[0].record.data).toMatchObject({
    revision: 2,
  });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "running",
  });
  const planSignals = events().filter(
    (e) => e.type === "activity.updated" && e.payload.includes('"kind":"plan"'),
  );
  expect(planSignals.map((e) => e.run_id)).toEqual([run.id, run.id]);
  expect(
    events().some(
      (e) => e.type === "native.event" && e.payload.includes('"activity'),
    ),
  ).toBe(false);

  // An oversized display update is dropped without interrupting native work.
  first.emit({
    type: "activity",
    activity: {
      v: 1,
      kind: "output",
      id: "huge",
      source: { transport: "native", harness: "codex", origin: "direct" },
      patch: {
        replace: [{ stream: "stdout", text: "x".repeat(2 * 1024 * 1024) }],
      },
    },
  });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "running",
  });
  expect(first.live.closed).toBe(false);

  // A run bound to another conversation cannot write into this one.
  const foreign = turn("other", "foreign");
  sessions.state.startTurn(first.live, foreign);
  first.emit(planEvent("x", ["pending"]));
  expect((await snapshot("other")).body.items).toEqual([]);
  expect(byKind((await snapshot("conv")).body.items, "plan")).toHaveLength(1);
  sessions.state.startTurn(first.live, run);

  // Reload: a full snapshot and an incremental page from the cursor agree.
  const cursor = page.cursor;
  first.controls.publish([
    option("model", "gpt-c"),
    option("sandbox", "workspace-write"),
  ]);
  const delta = (await snapshot("conv", cursor)).body;
  expect(delta.items.map((i: any) => i.kind)).toEqual(["settings"]);
  const full = (await snapshot("conv")).body;
  expect(new Set(full.items.map((i: any) => i.key)).size).toBe(
    full.items.length,
  );
  expect(byKind(full.items, "settings")[0]).toEqual(delta.items[0]);
  // Another owner cannot read the conversation.
  expect((await snapshot("conv", undefined, "mallory")).status).toBe(404);

  // Process restart: recovery clears the generation. Frames still produced
  // by the old process are stale and quarantined.
  sessions.state.detachTurn(first.live);
  sessions.recover();
  const frozen = JSON.stringify((await snapshot("conv")).body.items);
  first.controls.publish([option("model", "stale")]);
  first.emit(planEvent("x", ["failed", "failed"]));
  expect(JSON.stringify((await snapshot("conv")).body.items)).toBe(frozen);

  // New process, new generation. Producer revisions restart at 1 and the new
  // catalog replaces the old one instead of being rejected as stale.
  sessions = new NativeSessions();
  const second = start(sessions, "gen-2", bootstrap);
  const settingsRevision = byKind(JSON.parse(frozen), "settings")[0].record
    .revision;
  second.controls.publish([option("model", "gpt-d")], []);
  page = (await snapshot("conv")).body;
  const settings2 = byKind(page.items, "settings")[0];
  expect(settings2.record).toMatchObject({
    generation: "gen-2",
    data: { revision: 1 },
  });
  expect(
    settings2.record.data.options.map((o: any) => [o.id, o.confirmed]),
  ).toEqual([["model", "gpt-d"]]);
  expect(settings2.record.revision).toBe(settingsRevision + 1);
  expect(byKind(page.items, "commands")[0].record).toMatchObject({
    generation: "gen-2",
    data: { commands: [], revision: 1 },
  });
  expect(byKind(page.items, "capabilities")[0].record.generation).toBe("gen-2");
  // Completed history from the earlier generation is preserved as history.
  expect(byKind(page.items, "plan")[0].record).toMatchObject({
    generation: "gen-1",
  });
  // The first process's session object is no longer live for this conversation.
  first.controls.publish([option("model", "zombie")]);
  expect(
    byKind((await snapshot("conv")).body.items, "settings")[0].record.data
      .options[0].confirmed,
  ).toBe("gpt-d");
});

it.each(harnessIds)(
  "%s records its transport and drops another transport",
  async (harness) => {
    const sessions = new NativeSessions();
    const run = turn("conv", "spoof-" + harness);
    const { live, emit } = start(
      sessions,
      "gen-spoof-" + harness,
      run,
      "conv",
      harness,
    );
    sessions.state.startTurn(live, run);
    // Expected protocol is independent of the descriptor under test.
    const expected = ["acp", "grok", "antigravity"].includes(harness)
      ? "acp"
      : "native";
    const before = (await snapshot("conv")).body.items.length;
    for (const transport of [
      "api",
      expected === "acp" ? "native" : "acp",
    ] as const)
      emit({
        type: "activity",
        activity: {
          v: 1,
          kind: "output",
          id: "spoof-" + transport,
          source: { transport, harness, origin: "direct" },
          patch: {
            replace: [{ stream: "stdout", text: "not from " + transport }],
          },
        },
      });
    expect((await snapshot("conv")).body.items).toHaveLength(before);
    emit({
      type: "activity",
      activity: {
        v: 1,
        kind: "output",
        id: "honest-" + harness,
        source: { transport: expected, harness, origin: "direct" },
        patch: { replace: [{ stream: "stdout", text: "ok" }] },
      },
    });
    const items = (await snapshot("conv")).body.items;
    expect(items).toHaveLength(before + 1);
    const outputs = byKind(items, "output").filter(
      (o: any) => o.record.id === "honest-" + harness,
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].record.source.transport).toBe(expected);
  },
);

it("rejects settings writes from stale generations, including replacement during readiness", async () => {
  const sessions = new NativeSessions();
  const current = start(sessions, "controls-new", undefined);
  let calls = 0;
  current.live.adapter.setSetting = async () => {
    calls++;
    return { options: [], revision: 1 };
  };
  await expect(
    sessions.setSetting("conv", "model", "b", 1, "controls-old"),
  ).rejects.toThrow("Native session changed");
  expect(calls).toBe(0);
  let ready!: () => void;
  sessions.state.ready(
    current.live,
    new Promise<void>((r) => {
      ready = r;
    }),
  );
  const writing = sessions.setSetting("conv", "model", "b", 1, "controls-new");
  start(sessions, "controls-replacement", undefined);
  ready();
  await expect(writing).rejects.toThrow("Native session changed");
  expect(calls).toBe(0);
});

it("does not return old adapter controls or confirm a write after the binding changes", async () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "controls-before");
  transition(run, "completed");
  const current = start(sessions, "controls-before", run);
  current.live.adapter.setSetting = async () => {
    db.prepare(
      "UPDATE companion_sessions SET generation='controls-after' WHERE conversation_id='conv'",
    ).run();
    return { options: [], revision: 2 };
  };
  await expect(
    sessions.setSetting("conv", "model", "b", 1, "controls-before"),
  ).rejects.toThrow("Native session changed");
  expect(sessions.controls("conv")).toMatchObject({
    generation: "controls-after",
    state: "disconnected",
    settings: { options: [] },
    capabilities: { settings: { state: "undiscovered" } },
  });
});

it("persists native tool items and deltas as paged activities across reloads and turns", async () => {
  const conversation = "tool-items";
  seedConversation(db, {
    id: conversation,
    owner_id: "owner",
    title: "Tools",
    created_at: 0,
  });
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,updated_at) VALUES('fixture-agent',?,'codex',?,0)",
  ).run(conversation, dir);
  const queued = enqueue("owner", "test", "tool-item-run", { conversation });
  const run = claim("tool-worker", (candidate) => candidate.id === queued.id)!;
  const sessions = new NativeSessions();
  let current = start(sessions, "tools-g1", run, conversation);
  sessions.state.startTurn(current.live, run);
  const nativeId = "native:" + "same-prefix-".repeat(40);
  const item = (
    id: string,
    text: string,
    status: NativeItemState = "running",
  ) => ({
    type: "item" as const,
    item: { id, kind: "tool" as const, title: "Read", text, status },
  });
  try {
    current.emit(item(nativeId + "a", "first"));
    current.emit(item(nativeId + "b", "other"));
    current.emit({ type: "delta", id: nativeId + "a", text: " continued" });
    current.emit(item(nativeId + "a", "first continued", "completed"));
    const before = (await snapshot(conversation)).body;
    expect(before.items).toHaveLength(2);
    const first = before.items.find(
      (entry: any) => entry.record.data.links.trace === nativeId + "a",
    );
    expect(first).toMatchObject({
      run: run.id,
      record: {
        generation: "tools-g1",
        data: {
          title: "Read",
          status: "completed",
          content: [{ type: "text", text: "first continued" }],
          links: { trace: nativeId + "a" },
        },
      },
    });
    expect(new Set(before.items.map((entry: any) => entry.key)).size).toBe(2);
    expect(first.record.id.length).toBeLessThanOrEqual(300);
    expect((await snapshot(conversation, undefined, "foreign")).status).toBe(
      404,
    );
    expect(
      (await snapshot("other")).body.items.some(
        (entry: any) => entry.run === run.id,
      ),
    ).toBe(false);

    // An old process cannot replace a persisted record in a newer generation.
    db.prepare(
      "UPDATE companion_sessions SET generation='tools-g2' WHERE conversation_id=?",
    ).run(conversation);
    current.emit(item(nativeId + "a", "stale"));
    expect((await snapshot(conversation)).body.items).toEqual(before.items);
    await sessions.dispose(current.live);
    current = start(sessions, "tools-g2", run, conversation);
    sessions.state.startTurn(current.live, run);
    current.emit(item(nativeId + "a", "first continued", "completed"));
    expect((await snapshot(conversation)).body.items).toHaveLength(2);
    for (let i = 0; i < 105; i++)
      current.emit(item("paged-" + i, "done", "completed"));
    let cursor: number | null = null;
    const keys = new Set<string>();
    do {
      const response: Response = await fetch(
        `${base}/conversations/${conversation}/activities?view=recent${cursor === null ? "" : "&before=" + cursor}`,
      );
      expect(response.status).toBe(200);
      const page: {
        items: { key: string; run: string }[];
        earlier: number | null;
      } = await response.json();
      expect(page.items.length).toBeLessThanOrEqual(100);
      for (const entry of page.items) {
        expect(entry.run).toBe(run.id);
        keys.add(entry.key);
      }
      cursor = page.earlier;
    } while (cursor !== null);
    expect(keys.size).toBe(107);
    transition(run, "completed");
    const next = enqueue("owner", "test", "tool-item-next", { conversation });
    const nextRun = claim(
      "tool-worker",
      (candidate) => candidate.id === next.id,
    )!;
    sessions.state.startTurn(current.live, nextRun);
    current.emit(item(nativeId + "a", "next turn", "completed"));
    const reused = (await snapshot(conversation)).body.items.filter(
      (entry: any) => entry.record.data.links.trace === nativeId + "a",
    );
    expect(reused).toHaveLength(2);
    expect(new Set(reused.map((entry: any) => entry.run))).toEqual(
      new Set([run.id, nextRun.id]),
    );
    transition(nextRun, "completed");
  } finally {
    await sessions.close();
  }
});

it("normalizes provider item statuses to the closed set", () => {
  expect(normalizeItemStatus("inProgress")).toBe("running");
  expect(normalizeItemStatus("in_progress")).toBe("running");
  expect(normalizeItemStatus("awaiting-input")).toBe("waiting");
  expect(normalizeItemStatus("rejected")).toBe("declined");
  expect(normalizeItemStatus("done")).toBe("completed");
  expect(normalizeItemStatus("cancelled")).toBe("interrupted");
  expect(normalizeItemStatus("interrupted")).toBe("interrupted");
  expect(normalizeItemStatus("copied", false)).toBe("running");
  expect(normalizeItemStatus("copied", true)).toBe("completed");
});
