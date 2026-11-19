import { seedConnection } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const artifacts = await import("../src/server/sql/artifacts");
const { memoryRoutes, captureMemory } = await import("../src/server/memory");
const {
  evaluate,
  main,
  queryFingerprint,
  sample,
  sampleQueries,
  table,
  HEAD_CHARACTERS,
} = await import("../scripts/memory-recall-eval");
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
  const traceId = id();
  const traceTitle = "Runner diagnostic trace";
  const traceContent = "Runner diagnostic trace records disk quota";
  artifacts.insert(
    db,
    traceId,
    "alice",
    agent.id,
    answered.conversation_id,
    answered.id,
    traceTitle,
    "markdown",
    "trace",
    traceContent,
    "{}",
    null,
    now(),
  );
  artifacts.edit(db, traceTitle, traceContent, 1, 0, now(), traceId);
  // A prompt whose conversation produced nothing, and one the owner did not
  // type (agent mail), which is neither.
  const unanswered = submit("alice", {
    agentId: agentFor("alice").id,
    input: "Draft the aurora rollout plan",
    idempotencyKey: id(),
    personal: true,
  });
  const completedWithoutResult = claim("memory-eval-worker")!;
  expect(completedWithoutResult.id).toBe(unanswered.id);
  transition(completedWithoutResult, "completed");
  // A turn after a completed run never searches recall.
  const followUp = submit("alice", {
    agentId: unanswered.agent_id!,
    conversationId: unanswered.conversation_id!,
    input: "And the aurora rollback plan",
    idempotencyKey: id(),
    personal: true,
  });
  const claimedFollowUp = claim("memory-eval-worker")!;
  expect(claimedFollowUp.id).toBe(followUp.id);
  transition(claimedFollowUp, "failed");
  const failed = submit("alice", {
    agentId: agentFor("alice").id,
    input: "Draft an eclipse report",
    idempotencyKey: id(),
    personal: true,
  });
  const claimedFailed = claim("memory-eval-worker")!;
  expect(claimedFailed.id).toBe(failed.id);
  transition(claimedFailed, "failed");
  submit("alice", {
    agentId: failed.agent_id!,
    conversationId: failed.conversation_id!,
    input: "Retry the eclipse report",
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
  expect(
    db.prepare("SELECT 1 FROM memory_sources WHERE source_id=?").get(traceId),
  ).toBeDefined();
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
  expect(nulls.map((q) => q.query)).toContain("Retry the eclipse report");
  expect(nulls.map((q) => q.query)).not.toContain(
    "Mail about the aurora rollout",
  );
  expect(nulls.map((q) => q.query)).not.toContain(
    "And the aurora rollback plan",
  );
  expect(nulls.find((q) => q.query.includes("aurora"))?.conversation).toBe(
    unanswered.conversation_id,
  );

  const metrics = await evaluate(known);
  expect(metrics).toMatchObject({ known: 1, hit1: 1, hit5: 1, mrr5: 1 });

  // A result the owner's memory policy now excludes is not a known item:
  // recall could never return it, so it would count as a false miss.
  const policy = await fetch(app.url + "/api/memory/policy", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-owner": "alice" },
    body: JSON.stringify({
      scope: "conversation:" + answered.conversation_id,
      enabled: false,
    }),
  });
  expect(policy.status).toBe(200);
  expect(
    (await sampleQueries({ seed: 1, limit: 100 })).queries.filter(
      (q) => q.set === "known",
    ),
  ).toEqual([]);
  const setWorkspaceMemory = (enabled: boolean) =>
    fetch(app.url + "/api/memory/policy", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-owner": "alice" },
      body: JSON.stringify({ scope: "workspace", enabled }),
    });
  expect((await setWorkspaceMemory(false)).status).toBe(200);
  try {
    expect((await sampleQueries()).queries).toEqual([]);
  } finally {
    expect((await setWorkspaceMemory(true)).status).toBe(200);
  }
});

