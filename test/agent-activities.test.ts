import { SessionControls } from "../src/shared/session-controls";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMITS,
  activityKey,
  parseActivityUpdate,
  undiscoveredCapabilities,
  outputText,
  reduceActivities,
  reduceActivity,
  type ActivityRecord,
  type ActivityUpdate,
} from "../src/shared/agent-activities";

const source = {
  transport: "native" as const,
  harness: "codex",
  origin: "codex:item",
};
const tool = (
  patch: any,
  extra: Partial<ActivityUpdate> = {},
): ActivityUpdate =>
  ({
    v: 1,
    kind: "tool",
    id: "call-1",
    source,
    generation: "g1",
    patch,
    ...extra,
  }) as ActivityUpdate;
function fold(updates: ActivityUpdate[]) {
  let record: ActivityRecord | undefined;
  for (const u of updates) {
    const r = reduceActivity(record, u);
    if (r.changed) record = r.record;
  }
  return record!;
}

describe("partial updates", () => {
  it("keeps omitted fields and clears null ones", () => {
    const r = fold([
      tool({
        title: "Run tests",
        status: "running",
        input: "npm test",
        error: "x",
      }),
      tool({ status: "failed", error: null }),
    ]);
    expect(r.data).toMatchObject({
      title: "Run tests",
      input: "npm test",
      status: "failed",
    });
    expect("error" in r.data).toBe(false);
  });
  it("creates a partial record for updates that precede the initial one", () => {
    const first = fold([tool({ content: [{ type: "text", text: "late" }] })]);
    expect(first.partial).toBe(true);
    const done = fold([
      tool({ content: [{ type: "text", text: "late" }] }),
      tool({ title: "Read", status: "running" }),
    ]);
    expect(done.partial).toBe(false);
    expect(done.data).toMatchObject({
      title: "Read",
      content: [{ text: "late" }],
    });
  });
});

describe("ordering and duplicates", () => {
  it("ignores duplicate delivery without bumping revision", () => {
    const u = tool({ title: "A", status: "running" }, { seq: 1 });
    const a = reduceActivity(undefined, u);
    const b = reduceActivity(a.record, u);
    expect(b.changed).toBe(false);
    expect(b.record!.revision).toBe(1);
  });
  it("merges out-of-order updates by per-field sequence", () => {
    const r = fold([
      tool({ title: "New title", status: "completed" }, { seq: 3 }),
      tool({ title: "Old title", input: "late but unique" }, { seq: 2 }),
    ]);
    expect(r.data).toMatchObject({
      title: "New title",
      status: "completed",
      input: "late but unique",
    });
  });
  it("never regresses lifecycle, but resolves an unknown outcome", () => {
    expect(
      fold([tool({ status: "completed" }), tool({ status: "running" })]).data,
    ).toMatchObject({ status: "completed" });
    expect(
      fold([tool({ status: "failed" }), tool({ status: "completed" })]).data,
    ).toMatchObject({ status: "failed" });
    expect(
      fold([tool({ status: "unknown" }), tool({ status: "completed" })]).data,
    ).toMatchObject({ status: "completed" });
  });
  it("replay fills gaps but never overrides live state or executes lifecycle", () => {
    const live = fold([tool({ title: "Live", status: "running" })]);
    const replayed = reduceActivity(
      live,
      tool(
        { title: "Replay", status: "completed", input: "x" },
        { replay: true },
      ),
    );
    expect(replayed.record!.data).toMatchObject({
      title: "Live",
      status: "running",
      input: "x",
    });
    const onlyReplay = fold([
      tool({ title: "Hist", status: "completed" }, { replay: true }),
    ]);
    expect(onlyReplay.replayed).toBe(true);
    expect(onlyReplay.data).toMatchObject({ status: "completed" });
  });
  it("a new generation adopts the record and resets sequence ordering", () => {
    const r = fold([
      tool({ title: "g1" }, { seq: 50 }),
      tool({ title: "g2" }, { seq: 1, generation: "g2" }),
    ]);
    expect(r.generation).toBe("g2");
    expect(r.data).toMatchObject({ title: "g2" });
  });
  it("rejects an identity mismatch", () => {
    const r = fold([tool({ title: "a" })]);
    expect(() => reduceActivity(r, { ...tool({}), id: "other" })).toThrow();
  });
});

