import { seedConnection } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { settleRun } from "./helpers/run-outcome.js";
import { afterAll, expect, it } from "vitest";
import { DISPLAY_LIMITS } from "../src/shared/display-spec.js";

testDirectory();
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { nativeBindings, invokeNative, runtimeInstructions, PLAN_GUIDANCE } =
  await import("../src/server/native-tools");
const { applyActivity, listActivities, activityRoutes } =
  await import("../src/server/activities");
const app = await productionApp("alice", [activityRoutes], {
  ownerHeader: "x-owner",
});
const base = app.url + "/api";
const get = async (path: string, owner = "alice") => {
  const res = await fetch(base + path, { headers: { "x-owner": owner } });
  return { status: res.status, body: await res.json() };
};
afterAll(async () => {
  await app.close();
  db.close();
});
function agent(owner = "alice") {
  const connection = id();
  seedConnection(db, {
    id: connection,
    owner_id: owner,
    secret: seal("fixture", owner),
    models: JSON.stringify([{ id: "fixture" }]),
    created_at: now(),
  });
  return createAgent(owner, {
    name: "activity-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
}
const steps = (statuses: string[]) =>
  statuses.map((status, i) => ({ id: "s" + i, title: "Step " + i, status }));

it.each([
  ["oversized source", " ".repeat(6 * DISPLAY_LIMITS.source), "Block exceeds"],
  ["invalid arguments", 42, "source as a string"],
])(
  "returns a checker diagnostic to the API provider for %s and continues the run",
  async (_case, spec, diagnostic) => {
    const a = agent();
    submit("alice", {
      agentId: a.id,
      input: "Check my display",
      idempotencyKey: id(),
    });
    const run = claim("display-check-worker")!;
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_secret, input) {
        const result = input.messages.find(
          (message) => message.role === "tool",
        );
        if (!result) {
          yield {
            toolCall: {
              id: "check-display",
              name: "loop_check_display",
              arguments: { spec },
            },
          };
          return;
        }
        expect(result.content).toContain(diagnostic);
        yield { text: "I can fix the display." };
      },
    });
    try {
      await expect(executeAgent(run)).resolves.toMatchObject({
        kind: "finished",
      });
      transition(run, "completed");
      expect(
        db.prepare("SELECT result FROM runs WHERE id = ?").get(run.id),
      ).toEqual({ result: "I can fix the display." });
    } finally {
      restore();
    }
  },
);

it("API-provider runs publish structured plans, tool lifecycle and confirmed settings", async () => {
  const a = agent();
  submit("alice", {
    agentId: a.id,
    input: "Plan then act",
    idempotencyKey: id(),
  });
  const run = claim("activity-worker")!;
  let advertised: string[] = [];
  let planDescription = "";
  let instructions: string[] = [];
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      advertised = (input.tools || []).map((t: any) => t.name);
      instructions.push(input.instructions);
      planDescription =
        input.tools?.find((t: any) => t.name === "loop_plan")?.description ||
        "";
      const round = input.messages.filter((m) => m.role === "tool").length;
      if (round === 0)
        yield {
          toolCall: {
            id: "plan-1",
            name: "loop_plan",
            arguments: { steps: steps(["in_progress", "pending"]) },
          },
        };
      else if (round === 1)
        yield {
          toolCall: {
            id: "diagram-1",
            name: "loop_diagram",
            arguments: { title: "Flow", source: "graph TD; A-->B" },
          },
        };
      else if (round === 2)
        yield {
          toolCall: {
            id: "plan-2",
            name: "loop_plan",
            arguments: {
              steps: steps(["completed", "completed"]),
              explanation: "Done",
            },
          },
        };
      else if (round === 3)
        // A model re-sending the same final plan under a new call id.
        yield {
          toolCall: {
            id: "plan-3",
            name: "loop_plan",
            arguments: {
              steps: steps(["completed", "completed"]),
              explanation: "Done",
            },
          },
        };
      else yield { text: "All done." };
    },
  });
  try {
    expect(await executeAgent(run)).toMatchObject({ kind: "finished" });
    transition(run, "completed");
  } finally {
    restore();
  }
  expect(advertised).toContain("loop_plan");
  // The tool description says how to call loop_plan; the run instructions
  // say when. This agent has no instructions of its own, so every provider
  // round receives exactly Loop's plan guidance.
  expect(planDescription).toMatch(/keep step ids stable/i);
  expect(instructions).toHaveLength(5);
  expect(new Set(instructions)).toEqual(new Set([PLAN_GUIDANCE]));
  expect(PLAN_GUIDANCE).toMatch(/loop_plan/);
  expect(PLAN_GUIDANCE).toMatch(/complete updated list/);
  const { status, body } = await get(
    `/conversations/${run.conversation_id}/activities`,
  );
  expect(status).toBe(200);
  expect(body.version).toBe(1);
  const byKind = (kind: string) =>
    body.items.filter((i: any) => i.kind === kind);
  const [plan] = byKind("plan");
  expect(plan.run).toBe(run.id);
  expect(plan.record.data).toMatchObject({ revision: 2, explanation: "Done" });
  expect(plan.record.data.steps.map((s: any) => s.status)).toEqual([
    "completed",
    "completed",
  ]);
  // The plan tool is shown as a plan, not also as a tool card.
  const tools = byKind("tool");
  expect(tools).toHaveLength(1);
  expect(tools[0].record.data).toMatchObject({
    title: "loop_diagram",
    status: "completed",
    links: { broker: "diagram-1", trace: "tool:diagram-1" },
  });
  expect(tools[0].record.data.content[0]).toMatchObject({ type: "artifact" });
  const [settings] = byKind("settings");
  expect(settings.run).toBeNull();
  expect(settings.record.data.options[0]).toMatchObject({
    id: "model",
    confirmed: "fixture",
    mutable: false,
    application: "next-turn",
  });
  const [caps] = byKind("capabilities");
  expect(caps.record.capabilities).toMatchObject({
    plans: { state: "supported" },
    diffs: { state: "unsupported" },
    output: { state: "unsupported" },
    commands: { state: "unsupported" },
  });
  // Incremental sync returns only newer changes.
  const after = await get(
    `/conversations/${run.conversation_id}/activities?after=${body.cursor}`,
  );
  expect(after.body.items).toEqual([]);
  // Another owner cannot read the conversation's activities.
  expect(
    (await get(`/conversations/${run.conversation_id}/activities`, "bob"))
      .status,
  ).toBe(404);
});

