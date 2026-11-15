import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-result-imports-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { applyMigrations } = await import("../src/server/migrations");
const { stageImport, executeImport } = await import("../src/server/imports");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { listConversationResults, publishCompletedRunResult } =
  await import("../src/server/result-publication");
const { resultDefects } = await import("../src/server/result-history");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Node = {
  role?: "user" | "assistant" | "tool";
  text?: string;
  parent: string | null;
  children?: string[];
  time?: number;
  messageId?: string;
};

function chatgpt(conversationId: string, nodes: Record<string, Node>) {
  const mapping: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(nodes)) {
    mapping[nodeId] = {
      id: nodeId,
      parent: node.parent,
      children: node.children ?? [],
      message: node.role
        ? {
            id: node.messageId ?? "msg-" + nodeId,
            author: { role: node.role },
            content: { parts: [node.text ?? nodeId] },
            create_time: node.time,
          }
        : null,
    };
  }
  return Buffer.from(
    JSON.stringify([
      { id: conversationId, title: "Branched", current_node: null, mapping },
    ]),
  );
}

async function runImport(owner: string, bytes: Buffer) {
  const staged = await stageImport(owner, bytes, "conversations.json");
  if ("duplicate" in staged && staged.duplicate) return null;
  enqueue(owner, "Import", id(), {
    kind: "import",
    payload: { importId: staged.id },
  });
  const claimed = claim("importer-" + owner)!;
  await executeImport(claimed);
  transition(claimed, "completed");
  return claimed;
}

function importedConversation(owner: string, externalId: string) {
  return (
    db
      .prepare(
        "SELECT id FROM conversations WHERE owner_id=? AND origin='openai-import' AND external_id=?",
      )
      .get(owner, externalId) as { id: string }
  ).id;
}

function byBody(owner: string, conversation: string) {
  return new Map(
    listConversationResults(owner, conversation, db).map((r) => [
      r.outcome.body,
      r,
    ]),
  );
}

const branched: Record<string, Node> = {
  root: { parent: null, children: ["n-q1", "n-q2"] },
  // Two edits of the first question; their answers interleave in time.
  "n-q1": {
    role: "user",
    text: "First question",
    parent: "root",
    children: ["n-tool"],
    time: 1,
  },
  "n-q2": {
    role: "user",
    text: "Edited question",
    parent: "root",
    children: ["n-a2"],
    time: 2,
  },
  "n-a2": { role: "assistant", text: "A2", parent: "n-q2", time: 3 },
  // A tool call the importer drops, between the first question and answer.
  "n-tool": {
    role: "tool",
    text: "tool output",
    parent: "n-q1",
    children: ["n-a1"],
    time: 4,
  },
  "n-a1": { role: "assistant", text: "A1", parent: "n-tool", time: 5 },
  // Ancestry the export does not contain, and a cycle.
  "n-orphan": {
    role: "assistant",
    text: "Orphan",
    parent: "n-missing",
    time: 6,
  },
  "n-x": { role: "assistant", text: "X", parent: "n-y", time: 7 },
  "n-y": { role: "assistant", text: "Y", parent: "n-x", time: 8 },
};

it("seals each imported answer with its own branch's question through the import boundary", async () => {
  const owner = id();
  await runImport(owner, chatgpt("conv-branched", branched));
  const conversation = importedConversation(owner, "conv-branched");
  const results = byBody(owner, conversation);

  const question = (text: string) =>
    (
      db
        .prepare(
          "SELECT id FROM messages WHERE owner_id=? AND conversation_id=? AND content=?",
        )
        .get(owner, conversation, text) as { id: string }
    ).id;
  expect(results.get("A1")!.stimulus).toMatchObject({
    kind: "import",
    text: "First question",
    sourceMessageId: question("First question"),
    authorKind: "owner",
  });
  expect(results.get("A2")!.stimulus.text).toBe("Edited question");
  for (const body of ["Orphan", "X", "Y"]) {
    expect(results.get(body)!.stimulus).toMatchObject({
      text: null,
      sourceMessageId: null,
      authorKind: "unknown",
    });
    expect(results.get(body)!.outcome.title).toBe(body);
  }
  expect(results.get("A1")!.provenance.origin).toEqual({
    kind: "external_import",
    provider: "openai",
  });

  // Reimporting changed input order and an identical export changes nothing.
  const sealed = listConversationResults(owner, conversation, db);
  const reordered = Object.fromEntries(Object.entries(branched).reverse());
  await runImport(owner, chatgpt("conv-branched", reordered));
  await runImport(owner, chatgpt("conv-branched", branched));
  expect(listConversationResults(owner, conversation, db)).toEqual(sealed);
});