describe("plans", () => {
  const plan = (steps: any[], extra = {}): ActivityUpdate =>
    ({
      v: 1,
      kind: "plan",
      id: "plan",
      source,
      patch: { steps },
      ...extra,
    }) as ActivityUpdate;
  it("replaces the step list and counts revisions", () => {
    const r = fold([
      plan([{ id: "a", title: "Inspect", status: "in_progress" }]),
      plan([
        { id: "a", title: "Inspect", status: "completed" },
        { id: "b", title: "Fix", status: "pending" },
      ]),
    ]);
    expect(r.kind === "plan" && r.data.revision).toBe(2);
    expect(r.kind === "plan" && r.data.steps.map((s) => s.status)).toEqual([
      "completed",
      "pending",
    ]);
  });
  it("treats a re-delivered identical plan as no change", () => {
    const steps = [
      { id: "a", title: "Inspect", status: "completed" },
      { id: "b", title: "Fix", status: "in_progress" },
    ];
    const first = reduceActivity(undefined, plan(steps));
    expect(first.changed).toBe(true);
    const again = reduceActivity(first.record, plan(structuredClone(steps)));
    expect(again).toMatchObject({ changed: false, reason: "no change" });
    expect(again.record).toBe(first.record);
    // Unsequenced duplicates interleaved with real changes count once each.
    const r = fold([
      plan(steps),
      plan(steps),
      plan([{ ...steps[0] }, { ...steps[1], status: "completed" }]),
      plan([{ ...steps[0] }, { ...steps[1], status: "completed" }]),
    ]);
    expect(r.kind === "plan" && r.data.revision).toBe(2);
    expect(r.revision).toBe(2);
  });
  it("counts a reorder or retitle as a replacement", () => {
    const a = { id: "a", title: "Inspect", status: "pending" };
    const b = { id: "b", title: "Fix", status: "pending" };
    const r = fold([
      plan([a, b]),
      plan([b, a]),
      plan([b, { ...a, title: "Inspect logs" }]),
    ]);
    expect(r.kind === "plan" && r.data.revision).toBe(3);
  });
  it("validates statuses", () => {
    expect(() =>
      reduceActivity(
        undefined,
        plan([{ id: "a", title: "x", status: "done" }]),
      ),
    ).toThrow();
  });
});

describe("file changes", () => {
  const change = (patch: any): ActivityUpdate =>
    ({ v: 1, kind: "file_change", id: "fc", source, patch }) as ActivityUpdate;
  it("supports create/delete/rename and binary fallback honestly", () => {
    const r = fold([
      change({
        state: "applied",
        files: [
          { path: "a.ts", operation: "create", after: "x" },
          { path: "b.ts", operation: "delete", before: "y" },
          { path: "c.ts", oldPath: "old.ts", operation: "rename" },
          { path: "logo.png", operation: "modify", content: "binary" },
        ],
      }),
    ]);
    expect(
      r.kind === "file_change" &&
        r.data.files.map((f) => [f.operation, f.content]),
    ).toEqual([
      ["create", "available"],
      ["delete", "available"],
      ["rename", "available"],
      ["modify", "binary"],
    ]);
  });
  it("marks oversized diffs rather than storing them", () => {
    const r = fold([
      change({
        files: [
          {
            path: "big",
            operation: "modify",
            patch: "x".repeat(ACTIVITY_LIMITS.diffBytes + 1),
          },
        ],
      }),
    ]);
    const f = r.kind === "file_change" && r.data.files[0];
    expect(f && f.content).toBe("oversized");
    expect(f && f.patch).toBeUndefined();
  });
  it("keeps proposed and applied distinct and does not regress", () => {
    expect(fold([change({ state: "proposed" })]).data).toMatchObject({
      state: "proposed",
    });
    expect(
      fold([change({ state: "applied" }), change({ state: "proposed" })]).data,
    ).toMatchObject({ state: "applied" });
  });
});

