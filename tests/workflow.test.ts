import { afterAll, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-workflow-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { compile } = await import("../src/server/workflows/compiler");
const { startWorkflow } = await import("../src/server/workflows/runtime");
const { decide } = await import("../src/server/approvals");
const { withTestAdapter } = await import("../src/server/providers");
const { tick, execute } = await import("../src/server/worker");
const calls: any[] = [];
const resets = ["openai", "anthropic"].map((provider) =>
  withTestAdapter(provider as any, {
    async models() {
      return [];
    },
    async *stream(_s, input) {
      calls.push({ provider, ...input });
      yield {
        text:
          provider === "openai"
            ? "Draft: evidence first."
            : "Reviewed: " + input.messages.at(-1)?.content,
      };
    },
  }),
);
function agent(provider: string, name: string) {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice',?,?,?,'connected',?,?)",
  ).run(
    c,
    provider,
    "Fixture account",
    seal("fixture", "alice"),
    JSON.stringify([{ id: provider + "-test" }]),
    now(),
  );
  return createAgent("alice", {
    name,
    connectionId: c,
    model: provider + "-test",
  });
}
const a = agent("openai", "workflow-research"),
  b = agent("anthropic", "workflow-review");
const spec = {
  dsl: "loop.workflow/v1",
  title: "Bounded chain",
  inputs: { topic: { description: "Topic" } },
  agents: { research: a.id, review: b.id },
  steps: [
    {
      id: "draft",
      type: "agent",
      agent: "research",
      prompt: "Research {{inputs.topic}}",
    },
    {
      id: "approve",
      type: "approval",
      source: "draft",
      message: "Check the draft",
    },
    {
      id: "review",
      type: "agent",
      agent: "review",
      prompt: "Review {{steps.approve}}",
    },
    { id: "save", type: "save", source: "review", title: "Final brief" },
  ],
  outputs: { brief: "save" },
  folderId: null,
  limits: {
    maxCalls: 2,
    maxOutputTokens: 300,
    maxInputBytes: 3000,
    maxRunSeconds: 60,
  },
};
function save(value: any) {
  const w = id(),
    source = JSON.stringify(value),
    compiled = JSON.stringify(compile(source));
  db.prepare("INSERT INTO workflows VALUES(?,?,?,?,?,?,?)").run(
    w,
    "alice",
    value.title,
    1,
    source,
    compiled,
    now(),
  );
  db.prepare("INSERT INTO workflow_versions VALUES(?,?,?,?,?)").run(
    w,
    1,
    source,
    compiled,
    now(),
  );
  return w;
}
afterAll(() => {
  resets.forEach((f) => f());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("runs cross-provider fixture chain, waits for owner approval, consumes the first output, and saves once", async () => {
  const w = save(spec),
    run = startWorkflow(
      "alice",
      w,
      1,
      { topic: "order books" },
      "workflow-request-key",
    );
  expect(
    startWorkflow(
      "alice",
      w,
      1,
      { topic: "order books" },
      "workflow-request-key",
    ).id,
  ).toBe(run.id);
  await tick(execute);
  await tick(execute);
  await tick(execute);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "awaiting_approval",
  });
  expect(calls).toHaveLength(1);
  const approval = db
    .prepare("SELECT * FROM approvals WHERE run_id=?")
    .get(run.id) as any;
  expect(() => decide("bob", approval.id, "approve")).toThrow();
  decide("alice", approval.id, "approve");
  expect(() => decide("alice", approval.id, "approve")).toThrow();
  db.prepare("UPDATE agents SET model='future-model' WHERE id=?").run(b.id);
  await tick(execute);
  await tick(execute);
  await tick(execute);
  expect(calls[1].provider).toBe("anthropic");
  expect(calls[1].model).toBe("anthropic-test");
  expect(calls[1].maxTokens).toBe(300);
  expect(calls[1].messages[0].content).toContain("Draft: evidence first.");
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "completed",
  });
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM artifacts WHERE run_id=? AND title='Final brief'",
      )
      .get(run.id),
  ).toEqual({ n: 1 });
  expect(await tick(execute)).toBe(false);
});
it("rejects cycles, forward references, unknown bindings and unbounded model calls", () => {
  expect(() =>
    compile(
      JSON.stringify({
        ...spec,
        steps: [
          { id: "a", type: "agent", agent: "research", prompt: "{{steps.a}}" },
        ],
      }),
    ),
  ).toThrow(/forward/);
  expect(() =>
    compile(
      JSON.stringify({
        ...spec,
        steps: [{ id: "a", type: "agent", agent: "missing", prompt: "Hello" }],
      }),
    ),
  ).toThrow(/binding/);
  expect(() =>
    compile(
      JSON.stringify({ ...spec, limits: { ...spec.limits, maxCalls: 1 } }),
    ),
  ).toThrow(/budget/);
});
it("does not run a dependent step after rejection", async () => {
  db.prepare("UPDATE agents SET model='anthropic-test' WHERE id=?").run(b.id);
  const w = save(spec),
    run = startWorkflow(
      "alice",
      w,
      1,
      { topic: "risk" },
      "rejected-workflow-key",
    );
  await tick(execute);
  await tick(execute);
  await tick(execute);
  const approval = db
    .prepare("SELECT * FROM approvals WHERE run_id=?")
    .get(run.id) as any;
  decide("alice", approval.id, "reject");
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "failed",
  });
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM workflow_steps WHERE run_id=? AND step_id=?",
      )
      .get(run.id, "review"),
  ).toEqual({ n: 0 });
});

