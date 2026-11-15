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

const dir = mkdtempSync(join(tmpdir(), "loop-result-provenance-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { applyMigrations } = await import("../src/server/migrations");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { forkConversation } = await import("../src/server/mobile-return");
const { continueConversation } =
  await import("../src/server/conversation-continuations");
const {
  getResult,
  listConversationResults,
  publishCompletedRunResult,
  publishImportedConversationResults,
} = await import("../src/server/result-publication");
const { resultDefects, runResultHistoryPasses } =
  await import("../src/server/result-history");
const { doneCards } = await import("../src/server/done-cards");
const { projectFeed } = await import("../src/server/feed-projector");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function agentFor(owner: string, name: string, provider = "openai") {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,?,'Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    provider,
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

function completedRun(
  owner: string,
  agentId: string,
  text: string,
  conversationId?: string,
) {
  const queued = submit(owner, {
    agentId,
    ...(conversationId ? { conversationId } : {}),
    input: "Write the answer",
    idempotencyKey: id(),
  });
  const run = ownedRun(queued.id, owner);
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,'{}',?)",
  ).run(message, owner, run.conversation_id, run.id, text, now() + 5);
  db.prepare(
    "UPDATE runs SET state='completed',payload=json_set(payload,'$.provider','anthropic','$.model','model-x'),updated_at=? WHERE id=?",
  ).run(now() + 10, run.id);
  return {
    run,
    message,
    result: publishCompletedRunResult(run.id, owner, db)!,
  };
}

type DoneEntry = ReturnType<typeof doneCards>[number]["card"];
function doneDisplay(card: DoneEntry) {
  if (card.type !== "done") throw new Error("Expected a Done card");
  return card.display;
}

function copiedAnswer(owner: string, conversationId: string) {
  return listConversationResults(owner, conversationId, db).find(
    (r) => r.kind === "imported_answer",
  )!;
}

function assistantMessage(conversationId: string) {
  return (
    db
      .prepare(
        "SELECT id FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at,rowid LIMIT 1",
      )
      .get(conversationId) as { id: string }
  ).id;
}

it("seals a fork's copy with the source author and a link to the original Result", () => {
  const owner = id();
  const author = agentFor(owner, "author", "anthropic");
  const destination = agentFor(owner, "destination");
  const source = completedRun(owner, author.id, "Original answer");
  expect(source.result.provenance.origin).toEqual({ kind: "produced" });
  expect(source.result.schemaVersion).toBe(2);

  const fork = forkConversation(owner, source.run.conversation_id!, {
    messageId: source.message,
    agentId: destination.id,
  });
  const copy = copiedAnswer(owner, fork.id);
  expect(copy.provenance).toMatchObject({
    agentId: author.id,
    agentName: author.name,
    provider: "anthropic",
    model: "model-x",
    conversationId: fork.id,
    origin: {
      kind: "copied",
      sourceResultId: source.result.id,
      sourceMessageId: source.message,
      sourceConversationId: source.run.conversation_id,
      sourceAvailable: true,
    },
  });

  // New work in the fork is the destination agent's own.
  const own = completedRun(owner, destination.id, "Fork's answer", fork.id);
  expect(own.result.provenance).toMatchObject({
    agentId: destination.id,
    agentName: destination.name,
    origin: { kind: "produced" },
  });

  // Renaming and reconfiguring either agent leaves sealed facts unchanged.
  db.prepare(
    "UPDATE agents SET name=name||' renamed',normalized_name=normalized_name||' renamed',model='other-model' WHERE id IN (?,?)",
  ).run(author.id, destination.id);
  expect(getResult(owner, copy.id, db)).toEqual(copy);
  expect(getResult(owner, source.result.id, db)).toEqual(source.result);

  // Publishing again keeps identities and digests, with no duplicate.
  const again = publishImportedConversationResults(owner, fork.id, db);
  expect(again.map((r) => [r.id, r.contentDigest])).toEqual([
    [copy.id, copy.contentDigest],
  ]);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM results WHERE owner_id=? AND conversation_id=?",
      )
      .get(owner, fork.id),
  ).toEqual({ n: 2 });
});