describe("command output", () => {
  const out = (patch: any): ActivityUpdate =>
    ({ v: 1, kind: "output", id: "o", source, patch }) as ActivityUpdate;
  it("orders indexed chunks, drops duplicates and keeps streams separate", () => {
    const r = fold([
      out({
        command: "ls",
        append: [{ stream: "stdout", text: "b", index: 1 }],
      }),
      out({ append: [{ stream: "stderr", text: "a", index: 0 }] }),
      out({
        append: [
          { stream: "stdout", text: "b", index: 1 },
          { stream: "stdout", text: "c", index: 2 },
        ],
      }),
      out({ status: "exited", exitCode: 2 }),
    ]);
    if (r.kind !== "output") throw new Error();
    expect(outputText(r.data)).toBe("abc");
    expect(outputText(r.data, "stderr")).toBe("a");
    expect(r.data).toMatchObject({
      status: "exited",
      exitCode: 2,
      streams: "separate",
    });
  });
  it("bounds retained output and records truncation", () => {
    const chunk = "x".repeat(20_000);
    const r = fold(
      Array.from({ length: 10 }, (_, i) =>
        out({ append: [{ stream: "stdout", text: chunk + i }] }),
      ),
    );
    if (r.kind !== "output") throw new Error();
    const size = new TextEncoder().encode(outputText(r.data)).length;
    expect(size).toBeLessThanOrEqual(ACTIVITY_LIMITS.outputBytes);
    expect(r.data.truncated.droppedBytes).toBeGreaterThan(0);
    expect(outputText(r.data).endsWith("9")).toBe(true);
    // A late duplicate of dropped output is not resurrected.
    const again = reduceActivity(
      r,
      out({ append: [{ stream: "stdout", text: "old", index: 0 }] }),
    );
    expect(again.changed).toBe(false);
  });
  it("replaces with final output when a source cannot stream", () => {
    const r = fold([
      out({
        replace: [{ stream: "combined", text: "all" }],
        status: "exited",
        exitCode: 0,
      }),
    ]);
    expect(r.kind === "output" && [outputText(r.data), r.data.streams]).toEqual(
      ["all", "combined"],
    );
  });
  it("skips a gap once too many chunks wait for it", () => {
    const r = fold([
      out({
        append: Array.from(
          { length: ACTIVITY_LIMITS.outputPending + 1 },
          (_, i) => ({ stream: "stdout", text: "y", index: i + 1 }),
        ),
      }),
    ]);
    expect(r.kind === "output" && r.data.truncated.droppedChunks).toBe(1);
  });
});

