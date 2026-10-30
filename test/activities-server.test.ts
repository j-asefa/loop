import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop55-activities-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { recordTrace } = await import("../src/server/traces");
const { nativeBindings, invokeNative, runtimeInstructions, PLAN_GUIDANCE } =
  await import("../src/server/native-tools");
const { applyActivity, listActivities, activityRoutes } =
  await import("../src/server/activities");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(activityRoutes);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
const get = async (path: string, owner = "alice") => {
  const res = await fetch(base + path, { headers: { "x-owner": owner } });
  return { status: res.status, body: await res.json() };
};
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function agent(owner = "alice") {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return createAgent(owner, {
    name: "activity-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
}
const steps = (statuses: string[]) =>
  statuses.map((status, i) => ({ id: "s" + i, title: "Step " + i, status }));

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
        input.tools?.find((t: any) => t.name === "loop55_plan")?.description ||
        "";
      const round = input.messages.filter((m) => m.role === "tool").length;
      if (round === 0)
        yield {
          toolCall: {
            id: "plan-1",
            name: "loop55_plan",
            arguments: { steps: steps(["in_progress", "pending"]) },
          },
        };
      else if (round === 1)
        yield {
          toolCall: {
            id: "diagram-1",
            name: "loop55_diagram",
            arguments: { title: "Flow", source: "graph TD; A-->B" },
          },
        };
      else if (round === 2)
        yield {
          toolCall: {
            id: "plan-2",
            name: "loop55_plan",
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
            name: "loop55_plan",
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
    expect(await executeAgent(run)).toBe(true);
    transition(run, "completed");
  } finally {
    restore();
  }
  expect(advertised).toContain("loop55_plan");
  // The tool description says how to call loop55_plan; the run instructions
  // say when. This agent has no instructions of its own, so every provider
  // round receives exactly Loop55's plan guidance.
  expect(planDescription).toMatch(/complete updated list/);
  expect(instructions).toHaveLength(5);
  expect(new Set(instructions)).toEqual(new Set([PLAN_GUIDANCE]));
  expect(PLAN_GUIDANCE).toMatch(/loop55_plan/);
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
  expect(tools[0].legacy).toBeUndefined();
  expect(tools[0].record.data).toMatchObject({
    title: "loop55_diagram",
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

it("adds plan guidance only when loop55_plan is advertised", () => {
  const plan = { tool: "loop55_plan", connectionId: "__loop__" };
  expect(runtimeInstructions("Cite sources.", [plan])).toBe(
    "Cite sources.\n\n" + PLAN_GUIDANCE,
  );
  expect(runtimeInstructions("  ", [plan])).toBe(PLAN_GUIDANCE);
  // Workflow runs get no tools; an MCP tool that happens to share the name is
  // not Loop55's plan tool.
  expect(runtimeInstructions("Cite sources.", [])).toBe("Cite sources.");
  expect(
    runtimeInstructions("Cite sources.", [
      { tool: "loop55_plan", connectionId: "mcp-1" },
    ]),
  ).toBe("Cite sources.");
});

it("does not offer or accept the plan tool on the native bridge path", async () => {
  const a = agent();
  submit("alice", { agentId: a.id, input: "x", idempotencyKey: id() });
  const run = claim("bridge-worker")!;
  expect(nativeBindings(run).map((b) => b.tool)).not.toContain("loop55_plan");
  const binding = nativeBindings(run, { plans: true }).find(
    (b) => b.tool === "loop55_plan",
  )!;
  // Bridge and HAPI callers do not pass { plans: true }, so a direct call is refused.
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

it("projects legacy tool traces once and prefers activity records", () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "old",
    idempotencyKey: id(),
  });
  recordTrace(run as any, "tool:old-call", {
    kind: "tool",
    title: "legacy_tool",
    content: "legacy output",
    metadata: { state: "completed" },
  });
  recordTrace(run as any, "tool:new-call", {
    kind: "tool",
    title: "new_tool",
    metadata: { state: "running" },
  });
  applyActivity(
    { owner: "alice", conversation: run.conversation_id, run: run.id },
    {
      v: 1,
      kind: "tool",
      id: "new-call",
      source: { transport: "api", origin: "broker" },
      patch: {
        title: "new_tool",
        status: "running",
        links: { trace: "tool:new-call" },
      },
    },
  );
  const items = listActivities("alice", run.conversation_id!).items.filter(
    (i: any) => i.kind === "tool",
  );
  expect(items.map((i: any) => [i.record.data.title, !!i.legacy])).toEqual([
    ["legacy_tool", true],
    ["new_tool", false],
  ]);
  expect(items[0].record.data).toMatchObject({
    status: "completed",
    content: [{ type: "text", text: "legacy output" }],
  });
});

it("keeps internal native envelopes and receipts out of legacy activities", async () => {
  const a = agent();
  const run = submit("alice", {
    agentId: a.id,
    input: "old native",
    idempotencyKey: id(),
  });
  for (const [key, title, content, metadata] of [
    [
      "native:envelope",
      "StructuredOutput",
      "INTERNAL_ENVELOPE_SENTINEL",
      { native: true },
    ],
    [
      "native:envelope:result",
      "Tool result",
      "INTERNAL_RECEIPT_SENTINEL",
      { native: true },
    ],
    // A public tool with the same name is not the native envelope.
    [
      "tool:public",
      "StructuredOutput",
      "Public tool result",
      { state: "completed" },
    ],
    [
      "tool:review",
      "pull_request_review_write",
      "Public review failure",
      { state: "failed" },
    ],
  ] as const)
    recordTrace(run as any, key, { kind: "tool", title, content, metadata });
  const response = await get(
    `/conversations/${run.conversation_id}/activities`,
  );
  expect(response.status).toBe(200);
  expect(response.body.items.map((i: any) => i.record.id)).toEqual([
    "tool:public",
    "tool:review",
  ]);
  expect(JSON.stringify(response.body)).not.toMatch(
    /INTERNAL_(ENVELOPE|RECEIPT)_SENTINEL/,
  );
  expect(
    db.prepare("SELECT count(*) n FROM run_traces WHERE run_id=?").get(run.id),
  ).toEqual({ n: 4 });
});