it("names the root original for a continuation of a copy, never an intermediary", () => {
  const owner = id();
  const author = agentFor(owner, "author", "anthropic");
  const middle = agentFor(owner, "middle");
  const last = agentFor(owner, "last");
  const source = completedRun(owner, author.id, "Root answer");
  const fork = forkConversation(owner, source.run.conversation_id!, {
    messageId: source.message,
    agentId: middle.id,
  });
  const continuation = continueConversation(owner, fork.id, {
    agentId: last.id,
    messageIds: [assistantMessage(fork.id)],
    start: { input: "Go on", idempotencyKey: id() },
  } as any);
  const nested = copiedAnswer(owner, continuation.id);
  expect(nested.provenance).toMatchObject({
    agentId: author.id,
    provider: "anthropic",
    origin: {
      kind: "copied",
      sourceResultId: source.result.id,
      sourceMessageId: source.message,
    },
  });
});

it("records an unavailable source as unknown authorship and rejects another owner's source", () => {
  const owner = id();
  const agent = agentFor(owner, "receiver");
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Copy','loop-fork',1)",
  ).run(conversation, owner, agent.id);

  // A source owned by someone else reads exactly like a missing source.
  const other = id();
  const otherAgent = agentFor(other, "secret", "anthropic");
  const foreign = completedRun(other, otherAgent.id, "Private answer");
  for (const [content, sourceMessage] of [
    ["Gone", "deleted-message"],
    ["Foreign", foreign.message],
  ]) {
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,'assistant',?,?,?)",
    ).run(
      id(),
      owner,
      conversation,
      content,
      JSON.stringify({ sourceConversation: "elsewhere", sourceMessage }),
      content === "Gone" ? 2 : 3,
    );
  }
  const [gone, foreignCopy] = publishImportedConversationResults(
    owner,
    conversation,
    db,
  );
  for (const [result, sourceMessageId] of [
    [gone, "deleted-message"],
    [foreignCopy, foreign.message],
  ] as const) {
    expect(result.provenance).toMatchObject({
      agentId: null,
      agentName: null,
      provider: null,
      model: null,
      placement: { status: "unknown" },
      origin: {
        kind: "copied",
        sourceResultId: null,
        sourceMessageId,
        sourceConversationId: "elsewhere",
        sourceAvailable: false,
      },
    });
  }
  expect(JSON.stringify(foreignCopy)).not.toContain(otherAgent.name);
  expect(JSON.stringify(foreignCopy)).not.toContain(foreign.result.id);
});