it("serves a running card's activity line without output or diffs", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "x",
    idempotencyKey: id(),
  });
  const conversation = run.conversation_id!;
  const scope = { owner: "alice", conversation, run: run.id, generation: "g1" };
  const source = { transport: "native" as const, origin: "fixture" };
  const write = (update: object) =>
    expect(
      applyActivity(scope, { v: 1, source, generation: "g1", ...update } as any)
        .applied,
    ).toBe(true);
  write({
    kind: "output",
    id: "o1",
    patch: {
      command: "npm test",
      status: "running",
      append: [{ stream: "stdout", text: "OUTPUT-TEXT" }],
    },
  });
  // Written later, so newer, but finished: the running command still leads.
  write({
    kind: "file_change",
    id: "f1",
    patch: {
      state: "applied",
      files: [{ path: "src/a.ts", operation: "modify", patch: "DIFF-TEXT" }],
    },
  });
  const path = `/conversations/${conversation}/activity-line?run=${run.id}`;
  const { status, body } = await get(path);
  expect(status).toBe(200);
  expect(body).toEqual({ line: { text: "npm test", state: "live" } });
  expect(JSON.stringify(body)).not.toMatch(/OUTPUT-TEXT|DIFF-TEXT/);
  // Once the command exits, the newest step leads.
  write({ kind: "output", id: "o1", patch: { status: "exited", exitCode: 0 } });
  expect((await get(path)).body.line).toMatchObject({ state: "done" });
  // Many newer finished steps do not hide a step still running.
  write({
    kind: "tool",
    id: "t-live",
    patch: { title: "Build", status: "running" },
  });
  for (let i = 0; i < 60; i++)
    write({
      kind: "tool",
      id: "t" + i,
      patch: { title: "Read " + i, status: "completed" },
    });
  expect((await get(path)).body.line).toEqual({ text: "Build", state: "live" });
  // Another run of the conversation has no line.
  expect(
    (await get(`/conversations/${conversation}/activity-line?run=${id()}`))
      .body,
  ).toEqual({ line: null });
  // Another owner cannot read it.
  expect((await get(path, "bob")).status).toBe(404);
});

it("adds plan guidance only when loop_plan is advertised", () => {
  const plan = { tool: "loop_plan", connectionId: "__loop__" };
  expect(runtimeInstructions("Cite sources.", [plan])).toBe(
    "Cite sources.\n\n" + PLAN_GUIDANCE,
  );
  expect(runtimeInstructions("  ", [plan])).toBe(PLAN_GUIDANCE);
  // A run without bindings gets no guidance; an MCP tool that happens to share
  // the name is not Loop's plan tool.
  expect(runtimeInstructions("Cite sources.", [])).toBe("Cite sources.");
  expect(
    runtimeInstructions("Cite sources.", [
      { tool: "loop_plan", connectionId: "mcp-1" },
    ]),
  ).toBe("Cite sources.");
});

