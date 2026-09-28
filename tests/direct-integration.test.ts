import { describe, it, expect } from "vitest";
import { Codex } from "../src/adapters/codex";
import { Claude } from "../src/adapters/claude";
import { Pi } from "../src/adapters/pi";
import { OpenCode } from "../src/adapters/opencode";
import {
  ActivityUpdate,
  reduceActivities,
  outputText,
} from "../src/agent-activities";
import { DirectControls } from "../src/adapters/direct-controls";

const options = {
  executable: "fixture",
  project: "/fixture",
  billing: "existing" as const,
  version: "deterministic-fixture",
};
function capture(Adapter: any, harness: string) {
  const events: any[] = [];
  const adapter = new Adapter({ ...options, harness }, (e: any) =>
    events.push(e),
  );
  return {
    adapter,
    events,
    updates: () =>
      events
        .filter((e) => e.type === "activity")
        .map((e) => ActivityUpdate.parse(e.activity)),
  };
}
describe("actual direct adapter event handlers (deterministic protocol fixtures)", () => {
  it("Codex streams output and replaces it with final authoritative output", () => {
    const { adapter, updates } = capture(Codex, "codex");
    adapter.message({
      method: "item/commandExecution/outputDelta",
      params: { itemId: "c", delta: "partial" },
    });
    adapter.message({
      method: "item/completed",
      params: {
        item: {
          id: "c",
          type: "commandExecution",
          aggregatedOutput: "final",
          exitCode: 0,
          status: "completed",
        },
      },
    });
    const records = [
      ...reduceActivities(
        updates().map((update) => ({ update, turn: "t" })),
      ).values(),
    ];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "output",
      data: { status: "exited", exitCode: 0 },
    });
    if (records[0].kind === "output")
      expect(outputText(records[0].data)).toBe("final");
  });
  it("Claude correlates tool results with invocation inputs and emits replacement plans", () => {
    const { adapter, updates } = capture(Claude, "claude");
    adapter.message({
      type: "assistant",
      message: {
        id: "m",
        content: [
          {
            type: "tool_use",
            id: "b",
            name: "Bash",
            input: { command: "echo hi" },
          },
          {
            type: "tool_use",
            id: "p",
            name: "TodoWrite",
            input: { todos: [{ content: "check", status: "in_progress" }] },
          },
        ],
      },
    });
    adapter.message({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "b", content: "hi" }],
      },
    });
    expect(updates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "plan" }),
        expect.objectContaining({
          kind: "output",
          patch: expect.objectContaining({
            command: "echo hi",
            status: "exited",
          }),
        }),
      ]),
    );
  });
  it("Pi retains inputs across partial and final events", () => {
    const { adapter, updates } = capture(Pi, "pi");
    adapter.message({
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "bash",
      args: { command: "pwd" },
    });
    adapter.message({
      type: "tool_execution_update",
      toolCallId: "b",
      partialResult: { content: [{ type: "text", text: "/fi" }] },
    });
    adapter.message({
      type: "tool_execution_end",
      toolCallId: "b",
      result: { content: [{ type: "text", text: "/fixture" }] },
    });
    expect(updates().at(-1)).toMatchObject({
      kind: "output",
      patch: {
        command: "pwd",
        status: "exited",
        replace: [{ text: "/fixture" }],
      },
    });
  });
  it("OpenCode rejects another session and previous turns", () => {
    const { adapter, updates } = capture(OpenCode, "opencode");
    adapter.session = "s";
    adapter.activeTurn = true;
    const part = {
      id: "b",
      messageID: "m",
      sessionID: "other",
      type: "tool",
      tool: "bash",
      state: { status: "completed", output: "ok", input: { command: "test" } },
    };
    adapter.part(part);
    expect(updates()).toHaveLength(0);
    adapter.part({ ...part, sessionID: "s" });
    expect(updates()[0]).toMatchObject({ kind: "output" });
    adapter.previousMessages.add("old");
    adapter.part({ ...part, sessionID: "s", messageID: "old" });
    expect(updates()).toHaveLength(1);
  });
});
describe("direct control authority", () => {
  it("keeps pending separate, rejects stale/concurrent writes, confirms at boundary", async () => {
    const events: any[] = [];
    const c = new DirectControls("codex", (e) => events.push(e));
    c.publish([
      {
        id: "model",
        confirmed: "a",
        mutable: true,
        choices: [{ value: "b", label: "B" }],
        application: "next-turn",
      },
    ]);
    await c.change("model", "b", 1, async () => undefined);
    expect(c.settings.options[0]).toMatchObject({
      confirmed: "a",
      requested: "b",
    });
    await expect(c.change("model", "b", 1, async () => [])).rejects.toThrow(
      "changed",
    );
    c.confirmNextTurn();
    expect(c.settings.options[0]).toMatchObject({ confirmed: "b" });
    expect(c.settings.options[0].requested).toBeUndefined();
    for (const e of events.filter((e) => e.type === "activity"))
      expect(ActivityUpdate.safeParse(e.activity).success).toBe(true);
  });
  it("retains confirmed values after a failure and removes dependent settings", async () => {
    const events: any[] = [];
    const c = new DirectControls("pi", (e) => events.push(e));
    c.publish([
      { id: "model", confirmed: "a", mutable: true },
      { id: "effort", confirmed: "high" },
    ]);
    await expect(
      c.change("model", "b", 1, async () => {
        throw new Error("Denied");
      }),
    ).rejects.toThrow("Denied");
    expect(c.settings.options[0]).toMatchObject({
      confirmed: "a",
      rejected: "Denied",
    });
    c.publish([{ id: "model", confirmed: "a" }]);
    expect(events.at(-1).activity.patch.remove).toEqual(["effort"]);
  });
});

