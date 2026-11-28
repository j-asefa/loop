import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { writeMessageMetadata } from "../src/shared/message-metadata.js";
import {
  seedAgent,
  seedConnection,
  seedConversation,
  seedMessage,
  seedRun,
} from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";

const dir = testDirectory();
function createTestRepo(name: string) {
  const repoDir = join(dir, name);
  mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@loop.invalid");
  git("config", "user.name", "Loop Test");
  writeFileSync(join(repoDir, "app.ts"), "export const v = 1;\n");
  git("add", ".");
  git("commit", "-m", "initial");
  writeFileSync(join(repoDir, "app.ts"), "export const v = 2;\n");
  return repoDir;
}

const { db, id, now } = await import("../src/server/db");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { requestReview, requestedReviewStatus, startCodeReview } =
  await import("../src/server/code-reviews");
const { transition } = await import("../src/server/queue");
const { feed } = await import("../src/server/mobile-return");
const { doneCards } = await import("../src/server/done-cards");
const { threadDetails } = await import("../src/server/feed-card-details");
const { listAgentThreads } = await import("../src/server/agent-thread-feed");
const { projectFeed } = await import("../src/server/feed-projector");
const { sendMail } = await import("../src/server/agent-mail");
const { search } = await import("../src/server/search");

const listDoneCards = (
  owner: string,
  extra: Partial<Parameters<typeof doneCards>[1]> = {},
) =>
  doneCards(owner, {
    folders: null,
    teamIds: [],
    limit: 50,
    detail: false,
    ...extra,
  });

afterAll(() => {
  db.close();
});

function setupWorkspace(owner: string) {
  const connectionId = id();
  seedConnection(db, {
    id: connectionId,
    owner_id: owner,
    provider: "openai",
    secret: "",
    models: JSON.stringify([{ id: "fixture" }]),
    created_at: now(),
  });
  const builder = createAgent(owner, {
    name: "builder-" + id().slice(0, 6),
    connectionId,
    model: "fixture",
  });
  const helper = createAgent(owner, {
    name: "helper-" + id().slice(0, 6),
    connectionId,
    model: "fixture",
  });
  const reviewer = createAgent(owner, {
    name: "reviewer-" + id().slice(0, 6),
    connectionId,
    model: "fixture",
  });
  const peerReviewer = createAgent(owner, {
    name: "peer-" + id().slice(0, 6),
    connectionId,
    model: "fixture",
  });
  const repoDir = createTestRepo("repo-" + id().slice(0, 6));
  const folderId = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Repo',?)",
  ).run(folderId, owner, now());
  db.prepare("INSERT INTO project_paths(folder_id,path) VALUES(?,?)").run(
    folderId,
    repoDir,
  );
  const reviewTeamId = id();
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,folder_id,hide_results_from_feed,created_at) VALUES(?,?,'Review Team',?,?,1,?)",
  ).run(reviewTeamId, owner, reviewer.id, folderId, now());
  db.prepare("INSERT INTO team_members(team_id,agent_id) VALUES(?,?)").run(
    reviewTeamId,
    peerReviewer.id,
  );
  const runPayload = (folderId: string) =>
    JSON.stringify({
      agentId: builder.id,
      name: builder.name,
      provider: "openai",
      model: "fixture",
      instructions: "",
      connectionId,
      folderId,
    });
  return {
    connectionId,
    builder,
    helper,
    reviewer,
    folder: { id: folderId },
    reviewTeam: { id: reviewTeamId },
    runPayload,
  };
}

function finishTurn(
  owner: string,
  runId: string,
  conversationId: string,
  answerText: string,
) {
  db.prepare(
    "UPDATE runs SET state='running', worker_id='fixture-worker' WHERE id=? AND owner_id=?",
  ).run(runId, owner);
  const assistantMsgId = id();
  seedMessage(db, {
    id: assistantMsgId,
    owner_id: owner,
    conversation_id: conversationId,
    run_id: runId,
    role: "assistant",
    content: answerText,
    metadata: writeMessageMetadata({ final: true }),
    created_at: now(),
  });
  db.prepare("UPDATE runs SET result=? WHERE id=? AND owner_id=?").run(
    answerText,
    runId,
    owner,
  );
  transition({ id: runId, owner_id: owner }, "completed");
  return assistantMsgId;
}

