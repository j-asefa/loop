import { seedConnection } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { memoryRoutes, captureMemory } = await import("../src/server/memory");
const { evaluate, sample, sampleQueries, table, HEAD_CHARACTERS } =
  await import("../scripts/memory-recall-eval");
const app = await productionApp("alice", [memoryRoutes], {
  ownerHeader: "x-owner",
});
afterAll(async () => {
  await app.close();
  db.close();
});

async function note(title: string, content: string, owner = "alice") {
  const response = await fetch(app.url + "/api/memory/notes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner": owner },
    body: JSON.stringify({ title, content }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}
function agentFor(owner: string) {
  const connection = id();
  seedConnection(db, {
    id: connection,
    owner_id: owner,
    provider: "openai",
    secret: seal("fixture", owner),
    models: JSON.stringify([{ id: "fixture" }]),
    created_at: now(),
  });
  return createAgent(owner, {
    name: "eval-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
}

it("samples deterministically", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  expect(sample(items, 10, 7)).toEqual(sample(items, 10, 7));
  expect(sample(items, 10, 7)).not.toEqual(sample(items, 10, 8));
  expect(new Set(sample(items, 50, 3)).size).toBe(50);
});

it("selects a result's own prompt as a known item and prompts that left nothing as null queries", async () => {
  const agent = agentFor("alice");
  const answered = submit("alice", {
    agentId: agent.id,
    input: "Why did the borealis build fail?",
    idempotencyKey: id(),
    personal: true,
  });
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      yield { text: "The borealis build ran on the x64 runner, not arm64." };
    },
  });
  try {
    const claimed = claim("memory-eval-worker")!;
    expect(claimed.id).toBe(answered.id);
    expect(await executeAgent(claimed)).toMatchObject({ kind: "finished" });
    transition(claimed, "completed");
  } finally {
    restore();
  }
  // A prompt whose conversation produced nothing, and one the owner did not
  // type (agent mail), which is neither.
  const unanswered = submit("alice", {
    agentId: agentFor("alice").id,
    input: "Draft the aurora rollout plan",
    idempotencyKey: id(),
    personal: true,
  });
  submit("alice", {
    agentId: agentFor("alice").id,
    input: "Mail about the aurora rollout",
    idempotencyKey: id(),
    personal: false,
  });
  captureMemory();

  const { queries } = await sampleQueries({ seed: 1, limit: 100 });
  const known = queries.filter((q) => q.set === "known");
  expect(known).toEqual([
    expect.objectContaining({
      owner: "alice",
      query: "Why did the borealis build fail?",
      deep: false,
    }),
  ]);
  const nulls = queries.filter((q) => q.set === "null");
  expect(nulls.map((q) => q.query)).toContain("Draft the aurora rollout plan");
  expect(nulls.map((q) => q.query)).not.toContain(
    "Mail about the aurora rollout",
  );
  expect(nulls.find((q) => q.query.includes("aurora"))?.conversation).toBe(
    unanswered.conversation_id,
  );

  const metrics = await evaluate(known);
  expect(metrics).toMatchObject({ known: 1, hit1: 1, hit5: 1, mrr5: 1 });
});

it("computes each metric from production recall", async () => {
  const head = await note(
    "Zircon deploy",
    "zircon deploy steps: migrate first, then restart the workers.",
  );
  const deep = await note(
    "Long log",
    "lorem ".repeat(600) + "the kestrel migration window is sunday night",
  );
  const unreachable = await note("Ferry", "boats leave at noon");
  await note("Bob's zircon", "zircon deploy secrets for bob", "bob");
  const base = { owner: "alice", project: null } as const;
  const metrics = await evaluate(
    [
      {
        ...base,
        set: "known",
        query: "zircon deploy",
        target: head,
        deep: false,
        targetCoverage: 1,
      },
      {
        ...base,
        set: "known",
        query: "kestrel migration window",
        target: deep,
        deep: true,
        targetCoverage: 1,
      },
      {
        ...base,
        set: "known",
        query: "harbour departure timetable",
        target: unreachable,
        deep: false,
        targetCoverage: 0,
      },
      { ...base, set: "null", query: "unrelated nebulous wording" },
    ],
    { skipped: 2, warmup: 0 },
  );
  expect(HEAD_CHARACTERS).toBe(1100);
  // Recall judges relevance on the excerpt it shows, the first 1,100
  // characters, so the deep note's matching sentence is never seen: a miss
  // that is not a vocabulary miss (the note holds every query term).
  expect(metrics).toMatchObject({
    known: 3,
    deep: 1,
    null: 1,
    skipped: 2,
    hit1: 1 / 3,
    hit5: 1 / 3,
    mrr5: 1 / 3,
    abstainKnown: 2 / 3,
    abstainNull: 1,
    misses5: 2,
    vocabMisses5: 1,
    vocabMissShare: 1 / 2,
    deepHit5: 0,
    excerptCoverage: 1,
    deepCoverage: 0,
  });
  expect(metrics.injectedMean).toBeGreaterThan(0);
  expect(metrics.latencyP95Ms).toBeGreaterThanOrEqual(0);
  const rendered = table([
    ["base", metrics],
    ["head", metrics],
  ]);
  expect(rendered).toContain("| hit@5 | 33.3% | 33.3% |");
  expect(rendered).toContain("| vocab miss share | 50.0% | 50.0% |");
});