it("Pi confirms runtime-normalized settings and dependent levels instead of echoing the request", async () => {
  const { adapter } = capture(Pi, "pi");
  adapter.models = [{ id: "provider/model", name: "Model" }];
  adapter.displayControls.publish([
    {
      id: "effort",
      confirmed: "low",
      mutable: true,
      choices: [{ value: "high", label: "High" }],
    },
  ]);
  const calls: string[] = [];
  adapter.native = {
    request: async (method: string) => {
      calls.push(method);
      if (method === "get_state")
        return {
          model: { provider: "provider", id: "model" },
          thinkingLevel: "medium",
        };
      if (method === "get_available_thinking_levels")
        return { levels: ["low", "medium"] };
      return {};
    },
  };
  const result = await adapter.setSetting("effort", "high", 1);
  expect(result.options.find((o: any) => o.id === "effort")).toMatchObject({
    confirmed: "medium",
    choices: [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
    ],
  });
  expect(calls).toEqual([
    "set_thinking_level",
    "get_state",
    "get_available_thinking_levels",
  ]);
});

it("Claude mode is confirmed only after its control response", async () => {
  const { adapter } = capture(Claude, "claude");
  adapter.displayControls.publish(adapter.sessionOptions("m"));
  let release!: () => void;
  adapter.control = async (request: any) => {
    expect(request).toEqual({ subtype: "set_permission_mode", mode: "plan" });
    await new Promise<void>((r) => (release = r));
  };
  const changing = adapter.setSetting("mode", "plan", 1);
  expect(
    adapter.settings.options.find((o: any) => o.id === "mode"),
  ).toMatchObject({ requested: "plan" });
  expect(adapter.permissionMode).toBeUndefined();
  release();
  await changing;
  expect(
    adapter.settings.options.find((o: any) => o.id === "mode"),
  ).toMatchObject({ confirmed: "plan" });
});

it("Codex queues choices without replacing the confirmed model and applies them to its existing thread", async () => {
  const { adapter } = capture(Codex, "codex");
  adapter.thread = "same-thread";
  adapter.models = [
    { id: "a", name: "A" },
    { id: "b", name: "B", effortLevels: [{ value: "low" }] },
  ];
  adapter.displayControls.publish(adapter.sessionOptions("a"));
  const pending = await adapter.setSetting("model", "b", 1);
  expect(pending.options.find((o: any) => o.id === "model")).toMatchObject({
    confirmed: "a",
    requested: "b",
  });
  adapter.native = {
    request: async (method: string, params: any) => {
      expect(method).toBe("turn/start");
      expect(params).toMatchObject({ threadId: "same-thread", model: "b" });
      return { turn: { id: "t", status: "inProgress" } };
    },
  };
  await adapter.prompt("Continue");
  expect(
    adapter.settings.options.find((o: any) => o.id === "model"),
  ).toMatchObject({ confirmed: "b" });
});

