import {
  seedConnection,
  seedConversation,
  seedMessage,
} from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { feed, forkConversation, listSaved, setSaved } =
  await import("../src/server/mobile-return");
const { continueConversation } =
  await import("../src/server/conversation-continuations");
const { doneCards } = await import("../src/server/done-cards");
const { projectFeed } = await import("../src/server/feed-projector");
const {
  publishCompletedRunResult,
  publishImportedConversationResults,
  publishSteeringReplyResult,
} = await import("../src/server/result-publication");
const { runResultHistoryPasses } = await import("../src/server/result-history");

afterAll(() => {
  db.close();
});

function agentFor(owner: string, name: string) {
  const connection = id();
  seedConnection(db, {
    id: connection,
    owner_id: owner,
    secret: seal("fixture", owner),
    models: JSON.stringify([{ id: "fixture" }]),
    created_at: now(),
  });
  return createAgent(owner, {
    name: name + "-" + id().slice(0, 6),
    connectionId: connection,
    model: "fixture",
  });
}

function finishRun(
  owner: string,
  agentId: string,
  text: string,
  publish = true,
) {
  const queued = submit(owner, {
    agentId,
    input: "Task " + text,
    idempotencyKey: id(),
  });
  const run = ownedRun(queued.id, owner);
  const message = id();
  seedMessage(db, {
    id: message,
    owner_id: owner,
    conversation_id: run.conversation_id!,
    run_id: run.id,
    role: "assistant",
    content: text,
    metadata: "{}",
    created_at: now() + 1,
  });
  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(
    now() + 2,
    run.id,
  );
  const result = publish ? publishCompletedRunResult(run.id, owner, db) : null;
  return { run, message, result };
}

function project() {
  db.transaction(() => projectFeed(db, () => {})).immediate();
}

function done(owner: string) {
  project();
  return doneCards(owner, {
    folders: null,
    teamIds: [],
    before: null,
    limit: 50,
    atTime: now() + 10_000,
  }).map((entry) => entry.card);
}

it("discovers every published output from its sealed Result, not the transcript", () => {
  const owner = id();
  const author = agentFor(owner, "author");
  const other = agentFor(owner, "other");
  const answer = finishRun(owner, author.id, "Sealed answer");
  const fork = forkConversation(owner, answer.run.conversation_id!, {
    messageId: answer.message,
    agentId: other.id,
  });
  const forked = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant'",
    )
    .get(fork.id) as { id: string };
  const continuation = continueConversation(owner, fork.id, {
    agentId: other.id,
    messageIds: [forked.id],
    start: { input: "Go on", idempotencyKey: id() },
  } as any);
  const keys = new Set(done(owner).map((card) => card.id));
  expect(keys).toContain(`d:${answer.result!.id}`);
  expect(keys).toContain(`d:message:${forked.id}`);
  const continued = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant' AND run_id IS NULL",
    )
    .get(continuation.id) as { id: string };
  expect(keys).toContain(`d:message:${continued.id}`);

  // Rewriting the transcript, adding a later answer to the same run and
  // renaming the agent do not change or replace the published card.
  db.prepare("UPDATE messages SET content='Rewritten' WHERE id=?").run(
    answer.message,
  );
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: answer.run.conversation_id!,
    run_id: answer.run.id,
    role: "assistant",
    content: "Later reply",
    metadata: "{}",
    created_at: now() + 50,
  });
  db.prepare(
    "UPDATE agents SET name=name||' renamed',normalized_name=normalized_name||' renamed' WHERE id=?",
  ).run(author.id);
  db.prepare(
    "INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key) VALUES(?,?,'*')",
  ).run(owner, answer.run.conversation_id);
  const card = done(owner).find((c) => c.id === `d:${answer.result!.id}`)!;
  expect(card.content).toBe("Sealed answer");
  expect(card.source.message_id).toBe(answer.message);
  expect(card.type === "done" && card.display.agent_name).toBe(author.name);

  // A saved published answer shows the sealed Result too.
  setSaved(owner, answer.message, true);
  const saved = listSaved(owner).items.find(
    (item) => item.key === `m:${answer.message}`,
  );
  expect(saved?.kind === "message" && saved.message.content).toBe(
    "Sealed answer",
  );
  expect(saved?.kind === "message" && saved.message.agent_name).toBe(
    author.name,
  );
});

