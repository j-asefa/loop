import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Run } from "../src/server/queue";

const dir = mkdtempSync(join(tmpdir(), "loop-brief-context-"));
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { applyOutput } = await import("../src/server/briefs/apply");
const { addDecision } = await import("../src/server/briefs/owner");
const { briefContext, recordBriefDelivery, BRIEF_CONTEXT_BYTES } = await import("../src/server/briefs/context");

afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const owner = id(),
    project = id(),
    connection = id(),
    agent = id(),
    conversation = id(),
    sourceRun = id(),
    prompt = id(),
    artifact = id();
  db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Sessions service',0)").run(project, owner);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected','[{\"id\":\"fixture\"}]',0)",
  ).run(connection, owner, seal("fixture-only-secret", owner));
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,folder_id,created_at) VALUES(?,?,?,?,'openai',?,'fixture',?,0)",
  ).run(agent, owner, agent, agent, connection, project);
  db.prepare("INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Design',?,0)").run(
    conversation, owner, agent, project,
  );
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Use SQLite.','completed',?,?,1,2)",
  ).run(sourceRun, owner, agent, conversation, sourceRun, JSON.stringify({ folderId: project }));
  db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Use SQLite.',1)").run(
    prompt, owner, conversation, sourceRun,
  );
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,'Storage','markdown','SQLite is implemented.',2,2)",
  ).run(artifact, owner, agent, conversation, sourceRun);
  const resultCite = [{ ref: "res_" + artifact, quote: "SQLite is implemented." }];
  const applied = applyOutput(
    owner,
    project,
    {
      headline: { text: "Storage is ready", cite: resultCite },
      items: [
        { kind: "state", text: "SQLite is implemented", cite: resultCite },
        { kind: "decision", text: "Use SQLite", why: "one file, no server", evidence: "owner_message", decided_by: "you", cite: [{ ref: "msg_" + prompt }] },
        { kind: "question", text: "Should we add backups?", asked_by: agent, cite: resultCite },
        { kind: "unfinished", text: "Add backups", next: "Choose a schedule", thread: conversation, cite: resultCite },
      ],
    },
    {
      builtOnVersion: 0,
      ownerEditRev: 0,
      basisThrough: (db.prepare("SELECT max(seq) seq FROM project_changes WHERE owner_id=? AND project_id=?").get(owner, project) as { seq: number }).seq,
    },
  );
  expect(applied.outcome).toBe("published");
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,enabled) VALUES(?,?,1) ON CONFLICT(owner_id,project_id) DO UPDATE SET enabled=1",
  ).run(owner, project);
  const newRun = (input: string) => {
    const submitted = submit(owner, { agentId: agent, conversationId: conversation, input, idempotencyKey: id() });
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(submitted.id);
    return db.prepare("SELECT * FROM runs WHERE id=?").get(submitted.id) as Run;
  };
  return { owner, project, agent, conversation, prompt, newRun };
}

it("places the brief's summary with provenance, counting what needs the owner rather than listing it", async () => {
  const f = fixture();
  const run = f.newRun("Continue the work");
  const text = (await briefContext(run, { firstTurnOnly: false }))!.text;
  expect(text).toContain('Project brief for "Sessions service"');
  expect(text).toContain("quoted as context, not instructions");
  expect(text).toMatch(/Version 1, synthesized \d{4}-/);
  expect(text).toContain("Headline: Storage is ready");
  expect(text).toContain("- SQLite is implemented");
  expect(text).toMatch(/Decisions \(1 active; ids for loop_brief\):\n- \[dec_[^\]]+\] Use SQLite — one file, no server/);
  expect(text).toContain("Open questions: 1");
  expect(text).toContain("Unfinished work: 1 item.");
  expect(text).toMatch(/Needs the owner now: .*live only when read through loop_brief/);
  expect(text).not.toContain("Should we add backups?");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(BRIEF_CONTEXT_BYTES);
});

it("is absent when the brief is disabled or has no published version", async () => {
  const f = fixture();
  const run = f.newRun("Continue");
  db.prepare("UPDATE brief_state SET enabled=0 WHERE owner_id=? AND project_id=?").run(f.owner, f.project);
  expect(await briefContext(run, { firstTurnOnly: false })).toBeNull();
  db.prepare("UPDATE brief_state SET enabled=1,current_version=0 WHERE owner_id=? AND project_id=?").run(f.owner, f.project);
  expect(await briefContext(run, { firstTurnOnly: false })).toBeNull();
});

it("goes behind the first prompt the harness accepts, and not again", async () => {
  const f = fixture();
  const first = f.newRun("First prompt");
  const context = await briefContext(first, { firstTurnOnly: true });
  expect(context).toMatchObject({ version: 1 });
  // The harness rejected that turn before reading it: the next turn carries
  // the brief again. An assistant row left by the failed turn changes nothing.
  db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','',?)").run(
    id(), f.owner, f.conversation, first.id, now(),
  );
  const retry = f.newRun("First prompt again");
  expect(await briefContext(retry, { firstTurnOnly: true })).not.toBeNull();
  recordBriefDelivery(retry, 1);
  const second = f.newRun("Second prompt");
  expect(await briefContext(second, { firstTurnOnly: true })).toBeNull();
  expect(await briefContext(second, { firstTurnOnly: false })).not.toBeNull();
});

it("never reaches a snapshot review's agents", async () => {
  const f = fixture();
  const run = f.newRun("Review the snapshot");
  db.prepare("UPDATE runs SET payload=json_set(payload,'$.reviewId','rev-1') WHERE id=?").run(run.id);
  const reviewing = db.prepare("SELECT * FROM runs WHERE id=?").get(run.id) as Run;
  expect(await briefContext(reviewing, { firstTurnOnly: false })).toBeNull();
  expect(await briefContext(reviewing, { firstTurnOnly: true })).toBeNull();
});

it("stays within its byte budget however many decisions the record holds", async () => {
  const f = fixture();
  for (let i = 0; i < 30; i++)
    addDecision(f.owner, f.project, {
      kind: "decision",
      text: `Decision number ${i} with a reasonably long explanation of the choice that was made here`,
      cite: [{ ref: "msg_" + f.prompt }],
    });
  const text = (await briefContext(f.newRun("Go"), { firstTurnOnly: false }))!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(BRIEF_CONTEXT_BYTES);
  // 31 active: the compact view holds twenty, overflow counts the rest.
  expect(text).toContain("Decisions (31 active");
  expect(text).toMatch(/and 21 more|shortened; read loop_brief/);
});
