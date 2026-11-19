import { armResultReadHook } from "../helpers/result-read-hook.js";
import { db, id, now } from "../../src/server/db.js";
import { seal } from "../../src/server/secrets.js";
import { createAgent } from "../../src/server/domain.js";
import { submit } from "../../src/server/agent-runtime.js";
import { requestApproval } from "../../src/server/approvals.js";
import { saveArtifact } from "../../src/server/artifacts.js";
import { uploadFile } from "../../src/server/uploads.js";
import { claim, transition } from "../../src/server/queue.js";
import { storePublishedFile } from "../../src/server/published-files.js";
import { recordTrace } from "../../src/server/traces.js";
import Database from "better-sqlite3";
import { installFixtureProjection } from "../helpers/projected-writer.js";
import { seedConnection, seedMessage } from "../helpers/seed.js";

/** Try a worker commit after the HTTP handler establishes its Results snapshot.
 * If the handler holds the write lock, finish that commit after the response. */
export function interleaveResultWrite(artifact: string) {
  const writer = new Database(db.name, { timeout: 0 });
  installFixtureProjection(writer);
  const state = { attempted: false, committed: false };
  const write = () => {
    writer
      .prepare(
        "UPDATE artifacts SET content=content || ' concurrent' WHERE id=?",
      )
      .run(artifact);
    state.committed = true;
  };
  armResultReadHook(() => {
    state.attempted = true;
    try {
      write();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "SQLITE_BUSY"
      )
        throw error;
    }
  });
  return () => {
    armResultReadHook();
    try {
      if (state.attempted && !state.committed) write();
      return state;
    } finally {
      writer.close();
    }
  };
}

/** Provider-free records written through production domain operations in the
 * HTTP fixture's process, so the normal Feed projection observes the writes. */
export function integrationRecords(owner: string) {
  const connection = id();
  seedConnection(db, {
    id: connection,
    owner_id: owner,
    provider: "openai",
    label: "Fixture",
    secret: seal("integration-fixture-credential", owner),
    status: "connected",
    models: JSON.stringify([{ id: "fixture", name: "Fixture" }]),
    created_at: now(),
  });
  const agent = createAgent(owner, {
    name: "integration-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const run = submit(owner, {
    agentId: agent.id,
    input: "Integration fixture task",
    idempotencyKey: id(),
  });
  if (!claim("integration-fixture", (candidate) => candidate.id === run.id))
    throw new Error("Could not claim fixture run");
  const artifact = saveArtifact(owner, {
    title: "Integration result",
    content: "Public result",
    agent: agent.id,
    run: run.id,
    conversation: run.conversation_id,
    role: "answer",
  });
  const file = uploadFile(owner, {
    originalname: "fixture.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("Public file bytes"),
  });
  const published = storePublishedFile(run, id(), {
    name: "published.txt",
    title: "Published file",
    mime: "text/plain",
    bytes: Buffer.from("Published file bytes"),
  });
  recordTrace(run, "fixture-trace", {
    kind: "tool",
    title: "Fixture trace",
    content: "Public trace",
  });
  const reply = id();
  seedMessage(db, {
    id: reply,
    owner_id: owner,
    conversation_id: run.conversation_id!,
    run_id: run.id,
    role: "assistant",
    content: "Public fixture answer",
    metadata: "{}",
    created_at: now(),
  });
  transition(run, "completed");
  const pending = submit(owner, {
    agentId: agent.id,
    input: "Pending fixture approval",
    idempotencyKey: id(),
  });
  if (!claim("integration-fixture", (candidate) => candidate.id === pending.id))
    throw new Error("Could not claim approval fixture");
  const approval = requestApproval(pending, { tool: "fixture" });
  transition(pending, "awaiting_approval");
  const message = db
    .prepare("SELECT id FROM messages WHERE run_id=? AND role='user' LIMIT 1")
    .get(run.id) as { id: string };
  // A persisted, pending native request is sufficient for this read boundary;
  // there is no adapter, dispatch, or provider in this fixture.
  const generation = id(),
    decision = id();
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,generation,updated_at) VALUES('fixture-agent',?,'codex',?,?,?)",
  ).run(run.conversation_id, process.cwd(), generation, now());
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES(?,?,?,?,?,'{}',?)",
  ).run(decision, run.id, run.conversation_id, generation, id(), now());
  return {
    connection,
    agent: agent.id,
    run: run.id,
    conversation: run.conversation_id!,
    artifact,
    file,
    published: published.artifactId,
    approval: approval.id,
    message: message.id,
    reply,
    decision,
  };
}
