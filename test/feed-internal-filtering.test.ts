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
const { requestReview, requestedReviewStatus } =
  await import("../src/server/code-reviews");
const { transition } = await import("../src/server/queue");
const { feed } = await import("../src/server/mobile-return");
const { doneCards } = await import("../src/server/done-cards");
const { threadDetails } = await import("../src/server/feed-card-details");
const { listAgentThreads } = await import("../src/server/agent-thread-feed");
const { projectFeed } = await import("../src/server/feed-projector");
const { sendMail } = await import("../src/server/agent-mail");

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
  seedMessage(db, {
    id: id(),
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

  // Complete the review lead run, then read loop_review_status from the parent run
  db.prepare(
    "UPDATE runs SET state='completed', result='Clean snapshot' WHERE id=?",
  ).run(rc.lead_run_id);
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
  finishTurn(owner, mailReplyRun, humanConv, "Noted helper result.");

  // Human conversation stays visible in All, and ONLY the human turn's Done card shows in Done & unread
  expect(
    feed(owner, { filter: "all" }).items.some(
      (item) => item.conversation_id === humanConv,
    ),
  ).toBe(true);
  const humanDone = listDoneCards(owner).filter(
    (entry) => entry.card.source.conversation_id === humanConv,
  );
  expect(humanDone).toHaveLength(1);
  expect(humanDone[0].card.content).toBe("Done coordinating.");
  expect(feed(owner, { filter: "done" }).summary.done_unread).toBe(1);
});

it("migration 168 preserves historical rows and backfills hide_internal and filtered queued counts on upgrade", () => {
  const mem = new Database(":memory:");
  try {
    const files = readdirSync("migrations")
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      if (file.startsWith("168-")) break;
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

    // Apply migration 168 and run projectFeed in the upgrade transaction
    mem
      .transaction(() => {
        mem.exec(
          readFileSync("migrations/168-feed-hide-internal-mail.sql", "utf8"),
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