describe("settings and commands", () => {
  const settings = (patch: any, extra = {}): ActivityUpdate =>
    ({
      v: 1,
      kind: "settings",
      id: "session",
      source,
      patch,
      ...extra,
    }) as ActivityUpdate;
  it("keeps full session choices while rejecting an oversized activity delta", () => {
    const option = {
      id: "model",
      choices: Array.from({ length: 152 }, (_, i) => ({
        value: String(i),
        label: "model".repeat(101),
      })),
      confirmed: "0",
    };
    const controls = SessionControls.parse({
      generation: "g1",
      settings: { options: [option], revision: 1 },
      commands: { commands: [], revision: 1 },
      capabilities: undiscoveredCapabilities("fixture"),
    });
    expect(controls.settings.options[0].choices).toEqual(option.choices);
    expect(() =>
      parseActivityUpdate(settings({ options: [option] })),
    ).toThrow();
  });
  it("rejects unknown setting fields at ingestion but strips them from full controls", () => {
    const option = {
      id: "model",
      choices: [{ value: "a", label: "A", extra: true }],
      extra: true,
    };
    expect(() =>
      parseActivityUpdate(settings({ options: [option] })),
    ).toThrow();
    const controls = SessionControls.parse({
      generation: "g1",
      settings: { options: [option], revision: 1 },
      commands: { commands: [], revision: 1 },
      capabilities: undiscoveredCapabilities("fixture"),
    });
    expect(controls.settings.options).toEqual([
      { id: "model", choices: [{ value: "a", label: "A" }] },
    ]);
    expect(() =>
      parseActivityUpdate(
        settings({ options: [{ id: "model", confirmed: "x".repeat(1001) }] }),
      ),
    ).toThrow();
    expect(
      parseActivityUpdate(
        settings({
          options: [{ id: "model", confirmed: null, requested: false }],
        }),
      ),
    ).toMatchObject({
      patch: { options: [{ confirmed: null, requested: false }] },
    });
  });
  it("keeps requested values separate from confirmed ones", () => {
    const r = fold([
      settings({
        options: [
          {
            id: "model",
            label: "Model",
            type: "select",
            confirmed: "a",
            application: "next-turn",
            mutable: true,
          },
        ],
      }),
      settings({ options: [{ id: "model", requested: "b" }] }),
    ]);
    expect(r.kind === "settings" && r.data.options[0]).toMatchObject({
      confirmed: "a",
      requested: "b",
    });
    const rejected = reduceActivity(
      r,
      settings({ options: [{ id: "model", rejected: "Not allowed" }] }),
    );
    expect(
      rejected.record!.kind === "settings" && rejected.record!.data.options[0],
    ).toMatchObject({
      confirmed: "a",
      rejected: "Not allowed",
    });
    expect("requested" in (rejected.record as any).data.options[0]).toBe(false);
  });
  it("ignores stale revisions and removes options", () => {
    const r = fold([
      settings({
        revision: 2,
        options: [
          { id: "mode", confirmed: "ask" },
          { id: "x", confirmed: true },
        ],
      }),
      settings({ revision: 1, options: [{ id: "mode", confirmed: "stale" }] }),
      settings({ revision: 3, remove: ["x"] }),
    ]);
    expect(r.kind === "settings" && r.data.options).toEqual([
      { id: "mode", confirmed: "ask" },
    ]);
  });
  it("replaces command catalogs so removals are visible", () => {
    const cmds = (commands: any[], revision: number): ActivityUpdate =>
      ({
        v: 1,
        kind: "commands",
        id: "catalog",
        source,
        patch: { commands, revision },
      }) as ActivityUpdate;
    const r = fold([
      cmds(
        [
          { id: "review", token: "/review", name: "review" },
          { id: "init", token: "/init", name: "init" },
        ],
        1,
      ),
      cmds(
        [
          {
            id: "review",
            token: "/review",
            name: "review",
            description: "Review",
          },
        ],
        2,
      ),
      cmds([{ id: "gone", token: "/gone", name: "gone" }], 1),
    ]);
    expect(r.kind === "commands" && r.data.commands.map((c) => c.id)).toEqual([
      "review",
    ]);
  });
});

describe("keys and folding", () => {
  it("scopes turn activities by turn and session activities by conversation", () => {
    expect(activityKey(tool({}), "run-1")).toBe(
      "tool:native:codex:item:run-1:call-1",
    );
    expect(() => activityKey(tool({}))).toThrow();
    expect(activityKey({ kind: "commands", id: "c", source }, "ignored")).toBe(
      "commands:native:codex:item:session:c",
    );
  });
  it("reconstructs identical projections regardless of snapshot boundary", () => {
    const log = [
      {
        update: tool({ title: "t", status: "running" }, { seq: 1 }),
        turn: "r",
      },
      { update: tool({ status: "completed" }, { seq: 2 }), turn: "r" },
      { update: tool({ status: "completed" }, { seq: 2 }), turn: "r" },
    ];
    const all = reduceActivities(log);
    const snapshot = reduceActivities(log.slice(0, 1));
    const resumed = reduceActivities(log.slice(1), snapshot);
    expect([...resumed]).toEqual([...all]);
  });
});