it("does not offer or accept the plan tool on the native bridge path", async () => {
  const a = agent();
  submit("alice", { agentId: a.id, input: "x", idempotencyKey: id() });
  const run = claim("bridge-worker")!;
  expect(nativeBindings(run).map((b) => b.tool)).not.toContain("loop_plan");
  const binding = nativeBindings(run, { plans: true }).find(
    (b) => b.tool === "loop_plan",
  )!;
  // Native bridge callers do not pass { plans: true }, so a direct call is refused.
  await expect(
    invokeNative(run, binding, "p", {
      steps: [{ title: "x", status: "pending" }],
    }),
  ).rejects.toMatchObject({ status: 403 });
  transition(run, "completed");
});

it("rejects stale generations and invalid updates and ignores duplicates", () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "x",
    idempotencyKey: id(),
  });
  const scope = {
    owner: "alice",
    conversation: run.conversation_id,
    run: run.id,
    generation: "g2",
  };
  const update = {
    v: 1 as const,
    kind: "tool" as const,
    id: "t1",
    source: { transport: "native" as const, origin: "fixture" },
    generation: "g2",
    seq: 1,
    patch: { title: "Edit", status: "running" as const },
  };
  expect(applyActivity(scope, { ...update, generation: "g1" })).toMatchObject({
    applied: false,
    reason: "stale generation",
  });
  expect(
    applyActivity(scope, { ...update, patch: { status: "exploded" } }),
  ).toMatchObject({
    applied: false,
    reason: "invalid activity update",
  });
  const first = applyActivity(scope, update);
  expect(first.applied).toBe(true);
  expect(applyActivity(scope, update)).toMatchObject({
    applied: false,
    reason: "no change",
  });
  // Replayed history from an earlier generation may fill gaps but not execute.
  applyActivity(scope, {
    ...update,
    generation: "g1",
    replay: true,
    patch: { status: "completed", input: "a.ts" },
  });
  const [item] = listActivities("alice", run.conversation_id!).items.filter(
    (i: any) => i.kind === "tool",
  );
  expect(item.record.data).toMatchObject({ status: "running", input: "a.ts" });
  // Turn activities need trusted run scope.
  expect(
    applyActivity(
      { owner: "alice", conversation: run.conversation_id },
      update,
    ),
  ).toMatchObject({
    applied: false,
  });
});

it("resumes a stored legacy native tool binding through the API checkpoint caller", async () => {
  const a = agent();
  submit("alice", { agentId: a.id, input: "Plan", idempotencyKey: id() });
  const run = claim("legacy-checkpoint")!;
  let first = true;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      if (first) {
        first = false;
        yield {
          toolCall: {
            id: "legacy-plan",
            name: "loop_plan",
            arguments: { steps: steps(["pending"]) },
          },
        };
        transition(run, "pausing");
      } else yield { text: "Recovered." };
    },
  });
  try {
    expect(await settleRun(executeAgent, run)).toMatchObject({
      kind: "paused",
    });
    const checkpoint = db
      .prepare("SELECT pending,stage FROM agent_checkpoints WHERE run_id=?")
      .get(run.id) as any;
    expect(checkpoint.stage).toBe("tools");
    const pending = JSON.parse(checkpoint.pending);
    pending[0].binding.tool = "loop_plan";
    pending[0].binding.name = "loop_plan";
    pending[0].call.name = "loop_plan";
    db.prepare("UPDATE agent_checkpoints SET pending=? WHERE run_id=?").run(
      JSON.stringify(pending),
      run.id,
    );
    transition(run, "queued");
    const resumed = claim("legacy-resume")!;
    expect(resumed.id).toBe(run.id);
    expect(await executeAgent(resumed)).toMatchObject({ kind: "finished" });
    expect(
      db
        .prepare("SELECT call_id,tool FROM native_calls WHERE run_id=?")
        .all(run.id),
    ).toEqual([{ call_id: "legacy-plan", tool: "loop_plan" }]);
    expect(
      listActivities("alice", run.conversation_id!).items.some(
        (item: any) => item.kind === "plan",
      ),
    ).toBe(true);
    transition(resumed, "completed");
  } finally {
    restore();
  }
});
