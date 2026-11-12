import { NativeItemState } from "../src/shared/native-item-state.js";
import type { Live } from "../src/server/native-sessions";
import type { AdapterEvent } from "../src/adapters/events";
import { Codex } from "../src/adapters/codex";
import { Claude } from "../src/adapters/claude";
import { DirectControls } from "../src/adapters/direct-controls";
import { directActivityUpdate } from "../src/activity-bridge";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { NativeOutput } from "../src/server/native-output";
const dir = mkdtempSync(join(tmpdir(), "loop-activity-ingress-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { activityRoutes } = await import("../src/server/activities");
const { conversationUsage } = await import("../src/server/mobile-return");

// The real activity route, authenticated as the conversation owner.
const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "owner";
  next();
});
app.use(activityRoutes);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
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
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const c of ["conv", "other"])
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','t',0)",
  ).run(c);
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
) {
  const live: Live = {
    binding: {
      worktree_source: null,
      worktree_agent_id: "fixture-agent",
      conversation_id: conversation,
      harness: "codex",
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
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
  };
  (sessions as any).live.set(conversation, live);
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
  current.live.run = run;
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
        total: { inputTokens: input, outputTokens: output },
        last: { inputTokens: lastInput, outputTokens: lastOutput },
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
  });

  const next = turn("conv", "usage-second");
  current.live.run = next;
  send("turn/started", { turn: { id: "turn-2" } });
  usage("turn-2", 1350, 270, 50, 10);
  expect(conversationUsage("owner", "conv").runs[next.id]).toEqual({
    input_tokens: 50,
    output_tokens: 10,
  });
  const before = events().length;
  current.emit({
    type: "usage",
    usage: { input_tokens: NaN, output_tokens: 1 },
  });
  current.emit({
    type: "usage",
    usage: { input_tokens: -1, output_tokens: 1 },
  });
  current.live.run = turn("other", "usage-foreign");
  current.emit({
    type: "usage",
    usage: { input_tokens: 9000, output_tokens: 9000 },
  });
  current.live.run = next;
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
  const current = start(new NativeSessions(), "usage-claude-generation", run);
  current.live.run = run;
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
  });
  adapter.message(result);
  expect(conversationUsage("owner", "conv").runs[run.id]).toEqual({
    input_tokens: 175,
    output_tokens: 20,
  });
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
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'owner','openai','Fixture','','connected','[{\"id\":\"fixture\"}]','{}',?)",
    ).run(connection, now());
    const agent = createAgent("owner", {
      name: harness + "-watch",
      connectionId: connection,
      model: "fixture",
    });
    const conversation = id();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','PR creation',?)",
    ).run(conversation, now());
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
    const { live, emit } = start(
      new NativeSessions(),
      "pr-gen-" + harness,
      run,
      conversation,
    );
    live.binding.harness = harness as any;
    live.run = run;
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
  first.live.run = run;
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
  first.live.run = foreign;
  first.emit(planEvent("x", ["pending"]));
  expect((await snapshot("other")).body.items).toEqual([]);
  expect(byKind((await snapshot("conv")).body.items, "plan")).toHaveLength(1);
  first.live.run = run;

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
  first.live.run = undefined;
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

it("drops activity an adapter files under another transport", async () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "spoof");
  const { live, emit } = start(sessions, "gen-spoof", run);
  live.run = run;
  const before = (await snapshot("conv")).body.items.length;
  for (const transport of ["api", "acp"] as const)
    emit({
      type: "activity",
      activity: {
        v: 1,
        kind: "output",
        id: "spoof-" + transport,
        source: { transport, harness: "codex", origin: "direct" },
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
      id: "honest",
      source: { transport: "native", harness: "codex", origin: "direct" },
      patch: { replace: [{ stream: "stdout", text: "ok" }] },
    },
  });
  const outputs = byKind((await snapshot("conv")).body.items, "output");
  expect(outputs.map((o: any) => o.record.id)).toEqual(["honest"]);
});

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
  current.live.ready = new Promise<void>((r) => {
    ready = r;
  });
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
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','Tools',0)",
  ).run(conversation);
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,updated_at) VALUES('fixture-agent',?,'codex',?,0)",
  ).run(conversation, dir);
  const queued = enqueue("owner", "test", "tool-item-run", { conversation });
  const run = claim("tool-worker", (candidate) => candidate.id === queued.id)!;
  const sessions = new NativeSessions();
  let current = start(sessions, "tools-g1", run, conversation);
  current.live.run = run;
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
    current.live.run = run;
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
    current.live.run = nextRun;
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