it("distinguishes an external import from a copied publication", () => {
  const owner = id();
  const agent = agentFor(owner, "importer");
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Imported','openai-import',1)",
  ).run(conversation, owner, agent.id);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,'assistant','Imported answer','{}',2)",
  ).run(id(), owner, conversation);
  const [imported] = publishImportedConversationResults(
    owner,
    conversation,
    db,
  );
  expect(imported.provenance.origin).toEqual({
    kind: "external_import",
    provider: "openai",
  });

  const destination = agentFor(owner, "destination");
  const fork = forkConversation(owner, conversation, {
    messageId: imported.provenance.messageId,
    agentId: destination.id,
  });
  expect(copiedAnswer(owner, fork.id).provenance.origin).toMatchObject({
    kind: "copied",
    sourceResultId: imported.id,
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

// Seeds two owners, each with an original run answer by one agent and a fork
// copy of it in a conversation that belongs to a different agent.
function seedForkHistory(database: Database.Database) {
  const seeded: Record<string, { copyMessage: string; runId: string }> = {};
  for (const owner of ["owner-a", "owner-b"]) {
    const run = `${owner}-run`;
    database.exec(`
      INSERT INTO agents(id, owner_id, name, normalized_name, provider, model, instructions, origin, created_at)
      VALUES ('${owner}-author', '${owner}', 'Author', '${owner} author', 'anthropic', 'claude', '', 'loop', 1),
             ('${owner}-dest', '${owner}', 'Destination', '${owner} destination', 'openai', 'gpt', '', 'loop', 1);
      INSERT INTO conversations(id, owner_id, agent_id, title, origin, created_at)
      VALUES ('${owner}-src', '${owner}', '${owner}-author', 'Source', 'loop', 10),
             ('${owner}-fork', '${owner}', '${owner}-dest', 'Fork: Source', 'loop-fork', 20);
      INSERT INTO runs(id, owner_id, agent_id, conversation_id, kind, input, state, idempotency_key, payload, created_at, updated_at)
      VALUES ('${run}', '${owner}', '${owner}-author', '${owner}-src', 'agent', 'Question', 'completed', '${owner}-k', '{"provider":"anthropic","model":"claude"}', 11, 13);
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('${owner}-q', '${owner}', '${owner}-src', '${run}', 'user', 'Question', '{}', 11),
             ('${owner}-a', '${owner}', '${owner}-src', '${run}', 'assistant', 'Answer', '{}', 12),
             ('${owner}-fq', '${owner}', '${owner}-fork', NULL, 'user', 'Question', '{"sourceConversation":"${owner}-src","sourceMessage":"${owner}-q","forked":true}', 11),
             ('${owner}-fa', '${owner}', '${owner}-fork', NULL, 'assistant', 'Answer', '{"sourceConversation":"${owner}-src","sourceMessage":"${owner}-a","forked":true}', 12);
      INSERT INTO message_bookmarks(owner_id, message_id, created_at) VALUES ('${owner}', '${owner}-fa', 30);
    `);
    seeded[owner] = { copyMessage: `${owner}-fa`, runId: run };
  }
  return seeded;
}

it("seals released fork history with its source author on upgrade from v0.1.0", () => {
  const work = mkdtempSync(join(tmpdir(), "loop-provenance-upgrade-"));
  try {
    const migrations = join(work, "migrations");
    migrationsThrough(migrations, 163);
    const upgrade = new Database(join(work, "upgrade.db"));
    applyMigrations(upgrade, migrations);
    seedForkHistory(upgrade);
    upgrade.close();

    const reopened = new Database(join(work, "upgrade.db"));
    applyMigrations(reopened);
    const rows = () =>
      reopened
        .prepare(
          "SELECT owner_id,id,schema_version,origin_completeness,agent_id,content_digest,provenance,lineage FROM results ORDER BY owner_id,id",
        )
        .all() as Record<string, any>[];
    const first = rows();
    for (const owner of ["owner-a", "owner-b"]) {
      const copy = first.find(
        (r) => r.owner_id === owner && r.id === `message:${owner}-fa`,
      )!;
      expect(copy).toMatchObject({
        schema_version: 2,
        origin_completeness: "migrated_backfill",
        agent_id: `${owner}-author`,
      });
      expect(JSON.parse(copy.provenance)).toMatchObject({
        agentId: `${owner}-author`,
        agentName: "Author",
        provider: "anthropic",
        model: "claude",
        // The source run answer was itself backfilled without a placement.
        placement: { status: "unknown" },
        origin: {
          kind: "copied",
          sourceResultId: `run:${owner}-run`,
          sourceMessageId: `${owner}-a`,
          sourceAvailable: true,
        },
      });
      expect(JSON.parse(copy.lineage).parentResultId).toBeNull();
      expect(copy.content_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(copy.content_digest).not.toBe("0".repeat(64));
      const run = first.find(
        (r) => r.owner_id === owner && r.id === `run:${owner}-run`,
      )!;
      expect(JSON.parse(run.provenance).origin).toEqual({ kind: "produced" });
    }
    // Saved overlays still name the copied message.
    expect(
      reopened
        .prepare(
          "SELECT owner_id,message_id FROM message_bookmarks ORDER BY owner_id",
        )
        .all(),
    ).toEqual([
      { owner_id: "owner-a", message_id: "owner-a-fa" },
      { owner_id: "owner-b", message_id: "owner-b-fa" },
    ]);
    expect(
      reopened.prepare("SELECT count(*) n FROM result_defects").get(),
    ).toEqual({ n: 0 });

    // A restart applies nothing again.
    applyMigrations(reopened);
    expect(rows()).toEqual(first);
    reopened.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("flags, without rewriting, copies that a 247-era build sealed with the destination agent", () => {
  const work = mkdtempSync(join(tmpdir(), "loop-provenance-247-"));
  try {
    const migrations = join(work, "migrations");
    migrationsThrough(join(work, "pre"), 163);
    migrationsThrough(migrations, 163);
    copyFileSync(
      "test/fixtures/historical-migrations/164-canonical-results-pr247.sql",
      join(migrations, "164-canonical-results.sql"),
    );
    const earlier = new Database(join(work, "earlier.db"));
    applyMigrations(earlier, join(work, "pre"));
    seedForkHistory(earlier);
    // A standalone original the 247-era backfill sealed with its
    // conversation's agent of the time.
    earlier.exec(`
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('owner-b-imp', 'owner-b', 'owner-b-src', NULL, 'assistant', 'Standalone', '{}', 13);
    `);
    // The 247-era backfill sealed both owners' copies with the destination.
    applyMigrations(earlier, migrations);
    // A later 252-era writer sealed a new copy with its source author.
    earlier.exec(`
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('owner-b-fa2', 'owner-b', 'owner-b-fork', NULL, 'assistant', 'Answer', '{"sourceConversation":"owner-b-src","sourceMessage":"owner-b-a"}', 14);
      INSERT INTO results(id, owner_id, schema_version, kind, origin_completeness, sealed, created_at, conversation_id, run_id, message_id, agent_id, content_digest, stimulus, outcome, attachments, provenance, lineage)
      VALUES ('message:owner-b-fa2', 'owner-b', 1, 'imported_answer', 'sealed_at_publication', 1, 14, 'owner-b-fork', NULL, 'owner-b-fa2', 'owner-b-author',
        '0000000000000000000000000000000000000000000000000000000000000000',
        json_object('kind','user_prompt','text','Question','sourceMessageId','owner-b-fq','authorKind','owner','automationKind',NULL,'automationFrom',NULL),
        json_object('title','Question','body','Answer','format','markdown'),
        '[]',
        json_object('agentId','owner-b-author','agentName','Author','provider','anthropic','model','claude','resolvedModel',NULL,'connectionId',NULL,
          'conversationId','owner-b-fork','runId',NULL,'messageId','owner-b-fa2',
          'placement',json_object('status','recorded','folderId',NULL,'projectId',NULL,'projectName',NULL,'teamId',NULL)),
        json_object('parentResultId','message:owner-b-fa','triggerMessageId','owner-b-fq','suppliedContext',json('[]')));
    `);
    // Copies whose recorded author cannot be contradicted by durable
    // evidence: a correctly attributed copy of an unsealed answer whose author
    // was renamed before the upgrade, and a copy whose source was deleted.
    earlier.exec(`
      INSERT INTO runs(id, owner_id, agent_id, conversation_id, kind, input, state, idempotency_key, payload, created_at, updated_at)
      VALUES ('owner-b-cancelled', 'owner-b', 'owner-b-author', 'owner-b-src', 'agent', 'Stop', 'cancelled', 'owner-b-k2', '{}', 15, 16);
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('owner-b-partial', 'owner-b', 'owner-b-src', 'owner-b-cancelled', 'assistant', 'Partial', '{}', 15),
             ('owner-b-fa3', 'owner-b', 'owner-b-fork', NULL, 'assistant', 'Partial', '{"sourceConversation":"owner-b-src","sourceMessage":"owner-b-partial"}', 17),
             ('owner-b-fa4', 'owner-b', 'owner-b-fork', NULL, 'assistant', 'Gone', '{"sourceConversation":"owner-b-src","sourceMessage":"deleted-message"}', 18),
             ('owner-b-loose', 'owner-b', 'owner-b-src', NULL, 'assistant', 'Loose', '{}', 19),
             ('owner-b-fa6', 'owner-b', 'owner-b-fork', NULL, 'assistant', 'Vanished', '{"sourceConversation":"owner-b-src","sourceMessage":"owner-b-vanished"}', 21),
             ('owner-b-fa7', 'owner-b', 'owner-b-fork', NULL, 'assistant', 'Standalone', '{"sourceConversation":"owner-b-src","sourceMessage":"owner-b-imp"}', 22),
             ('owner-b-fa5', 'owner-b', 'owner-b-fork', NULL, 'assistant', 'Loose', '{"sourceConversation":"owner-b-src","sourceMessage":"owner-b-loose"}', 20);
    `);
    for (const [message, agent, name, parent] of [
      ["owner-b-fa3", "owner-b-author", "Author", "message:owner-b-fa2"],
      ["owner-b-fa4", "owner-b-dest", "Destination", "message:owner-b-fa3"],
      // Only the source conversation's current agent could contradict this
      // one, and that assignment can change.
      ["owner-b-fa5", "owner-b-dest", "Destination", "message:owner-b-fa4"],
      // Its source is a version 1 imported answer whose message is gone, so
      // that Result may itself have been a copy and settles nothing.
      ["owner-b-fa6", "owner-b-dest", "Destination", "message:owner-b-fa5"],
      // Its source's version 1 Result took its author from a conversation
      // setting, so it does not establish the author either.
      ["owner-b-fa7", "owner-b-dest", "Destination", "message:owner-b-fa6"],
    ]) {
      earlier
        .prepare(
          `INSERT INTO results(id, owner_id, schema_version, kind, origin_completeness, sealed, created_at, conversation_id, run_id, message_id, agent_id, content_digest, stimulus, outcome, attachments, provenance, lineage)
           SELECT 'message:' || @message, 'owner-b', 1, 'imported_answer', 'sealed_at_publication', 1, m.created_at, 'owner-b-fork', NULL, @message, @agent,
             '0000000000000000000000000000000000000000000000000000000000000000',
             json_object('kind','user_prompt','text',NULL,'sourceMessageId',NULL,'authorKind','owner','automationKind',NULL,'automationFrom',NULL),
             json_object('title',m.content,'body',m.content,'format','markdown'), '[]',
             json_object('agentId',@agent,'agentName',@name,'provider',NULL,'model',NULL,'resolvedModel',NULL,'connectionId',NULL,
               'conversationId','owner-b-fork','runId',NULL,'messageId',@message,
               'placement',json_object('status','unknown','folderId',NULL,'projectId',NULL,'projectName',NULL,'teamId',NULL)),
             json_object('parentResultId',@parent,'triggerMessageId',NULL,'suppliedContext',json('[]'))
           FROM messages m WHERE m.id=@message`,
        )
        .run({ message, agent, name, parent });
    }
    earlier.exec(`
      INSERT INTO results(id, owner_id, schema_version, kind, origin_completeness, sealed, created_at, conversation_id, run_id, message_id, agent_id, content_digest, stimulus, outcome, attachments, provenance, lineage)
      VALUES ('message:owner-b-vanished', 'owner-b', 1, 'imported_answer', 'sealed_at_publication', 1, 16, 'owner-b-src', NULL, 'owner-b-vanished', 'owner-b-author',
        '0000000000000000000000000000000000000000000000000000000000000000',
        json_object('kind','user_prompt','text',NULL,'sourceMessageId',NULL,'authorKind','owner','automationKind',NULL,'automationFrom',NULL),
        json_object('title','Vanished','body','Vanished','format','markdown'), '[]',
        json_object('agentId','owner-b-author','agentName','Author','provider',NULL,'model',NULL,'resolvedModel',NULL,'connectionId',NULL,
          'conversationId','owner-b-src','runId',NULL,'messageId','owner-b-vanished',
          'placement',json_object('status','unknown','folderId',NULL,'projectId',NULL,'projectName',NULL,'teamId',NULL)),
        json_object('parentResultId','run:owner-b-run','triggerMessageId',NULL,'suppliedContext',json('[]')));
    `);
    earlier
      .prepare(
        "UPDATE agents SET name='Renamed author' WHERE id='owner-b-author'",
      )
      .run();
    applyMigrations(earlier, migrations);
    const before = earlier
      .prepare("SELECT * FROM results ORDER BY owner_id,id")
      .all();
    earlier.close();

    const upgraded = new Database(join(work, "earlier.db"));
    applyMigrations(upgraded);
    // Sealed rows, digests and references are untouched. The only new row
    // seals the answer an earlier build listed without a Result.
    const after = upgraded
      .prepare("SELECT * FROM results ORDER BY owner_id,id")
      .all() as { id: string }[];
    const known = new Set((before as { id: string }[]).map((row) => row.id));
    expect(after.filter((row) => known.has(row.id))).toEqual(before);
    expect(
      after.filter((row) => !known.has(row.id)).map((row) => row.id),
    ).toEqual(["message:owner-b-loose"]);
    // Copies naming the destination agent are flagged with the evidence; the
    // copy sealed with the right author by a later build is not.
    expect(
      resultDefects("owner-b", "message:owner-b-fa", upgraded),
    ).toHaveLength(1);
    expect(resultDefects("owner-a", "message:owner-a-fa", upgraded)).toEqual([
      {
        defect: "copy_attribution",
        evidence: {
          recorded: {
            agentId: "owner-a-dest",
            agentName: "Destination",
            provider: "openai",
            model: "gpt",
          },
          source: {
            agentId: "owner-a-author",
            agentName: "Author",
            provider: "anthropic",
            model: "claude",
            available: true,
            sourceResultId: "run:owner-a-run",
            sourceMessageId: "owner-a-a",
          },
        },
        detectedAt: expect.any(Number),
      },
    ]);
    for (const copy of ["fa2", "fa3", "fa4", "fa5", "fa6", "fa7"])
      expect(
        resultDefects("owner-b", `message:owner-b-${copy}`, upgraded),
      ).toEqual([]);
    // Findings are owner-scoped.
    expect(resultDefects("owner-b", "message:owner-a-fa", upgraded)).toEqual(
      [],
    );

    // A restart neither repeats the pass nor changes the finding.
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

it("presents a recorded finding on the copy's Done card without changing the record", () => {
  const owner = id();
  const author = agentFor(owner, "author", "anthropic");
  const destination = agentFor(owner, "destination");
  const source = completedRun(owner, author.id, "Original answer");
  // An earlier build sealed this copy as the destination agent's work.
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Fork','loop-fork',?)",
  ).run(conversation, owner, destination.id, now());
  const copy = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,'assistant','Original answer',?,?)",
  ).run(
    copy,
    owner,
    conversation,
    JSON.stringify({
      sourceConversation: source.run.conversation_id,
      sourceMessage: source.message,
    }),
    now(),
  );
  const resultId = "message:" + copy;
  db.prepare(
    `INSERT INTO results(id,owner_id,schema_version,kind,origin_completeness,sealed,created_at,conversation_id,run_id,message_id,agent_id,content_digest,stimulus,outcome,attachments,provenance,lineage)
     VALUES(?,?,1,'imported_answer','sealed_at_publication',1,?,?,NULL,?,?,?,?,?,'[]',?,?)`,
  ).run(
    resultId,
    owner,
    now(),
    conversation,
    copy,
    destination.id,
    "0".repeat(64),
    JSON.stringify({
      kind: "user_prompt",
      text: null,
      sourceMessageId: null,
      authorKind: "owner",
      automationKind: null,
      automationFrom: null,
    }),
    JSON.stringify({
      title: "Original answer",
      body: "Original answer",
      format: "markdown",
    }),
    JSON.stringify({
      agentId: destination.id,
      agentName: destination.name,
      provider: "openai",
      model: "fixture",
      resolvedModel: null,
      connectionId: null,
      conversationId: conversation,
      runId: null,
      messageId: copy,
      placement: {
        status: "unknown",
        folderId: null,
        projectId: null,
        projectName: null,
        teamId: null,
      },
    }),
    JSON.stringify({
      parentResultId: null,
      triggerMessageId: null,
      suppliedContext: [],
    }),
  );
  const sealed = getResult(owner, resultId, db)!;

  // Rerun the detection pass as an upgrade from that build would.
  db.prepare(
    "DELETE FROM result_history_passes WHERE name='detect-copy-attribution'",
  ).run();
  db.transaction(() =>
    runResultHistoryPasses(db, { freshResults: false }),
  ).immediate();
  // A finding kind from a newer build is not presented.
  db.prepare(
    "INSERT INTO result_defects(owner_id,result_id,defect,evidence,detected_at) VALUES(?,?,'future_kind','{}',1)",
  ).run(owner, resultId);
  db.prepare(
    "INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key) VALUES(?,?,?)",
  ).run(owner, conversation, resultId);
  db.transaction(() => projectFeed(db, () => {})).immediate();

  const card = doneCards(owner, {
    folders: null,
    teamIds: [],
    before: null,
    limit: 20,
    atTime: now() + 1000,
  }).find((entry) => entry.card.id === `d:${resultId}`)!;
  expect(doneDisplay(card.card).result_findings).toEqual(["copy_attribution"]);
  expect(card.card.content).toBe("Original answer");
  expect(getResult(owner, resultId, db)).toEqual(sealed);
  const original = doneCards(owner, {
    folders: null,
    teamIds: [],
    before: null,
    limit: 20,
    atTime: now() + 1000,
  }).find((entry) => entry.card.id === `d:${source.result.id}`)!;
  expect(doneDisplay(original.card).result_findings).toBeUndefined();
});

it("does not record a placement for a copy of an answer that was never published", () => {
  const owner = id();
  const author = agentFor(owner, "author");
  const destination = agentFor(owner, "destination");
  const queued = submit(owner, {
    agentId: author.id,
    input: "Start",
    idempotencyKey: id(),
  });
  const run = ownedRun(queued.id, owner);
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','Interrupted answer','{}',?)",
  ).run(message, owner, run.conversation_id, run.id, now() + 1);
  // Even a folder the run recorded says nothing about the project and team
  // its answer was published under, since it was never published.
  const folder = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'project','Renamed later',1)",
  ).run(folder, owner);
  db.prepare(
    "UPDATE runs SET state='cancelled',payload=json_set(payload,'$.folderId',?) WHERE id=?",
  ).run(folder, run.id);
  const fork = forkConversation(owner, run.conversation_id!, {
    messageId: message,
    agentId: destination.id,
  });
  expect(copiedAnswer(owner, fork.id).provenance).toMatchObject({
    agentId: author.id,
    placement: { status: "unknown" },
    origin: {
      kind: "copied",
      sourceResultId: null,
      sourceMessageId: message,
      sourceAvailable: true,
    },
  });
});

it("keeps a version 1 copy's recorded author when the chain beyond it is gone", () => {
  const owner = id();
  const author = agentFor(owner, "author", "anthropic");
  const destination = agentFor(owner, "destination");
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Fork','loop-fork',?)",
  ).run(conversation, owner, destination.id, now());
  // An earlier build sealed this copy, whose own source no longer exists.
  const earlier = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,'assistant','Kept answer',?,?)",
  ).run(
    earlier,
    owner,
    conversation,
    JSON.stringify({ sourceMessage: "gone-message" }),
    now(),
  );
  const earlierResult = "message:" + earlier;
  db.prepare(
    `INSERT INTO results(id,owner_id,schema_version,kind,origin_completeness,sealed,created_at,conversation_id,run_id,message_id,agent_id,content_digest,stimulus,outcome,attachments,provenance,lineage)
     VALUES(?,?,1,'imported_answer','sealed_at_publication',1,?,?,NULL,?,?,?,?,?,'[]',?,?)`,
  ).run(
    earlierResult,
    owner,
    now(),
    conversation,
    earlier,
    author.id,
    "0".repeat(64),
    JSON.stringify({
      kind: "user_prompt",
      text: null,
      sourceMessageId: null,
      authorKind: "owner",
      automationKind: null,
      automationFrom: null,
    }),
    JSON.stringify({
      title: "Kept answer",
      body: "Kept answer",
      format: "markdown",
    }),
    JSON.stringify({
      agentId: author.id,
      agentName: author.name,
      provider: "anthropic",
      model: "model-x",
      resolvedModel: null,
      connectionId: null,
      conversationId: conversation,
      runId: null,
      messageId: earlier,
      placement: {
        status: "unknown",
        folderId: null,
        projectId: null,
        projectName: null,
        teamId: null,
      },
    }),
    JSON.stringify({
      parentResultId: null,
      triggerMessageId: null,
      suppliedContext: [],
    }),
  );
  const fork = forkConversation(owner, conversation, {
    messageId: earlier,
    agentId: destination.id,
  });
  expect(copiedAnswer(owner, fork.id).provenance).toMatchObject({
    agentId: author.id,
    agentName: author.name,
    provider: "anthropic",
    origin: {
      kind: "copied",
      sourceResultId: earlierResult,
      sourceMessageId: earlier,
      sourceAvailable: true,
    },
  });
});

