// Batches materialize display data and events together; indexes wait for completion.
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-streaming-writes-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, changes, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { runPreview } = await import("../src/server/run-attention");
const { feed } = await import("../src/server/mobile-return");

let executed = 0;
const prepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const statement = prepare(sql) as any;
  for (const method of ["run", "get", "all", "iterate"] as const) {
    const original = statement[method].bind(statement);
    statement[method] = (...args: unknown[]) => {
      executed++;
      return original(...args);
    };
  }
  return statement;
}) as typeof db.prepare;

const chunks = ["Streaming ", "one ", "answer ", "in ", "pieces."];
const observed: { statements: number; preview: string; artifact: string; projected: string | null }[] = [];
let indexed: unknown;
let runId = "";
const restore = withTestAdapter("openai", {
  async models() {
    return [
      { id: "fixture-model", name: "Fixture model", capabilities: "Test only" },
    ];
  },
  async *stream() {
    for (const [index, text] of chunks.entries()) {
      const snapshot = () =>
        prepare(`SELECT a.id, f.content fts, s.content search,
        r.revision FROM artifacts a JOIN artifact_fts f ON f.artifact_id=a.id
        JOIN search_documents s ON s.id='artifact:'||a.id
        JOIN feed_revisions r ON r.object_id=a.id AND r.entity='artifact'
        WHERE a.run_id=?`).get(runId);
      indexed ??= snapshot();
      const before = executed;
      yield { text };
      // Fast chunks stay in memory. A 250ms batch makes exactly the same
      // prefix available to snapshots and events, then requests more tokens.
      if (index === 1 || index === 3) await vi.advanceTimersByTimeAsync(250);
      const after = executed;
      expect(snapshot()).toEqual(indexed);
      const { artifact } = runPreview("alice", runId);
      const stored = prepare(
        "SELECT a.content FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id WHERE cp.run_id=?",
      ).get(runId) as { content: string };
      observed.push({
        statements: after - before,
        preview: String(artifact?.content ?? ""),
        artifact: stored.content,
        projected: feed("alice", { filter: "working" }).items[0].live_preview ?? null,
      });
    }
  },
});
afterAll(() => {
  vi.useRealTimers();
  restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("keeps the result live while deferring its indexes until completion", async () => {
  const connection = id();
  prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    "alice",
    seal("fake-key", "alice"),
    JSON.stringify([{ id: "fixture-model" }]),
    now(),
  );
  const agent = createAgent("alice", {
    name: "streamer",
    connectionId: connection,
    model: "fixture-model",
  });
  submit("alice", {
    agentId: agent.id,
    input: "Stream please",
    idempotencyKey: "stream-1",
  });
  const run = claim("worker")!;
  runId = run.id;
  // As the worker does: a finished execution completes the run, which publishes.
  vi.useFakeTimers();
  try { expect(await executeAgent(run)).toBe(true); }
  finally { vi.useRealTimers(); }
  transition(run, "completed");

  // Each elapsed batch advances both projections; terminal flush saves the tail.
  for (const [index, step] of observed.entries()) {
    const through = index < 1 ? 0 : index < 3 ? 2 : 4;
    const text = chunks.slice(0, through).join("");
    expect(step.preview).toBe(text);
    expect(step.artifact).toBe(text);
    expect(step.projected).toBe(text.trim() || null);
    // Preserve the shadow projection work bound and prove unflushed chunks
    // perform no database work between the 250 ms materialization batches.
    expect(step.statements).toBeLessThanOrEqual(47);
    if (index !== 1 && index !== 3) expect(step.statements).toBe(0);
  }

  const answer = chunks.join("");
  const result = prepare(
    "SELECT a.content,json_extract(a.metadata,'$.partial') partial,v.content version FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=1 WHERE cp.run_id=?",
  ).get(run.id) as { content: string; partial: number; version: string };
  expect(result).toEqual({ content: answer, partial: 0, version: answer });
  const message = prepare(
    "SELECT m.content FROM agent_checkpoints cp JOIN messages m ON m.id=cp.message_id WHERE cp.run_id=?",
  ).get(run.id) as { content: string };
  expect(message.content).toBe(answer);
  expect(
    prepare(
      "SELECT count(*) n FROM artifact_publications p JOIN agent_checkpoints cp ON cp.artifact_id=p.artifact_id WHERE cp.run_id=?",
    ).get(run.id),
  ).toEqual({ n: 1 });
  expect(runPreview("alice", run.id).artifact?.content).toBe(answer);
  const indexedFinal =
    prepare(`SELECT f.content fts, s.content search, r.revision
    FROM artifacts a JOIN artifact_fts f ON f.artifact_id=a.id
    JOIN search_documents s ON s.id='artifact:'||a.id
    JOIN feed_revisions r ON r.object_id=a.id AND r.entity='artifact'
    WHERE a.run_id=?`).get(run.id) as {
      fts: string;
      search: string;
      revision: number;
    };
  expect(indexedFinal).toMatchObject({ fts: answer, search: answer });
  expect(indexedFinal.revision).toBeGreaterThan(
    (indexed as { revision: number }).revision,
  );
});

it("releases run subscriptions when the terminal projection flush fails", async () => {
  const connection = id();
  prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)")
    .run(connection, "alice", seal("fake-key", "alice"), JSON.stringify([{id:"fixture-model"}]), now());
  const agent = createAgent("alice", {name:"flush-failure", connectionId:connection, model:"fixture-model"});
  submit("alice", {agentId:agent.id,input:"Stream a tail",idempotencyKey:"flush-failure"});
  const run = claim("worker")!;
  const before = changes.subscriberCount;
  const restoreFailure = withTestAdapter("openai", {
    async models() { return []; },
    async *stream() { yield {text:"Unflushed tail"}; },
  });
  db.exec("CREATE TEMP TRIGGER reject_terminal_flush BEFORE UPDATE OF content ON messages WHEN NEW.content='Unflushed tail' BEGIN SELECT RAISE(ABORT,'fixture terminal flush failure'); END");
  try {
    await expect(executeAgent(run)).rejects.toThrow("fixture terminal flush failure");
    expect(changes.subscriberCount).toBe(before);
  } finally {
    db.exec("DROP TRIGGER reject_terminal_flush");
    restoreFailure();
  }
});