it("catalog rediscovery replaces removals and disposal drops late results", async () => {
  const c = new DirectControls("pi", () => {});
  c.publish(
    [],
    [{ name: "old", token: "/old", kind: "command", description: "" }],
  );
  let selected: any[] = [];
  c.refresh(
    async () => [],
    (commands) => {
      selected = commands;
    },
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(selected).toEqual([]);
  expect(c.commands.commands).toEqual([]);
  const stopped = new DirectControls("pi", () => {});
  let release!: (c: any[]) => void;
  stopped.refresh(
    () => new Promise((resolve) => (release = resolve)),
    () => {
      throw new Error("Late catalog must not apply");
    },
  );
  stopped.stop();
  release([{ name: "late", token: "/late", kind: "command", description: "" }]);
  await new Promise((r) => setTimeout(r, 0));
  expect(stopped.commands.commands).toEqual([]);
});

it("retains old-turn activity snapshots during pagination and ignores older revisions", async () => {
  const { mergeActivitySnapshots } =
    await import("../src/client/activitySnapshots");
  const update: any = {
    v: 1,
    kind: "plan",
    id: "plan",
    source: { transport: "native", harness: "codex", origin: "test" },
    patch: { steps: [] },
  };
  const records = [...reduceActivities([{ update, turn: "old" }]).values()];
  const older = { record: records[0], run_id: "old" };
  const newer = { record: { ...records[0], revision: 5 }, run_id: "old" };
  const other = { record: records[0], run_id: "new" };
  const merged = mergeActivitySnapshots([newer, other], [older]);
  expect(merged).toHaveLength(2);
  expect(merged[0].record.revision).toBe(5);
});

it("Codex rejects foreign-thread and previous-turn rich events before emission", () => {
  const { adapter, updates } = capture(Codex, "codex");
  adapter.thread = "current";
  adapter.turn = "turn-2";
  for (const params of [
    { threadId: "foreign", turnId: "turn-2" },
    { threadId: "current", turnId: "turn-1" },
  ])
    adapter.message({
      method: "item/commandExecution/outputDelta",
      params: { ...params, itemId: "c", delta: "wrong" },
    });
  expect(updates()).toHaveLength(0);
});

it("direct output has instance-local ordering and duplicate-safe chunk indices", () => {
  const first = capture(Codex, "codex");
  for (const delta of ["a", "b"])
    first.adapter.message({
      method: "item/commandExecution/outputDelta",
      params: { itemId: "c", delta },
    });
  const updates = first.updates();
  expect(updates.map((u: any) => u.seq)).toEqual([1, 2]);
  expect(updates.map((u: any) => u.patch.append[0].index)).toEqual([0, 1]);
  const records = [
    ...reduceActivities(
      [updates[0], updates[1], updates[0]].map((update) => ({
        update,
        turn: "t",
      })),
    ).values(),
  ];
  expect(outputText((records[0] as any).data)).toBe("ab");
  const second = capture(Codex, "codex");
  second.adapter.message({
    method: "item/commandExecution/outputDelta",
    params: { itemId: "c", delta: "new" },
  });
  expect(second.updates()[0].seq).toBe(1);
});

it("new producer generations replace settings and command revisions without stale choices", async () => {
  const { reduceActivity } = await import("../src/agent-activities");
  const source = {
    transport: "native" as const,
    harness: "codex",
    origin: "controls",
  };
  const old = reduceActivity(undefined, {
    v: 1,
    kind: "settings",
    id: "s",
    source,
    generation: "old",
    patch: {
      revision: 90,
      options: [{ id: "old", type: "text", mutable: true, confirmed: "stale" }],
    },
  }).record;
  const next = reduceActivity(old, {
    v: 1,
    kind: "settings",
    id: "s",
    source,
    generation: "new",
    patch: {
      revision: 1,
      options: [{ id: "new", type: "text", mutable: true, confirmed: "fresh" }],
    },
  });
  expect(next.record!.data).toMatchObject({
    revision: 1,
    options: [{ id: "new", confirmed: "fresh" }],
  });
  expect((next.record!.data as any).options).toHaveLength(1);
  const commands = reduceActivity(undefined, {
    v: 1,
    kind: "commands",
    id: "c",
    source,
    generation: "old",
    patch: { revision: 90, commands: [] },
  }).record;
  expect(
    reduceActivity(commands, {
      v: 1,
      kind: "commands",
      id: "c",
      source,
      generation: "new",
      patch: { revision: 1, commands: [] },
    }).record!.data,
  ).toMatchObject({ revision: 1 });
});

it("incremental durable broker cards replace legacy cards without merging distinct runs", async () => {
  const { visibleActivities, mergeActivities } =
    await import("../src/client/activityView");
  const legacy = {
    key: "legacy",
    kind: "tool" as const,
    run: "r",
    sequence: 0,
    legacy: true,
    record: { v: 1, id: "tool:b", kind: "tool" },
  };
  const durable = {
    key: "durable",
    kind: "tool" as const,
    run: "r",
    sequence: 2,
    record: {
      v: 1,
      id: "b",
      kind: "tool",
      data: { links: { trace: "tool:b" } },
    },
  };
  const other = { ...legacy, key: "other", run: "other" };
  expect(
    visibleActivities(
      mergeActivities([legacy, other], { items: [durable] }),
    ).map((i) => i.key),
  ).toEqual(["other", "durable"]);
});

it("pairs persisted controls with capabilities from the same harness and generation", async () => {
  const { recordedSessionControls } =
    await import("../src/client/activityView");
  const settings = {
    kind: "settings",
    generation: "new",
    source: { transport: "native", harness: "codex" },
  };
  const matching = {
    kind: "capabilities",
    generation: "new",
    source: settings.source,
    capabilities: { settings: { state: "supported" } },
  };
  const records = [
    settings,
    matching,
    { ...matching, generation: "old" },
    { ...matching, source: { transport: "acp", harness: "acp" } },
  ];
  expect(
    recordedSessionControls(
      records.map((record) => ({ kind: record.kind, record })) as any,
    ),
  ).toEqual({
    settings,
    capabilities: matching.capabilities,
    capabilityGeneration: "new",
  });
  expect(
    recordedSessionControls([{ kind: "settings", record: settings }] as any)
      .capabilities,
  ).toBeUndefined();
});