it("auto-cancels pending review continuations when loop_review_status returns a finished review", () => {
  const owner = "auto-cancel-" + id().slice(0, 6);
  const { builder, folder, reviewTeam, runPayload } = setupWorkspace(owner);
  const convId = id();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "PR review flow",
    project_id: folder.id,
    created_at: now(),
  });
  const parentId = id();
  seedRun(db, {
    id: parentId,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Fix bug and get review",
    state: "running",
    idempotency_key: parentId,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: parentId,
    role: "user",
    content: "Fix bug and get review",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });

  const requested = requestReview(ownedRun(parentId, owner), "call-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  expect("report" in requested).toBe(true);
  const reviewId = (requested as { report: { reviewId: string } }).report
    .reviewId;

  const rc = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(reviewId) as { run_id: string; lead_run_id: string };

  // Polling loop_review_status while the review is still active must NOT cancel the continuation
  const stillRunning = requestedReviewStatus(
    ownedRun(parentId, owner),
    reviewId,
  );
  expect((stillRunning.report as { state: string }).state).toBe("queued");
  expect(
    (
      db.prepare("SELECT state FROM runs WHERE id=?").get(rc.run_id) as {
        state: string;
      }
    ).state,
  ).toBe("queued");

  // Complete the review lead run. A DIFFERENT running turn in the same
  // conversation reading loop_review_status must NOT cancel parentId's continuation.
  db.prepare(
    "UPDATE runs SET state='completed', result='Clean snapshot' WHERE id=?",
  ).run(rc.lead_run_id);
  const siblingTurn = id();
  seedRun(db, {
    id: siblingTurn,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Unrelated turn",
    state: "running",
    idempotency_key: siblingTurn,
    payload: runPayload(folder.id),
    created_at: now() + 5,
    updated_at: now() + 5,
  });
  requestedReviewStatus(ownedRun(siblingTurn, owner), reviewId);
  expect(
    (
      db.prepare("SELECT state FROM runs WHERE id=?").get(rc.run_id) as {
        state: string;
      }
    ).state,
  ).toBe("queued");
  db.prepare("DELETE FROM runs WHERE id=? AND owner_id=?").run(
    siblingTurn,
    owner,
  );

  // Reading loop_review_status from the original parent run auto-cancels the continuation
  const finished = requestedReviewStatus(ownedRun(parentId, owner), reviewId);
  expect((finished.report as { state: string }).state).toBe("completed");

  // Pending continuation is auto-cancelled so no stale follow-up turn fires
  expect(
    (
      db.prepare("SELECT state FROM runs WHERE id=?").get(rc.run_id) as {
        state: string;
      }
    ).state,
  ).toBe("cancelled");

  // Completing the parent turn after auto-cancelling its continuation must leave
  // the thread in completed state (not cancelled) in All / Outcomes
  finishTurn(owner, parentId, convId, "Handled review inline.");
  const allThread = feed(owner, { filter: "all" }).items.find(
    (item) => item.conversation_id === convId,
  );
  expect(allThread?.run?.id).toBe(parentId);
  expect(allThread?.run?.state).toBe("completed");
  expect(
    feed(owner, { filter: "outcomes" }).items.some(
      (item) => item.conversation_id === convId,
    ),
  ).toBe(true);

  // An already-dispatched continuation (with native_dispatch) is never auto-cancelled
  const conv2 = id();
  seedConversation(db, {
    id: conv2,
    owner_id: owner,
    agent_id: builder.id,
    title: "Dispatched continuation",
    project_id: folder.id,
    created_at: now(),
  });
  const parent2 = id();
  seedRun(db, {
    id: parent2,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: conv2,
    input: "Second task",
    state: "running",
    idempotency_key: parent2,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  const req2 = requestReview(ownedRun(parent2, owner), "call-2", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const review2 = (req2 as { report: { reviewId: string } }).report.reviewId;
  const rc2 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(review2) as { run_id: string; lead_run_id: string };
  db.prepare(
    "INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES(?,'gen-1','hash','dispatched',?)",
  ).run(rc2.run_id, now());
  db.prepare(
    "UPDATE runs SET state='completed', result='Report 2' WHERE id=?",
  ).run(rc2.lead_run_id);
  requestedReviewStatus(ownedRun(parent2, owner), review2);
  expect(
    (
      db.prepare("SELECT state FROM runs WHERE id=?").get(rc2.run_id) as {
        state: string;
      }
    ).state,
  ).toBe("queued");
});

it("collapses intermediate review-continuation turns and surfaces only the terminal Done card", () => {
  const owner = "review-collapse-" + id().slice(0, 6);
  const { builder, folder, reviewTeam, runPayload } = setupWorkspace(owner);
  const convId = id();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "Multi-round review",
    project_id: folder.id,
    created_at: now(),
  });

  // Turn 1: user prompt -> requests Review 1 -> completes
  const turn1 = id();
  seedRun(db, {
    id: turn1,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Build feature",
    state: "running",
    idempotency_key: turn1,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: turn1,
    role: "user",
    content: "Build feature",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });
  const req1 = requestReview(ownedRun(turn1, owner), "rev-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev1 = (req1 as { report: { reviewId: string } }).report.reviewId;
  const rc1 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(rev1) as { run_id: string; lead_run_id: string };
  finishTurn(owner, turn1, convId, "Opened PR and requested review 1.");

  // Queued continuation must NOT appear in Queued feed or queued_runs
  expect(feed(owner, { filter: "queued" }).items).toEqual([]);
  expect(feed(owner, { filter: "queued" }).summary.queued).toBe(0);
  expect(threadDetails(db, owner, convId).queued_runs).toEqual([]);
  // While Review 1 is pending, Turn 1 is still visible in Done
  expect(listDoneCards(owner).map((entry) => entry.card.content)).toEqual([
    "Opened PR and requested review 1.",
  ]);

  // Turn 2 (review_continuation for Review 1) fixes code and requests Review 2 -> completes
  db.prepare(
    "UPDATE runs SET state='completed', result='Found P2' WHERE id=?",
  ).run(rc1.lead_run_id);
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(rc1.run_id);
  const req2 = requestReview(ownedRun(rc1.run_id, owner), "rev-2", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev2 = (req2 as { report: { reviewId: string } }).report.reviewId;
  const rc2 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(rev2) as { run_id: string; lead_run_id: string };
  finishTurn(owner, rc1.run_id, convId, "Fixed P2 and requested review 2.");

  // Turn 2 is intermediate (spawned Review 2) and superseded Turn 1 -> 0 Done cards while Review 2 runs
  expect(feed(owner, { filter: "done" }).items).toEqual([]);
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(0);
  expect(listDoneCards(owner)).toEqual([]);

  // Turn 3 (review_continuation for Review 2) finishes cleanly without spawning another review
  db.prepare(
    "UPDATE runs SET state='completed', result='No confirmed bugs' WHERE id=?",
  ).run(rc2.lead_run_id);
  finishTurn(owner, rc2.run_id, convId, "Merged PR! Everything is live.");

  // ONLY the single terminal Done card appears in Feed Done, /api/v1/cards?view=done, and done_unread
  const doneFeed = feed(owner, { filter: "done" });
  expect(doneFeed.items).toHaveLength(1);
  expect(doneFeed.items[0].last_message?.content).toBe(
    "Merged PR! Everything is live.",
  );
  expect(doneFeed.summary.done_unread).toBe(1);
  const cards = listDoneCards(owner);
  expect(cards).toHaveLength(1);
  expect(cards[0].card.content).toBe("Merged PR! Everything is live.");

  // Direct detail lookup of an earlier superseded card still works
  const turn1CardId = `d:run:${turn1}`;
  const detailCards = listDoneCards(owner, {
    ids: [turn1CardId],
    detail: true,
    includeDismissed: true,
  });
  expect(detailCards).toHaveLength(1);
  expect(detailCards[0].card.content).toBe("Opened PR and requested review 1.");
});

it("hides agent-to-agent mail from Done, All, Queued, Outcomes and unread while preserving Needs you, Working and Agent Mail", () => {
  const owner = "mail-feed-hide-" + id().slice(0, 6);
  const { connectionId, builder, helper } = setupWorkspace(owner);

  // Human-initiated conversation with builder
  const humanConv = id();
  seedConversation(db, {
    id: humanConv,
    owner_id: owner,
    agent_id: builder.id,
    title: "Human task",
    created_at: now(),
  });
  const humanRun = id();
  seedRun(db, {
    id: humanRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: "Coordinate with helper",
    state: "running",
    idempotency_key: humanRun,
    payload: JSON.stringify({ connectionId }),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: humanConv,
    run_id: humanRun,
    role: "user",
    content: "Coordinate with helper",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });

  // Builder sends direct agent-to-agent mail to helper (creates a pure agent-mail conversation for helper)
  const sent = sendMail(ownedRun(humanRun, owner), "mail-call-1", {
    to: helper.id,
    body: "Please check build logs",
    interrupt: false,
    fileIds: [],
  });
  expect(sent.messageId).toBeTruthy();
  const mailRecord = db
    .prepare(
      "SELECT id, run_id, recipient_conversation_id FROM agent_mail WHERE owner_id=? AND id=?",
    )
    .get(owner, sent.messageId) as {
    id: string;
    run_id: string;
    recipient_conversation_id: string;
  };
  const mailConv = mailRecord.recipient_conversation_id;
  const mailRun = mailRecord.run_id;

  // Queued agent-mail run must NOT appear in Queued, All, or queued_runs
  expect(feed(owner, { filter: "queued" }).items).toEqual([]);
  expect(feed(owner, { filter: "queued" }).summary.queued).toBe(0);
  expect(threadDetails(db, owner, mailConv).queued_runs).toEqual([]);
  expect(
    feed(owner, { filter: "all" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(false);

  // While actively running, Working still shows it; if awaiting approval, Needs you still shows it
  db.prepare("UPDATE runs SET state='running', worker_id='w' WHERE id=?").run(
    mailRun,
  );
  expect(
    feed(owner, { filter: "working" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(true);
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    mailRun,
  );
  expect(
    feed(owner, { filter: "needs" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(true);

  // Once completed, the pure agent-mail conversation stays hidden from Done, All, Outcomes, /api/v1/cards?view=done, and done_unread
  finishTurn(owner, mailRun, mailConv, "Build logs look clean.");
  expect(
    feed(owner, { filter: "done" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(
    feed(owner, { filter: "all" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(
    feed(owner, { filter: "outcomes" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(
    listDoneCards(owner).some(
      (entry) => entry.card.source.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(0);

  // Agent Mail view still exposes the inter-agent thread
  expect(
    listAgentThreads(owner, { view: "threads", limit: 20 }).items.length,
  ).toBeGreaterThanOrEqual(1);

  // Human conversation's own Done card still shows normally, while an agent-mail reply inside the human conversation is hidden from Done
  finishTurn(owner, humanRun, humanConv, "Done coordinating.");
  const mailReplyRun = id();
  seedRun(db, {
    id: mailReplyRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: "Result from helper",
    state: "queued",
    idempotency_key: mailReplyRun,
    payload: JSON.stringify({ connectionId, mailId: mailRecord.id }),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: humanConv,
    run_id: mailReplyRun,
    role: "user",
    content: "Result from helper",
    metadata: writeMessageMetadata({
      personal: false,
      automation: {
        kind: "agent_result",
        mailId: mailRecord.id,
        threadId: "t-1",
        fromAgentId: helper.id,
        fromName: helper.name,
      },
    }),
    created_at: now(),
  });

  // While the internal mail reply is still queued, the owner's conversation
  // must stay in Outcomes and display the owner's completed turn, not the queued mail run.
  const humanWhileQueued = feed(owner, { filter: "outcomes" }).items.find(
    (item) => item.conversation_id === humanConv,
  );
  expect(humanWhileQueued?.run?.id).toBe(humanRun);
  expect(humanWhileQueued?.last_message?.content).toBe("Done coordinating.");

  finishTurn(owner, mailReplyRun, humanConv, "Noted helper result.");

  // Human conversation stays visible in All & Outcomes showing the owner's turn
  // (not the hidden trailing mail run), and ONLY the owner's Done card shows in Done & unread
  const humanInAll = feed(owner, { filter: "all" }).items.find(
    (item) => item.conversation_id === humanConv,
  );
  expect(humanInAll?.run?.id).toBe(humanRun);
  expect(humanInAll?.last_message?.content).toBe("Done coordinating.");
  const humanInOutcomes = feed(owner, { filter: "outcomes" }).items.find(
    (item) => item.conversation_id === humanConv,
  );
  expect(humanInOutcomes?.run?.id).toBe(humanRun);
  expect(humanInOutcomes?.last_message?.content).toBe("Done coordinating.");
  const humanDone = listDoneCards(owner).filter(
    (entry) => entry.card.source.conversation_id === humanConv,
  );
  expect(humanDone).toHaveLength(1);
  expect(humanDone[0].card.content).toBe("Done coordinating.");
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(1);
});

it("migration 169 preserves historical rows and backfills hide_internal and filtered queued counts on upgrade", () => {
  const mem = new Database(":memory:");
  try {
    const files = readdirSync("migrations")
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      if (file.startsWith("169-")) break;
      mem.exec(readFileSync(join("migrations", file), "utf8"));
    }

    const owner = "upgrade-owner";
    const t = 1_700_000_000_000;
    seedConnection(mem, {
      id: "conn",
      owner_id: owner,
      provider: "openai",
      secret: "",
      models: "[]",
      created_at: t,
    });
    seedAgent(mem, {
      id: "a1",
      owner_id: owner,
      name: "alpha",
      normalized_name: "alpha",
      provider: "openai",
      connection_id: "conn",
      model: "m",
      created_at: t,
    });

    // Seed a historical pure agent-mail conversation with a sealed result
    mem
      .prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('c-mail',?,'a1','Mail thread',?)",
      )
      .run(owner, t);
    mem
      .prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES('r-mail',?,'a1','c-mail','agent','Ping','completed','k-mail',?,?,?)",
      )
      .run(owner, JSON.stringify({ mailId: "m-1" }), t, t + 1);
    mem
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('msg-u',?,'c-mail','r-mail','user','Ping',?,?)",
      )
      .run(
        owner,
        writeMessageMetadata({
          personal: false,
          automation: {
            kind: "agent_message",
            mailId: "m-1",
            threadId: "th-1",
            fromName: "beta",
          },
        }),
        t,
      );
    mem
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('msg-a',?,'c-mail','r-mail','assistant','Pong',?,?)",
      )
      .run(owner, writeMessageMetadata({ final: true }), t + 1);
    mem
      .prepare(
        `INSERT INTO results(id,owner_id,conversation_id,run_id,message_id,agent_id,kind,origin_completeness,sealed,content_digest,stimulus,outcome,provenance,attachments,lineage,created_at)
         VALUES('run:r-mail',?,'c-mail','r-mail','msg-a','a1','run_answer','sealed_at_publication',1,'sha256:fixture',?,?,?,'[]','{}',?)`,
      )
      .run(
        owner,
        JSON.stringify({
          kind: "delegation",
          text: "Ping",
          sourceMessageId: "msg-u",
          authorKind: "agent",
          automationKind: "agent_message",
          automationFrom: "beta",
        }),
        JSON.stringify({ body: "Pong", format: "markdown" }),
        JSON.stringify({ agentName: "alpha", provider: "openai" }),
        t + 1,
      );
    // Pre-168 feed_cards row existed without hide_internal
    mem
      .prepare(
        `INSERT INTO feed_cards(owner_id,conversation_id,kind,card_key,agent_id,sort_at,completed,payload,unread)
         VALUES(?,'c-mail','result','run:r-mail','a1',?,1,'{}',1)`,
      )
      .run(owner, t + 1);

    // Apply migration 169 and run projectFeed in the upgrade transaction
    mem
      .transaction(() => {
        mem.exec(
          readFileSync("migrations/169-feed-hide-internal-mail.sql", "utf8"),
        );
        projectFeed(mem, () => {});
      })
      .immediate();

    // Historical result and messages remain preserved intact
    expect(
      mem
        .prepare("SELECT id FROM results WHERE id='run:r-mail' AND owner_id=?")
        .get(owner),
    ).toEqual({ id: "run:r-mail" });
    expect(
      mem
        .prepare(
          "SELECT count(*) n FROM messages WHERE conversation_id='c-mail' AND owner_id=?",
        )
        .get(owner),
    ).toEqual({ n: 2 });

    // Backfilled feed_cards rows now carry hide_internal=1 for both thread and result
    const rows = mem
      .prepare(
        "SELECT kind, hide_internal FROM feed_cards WHERE owner_id=? AND conversation_id='c-mail' ORDER BY kind",
      )
      .all(owner);
    expect(rows).toEqual([
      { kind: "result", hide_internal: 1 },
      { kind: "thread", hide_internal: 1 },
    ]);
  } finally {
    mem.close();
  }
});

it("keeps an owner turn visible in Done when teammate mail is steered into it", () => {
  const owner = "steered-owner-" + id().slice(0, 6);
  const { connectionId, builder, helper } = setupWorkspace(owner);
  const convId = id();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "Owner task with steered mail",
    created_at: now(),
  });
  const ownerRun = id();
  seedRun(db, {
    id: ownerRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Ship release",
    state: "running",
    idempotency_key: ownerRun,
    payload: JSON.stringify({ connectionId }),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: ownerRun,
    role: "user",
    content: "Ship release",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });
  // Teammate interrupts/steers the running owner turn with agent_message metadata + steeringId
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: ownerRun,
    role: "user",
    content: "FYI build green",
    metadata: writeMessageMetadata({
      personal: false,
      steeringId: "steer-1",
      automation: {
        kind: "agent_message",
        mailId: "mail-1",
        threadId: "thread-1",
        fromAgentId: helper.id,
        fromName: helper.name,
      },
    }),
    created_at: now() + 1,
  });

  finishTurn(owner, ownerRun, convId, "Release shipped.");

  // Sealed stimulus came from the owner prompt, so the owner's answer must stay visible
  const cards = listDoneCards(owner);
  expect(cards).toHaveLength(1);
  expect(cards[0].card.content).toBe("Release shipped.");
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(1);
});

it("resurfaces prior continuation result in Done if the next continuation fails or interrupts", () => {
  const owner = "failed-cont-" + id().slice(0, 6);
  const { builder, folder, reviewTeam, runPayload } = setupWorkspace(owner);
  const convId = id();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "Failed continuation recovery",
    project_id: folder.id,
    created_at: now(),
  });
  const turn1 = id();
  seedRun(db, {
    id: turn1,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Start work",
    state: "running",
    idempotency_key: turn1,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: turn1,
    role: "user",
    content: "Start work",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });
  const req1 = requestReview(ownedRun(turn1, owner), "frev-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev1 = (req1 as { report: { reviewId: string } }).report.reviewId;
  const rc1 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(rev1) as { run_id: string; lead_run_id: string };
  finishTurn(owner, turn1, convId, "Requested review 1.");

  // Turn 2 completes and spawns Review 2 (Turn 3)
  db.prepare("UPDATE runs SET state='completed', result='Fix' WHERE id=?").run(
    rc1.lead_run_id,
  );
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(rc1.run_id);
  const req2 = requestReview(ownedRun(rc1.run_id, owner), "frev-2", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev2 = (req2 as { report: { reviewId: string } }).report.reviewId;
  const rc2 = db
    .prepare(
      "SELECT rc.run_id FROM review_continuations rc WHERE rc.review_id=?",
    )
    .get(rev2) as { run_id: string };
  finishTurn(owner, rc1.run_id, convId, "Fixed and requested review 2.");
  expect(listDoneCards(owner)).toEqual([]);

  // Turn 3 fails without sealing a result -> Turn 2 must resurface immediately
  // First verify that if the connection disconnects while Turn 3 is queued,
  // Turn 2 resurfaces instead of leaving the conversation absent from Done.
  const connId = (
    JSON.parse(
      (
        db.prepare("SELECT payload FROM runs WHERE id=?").get(rc2.run_id) as {
          payload: string;
        }
      ).payload,
    ) as { connectionId: string }
  ).connectionId;
  db.prepare(
    "UPDATE connections SET status='disconnected' WHERE id=? AND owner_id=?",
  ).run(connId, owner);
  expect(listDoneCards(owner).map((entry) => entry.card.content)).toEqual([
    "Fixed and requested review 2.",
  ]);
  db.prepare(
    "UPDATE connections SET status='connected' WHERE id=? AND owner_id=?",
  ).run(connId, owner);
  expect(listDoneCards(owner)).toEqual([]);

  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(rc2.run_id);
  transition({ id: rc2.run_id, owner_id: owner }, "failed", {
    message: "Provider failure",
  });
  const resurfaced = listDoneCards(owner);
  expect(resurfaced).toHaveLength(1);
  expect(resurfaced[0].card.content).toBe("Fixed and requested review 2.");
});

it("promotes the newest visible owner result (not a hidden mail result) when a reminder comes due", () => {
  const owner = "reminder-mail-" + id().slice(0, 6);
  const { connectionId, builder, helper } = setupWorkspace(owner);
  const convId = id();
  const baseTime = now();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "Reminded conversation",
    created_at: baseTime,
  });
  const humanRun = id();
  seedRun(db, {
    id: humanRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Owner prompt",
    state: "running",
    idempotency_key: humanRun,
    payload: JSON.stringify({ connectionId }),
    created_at: baseTime,
    updated_at: baseTime,
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: humanRun,
    role: "user",
    content: "Owner prompt",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: baseTime,
  });
  finishTurn(owner, humanRun, convId, "Owner answer.");

  // A newer internal agent_result lands later in the same conversation
  const mailRun = id();
  seedRun(db, {
    id: mailRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Mail result",
    state: "queued",
    idempotency_key: mailRun,
    payload: JSON.stringify({ connectionId, mailId: "m-rem" }),
    created_at: baseTime + 100,
    updated_at: baseTime + 100,
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: convId,
    run_id: mailRun,
    role: "user",
    content: "Mail result",
    metadata: writeMessageMetadata({
      personal: false,
      automation: {
        kind: "agent_result",
        mailId: "m-rem",
        threadId: "th-rem",
        fromAgentId: helper.id,
        fromName: helper.name,
      },
    }),
    created_at: baseTime + 100,
  });
  finishTurn(owner, mailRun, convId, "Internal mail answer.");

  // Surface a due reminder far in the future; it must lift the visible owner result, not the hidden mail result
  const surfacedAt = baseTime + 500_000;
  db.prepare(
    `INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,created_at,surfaced_at,snoozes)
     VALUES(?,?,'conversation',?,'time',?,?,?,0)`,
  ).run(id(), owner, convId, surfacedAt, baseTime, surfacedAt);

  const cards = listDoneCards(owner);
  expect(cards).toHaveLength(1);
  expect(cards[0].card.content).toBe("Owner answer.");
  expect(cards[0].order[0]).toBe(surfacedAt);
});

it("keeps a direct owner follow-up queued in a review conversation visible in Queued", () => {
  const owner = "owner-review-followup-" + id().slice(0, 6);
  const { connectionId, builder, folder, reviewTeam, runPayload } =
    setupWorkspace(owner);
  const convId = id();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "Task requesting review",
    project_id: folder.id,
    created_at: now(),
  });
  const parentId = id();
  seedRun(db, {
    id: parentId,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Request review",
    state: "running",
    idempotency_key: parentId,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  const req = requestReview(ownedRun(parentId, owner), "own-rev-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const reviewId = (req as { report: { reviewId: string } }).report.reviewId;
  const lead = db
    .prepare(
      "SELECT r.id, r.conversation_id, r.agent_id FROM code_reviews cr JOIN runs r ON r.id=cr.run_id WHERE cr.id=?",
    )
    .get(reviewId) as { id: string; conversation_id: string; agent_id: string };

  // Review lead and independent reviewer runs are hidden from Queued
  expect(feed(owner, { filter: "queued" }).items).toEqual([]);

  // Owner sends a direct follow-up in the review conversation (even with reviewId copied on payload)
  const ownerFollowUp = id();
  seedRun(db, {
    id: ownerFollowUp,
    owner_id: owner,
    agent_id: lead.agent_id,
    conversation_id: lead.conversation_id,
    input: "Please clarify finding 2",
    state: "queued",
    idempotency_key: ownerFollowUp,
    payload: JSON.stringify({ connectionId, reviewId }),
    created_at: now() + 10,
    updated_at: now() + 10,
  });
  expect(
    feed(owner, { filter: "queued" }).items.some(
      (item) => item.conversation_id === lead.conversation_id,
    ),
  ).toBe(true);
  expect(
    threadDetails(db, owner, lead.conversation_id).queued_runs.map((r) => r.id),
  ).toEqual([ownerFollowUp]);
});

it("keeps a mail-only conversation hidden even when a mail turn requests a code review", () => {
  const owner = "mail-review-hide-" + id().slice(0, 6);
  const { connectionId, builder, helper, folder, reviewTeam } =
    setupWorkspace(owner);
  const humanConv = id();
  seedConversation(db, {
    id: humanConv,
    owner_id: owner,
    agent_id: builder.id,
    title: "Builder root",
    project_id: folder.id,
    created_at: now(),
  });
  const humanRun = id();
  seedRun(db, {
    id: humanRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: "Ask helper to review",
    state: "running",
    idempotency_key: humanRun,
    payload: JSON.stringify({ connectionId, folderId: folder.id }),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: humanConv,
    run_id: humanRun,
    role: "user",
    content: "Ask helper to review",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });

  // Builder mails helper, creating a pure agent-mail conversation for helper
  const sent = sendMail(ownedRun(humanRun, owner), "mail-rev-call", {
    to: helper.id,
    body: "Run a code review on the repo",
    interrupt: false,
    fileIds: [],
  });
  const mailRow = db
    .prepare(
      "SELECT run_id, recipient_conversation_id FROM agent_mail WHERE owner_id=? AND id=?",
    )
    .get(owner, sent.messageId) as {
    run_id: string;
    recipient_conversation_id: string;
  };
  const mailConv = mailRow.recipient_conversation_id;
  const mailRun = mailRow.run_id;

  // Helper's mail run requests a review with default wait:false (adds review_continuation)
  db.prepare(
    "UPDATE runs SET state='running', payload=? WHERE id=? AND owner_id=?",
  ).run(
    JSON.stringify({
      agentId: helper.id,
      name: helper.name,
      provider: "openai",
      model: "fixture",
      instructions: "",
      connectionId,
      folderId: folder.id,
      mailId: sent.messageId,
    }),
    mailRun,
    owner,
  );
  const req = requestReview(ownedRun(mailRun, owner), "mail-rev-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const reviewId = (req as { report: { reviewId: string } }).report.reviewId;
  const rc = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(reviewId) as { run_id: string; lead_run_id: string };
  finishTurn(owner, mailRun, mailConv, "Requested review from mail turn.");

  // Review completes and continuation finishes inside helper's mail-only conversation
  db.prepare(
    "UPDATE runs SET state='completed', result='Clean' WHERE id=?",
  ).run(rc.lead_run_id);
  finishTurn(owner, rc.run_id, mailConv, "Review clean on mail thread.");

  // Mail-only conversation and its terminal review_continuation result stay hidden
  expect(
    feed(owner, { filter: "all" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(
    feed(owner, { filter: "done" }).items.some(
      (item) => item.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(
    listDoneCards(owner).some(
      (entry) => entry.card.source.conversation_id === mailConv,
    ),
  ).toBe(false);
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(0);

  // Even if the owner later joins that conversation with a direct prompt, the
  // older mail-parented review continuation result must stay hidden from Done
  const ownerJoinRun = id();
  seedRun(db, {
    id: ownerJoinRun,
    owner_id: owner,
    agent_id: helper.id,
    conversation_id: mailConv,
    input: "Thanks, summarize for me",
    state: "running",
    idempotency_key: ownerJoinRun,
    payload: JSON.stringify({ connectionId }),
    created_at: now() + 50,
    updated_at: now() + 50,
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: mailConv,
    run_id: ownerJoinRun,
    role: "user",
    content: "Thanks, summarize for me",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now() + 50,
  });
  finishTurn(owner, ownerJoinRun, mailConv, "Owner-requested summary.");
  const afterOwnerJoin = listDoneCards(owner).filter(
    (entry) => entry.card.source.conversation_id === mailConv,
  );
  expect(afterOwnerJoin.map((entry) => entry.card.content)).toEqual([
    "Owner-requested summary.",
  ]);
});

it("does not auto-cancel a paused continuation when loop_review_status is read", () => {
  const owner = "paused-cont-" + id().slice(0, 6);
  const { builder, folder, reviewTeam, runPayload } = setupWorkspace(owner);
  const convId = id();
  seedConversation(db, {
    id: convId,
    owner_id: owner,
    agent_id: builder.id,
    title: "Paused continuation guard",
    project_id: folder.id,
    created_at: now(),
  });
  const parentId = id();
  seedRun(db, {
    id: parentId,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: convId,
    input: "Work",
    state: "running",
    idempotency_key: parentId,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  const req = requestReview(ownedRun(parentId, owner), "paused-call-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const reviewId = (req as { report: { reviewId: string } }).report.reviewId;
  const rc = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(reviewId) as { run_id: string; lead_run_id: string };
  db.prepare("UPDATE runs SET state='completed', result='Done' WHERE id=?").run(
    rc.lead_run_id,
  );
  // Continuation has already started and paused -> must NOT be auto-cancelled
  db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(rc.run_id);

  requestedReviewStatus(ownedRun(parentId, owner), reviewId);
  expect(
    (
      db.prepare("SELECT state FROM runs WHERE id=?").get(rc.run_id) as {
        state: string;
      }
    ).state,
  ).toBe("paused");
});

it("keeps an owner-started code review lead visible in Queued while hiding its delegated reviewer fan-out", () => {
  const owner = "owner-started-rev-" + id().slice(0, 6);
  const { folder, reviewTeam } = setupWorkspace(owner);
  const started = startCodeReview(owner, reviewTeam.id, {
    folderId: folder.id,
    scope: "uncommitted",
    base: "main",
    idempotencyKey: "owner-ui-review-" + id(),
  });
  const queued = feed(owner, { filter: "queued" });
  expect(queued.items.map((item) => item.conversation_id)).toEqual([
    started.conversationId,
  ]);
  expect(queued.summary.queued).toBe(1);
});

it("keeps multi-hop mail-parented review continuations hidden even after the owner joins the conversation", () => {
  const owner = "mail-multihop-rev-" + id().slice(0, 6);
  const { connectionId, builder, helper, folder, reviewTeam } =
    setupWorkspace(owner);
  const humanConv = id();
  seedConversation(db, {
    id: humanConv,
    owner_id: owner,
    agent_id: builder.id,
    title: "Builder root",
    project_id: folder.id,
    created_at: now(),
  });
  const humanRun = id();
  seedRun(db, {
    id: humanRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: "Ask helper to run multi-round review",
    state: "running",
    idempotency_key: humanRun,
    payload: JSON.stringify({ connectionId, folderId: folder.id }),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: humanConv,
    run_id: humanRun,
    role: "user",
    content: "Ask helper to run multi-round review",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });

  const sent = sendMail(ownedRun(humanRun, owner), "multihop-mail-call", {
    to: helper.id,
    body: "Run multi-round review",
    interrupt: false,
    fileIds: [],
  });
  const mailRow = db
    .prepare(
      "SELECT run_id, recipient_conversation_id FROM agent_mail WHERE owner_id=? AND id=?",
    )
    .get(owner, sent.messageId) as {
    run_id: string;
    recipient_conversation_id: string;
  };
  const mailConv = mailRow.recipient_conversation_id;
  const mailRun = mailRow.run_id;

  db.prepare(
    "UPDATE runs SET state='running', payload=? WHERE id=? AND owner_id=?",
  ).run(
    JSON.stringify({
      agentId: helper.id,
      name: helper.name,
      provider: "openai",
      model: "fixture",
      instructions: "",
      connectionId,
      folderId: folder.id,
      mailId: sent.messageId,
    }),
    mailRun,
    owner,
  );

  // Round 1 review requested from mailRun -> rc1
  const req1 = requestReview(ownedRun(mailRun, owner), "mh-rev-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev1 = (req1 as { report: { reviewId: string } }).report.reviewId;
  const rc1 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(rev1) as { run_id: string; lead_run_id: string };
  finishTurn(owner, mailRun, mailConv, "Mail turn requested review 1.");

  // Round 2 review requested from rc1 -> rc2 (2 hops from mailRun, no mailId on rc1/rc2 payload)
  db.prepare(
    "UPDATE runs SET state='completed', result='Round 1 findings' WHERE id=?",
  ).run(rc1.lead_run_id);
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(rc1.run_id);
  const req2 = requestReview(ownedRun(rc1.run_id, owner), "mh-rev-2", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev2 = (req2 as { report: { reviewId: string } }).report.reviewId;
  const rc2 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(rev2) as { run_id: string; lead_run_id: string };
  finishTurn(owner, rc1.run_id, mailConv, "Round 1 fixed, requested review 2.");

  db.prepare(
    "UPDATE runs SET state='completed', result='Clean round 2' WHERE id=?",
  ).run(rc2.lead_run_id);
  finishTurn(owner, rc2.run_id, mailConv, "Round 2 mail-origin review clean.");

  // Owner later joins mailConv, flipping internal_thread to 0
  const ownerJoinRun = id();
  seedRun(db, {
    id: ownerJoinRun,
    owner_id: owner,
    agent_id: helper.id,
    conversation_id: mailConv,
    input: "Give me the final summary",
    state: "running",
    idempotency_key: ownerJoinRun,
    payload: JSON.stringify({ connectionId }),
    created_at: now(),
    updated_at: now(),
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: mailConv,
    run_id: ownerJoinRun,
    role: "user",
    content: "Give me the final summary",
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });
  finishTurn(owner, ownerJoinRun, mailConv, "Owner-requested final summary.");

  // Only the owner's turn appears in Done, done_unread, All, and Outcomes; rc2 stays hidden
  const doneInMailConv = listDoneCards(owner).filter(
    (entry) => entry.card.source.conversation_id === mailConv,
  );
  expect(doneInMailConv.map((entry) => entry.card.content)).toEqual([
    "Owner-requested final summary.",
  ]);
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(1);

  // Even if another mail-origin continuation later completes in this mixed thread,
  // All and Outcomes must still display the owner's turn rather than the mail continuation.
  const req3 = requestReview(ownedRun(rc2.run_id, owner), "mh-rev-3", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const rev3 = (req3 as { report: { reviewId: string } }).report.reviewId;
  const rc3 = db
    .prepare(
      "SELECT rc.run_id, cr.run_id lead_run_id FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
    )
    .get(rev3) as { run_id: string; lead_run_id: string };
  db.prepare(
    "UPDATE runs SET state='completed', result='Clean round 3' WHERE id=?",
  ).run(rc3.lead_run_id);
  finishTurn(owner, rc3.run_id, mailConv, "Round 3 mail-origin review clean.");

  const mixedAll = feed(owner, { filter: "all" }).items.find(
    (item) => item.conversation_id === mailConv,
  );
  expect(mixedAll?.run?.id).toBe(ownerJoinRun);
  expect(mixedAll?.last_message?.content).toBe(
    "Owner-requested final summary.",
  );
  const mixedOutcomes = feed(owner, { filter: "outcomes" }).items.find(
    (item) => item.conversation_id === mailConv,
  );
  expect(mixedOutcomes?.run?.id).toBe(ownerJoinRun);
  expect(mixedOutcomes?.last_message?.content).toBe(
    "Owner-requested final summary.",
  );
});

it("excludes hidden internal mail and internal queued runs from category search", async () => {
  const owner = "search-hide-internal-" + id().slice(0, 6);
  const { connectionId, builder, helper, folder, reviewTeam, runPayload } =
    setupWorkspace(owner);
  const needle = "internalfilterneedle" + id().slice(0, 6);

  // 1. Human conversation with an owner turn, an internal agent_result turn,
  //    a real owner queued follow-up, and a queued review continuation
  const humanConv = id();
  seedConversation(db, {
    id: humanConv,
    owner_id: owner,
    agent_id: builder.id,
    title: "Human search thread",
    project_id: folder.id,
    created_at: now(),
  });
  const ownerRun = id();
  seedRun(db, {
    id: ownerRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: `${needle} owner prompt`,
    state: "running",
    idempotency_key: ownerRun,
    payload: runPayload(folder.id),
    created_at: now(),
    updated_at: now(),
  });
  const ownerPromptMsgId = id();
  seedMessage(db, {
    id: ownerPromptMsgId,
    owner_id: owner,
    conversation_id: humanConv,
    run_id: ownerRun,
    role: "user",
    content: `${needle} owner prompt`,
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now(),
  });
  const req = requestReview(ownedRun(ownerRun, owner), "search-rev-1", {
    teamId: reviewTeam.id,
    scope: "uncommitted",
    base: "main",
    depth: "auto",
    wait: false,
  });
  const revId = (req as { report: { reviewId: string } }).report.reviewId;
  const rc = db
    .prepare("SELECT run_id FROM review_continuations WHERE review_id=?")
    .get(revId) as { run_id: string };
  // Give the queued review continuation a searchable prompt containing the needle
  db.prepare(
    "UPDATE messages SET content=? WHERE owner_id=? AND run_id=? AND role='user'",
  ).run(`${needle} queued review continuation`, owner, rc.run_id);

  // Send pure agent-to-agent mail to helper with the needle
  const sent = sendMail(ownedRun(ownerRun, owner), "search-mail-1", {
    to: helper.id,
    body: `${needle} pure mail body`,
    interrupt: false,
    fileIds: [],
  });
  const mailRow = db
    .prepare(
      "SELECT id, run_id, recipient_conversation_id FROM agent_mail WHERE owner_id=? AND id=?",
    )
    .get(owner, sent.messageId) as {
    id: string;
    run_id: string;
    recipient_conversation_id: string;
  };
  const pureMailAnswerId = finishTurn(
    owner,
    mailRow.run_id,
    mailRow.recipient_conversation_id,
    `${needle} pure mail answer`,
  );
  const ownerAnswerId = finishTurn(
    owner,
    ownerRun,
    humanConv,
    `${needle} owner answer`,
  );

  // Internal agent_result turn inside the human conversation
  const mailReplyRun = id();
  seedRun(db, {
    id: mailReplyRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: `${needle} internal mail reply`,
    state: "queued",
    idempotency_key: mailReplyRun,
    payload: JSON.stringify({ connectionId, mailId: mailRow.id }),
    created_at: now() + 10,
    updated_at: now() + 10,
  });
  seedMessage(db, {
    id: id(),
    owner_id: owner,
    conversation_id: humanConv,
    run_id: mailReplyRun,
    role: "user",
    content: `${needle} internal mail reply`,
    metadata: writeMessageMetadata({
      personal: false,
      automation: {
        kind: "agent_result",
        mailId: mailRow.id,
        threadId: "th-search",
        fromAgentId: helper.id,
        fromName: helper.name,
      },
    }),
    created_at: now() + 10,
  });
  const hiddenMailAnswerId = finishTurn(
    owner,
    mailReplyRun,
    humanConv,
    `${needle} hidden mail answer`,
  );

  // Owner also queues a direct follow-up in humanConv alongside the queued review continuation
  const ownerQueuedRun = id();
  seedRun(db, {
    id: ownerQueuedRun,
    owner_id: owner,
    agent_id: builder.id,
    conversation_id: humanConv,
    input: `${needle} owner queued followup`,
    state: "queued",
    idempotency_key: ownerQueuedRun,
    payload: runPayload(folder.id),
    created_at: now() + 20,
    updated_at: now() + 20,
  });
  const ownerQueuedMsgId = id();
  seedMessage(db, {
    id: ownerQueuedMsgId,
    owner_id: owner,
    conversation_id: humanConv,
    run_id: ownerQueuedRun,
    role: "user",
    content: `${needle} owner queued followup`,
    metadata: writeMessageMetadata({ personal: true }),
    created_at: now() + 20,
  });

  // Trigger projection before querying search
  db.transaction(() => {
    projectFeed(db, () => {});
  }).immediate();

  const threadsHits = await search(owner, needle, { category: "threads" });
  expect(
    threadsHits.items.every(
      (item) => item.conversation_id !== mailRow.recipient_conversation_id,
    ),
  ).toBe(true);
  expect(
    threadsHits.items.some((item) => item.conversation_id === humanConv),
  ).toBe(true);

  const doneHits = await search(owner, needle, { category: "done" });
  const doneMsgIds = doneHits.items.map((item) => item.message_id).sort();
  expect(doneMsgIds).toEqual([ownerPromptMsgId, ownerAnswerId].sort());
  expect(doneMsgIds).not.toContain(pureMailAnswerId);
  expect(doneMsgIds).not.toContain(hiddenMailAnswerId);

  const queuedHits = await search(owner, needle, { category: "queued" });
  expect(queuedHits.items.map((item) => item.message_id)).toEqual([
    ownerQueuedMsgId,
  ]);
});