it("seals a copy's source conversation first even when it was created later", () => {
  const work = mkdtempSync(join(tmpdir(), "loop-provenance-order-"));
  try {
    const migrations = join(work, "migrations");
    migrationsThrough(migrations, 163);
    const upgrade = new Database(join(work, "upgrade.db"));
    applyMigrations(upgrade, migrations);
    // "late" holds an original answer and a copy of its own; "early" copies
    // that original but sorts first by creation time.
    upgrade.exec(`
      INSERT INTO agents(id, owner_id, name, normalized_name, provider, model, instructions, origin, created_at)
      VALUES ('order-agent', 'order-owner', 'Order', 'order agent', 'openai', 'gpt', '', 'loop', 1);
      INSERT INTO conversations(id, owner_id, agent_id, title, origin, created_at)
      VALUES ('elsewhere', 'order-owner', 'order-agent', 'Elsewhere', 'loop', 1),
             ('early', 'order-owner', 'order-agent', 'Early', 'loop-fork', 5),
             ('late', 'order-owner', 'order-agent', 'Late', 'loop-continuation', 10);
      INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
      VALUES ('other', 'order-owner', 'elsewhere', NULL, 'assistant', 'Other', '{}', 1),
             ('late-copy', 'order-owner', 'late', NULL, 'assistant', 'Other', '{"sourceMessage":"other"}', 2),
             ('late-original', 'order-owner', 'late', NULL, 'assistant', 'Original', '{}', 3),
             ('early-copy', 'order-owner', 'early', NULL, 'assistant', 'Original', '{"sourceMessage":"late-original"}', 4);
    `);
    applyMigrations(upgrade);
    const [copy] = listConversationResults("order-owner", "early", upgrade);
    expect(copy.provenance.origin).toMatchObject({
      kind: "copied",
      sourceResultId: "message:late-original",
    });
    upgrade.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