it("rejects comparisons across different query sets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-eval-comparison-"));
  const first = join(directory, "first.json");
  const second = join(directory, "second.json");
  const query = {
    set: "null",
    owner: "alice",
    project: null,
    query: "zircon",
  } as const;
  writeFileSync(
    first,
    JSON.stringify({ queryFingerprint: queryFingerprint([query]) }),
  );
  writeFileSync(
    second,
    JSON.stringify({
      queryFingerprint: queryFingerprint([{ ...query, query: "pelican" }]),
    }),
  );
  await expect(main(["--compare", first, second])).rejects.toThrow(
    "same sampled queries",
  );
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
  // The excerpt is the passage that matches, so the deep note's sentence,
  // past the first 1,100 characters, is shown in full.
  expect(metrics).toMatchObject({
    known: 3,
    deep: 1,
    null: 1,
    skipped: 2,
    hit1: 2 / 3,
    hit5: 2 / 3,
    mrr5: 2 / 3,
    abstainKnown: 1 / 3,
    abstainNull: 1,
    misses5: 1,
    vocabMisses5: 1,
    vocabMissShare: 1,
    deepHit5: 1,
    excerptCoverage: 1,
    deepCoverage: 1,
  });
  expect(metrics.injectedMean).toBeGreaterThan(0);
  expect(metrics.latencyP95Ms).toBeGreaterThanOrEqual(0);
  const rendered = table([
    ["base", metrics],
    ["head", metrics],
  ]);
  expect(rendered).toContain("| hit@5 | 66.7% | 66.7% |");
  expect(rendered).toContain("| vocab miss share | 100.0% | 100.0% |");
});

it("writes only to a database it copied, in a directory it started empty", async () => {
  const previous = process.env.LOOP_DATA_DIR;
  const data = mkdtempSync(join(tmpdir(), "memory-eval-"));
  try {
    delete process.env.LOOP_DATA_DIR;
    await expect(main([])).rejects.toThrow("empty directory");
    process.env.LOOP_DATA_DIR = data;
    // A directory holding a database the script did not build, such as the
    // live workspace or a link to it, is refused before anything opens it.
    writeFileSync(join(data, "loop.db"), "");
    await expect(main([])).rejects.toThrow("not built by --copy-from");
    await expect(main(["--copy-from", join(data, "loop.db")])).rejects.toThrow(
      "needs an empty LOOP_DATA_DIR",
    );
    // A copy that fails leaves no marker for a later run to trust.
    const failed = mkdtempSync(join(tmpdir(), "memory-eval-"));
    process.env.LOOP_DATA_DIR = failed;
    await expect(
      main(["--copy-from", join(failed, "missing.db")]),
    ).rejects.toThrow();
    expect(existsSync(join(failed, "memory-eval-copy"))).toBe(false);
    await expect(main([])).rejects.toThrow("not built by --copy-from");
    // The copy holds the owner's work, so the directory must be private.
    const open = mkdtempSync(join(tmpdir(), "memory-eval-"));
    chmodSync(open, 0o755);
    process.env.LOOP_DATA_DIR = open;
    await expect(main([])).rejects.toThrow("must be private");
  } finally {
    if (previous === undefined) delete process.env.LOOP_DATA_DIR;
    else process.env.LOOP_DATA_DIR = previous;
  }
});

it("scores only the sources the evidence block delivers", async () => {
  for (let index = 0; index < 5; index++)
    await note(`Pelican ${index}`, `pelican ledger ${index} `.repeat(80));
  const { searchMemory } = await import("../src/server/memory");
  const found = (
    await searchMemory("alice", null, "pelican ledger", { relevant: true })
  ).sources;
  expect(found).toHaveLength(5);
  // Five full excerpts plus their headers exceed the block's budget, so the
  // fifth source never reaches the turn: a miss, though search returned it.
  const last = found[4].id;
  const metrics = await evaluate(
    [
      {
        set: "known",
        owner: "alice",
        project: null,
        query: "pelican ledger",
        target: last,
        deep: false,
        targetCoverage: 1,
      },
    ],
    { warmup: 0 },
  );
  expect(metrics).toMatchObject({ hit5: 0, misses5: 1, abstainKnown: 0 });
});
