import { testDirectory } from "./helpers/test-workspace.js";
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

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { applyMigrations } = await import("../src/server/migrations");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { forkConversation } = await import("../src/server/mobile-return");
const { continueConversation } =
  await import("../src/server/conversation-continuations");
const { doneCards } = await import("../src/server/done-cards");
const { projectFeed } = await import("../src/server/feed-projector");
const {
  getResult,
  listConversationResults,
  publishCompletedRunResult,
  publishImportedConversationResults,
} = await import("../src/server/result-publication");

afterAll(() => {
  db.close();
});

function agentFor(owner: string, name: string) {
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
    name: name + "-" + id().slice(0, 6),
    connectionId: connection,
    model: "fixture",
  });
}

function completedRun(owner: string, agentId: string, text: string) {
  const queued = submit(owner, {
    agentId,
    input: "Write the answer",
    idempotencyKey: id(),
  });
  const run = ownedRun(queued.id, owner);
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,'{}',?)",
  ).run(message, owner, run.conversation_id, run.id, text, now() + 5);
  db.prepare(
    "UPDATE runs SET state='completed',payload=json_set(payload,'$.provider','anthropic'),updated_at=? WHERE id=?",
  ).run(now() + 10, run.id);
  return {
    run,
    message,
    result: publishCompletedRunResult(run.id, owner, db)!,
  };
}

function importedConversation(owner: string, agentId: string) {
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Imported','openai-import',1)",
  ).run(conversation, owner, agentId);
  return conversation;
}

function insertStandalone(
  owner: string,
  conversation: string,
  role: "user" | "assistant",
  content: string,
  createdAt: number,
  metadata: object = {},
) {
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,?,?,?,?)",
  ).run(
    message,
    owner,
    conversation,
    role,
    content,
    JSON.stringify(metadata),
    createdAt,
  );
  return message;
}

it("seals a forked or continued answer with its source author, not the destination agent", () => {
  const owner = id();
  const author = agentFor(owner, "author");
  const destination = agentFor(owner, "destination");
  const source = completedRun(owner, author.id, "Answer from the author");

  const fork = forkConversation(owner, source.run.conversation_id!, {
    messageId: source.message,
    agentId: destination.id,
  });
  const [forked] = listConversationResults(owner, fork.id, db);
  expect(forked.provenance).toMatchObject({
    agentId: author.id,
    agentName: author.name,
    provider: "anthropic",
    conversationId: fork.id,
    runId: null,
  });
  expect(forked.provenance.placement).toEqual(
    source.result.provenance.placement,
  );

  // A copy of a copy still names the original author.
  const copied = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant'",
    )
    .get(fork.id) as { id: string };
  const continuation = continueConversation(owner, fork.id, {
    agentId: destination.id,
    messageIds: [copied.id],
    start: { input: "Go on", idempotencyKey: id() },
  } as any);
  const [continued] = listConversationResults(
    owner,
    continuation.id,
    db,
  ).filter((r) => r.kind === "imported_answer");
  expect(continued.provenance.agentId).toBe(author.id);
  expect(continued.provenance.provider).toBe("anthropic");
  expect(
    db
      .prepare("SELECT agent_id FROM results WHERE owner_id=? AND id=?")
      .get(owner, continued.id),
  ).toEqual({ agent_id: author.id });

  // Another owner's answer is never consulted as a source.
  const other = id();
  const otherAgent = agentFor(other, "other");
  const otherConversation = importedConversation(other, otherAgent.id);
  insertStandalone(other, otherConversation, "assistant", "Copied", 10, {
    sourceMessage: source.message,
  });
  const [isolated] = publishImportedConversationResults(
    other,
    otherConversation,
    db,
  );
  expect(isolated.provenance.agentId).toBeNull();
  expect(isolated.provenance.placement.status).toBe("unknown");
});

it("follows branch parent pointers to an imported answer's own question", () => {
  const owner = id();
  const agent = agentFor(owner, "importer");
  const conversation = importedConversation(owner, agent.id);
  const node = (nodeId: string, parent: string | null, children: string[]) => ({
    origin: "import",
    provider: "openai",
    externalId: nodeId,
    parent,
    raw: { nodeId, parent, children },
  });
  insertStandalone(owner, conversation, "user", "First question", 1, {
    ...node("n-q1", "root", ["n-tool"]),
  });
  // Another branch's question is chronologically closer to the answer.
  insertStandalone(owner, conversation, "user", "Edited question", 2, {
    ...node("n-q2", "root", ["n-a2"]),
  });
  // The answer's parent is a tool node that the import did not store.
  const answer = insertStandalone(owner, conversation, "assistant", "A1", 3, {
    ...node("n-a1", "n-tool", []),
  });
  insertStandalone(owner, conversation, "assistant", "A2", 4, {
    ...node("n-a2", "n-q2", []),
  });

  const results = publishImportedConversationResults(owner, conversation, db);
  const first = results.find((r) => r.provenance.messageId === answer)!;
  expect(first.stimulus.text).toBe("First question");
  expect(first.outcome.title).toBe("First question");
  expect(results.find((r) => r.outcome.body === "A2")!.stimulus.text).toBe(
    "Edited question",
  );
});