it("excludes child queue and pause intervals from the active workflow budget", async () => {
  let clock = Date.now();
  const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const { claim, transition } = await import("../src/server/queue");
  try {
    const short = {
      ...spec,
      steps: [
        spec.steps[0],
        { id: "save", type: "save", source: "draft", title: "Waited brief" },
      ],
      outputs: { brief: "save" },
    };
    const run = startWorkflow(
      "alice",
      save(short),
      1,
      { topic: "queue" },
      id(),
    );
    await tick(execute); // Enqueue the child.
    clock += 61_000;
    const child = claim("paused-worker")!;
    expect(child.agent_id).toBe(a.id);
    clock += 2_000;
    transition(child, "pausing");
    clock += 1_000;
    transition(child, "paused");
    clock += 91_000;
    transition(child, "queued");
    clock += 31_000;
    await tick(execute);
    expect(
      db
        .prepare("SELECT active_ms,active_since,state FROM runs WHERE id=?")
        .get(child.id),
    ).toEqual({ active_ms: 3_000, active_since: null, state: "completed" });
    await tick(execute);
    expect(
      db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
    ).toEqual({ state: "completed", error: null });
    expect(
      db
        .prepare(
          "SELECT content FROM artifacts WHERE run_id=? AND title='Waited brief'",
        )
        .get(run.id),
    ).toEqual({ content: "Draft: evidence first." });
  } finally {
    date.mockRestore();
  }
});

it("still rejects work exceeding the actual active execution budget", async () => {
  let clock = Date.now();
  const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      clock += 61_000;
      yield { text: "Slow work" };
    },
  });
  try {
    const short = {
      ...spec,
      steps: [
        spec.steps[0],
        { id: "save", type: "save", source: "draft", title: "Over budget" },
      ],
      outputs: { brief: "save" },
    };
    const run = startWorkflow("alice", save(short), 1, { topic: "slow" }, id());
    await tick(execute);
    await tick(execute);
    await tick(execute);
    expect(
      db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
    ).toEqual({
      state: "failed",
      error: "Workflow exceeded its active runtime budget",
    });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM artifacts WHERE run_id=? AND title='Over budget'",
        )
        .get(run.id),
    ).toEqual({ n: 0 });
  } finally {
    restore();
    date.mockRestore();
  }
});