it("chains appended and late-arriving imports through the canonical sequence without rewriting sealed Results", async () => {
  const owner = id();
  const first: Record<string, Node> = {
    root: { parent: null, children: ["q"] },
    q: { role: "user", text: "Q", parent: "root", children: ["a"], time: 10 },
    a: { role: "assistant", text: "A", parent: "q", time: 11 },
  };
  await runImport(owner, chatgpt("conv-seq", first));
  const conversation = importedConversation(owner, "conv-seq");
  const a = byBody(owner, conversation).get("A")!;

  // A Loop run continues the imported conversation.
  const agent = (
    db
      .prepare("SELECT agent_id FROM conversations WHERE id=?")
      .get(conversation) as { agent_id: string }
  ).agent_id;
  const run = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'agent','More','completed',?,'{}',20000,20001)",
  ).run(run, owner, agent, conversation, id());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','B','{}',20000)",
  ).run(id(), owner, conversation, run);
  const b = publishCompletedRunResult(run, owner, db)!;
  expect(b.lineage.parentResultId).toBe(a.id);

  // A later export appends C after the run, and adds an earlier turn E.
  await runImport(
    owner,
    chatgpt("conv-seq", {
      ...first,
      root: { parent: null, children: ["q", "q-early"] },
      a: {
        role: "assistant",
        text: "A",
        parent: "q",
        children: ["c"],
        time: 11,
      },
      c: { role: "assistant", text: "C", parent: "a", time: 30 },
      "q-early": {
        role: "user",
        text: "Early",
        parent: "root",
        children: ["e"],
        time: 1,
      },
      e: { role: "assistant", text: "E", parent: "q-early", time: 2 },
    }),
  );
  const results = byBody(owner, conversation);
  expect(results.get("C")!.lineage.parentResultId).toBe(b.id);
  expect(results.get("C")!.stimulus.text).toBe("Q");
  // The late earlier turn starts its own link; sealed successors keep theirs.
  expect(results.get("E")!.lineage.parentResultId).toBeNull();
  expect(results.get("E")!.stimulus.text).toBe("Early");
  expect(results.get("A")).toEqual(a);
  expect(results.get("B")).toEqual(b);
});

it("keeps a linear Claude export's documented order", async () => {
  const owner = id();
  await runImport(
    owner,
    Buffer.from(
      JSON.stringify([
        {
          uuid: "claude-conv",
          name: "Linear",
          created_at: "2026-01-01T00:00:00Z",
          chat_messages: [
            {
              uuid: "h1",
              sender: "human",
              text: "Hello",
              created_at: "2026-01-01T00:00:01Z",
            },
            {
              uuid: "a1",
              sender: "assistant",
              text: "Hi",
              created_at: "2026-01-01T00:00:02Z",
            },
            {
              uuid: "h2",
              sender: "human",
              text: "Again",
              created_at: "2026-01-01T00:00:03Z",
            },
            {
              uuid: "a2",
              sender: "assistant",
              text: "Sure",
              created_at: "2026-01-01T00:00:03Z",
            },
          ],
        },
      ]),
    ),
  );
  const conversation = (
    db
      .prepare(
        "SELECT id FROM conversations WHERE owner_id=? AND origin='anthropic-import'",
      )
      .get(owner) as { id: string }
  ).id;
  const results = byBody(owner, conversation);
  expect(results.get("Hi")!.stimulus.text).toBe("Hello");
  expect(results.get("Sure")!.stimulus.text).toBe("Again");
  expect(results.get("Sure")!.provenance.origin).toEqual({
    kind: "external_import",
    provider: "anthropic",
  });
});