it("chains an appended imported answer to the run that preceded it", () => {
  const owner = id();
  const agent = agentFor(owner, "chain");
  const conversation = importedConversation(owner, agent.id);
  insertStandalone(owner, conversation, "user", "Q", 1);
  insertStandalone(owner, conversation, "assistant", "A", 2);
  const [a] = publishImportedConversationResults(owner, conversation, db);

  const queued = submit(owner, {
    agentId: agent.id,
    conversationId: conversation,
    input: "Continue",
    idempotencyKey: id(),
  });
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','B','{}',?)",
  ).run(id(), owner, conversation, queued.id, 100);
  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(
    101,
    queued.id,
  );
  const b = publishCompletedRunResult(queued.id, owner, db)!;
  expect(b.lineage.parentResultId).toBe(a.id);

  insertStandalone(owner, conversation, "assistant", "C", 200);
  const c = publishImportedConversationResults(owner, conversation, db).find(
    (r) => r.outcome.body === "C",
  )!;
  expect(c.lineage.parentResultId).toBe(b.id);
  expect(getResult(owner, a.id, db)!.lineage.parentResultId).toBeNull();
});

it("files a Done card under its conversation's current folder and shows where its Result was published", () => {
  const owner = id();
  const agent = agentFor(owner, "placed");
  const [origin, later] = ["Origin", "Later"].map((name) => {
    const folder = id();
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'project',?,1)",
    ).run(folder, owner, name);
    return folder;
  });
  const conversation = importedConversation(owner, agent.id);
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    origin,
    conversation,
  );
  insertStandalone(owner, conversation, "user", "Q", 1);
  insertStandalone(owner, conversation, "assistant", "Placed answer", 2);
  const [result] = publishImportedConversationResults(owner, conversation, db);
  expect(result.provenance.placement.folderId).toBe(origin);

  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    later,
    conversation,
  );
  db.transaction(() => projectFeed(db, () => {})).immediate();
  const card = doneCards(owner, {
    folders: null,
    teamIds: [],
    before: null,
    limit: 20,
    atTime: now() + 1000,
  }).find((entry) => entry.card.id === `d:${result.id}`);
  // Organization follows the move; the published placement stays recorded.
  expect(card?.card.context.folder_id).toBe(later);
  expect(card?.card.type === "done" && card.card.display.produced_in).toEqual({
    project_id: origin,
    project_name: "Origin",
  });
  expect(getResult(owner, result.id, db)!.provenance.placement.folderId).toBe(
    origin,
  );
});

it("backfills historical fork and continuation copies with their source author", () => {
  const upgradeDir = mkdtempSync(join(tmpdir(), "loop-result-copy-mig-"));
  try {
    const pre164 = join(upgradeDir, "migrations");
    mkdirSync(pre164);
    for (const file of readdirSync("migrations").filter(
      (f) => f.endsWith(".sql") && Number(f.split("-")[0]) <= 163,
    )) {
      copyFileSync(join("migrations", file), join(pre164, file));
    }
    const upgrade = new Database(join(upgradeDir, "upgrade.db"));
    upgrade.pragma("foreign_keys=ON");
    applyMigrations(upgrade, pre164);
    upgrade.exec(`
      INSERT INTO agents(id, owner_id, name, normalized_name, provider, model, instructions, origin, created_at)
      VALUES ('ag-src', 'o', 'Source Agent', 'source agent', 'anthropic', 'claude-x', '', 'loop', 1),
             ('ag-dst', 'o', 'Destination Agent', 'destination agent', 'openai', 'gpt-x', '', 'loop', 1);
      INSERT INTO conversations(id, owner_id, agent_id, title, origin, created_at)
      VALUES ('c-src', 'o', 'ag-src', 'Source', 'loop', 1),
             ('c-fork', 'o', 'ag-dst', 'Fork: Source', 'loop-fork', 5),
             ('c-cont', 'o', 'ag-dst', 'Continuation: Fork', 'loop-continuation', 6);
      INSERT INTO runs(id, owner_id, agent_id, conversation_id, kind, input, state, idempotency_key, payload, result, created_at, updated_at)
      VALUES ('r-src', 'o', 'ag-src', 'c-src', 'agent', 'Prompt', 'completed', 'k', '{"provider":"anthropic","model":"claude-run"}', NULL, 2, 3);
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('m-src', 'o', 'c-src', 'r-src', 'assistant', 'Original answer', '{}', 3),
             ('m-fork', 'o', 'c-fork', NULL, 'assistant', 'Original answer', '{"sourceMessage":"m-src","forked":true}', 3),
             ('m-cont', 'o', 'c-cont', NULL, 'assistant', 'Original answer', '{"sourceMessage":"m-fork"}', 3),
             ('m-gone', 'o', 'c-fork', NULL, 'assistant', 'Orphan copy', '{"sourceMessage":"m-deleted"}', 4),
             ('m-own', 'o', 'c-fork', NULL, 'assistant', 'Imported here', '{}', 4);
    `);
    applyMigrations(upgrade);
    const provenance = (messageId: string) => {
      const row = upgrade
        .prepare("SELECT agent_id, provenance FROM results WHERE id=?")
        .get("message:" + messageId) as {
        agent_id: string | null;
        provenance: string;
      };
      return { agentId: row.agent_id, ...JSON.parse(row.provenance) };
    };
    for (const copy of ["m-fork", "m-cont"]) {
      expect(provenance(copy)).toMatchObject({
        agentId: "ag-src",
        agentName: "Source Agent",
        provider: "anthropic",
        model: "claude-run",
      });
    }
    expect(provenance("m-gone")).toMatchObject({
      agentId: null,
      provider: null,
    });
    expect(provenance("m-own")).toMatchObject({
      agentId: "ag-dst",
      provider: "openai",
    });
    upgrade.close();
  } finally {
    rmSync(upgradeDir, { recursive: true, force: true });
  }
});