it("does not manufacture a published card from an unsealed transcript answer", () => {
  const owner = id();
  const agent = agentFor(owner, "raw");
  const unpublished = finishRun(owner, agent.id, "Never sealed", false);
  const conversation = id();
  seedConversation(db, {
    id: conversation,
    owner_id: owner,
    agent_id: agent.id,
    title: "Loose",
    origin: "loop",
    created_at: now(),
  });
  const loose = id();
  seedMessage(db, {
    id: loose,
    owner_id: owner,
    conversation_id: conversation,
    run_id: null,
    role: "assistant",
    content: "Loose answer",
    metadata: "{}",
    created_at: now(),
  });
  for (const conv of [unpublished.run.conversation_id!, conversation])
    db.prepare(
      "INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key) VALUES(?,?,'*')",
    ).run(owner, conv);
  project();
  // Idle threads keep their operational card; no result card is projected.
  const resultCards = () =>
    db
      .prepare(
        "SELECT card_key FROM feed_cards WHERE owner_id=? AND kind='result' ORDER BY card_key",
      )
      .all(owner)
      .map((row) => (row as { card_key: string }).card_key);
  expect(resultCards()).toEqual([]);

  // An upgrade from a build that listed such answers seals them from that
  // evidence; the cards then come from those Results.
  db.prepare(
    "DELETE FROM result_history_passes WHERE name IN ('seal-unpublished-answers','rebuild-result-cards')",
  ).run();
  db.transaction(() =>
    runResultHistoryPasses(db, { freshResults: false }),
  ).immediate();
  const upgraded = done(owner);
  expect(resultCards()).toEqual(
    [`message:${loose}`, `run:${unpublished.run.id}`].sort(),
  );
  const sealedRun = upgraded.find(
    (c) => c.id === `d:run:${unpublished.run.id}`,
  )!;
  expect(sealedRun.content).toBe("Never sealed");
  const row = db
    .prepare(
      "SELECT origin_completeness,json_extract(provenance,'$.placement.status') placement FROM results WHERE owner_id=? AND id=?",
    )
    .get(owner, `run:${unpublished.run.id}`);
  // Sealed late, but its run recorded the folder it ran in.
  expect(row).toEqual({
    origin_completeness: "migrated_backfill",
    placement: "recorded",
  });
  // Sealing again changes nothing.
  const before = db
    .prepare("SELECT * FROM results WHERE owner_id=? ORDER BY id")
    .all(owner);
  publishImportedConversationResults(owner, conversation, db);
  expect(
    db.prepare("SELECT * FROM results WHERE owner_id=? ORDER BY id").all(owner),
  ).toEqual(before);
});

it("serves Replies from sealed steering-reply Results with their read state", () => {
  const owner = id();
  const agent = agentFor(owner, "replier");
  const queued = submit(owner, {
    agentId: agent.id,
    input: "Work",
    idempotencyKey: id(),
  });
  const run = ownedRun(queued.id, owner);
  const question = id();
  const reply = id();
  seedMessage(db, {
    id: question,
    owner_id: owner,
    conversation_id: run.conversation_id!,
    run_id: run.id,
    role: "user",
    content: "Which option?",
    metadata: JSON.stringify({ steeringId: "s-" + reply }),
    created_at: now(),
  });
  db.prepare(
    "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,state,created_at) VALUES(?,?,?,?,?,'{}','delivered',?)",
  ).run("s-" + reply, owner, run.id, question, id(), now());
  seedMessage(db, {
    id: reply,
    owner_id: owner,
    conversation_id: run.conversation_id!,
    run_id: run.id,
    role: "assistant",
    content: "Option B",
    metadata: JSON.stringify({ reply: { to: question, published: true } }),
    created_at: now() + 1,
  });
  db.prepare(
    "INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at) VALUES(?,?,?,?)",
  ).run(reply, owner, "s-" + reply, now() + 1);
  const replies = () =>
    feed(owner, { filter: "replies" }).items.filter(
      (item) => item.conversation_id === run.conversation_id,
    );
  // A reply row without a sealed Result is not a published output.
  expect(replies()).toEqual([]);

  publishSteeringReplyResult(
    { ownerId: owner, messageId: reply, steeringId: "s-" + reply },
    db,
  );
  db.prepare("UPDATE messages SET content='Rewritten' WHERE id IN (?,?)").run(
    question,
    reply,
  );
  const [item] = replies();
  expect(item.last_message?.preview).toBe("Option B");
  expect(item.reply).toMatchObject({
    message_id: question,
    content: "Which option?",
    read_at: null,
  });
  expect(item.agent_id).toBe(agent.id);
});