function migrationsThrough(target: string, last: number) {
  mkdirSync(target);
  for (const file of readdirSync("migrations").filter(
    (f) => f.endsWith(".sql") && Number(f.split("-")[0]) <= last,
  )) {
    copyFileSync(join("migrations", file), join(target, file));
  }
}

// A branched import as released importers stored it, for two owners.
function seedBranchedImport(database: Database.Database) {
  for (const owner of ["owner-a", "owner-b"]) {
    const meta = (nodeId: string, parent: string | null, children: string[]) =>
      JSON.stringify({
        origin: "import",
        provider: "openai",
        externalId: "msg-" + nodeId,
        parent,
        activeBranch: true,
        raw: { nodeId, parent, children },
      });
    database
      .prepare(
        `INSERT INTO agents(id, owner_id, name, normalized_name, provider, model, instructions, origin, created_at)
         VALUES (?, ?, 'Importer', ?, 'openai', 'gpt', '', 'import', 1)`,
      )
      .run(`${owner}-agent`, owner, `${owner} importer`);
    database
      .prepare(
        `INSERT INTO conversations(id, owner_id, agent_id, title, origin, external_id, created_at)
         VALUES (?, ?, ?, 'Branched', 'openai-import', 'conv', 1)`,
      )
      .run(`${owner}-conv`, owner, `${owner}-agent`);
    const insert = database.prepare(
      `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    );
    insert.run(
      `${owner}-q1`,
      owner,
      `${owner}-conv`,
      "user",
      "First question",
      meta("n-q1", "root", ["n-a1"]),
      1,
    );
    insert.run(
      `${owner}-q2`,
      owner,
      `${owner}-conv`,
      "user",
      "Edited question",
      meta("n-q2", "root", ["n-a2"]),
      2,
    );
    insert.run(
      `${owner}-a1`,
      owner,
      `${owner}-conv`,
      "assistant",
      "A1",
      meta("n-a1", "n-q1", []),
      3,
    );
  }
}

it("seals released branched imports with their own question on upgrade from v0.1.0", () => {
  const work = mkdtempSync(join(tmpdir(), "loop-imports-upgrade-"));
  try {
    migrationsThrough(join(work, "migrations"), 163);
    const upgrade = new Database(join(work, "upgrade.db"));
    applyMigrations(upgrade, join(work, "migrations"));
    seedBranchedImport(upgrade);
    applyMigrations(upgrade);
    for (const owner of ["owner-a", "owner-b"]) {
      const [a1] = listConversationResults(owner, `${owner}-conv`, upgrade);
      expect(a1).toMatchObject({
        originCompleteness: "migrated_backfill",
        stimulus: { text: "First question", sourceMessageId: `${owner}-q1` },
      });
    }
    expect(
      upgrade.prepare("SELECT count(*) n FROM result_defects").get(),
    ).toEqual({ n: 0 });
    upgrade.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("flags, without rewriting, a 247-era import's chronological question and skipped predecessor", () => {
  const work = mkdtempSync(join(tmpdir(), "loop-imports-247-"));
  try {
    migrationsThrough(join(work, "pre"), 163);
    const migrations = join(work, "migrations");
    migrationsThrough(migrations, 163);
    copyFileSync(
      "test/fixtures/historical-migrations/164-canonical-results-pr247.sql",
      join(migrations, "164-canonical-results.sql"),
    );
    const earlier = new Database(join(work, "earlier.db"));
    applyMigrations(earlier, join(work, "pre"));
    seedBranchedImport(earlier);
    // The 247-era backfill took the chronologically latest question.
    applyMigrations(earlier, migrations);
    // 247-era runtime: a run answer B, then an appended answer C chained to
    // the previous imported answer instead of B.
    earlier.exec(`
      INSERT INTO runs(id, owner_id, agent_id, conversation_id, kind, input, state, idempotency_key, payload, created_at, updated_at)
      VALUES ('owner-a-run', 'owner-a', 'owner-a-agent', 'owner-a-conv', 'agent', 'More', 'completed', 'k', '{}', 10, 11);
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('owner-a-b', 'owner-a', 'owner-a-conv', 'owner-a-run', 'assistant', 'B', '{}', 10),
             ('owner-a-c', 'owner-a', 'owner-a-conv', NULL, 'assistant', 'C', '{}', 20);
    `);
    const sealed = (
      id: string,
      kind: string,
      message: string,
      runId: string | null,
      at: number,
      parent: string,
      body: string,
    ) =>
      earlier
        .prepare(
          `INSERT INTO results(id, owner_id, schema_version, kind, origin_completeness, sealed, created_at, conversation_id, run_id, message_id, agent_id, content_digest, stimulus, outcome, attachments, provenance, lineage)
           VALUES (?, 'owner-a', 1, ?, 'sealed_at_publication', 1, ?, 'owner-a-conv', ?, ?, 'owner-a-agent',
             '0000000000000000000000000000000000000000000000000000000000000000',
             json_object('kind','user_prompt','text',NULL,'sourceMessageId',NULL,'authorKind','owner','automationKind',NULL,'automationFrom',NULL),
             json_object('title',?,'body',?,'format','markdown'), '[]',
             json_object('agentId','owner-a-agent','agentName','Importer','provider','openai','model','gpt','resolvedModel',NULL,'connectionId',NULL,
               'conversationId','owner-a-conv','runId',?,'messageId',?,
               'placement',json_object('status','unknown','folderId',NULL,'projectId',NULL,'projectName',NULL,'teamId',NULL)),
             json_object('parentResultId',?,'triggerMessageId',NULL,'suppliedContext',json('[]')))`,
        )
        .run(id, kind, at, runId, message, body, body, runId, message, parent);
    sealed(
      "run:owner-a-run",
      "run_answer",
      "owner-a-b",
      "owner-a-run",
      11,
      "message:owner-a-a1",
      "B",
    );
    sealed(
      "message:owner-a-c",
      "imported_answer",
      "owner-a-c",
      null,
      20,
      "message:owner-a-a1",
      "C",
    );
    applyMigrations(earlier, migrations);
    const before = earlier
      .prepare("SELECT * FROM results ORDER BY owner_id,id")
      .all();
    earlier.close();

    const upgraded = new Database(join(work, "earlier.db"));
    applyMigrations(upgraded);
    expect(
      upgraded.prepare("SELECT * FROM results ORDER BY owner_id,id").all(),
    ).toEqual(before);
    for (const owner of ["owner-a", "owner-b"]) {
      expect(resultDefects(owner, `message:${owner}-a1`, upgraded)).toEqual([
        {
          defect: "import_stimulus",
          evidence: {
            recordedSourceMessageId: `${owner}-q2`,
            branch: "question",
            branchSourceMessageId: `${owner}-q1`,
          },
          detectedAt: expect.any(Number),
        },
      ]);
    }
    expect(resultDefects("owner-a", "message:owner-a-c", upgraded)).toEqual([
      {
        defect: "sequence_predecessor",
        evidence: {
          recordedParentResultId: "message:owner-a-a1",
          sequenceParentResultId: "run:owner-a-run",
        },
        detectedAt: expect.any(Number),
      },
    ]);
    expect(resultDefects("owner-b", "message:owner-a-c", upgraded)).toEqual([]);
    const findings = upgraded.prepare("SELECT * FROM result_defects").all();
    applyMigrations(upgraded);
    expect(upgraded.prepare("SELECT * FROM result_defects").all()).toEqual(
      findings,
    );
    upgraded.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
