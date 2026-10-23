// Artifacts stay live per chunk; their derived indexes catch up at completion.
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-streaming-writes-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { runPreview } = await import("../src/server/run-attention");

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
const observed: { statements: number; preview: string; artifact: string }[] =
  [];
let indexed: unknown;
let runId = "";
const restore = withTestAdapter("openai", {
  async models() {
    return [
      { id: "fixture-model", name: "Fixture model", capabilities: "Test only" },
    ];
  },
  async *stream() {
    for (const text of chunks) {
      const snapshot = () =>
        prepare(`SELECT a.id, f.content fts, s.content search,
        r.revision FROM artifacts a JOIN artifact_fts f ON f.artifact_id=a.id
        JOIN search_documents s ON s.id='artifact:'||a.id
        JOIN feed_revisions r ON r.object_id=a.id AND r.entity='artifact'
        WHERE a.run_id=?`).get(runId);
      indexed ??= snapshot();
      const before = executed;
      yield { text };
      // Back here once the chunk was persisted and the next one is requested.
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
      });
    }
  },
});
afterAll(() => {
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
  expect(await executeAgent(run)).toBe(true);
  transition(run, "completed");

  // Both the preview and open result advance with every chunk.
  let text = "";
  for (const [index, step] of observed.entries()) {
    text += chunks[index];
    expect(step.preview).toBe(text);
    expect(step.artifact).toBe(text);
    // Six persistence statements plus one producer ownership check. Derived
    // indexes remain deferred; identity-only log writes happen in SQL triggers.
    expect(step.statements).toBe(7);
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
