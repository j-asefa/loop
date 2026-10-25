import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AgentRecord, ConnectionRecord, ConversationRecord } from "../src/server/storage-schemas.js";
import { QueryRecords } from "../src/server/query-records.js";

const dir = mkdtempSync(join(tmpdir(), "loop-storage-schemas-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "server";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db.js");
const { seal } = await import("../src/server/secrets.js");
const { createAgent } = await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { tick, execute } = await import("../src/server/worker.js");
const { withTestAdapter } = await import("../src/server/providers.js");
const { captureMemory } = await import("../src/server/memory.js");
const restore = withTestAdapter("openai", {
  async models() { return [{ id: "fixture", name: "Fixture", capabilities: "Fixture only" }]; },
  async *stream() { yield { text: "Storage fixture answer." }; },
});
afterAll(() => { restore(); db.close(); rmSync(dir, { recursive: true, force: true }); });

it("matches storage schemas to worker-produced rows without changing their serialized JSON", async () => {
  const owner = id(), connection = id();
  db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)")
    .run(connection, owner, seal("fixture-key", owner), JSON.stringify([{ id: "fixture" }]), now());
  const agent = createAgent(owner, { name: "storage-" + id().slice(0, 8), connectionId: connection, model: "fixture" });
  const queued = submit(owner, { agentId: agent.id, input: "Exercise persisted schemas", idempotencyKey: id() });
  const rawRun = () => db.prepare("SELECT * FROM runs WHERE id=?").get(queued.id);
  const initial = QueryRecords.runs.parse(rawRun());
  expect(initial).toMatchObject({ state: "queued", owner_id: owner, result: null, worker_id: null });
  expect(JSON.parse(initial.payload)).toMatchObject({ agentId: agent.id, connectionId: connection });
  expect(await tick(execute)).toBe(true);
  const completed = QueryRecords.runs.parse(rawRun());
  expect(completed).toMatchObject({ state: "completed", result: "Storage fixture answer.", error: null });
  expect(completed.payload).toBe(initial.payload);
  expect(AgentRecord.parse(db.prepare("SELECT * FROM agents WHERE id=?").get(agent.id))).toMatchObject({ id: agent.id, folder_id: null });
  expect(ConnectionRecord.parse(db.prepare("SELECT * FROM connections WHERE id=?").get(connection))).toMatchObject({ models: '[{"id":"fixture"}]', metadata: "{}" });
  expect(ConversationRecord.parse(db.prepare("SELECT * FROM conversations WHERE id=?").get(queued.conversation_id))).toMatchObject({ owner_id: owner, agent_id: agent.id });
  const message = QueryRecords.messages.parse(db.prepare("SELECT * FROM messages WHERE run_id=? AND role='assistant' AND json_extract(metadata,'$.progress') IS NOT 1 ORDER BY rowid DESC LIMIT 1").get(queued.id));
  const artifact = QueryRecords.artifacts.parse(db.prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get(queued.id));
  expect(message.content).toBe(completed.result);
  expect(artifact.content).toBe(completed.result);
  expect(JSON.parse(message.metadata)).toMatchObject({ agentId: agent.id });
  expect(JSON.parse(artifact.metadata)).toMatchObject({ agentId: agent.id });
  expect(QueryRecords.agent_checkpoints.parse(db.prepare("SELECT * FROM agent_checkpoints WHERE run_id=?").get(queued.id))).toMatchObject({ message_id: message.id, artifact_id: artifact.id });
  captureMemory();
  const sources = QueryRecords.memory_sources.array().parse(db.prepare("SELECT * FROM memory_sources WHERE owner_id=?").all(owner));
  expect(sources.some(source => source.message_id === message.id && source.content === completed.result)).toBe(true);
  expect(sources.every(source => source.owner_id === owner)).toBe(true);
});
