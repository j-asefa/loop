import { afterAll, describe, expect, it } from "vitest";
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

const dataDir = mkdtempSync(join(tmpdir(), "loop-canonical-results-"));
process.env.LOOP_DATA_DIR = dataDir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");

const { db } = await import("../src/server/db");
const { applyMigrations } = await import("../src/server/migrations");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { publishReply } = await import("../src/server/steering-replies");
const {
  getResult,
  listConversationResults,
  listResultContextEdges,
  listResultsBuiltOn,
  publishImportedConversationResults,
  publishResult,
  resolveSuppliedResultSnapshots,
} = await import("../src/server/result-publication");
const { computeResultContentDigest } =
  await import("../src/server/result-digest");
const { doneCards } = await import("../src/server/done-cards");
const { feed } = await import("../src/server/mobile-return");
const { projectFeed } = await import("../src/server/feed-projector");

afterAll(() => {
  try {
    db.close();
  } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Canonical Result publication, immutability, and migration", () => {
  it("seals run:<runId>, reply:<messageId>, and message:<messageId> at publication and preserves them across transcript and agent mutations", () => {
    const owner = "local-owner";
    db.prepare(
      `INSERT INTO agents(id, owner_id, name, normalized_name, provider, model, instructions, origin, created_at)
       VALUES ('agent-1', ?, 'Original Architect', 'original architect', 'anthropic', 'claude-3-7-sonnet', '', 'loop', 100)`,
    ).run(owner);
    db.prepare(
      `INSERT INTO conversations(id, owner_id, agent_id, title, origin, created_at)
       VALUES ('conv-1', ?, 'agent-1', 'Architecture Thread', 'loop', 100)`,
    ).run(owner);

    // Create an attachment object + artifact for the first run answer
    db.prepare(
      `INSERT INTO objects(id, owner_id, name, mime, bytes, created_at)
       VALUES ('obj-1', ?, 'design.md', 'text/markdown', ?, 105)`,
    ).run(owner, Buffer.from("# Canonical Result Spec\n"));
    db.prepare(
      `INSERT INTO artifacts(id, owner_id, agent_id, conversation_id, title, kind, role, content, metadata, version, created_at, updated_at)
       VALUES ('art-1', ?, 'agent-1', 'conv-1', 'Design Spec', 'file', 'upload', '# Canonical Result Spec', '{"objectId":"obj-1","mime":"text/markdown","size":24}', 2, 105, 105)`,
    ).run(owner);
    db.prepare(
      `INSERT INTO artifact_objects(artifact_id, owner_id, run_id, call_id, object_key, mime, size, checksum)
       VALUES ('art-1', ?, 'run-setup', 'call-1', 'key-1', 'text/markdown', 24, 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234')`,
    ).run(owner);

    // 1. Complete first run via production queue state machine
    const run1 = enqueue(
      owner,
      "Draft the canonical result model",
      "idem-run-1",
      {
        agent: "agent-1",
        conversation: "conv-1",
        payload: {
          model: "claude-3-7-sonnet",
        },
      },
    );
    db.prepare(
      `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
       VALUES ('msg-user-1', ?, 'conv-1', ?, 'user', 'Draft the canonical result model', '{}', 110)`,
    ).run(owner, run1.id);
    const claimed1 = claim("worker-1");
    expect(claimed1?.id).toBe(run1.id);

    // While run1 is running, steer it with a question and publish a steering reply
    db.prepare(
      `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
       VALUES ('msg-steer-q', ?, 'conv-1', ?, 'user', 'Should results be mutable?', '{"steeringId":"steer-1"}', 115)`,
    ).run(owner, run1.id);
    db.prepare(
      `INSERT INTO run_steering(id, owner_id, run_id, message_id, idempotency_key, request, state, created_at)
       VALUES ('steer-1', ?, ?, 'msg-steer-q', 'idem-steer-1', '{}', 'delivered', 115)`,
    ).run(owner, run1.id);

    const publishedReply = publishReply(claimed1!, "call-reply-1", {
      replyTo: "msg-steer-q",
      body: "No, results are sealed at publication.",
    });

    // Write final answer for run1 (plain markdown in runs.result and resolvedModel in payload, matching production) and transition to completed
    db.prepare(
      `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
       VALUES ('msg-ans-1', ?, 'conv-1', ?, 'assistant', 'Final canonical result design v1.', ?, 120)`,
    ).run(
      owner,
      run1.id,
      JSON.stringify({
        attachments: [
          {
            id: "art-1",
            objectId: "foreign-or-mismatched-obj",
            name: "design-v1.md",
            mime: "text/markdown",
            size: 24,
          },
        ],
      }),
    );
    db.prepare(
      `UPDATE runs SET payload = json_set(payload, '$.resolvedModel', ?), result = ? WHERE id = ?`,
    ).run(
      "claude-3-7-sonnet-20250219",
      "Final canonical result design v1.",
      run1.id,
    );
    transition(claimed1!, "completed");

    // 2. Complete a second run in the same conversation to verify parentResultId chaining
    const run2 = enqueue(owner, "Add context edges index", "idem-run-2", {
      agent: "agent-1",
      conversation: "conv-1",
      payload: {},
    });
    const claimed2 = claim("worker-1");
    expect(claimed2?.id).toBe(run2.id);
    db.prepare(
      `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
       VALUES ('msg-ans-2', ?, 'conv-1', ?, 'assistant', 'Context edges index added.', '{}', 130)`,
    ).run(owner, run2.id);
    transition(claimed2!, "completed");

    // 3. Import standalone messages in an imported conversation and seal them
    db.prepare(
      `INSERT INTO conversations(id, owner_id, agent_id, title, origin, created_at)
       VALUES ('conv-import', ?, 'agent-1', 'Imported Notes', 'import', 140)`,
    ).run(owner);
    db.prepare(
      `INSERT INTO messages(id, owner_id, conversation_id, role, content, metadata, created_at)
       VALUES ('msg-imp-u1', ?, 'conv-import', 'user', 'What is event sourcing?', '{}', 141),
              ('msg-imp-a1', ?, 'conv-import', 'assistant', 'Storing immutable domain facts.', '{}', 142)`,
    ).run(owner, owner);
    const importedResults = publishImportedConversationResults(
      owner,
      "conv-import",
    );
    expect(importedResults).toHaveLength(1);
    expect(importedResults[0]?.id).toBe("message:msg-imp-a1");

    // Verify all sealed CanonicalResult records before mutation
    const sealedRun1 = getResult(owner, `run:${run1.id}`);
    expect(sealedRun1).toBeDefined();
    expect(sealedRun1?.kind).toBe("run_answer");
    expect(sealedRun1?.originCompleteness).toBe("sealed_at_publication");
    expect(sealedRun1?.stimulus.text).toBe("Draft the canonical result model");
    expect(sealedRun1?.outcome.body).toBe("Final canonical result design v1.");
    expect(sealedRun1?.provenance.agentName).toBe("Original Architect");
    expect(sealedRun1?.provenance.provider).toBe("anthropic");
    expect(sealedRun1?.provenance.resolvedModel).toBe(
      "claude-3-7-sonnet-20250219",
    );
    expect(sealedRun1?.attachments).toEqual([
      {
        artifactId: "art-1",
        objectId: "obj-1",
        version: 2,
        sha256:
          "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
        name: "design-v1.md",
        mime: "text/markdown",
        size: 24,
        published: true,
      },
    ]);

    const sealedRun2 = getResult(owner, `run:${run2.id}`);
    expect(sealedRun2?.lineage.parentResultId).toBe(`run:${run1.id}`);

    const sealedReply = getResult(owner, `reply:${publishedReply.messageId}`);
    expect(sealedReply).toBeDefined();
    expect(sealedReply?.kind).toBe("steering_reply");
    expect(sealedReply?.stimulus.text).toBe("Should results be mutable?");
    expect(sealedReply?.outcome.body).toBe(
      "No, results are sealed at publication.",
    );
    expect(sealedReply?.provenance.agentName).toBe("Original Architect");

    // Mutate operational transcript rows, reassign/clear conversation agent, and edit agent profile!
    db.transaction(() => {
      db.prepare(
        `UPDATE agents SET name = 'Renamed Agent', provider = 'openai', model = 'gpt-4.1' WHERE id = 'agent-1'`,
      ).run();
      db.prepare(
        `UPDATE conversations SET agent_id = NULL WHERE id = 'conv-1'`,
      ).run();
      db.prepare(
        `UPDATE runs SET input = 'MUTATED RUN INPUT' WHERE id IN (?, ?)`,
      ).run(run1.id, run2.id);
      db.prepare(
        `UPDATE messages SET content = 'MUTATED TRANSCRIPT BODY', metadata = '{}' WHERE id IN ('msg-ans-1', 'msg-ans-2', 'msg-imp-a1', ?, 'msg-steer-q')`,
      ).run(publishedReply.messageId);
      projectFeed(db, () => {});
    }).immediate();

    // 1. CanonicalResult reads remain 100% unchanged
    const afterRun1 = getResult(owner, `run:${run1.id}`);
    expect(afterRun1).toEqual(sealedRun1);

    // 2. Done Cards API (/api/v1/cards?view=done) serves sealed content, prompt, attribution, and attachments
    const cards = doneCards(owner, {
      folders: null,
      teamIds: [],
      before: null,
      limit: 20,
      atTime: 1000,
    });
    const cardRun1 = cards.find((c) => c.card.id === `d:run:${run1.id}`);
    expect(cardRun1).toBeDefined();
    expect(cardRun1?.card.content).toBe("Final canonical result design v1.");
    expect(cardRun1?.card.author.name).toBe("Original Architect");
    expect(cardRun1?.card.author.provider).toBe("anthropic");
    expect(
      cardRun1?.card.type === "done" ? cardRun1.card.display.run?.input : null,
    ).toBe("Draft the canonical result model");
    expect(cardRun1?.card.attachments).toEqual([
      {
        id: "art-1",
        name: "design-v1.md",
        mime: "text/markdown",
        size: 24,
        href: "/?artifact=art-1",
        download: "/api/objects/obj-1",
      },
    ]);

    const cardImport = cards.find((c) => c.card.id === "d:message:msg-imp-a1");
    expect(cardImport).toBeDefined();
    expect(cardImport?.card.content).toBe("Storing immutable domain facts.");

    // 3. Done Feed (/api/feed?filter=done) serves sealed content and attribution even when conv agent_id was cleared
    const doneFeed = feed(owner, { filter: "done" });
    const doneItem1 = doneFeed.items.find(
      (c) => c.done_card_key === `run:${run1.id}`,
    );
    expect(doneItem1).toBeDefined();
    expect(doneItem1?.agent_id).toBe("agent-1");
    expect(doneItem1?.agent_name).toBe("Original Architect");
    expect(doneItem1?.provider).toBe("anthropic");
    expect(doneItem1?.run?.resolved_model).toBe("claude-3-7-sonnet-20250219");
    expect(doneItem1?.last_message?.preview).toBe(
      "Final canonical result design v1.",
    );
    expect(doneItem1?.run?.input).toBe("Draft the canonical result model");

    // 4. Steering Replies Feed (/api/feed?filter=replies) serves sealed question, body, and agent_name
    const repliesFeed = feed(owner, { filter: "replies" });
    const replyItem = repliesFeed.items.find(
      (c) => c.reply_card_key === `reply:${publishedReply.messageId}`,
    );
    expect(replyItem).toBeDefined();
    expect(replyItem?.agent_name).toBe("Original Architect");
    expect(replyItem?.reply?.content).toBe("Should results be mutable?");
    expect(replyItem?.last_message?.preview).toBe(
      "No, results are sealed at publication.",
    );

    // 5. Revoking live object/publication revokes download URLs while preserving sealed display metadata
    db.prepare(
      "DELETE FROM artifact_objects WHERE artifact_id = 'art-1'",
    ).run();
    db.prepare("DELETE FROM objects WHERE id = 'obj-1'").run();
    const cardsAfterRevoke = doneCards(owner, {
      folders: null,
      teamIds: [],
      before: null,
      limit: 20,
      atTime: 1000,
    });
    const revokedCard = cardsAfterRevoke.find(
      (c) => c.card.id === `d:run:${run1.id}`,
    );
    expect(revokedCard?.card.attachments).toEqual([
      {
        id: "art-1",
        name: "design-v1.md",
        mime: "text/markdown",
        size: 24,
        href: "/?artifact=art-1",
        download: null,
      },
    ]);

    // 6. Unsealed draft rows (sealed = 0) are excluded from canonical readers and supplied-context resolution
    db.prepare(
      `INSERT INTO results (
        id, owner_id, schema_version, kind, origin_completeness, sealed,
        created_at, conversation_id, run_id, message_id, agent_id,
        content_digest, stimulus, outcome, attachments, provenance, lineage
      ) VALUES (
        'run:draft-unsealed', ?, 1, 'run_answer', 'sealed_at_publication', 0,
        500, 'conv-1', NULL, 'msg-draft', NULL,
        '0000000000000000000000000000000000000000000000000000000000000000',
        '{"kind":"user_prompt","text":"Draft","sourceMessageId":null,"authorKind":"owner","automationKind":null,"automationFrom":null}',
        '{"title":"Draft","body":"Mutable unsealed draft","format":"markdown"}',
        '[]',
        '{"agentId":null,"agentName":null,"provider":null,"model":null,"resolvedModel":null,"connectionId":null,"conversationId":"conv-1","runId":null,"messageId":"msg-draft"}',
        '{"parentResultId":null,"triggerMessageId":null,"suppliedContext":[]}'
      )`,
    ).run(owner);
    expect(getResult(owner, "run:draft-unsealed")).toBeUndefined();
    expect(
      listConversationResults(owner, "conv-1").some(
        (r) => r.id === "run:draft-unsealed",
      ),
    ).toBe(false);
    expect(() =>
      resolveSuppliedResultSnapshots(owner, [
        { resultId: "run:draft-unsealed" },
      ]),
    ).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("enforces idempotent replay and rejects conflicting content with 409 on publishResult", () => {
    const owner = "local-owner";
    db.prepare(
      `INSERT INTO conversations(id, owner_id, title, origin, created_at)
       VALUES ('conv-idem', ?, 'Idempotency Thread', 'loop', 100)`,
    ).run(owner);
    const input = {
      id: "run:run-idem-1" as const,
      ownerId: owner,
      kind: "run_answer" as const,
      createdAt: 200,
      stimulus: {
        kind: "user_prompt" as const,
        text: "Original prompt",
        sourceMessageId: "msg-u-1",
        authorKind: "owner" as const,
        automationKind: null,
        automationFrom: null,
      },
      outcome: {
        title: "Original prompt",
        body: "Original sealed answer.",
        format: "markdown" as const,
      },
      attachments: [],
      provenance: {
        agentId: "agent-1",
        agentName: "Agent One",
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        resolvedModel: "claude-3-7-sonnet-20250219",
        connectionId: "conn-1",
        conversationId: "conv-idem",
        runId: "run-idem-1",
        messageId: "msg-a-1",
        placement: {
          status: "unknown" as const,
          folderId: null,
          projectId: null,
          projectName: null,
          teamId: null,
        },
      },
      lineage: {
        parentResultId: null,
        triggerMessageId: "msg-u-1",
        suppliedContext: [],
      },
    };

    const first = publishResult(input);
    const second = publishResult(input);
    expect(second).toEqual(first);
    expect(first.contentDigest).toBe(computeResultContentDigest(input));

    // Attempting to publish different content under the same (ownerId, id) throws 409
    expect(() =>
      publishResult({
        ...input,
        outcome: {
          ...input.outcome,
          body: "Tampered answer body.",
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 409,
      }),
    );
  });

  it("resolves server-trusted supplied context snapshots and indexes result_context_edges", () => {
    const owner = "local-owner";
    db.prepare(
      `INSERT INTO conversations(id, owner_id, title, origin, created_at)
       VALUES ('conv-ctx', ?, 'Context Thread', 'loop', 100)`,
    ).run(owner);

    const sourceResult = publishResult({
      id: "run:source-1",
      ownerId: owner,
      kind: "run_answer",
      createdAt: 100,
      stimulus: {
        kind: "user_prompt",
        text: "Analyze caching options",
        sourceMessageId: null,
        authorKind: "owner",
        automationKind: null,
        automationFrom: null,
      },
      outcome: {
        title: "Analyze caching options",
        body: "Option A uses SQLite WAL. Option B uses an in-memory LRU cache.",
        format: "markdown",
      },
      attachments: [],
      provenance: {
        agentId: "agent-1",
        agentName: "Researcher",
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        resolvedModel: null,
        connectionId: null,
        conversationId: "conv-ctx",
        runId: "source-1",
        messageId: "msg-s-1",
        placement: {
          status: "unknown" as const,
          folderId: null,
          projectId: null,
          projectName: null,
          teamId: null,
        },
      },
      lineage: {
        parentResultId: null,
        triggerMessageId: null,
        suppliedContext: [],
      },
    });

    // Server resolves trusted snapshot from resultId + verified excerpt
    const supplied = resolveSuppliedResultSnapshots(owner, [
      {
        resultId: sourceResult.id,
        excerpt: "Option A uses SQLite WAL.",
      },
    ]);
    expect(supplied).toEqual([
      {
        resultId: "run:source-1",
        contentDigest: sourceResult.contentDigest,
        title: "Analyze caching options",
        agentId: "agent-1",
        agentName: "Researcher",
        conversationId: "conv-ctx",
        suppliedText: "Option A uses SQLite WAL.",
        excerpt: true,
        truncated: true,
      },
    ]);

    // Rejects fabricated excerpt not present in the sealed body
    expect(() =>
      resolveSuppliedResultSnapshots(owner, [
        {
          resultId: sourceResult.id,
          excerpt: "Option C uses Redis cluster.",
        },
      ]),
    ).toThrowError(expect.objectContaining({ status: 400 }));

    // Rejects another owner's access
    expect(() =>
      resolveSuppliedResultSnapshots("other-owner", [
        { resultId: sourceResult.id },
      ]),
    ).toThrowError(expect.objectContaining({ status: 404 }));

    // Publish a downstream result built on sourceResult
    const childResult = publishResult({
      id: "run:child-1",
      ownerId: owner,
      kind: "run_answer",
      createdAt: 200,
      stimulus: {
        kind: "user_prompt",
        text: "Implement Option A",
        sourceMessageId: null,
        authorKind: "owner",
        automationKind: null,
        automationFrom: null,
      },
      outcome: {
        title: "Implement Option A",
        body: "Implemented SQLite WAL mode.",
        format: "markdown",
      },
      attachments: [],
      provenance: {
        agentId: "agent-2",
        agentName: "Builder",
        provider: "openai",
        model: "gpt-4.1",
        resolvedModel: null,
        connectionId: null,
        conversationId: "conv-ctx",
        runId: "child-1",
        messageId: "msg-c-1",
        placement: {
          status: "unknown" as const,
          folderId: null,
          projectId: null,
          projectName: null,
          teamId: null,
        },
      },
      lineage: {
        parentResultId: sourceResult.id,
        triggerMessageId: null,
        suppliedContext: supplied,
      },
    });

    const edges = listResultContextEdges(owner, childResult.id);
    expect(edges).toEqual([
      {
        owner_id: owner,
        result_id: "run:child-1",
        source_result_id: "run:source-1",
        position: 0,
        excerpt: 1,
        created_at: 200,
      },
    ]);

    const builtOn = listResultsBuiltOn(owner, sourceResult.id);
    expect(builtOn.map((r) => r.id)).toEqual(["run:child-1"]);
    expect(listResultsBuiltOn("other-owner", sourceResult.id)).toEqual([]);
    expect(listConversationResults(owner, "conv-ctx").map((r) => r.id)).toEqual(
      ["run:source-1", "run:child-1"],
    );
  });

  it("backfills historical runs, replies, and standalone messages on upgrade from migration 163 while preserving overlays and groups", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-canonical-results-mig-"));
    try {
      const pre164Dir = join(dir, "migrations");
      mkdirSync(pre164Dir);
      for (const file of readdirSync("migrations").filter(
        (f) => f.endsWith(".sql") && Number(f.split("-")[0]) <= 163,
      )) {
        copyFileSync(join("migrations", file), join(pre164Dir, file));
      }

      const upgradeDb = new Database(join(dir, "upgrade.db"));
      upgradeDb.pragma("foreign_keys=ON");
      applyMigrations(upgradeDb, pre164Dir);

      // Seed historical pre-164 records including plain-text runs.result, corrupt legacy metadata, and steering prompt
      upgradeDb
        .prepare(
          `INSERT INTO agents(id, owner_id, name, normalized_name, provider, model, instructions, origin, created_at)
           VALUES ('ag-hist', 'owner-1', 'Historical Agent', 'historical agent', 'anthropic', 'claude-3-5-sonnet', '', 'loop', 10)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO conversations(id, owner_id, agent_id, title, origin, created_at)
           VALUES ('c-hist', 'owner-1', 'ag-hist', 'Historical Thread', 'loop', 10)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO objects(id, owner_id, name, mime, bytes, created_at)
           VALUES ('obj-hist', 'owner-1', 'hist.txt', 'text/plain', ?, 15)`,
        )
        .run(Buffer.from("historical attachment"));
      upgradeDb
        .prepare(
          `INSERT INTO artifacts(id, owner_id, agent_id, conversation_id, title, kind, role, content, metadata, version, created_at, updated_at)
           VALUES ('art-hist', 'owner-1', 'ag-hist', 'c-hist', 'hist.txt', 'file', 'upload', '', '{"objectId":"obj-hist","mime":"text/plain","size":21}', 1, 15, 15)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO runs(id, owner_id, agent_id, conversation_id, kind, input, state, idempotency_key, payload, result, created_at, updated_at)
           VALUES ('r-hist', 'owner-1', 'ag-hist', 'c-hist', 'agent', 'Historical prompt', 'completed', 'k-hist', '{"model":"claude-3-5-sonnet","resolvedModel":"claude-3-5-sonnet-20241022"}', 'Plain markdown run result text.', 20, 30),
                  ('r-legacy', 'owner-1', NULL, 'c-hist', 'agent', 'Legacy prompt', 'completed', 'k-legacy', '{}', 'Plain markdown text without JSON.', 31, 32)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
           VALUES ('m-hist-u', 'owner-1', 'c-hist', 'r-hist', 'user', 'Historical prompt', '{}', 20),
                  ('m-hist-q', 'owner-1', 'c-hist', 'r-hist', 'user', 'Historical steering question?', '{"steeringId":"s-hist"}', 22),
                  ('m-hist-rep', 'owner-1', 'c-hist', 'r-hist', 'assistant', 'Historical steering reply.', '{"reply":{"to":"m-hist-q","published":true}}', 23),
                  ('m-hist-ans', 'owner-1', 'c-hist', 'r-hist', 'assistant', 'Historical run answer.', '{"attachments":[{"id":"art-hist","name":"hist.txt","mime":"text/plain","size":21}]}', 29),
                  ('m-legacy-ans', 'owner-1', 'c-hist', 'r-legacy', 'assistant', 'Legacy answer with unexpected metadata.', '{"legacyExtra":123}', 32),
                  ('m-hist-imp-u', 'owner-1', 'c-hist', NULL, 'user', 'Standalone user prompt', '{}', 40),
                  ('m-hist-imp-a', 'owner-1', 'c-hist', NULL, 'assistant', 'Standalone imported answer.', '{}', 41),
                  ('m-hist-imp-a2', 'owner-1', 'c-hist', NULL, 'assistant', 'Second standalone imported answer.', '{}', 43),
                  ('m-hist-partial', 'owner-1', 'c-hist', NULL, 'assistant', 'Unfinished partial draft', '{"partial":true}', 42)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO run_steering(id, owner_id, run_id, message_id, idempotency_key, request, state, created_at)
           VALUES ('s-hist', 'owner-1', 'r-hist', 'm-hist-q', 'k-steer', '{}', 'delivered', 26)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO steering_replies(message_id, owner_id, steering_id, created_at, read_at)
           VALUES ('m-hist-rep', 'owner-1', 's-hist', 27, 28)`,
        )
        .run();

      // Seed user overlays: bookmarks, done_card_reads, done_card_dismissals, done_threads
      upgradeDb
        .prepare(
          `INSERT INTO message_bookmarks(owner_id, message_id, created_at)
           VALUES ('owner-1', 'm-hist-ans', 50)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO done_card_reads(owner_id, conversation_id, card_key, read_at)
           VALUES ('owner-1', 'c-hist', 'run:r-hist', 51)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO done_threads(id, owner_id, title, created_at)
           VALUES ('dt-1', 'owner-1', 'Saved Group', 52)`,
        )
        .run();
      upgradeDb
        .prepare(
          `INSERT INTO done_thread_members(owner_id, card_id, thread_id, conversation_id)
           VALUES ('owner-1', 'd:run:r-hist', 'dt-1', 'c-hist')`,
        )
        .run();

      // Apply full migrations (including 164-canonical-results.sql)
      applyMigrations(upgradeDb);

      const backfilledRun = getResult("owner-1", "run:r-hist", upgradeDb);
      expect(backfilledRun).toBeDefined();
      expect(backfilledRun?.originCompleteness).toBe("migrated_backfill");
      expect(backfilledRun?.outcome.body).toBe("Historical run answer.");
      expect(backfilledRun?.provenance.agentName).toBe("Historical Agent");
      expect(backfilledRun?.provenance.resolvedModel).toBe(
        "claude-3-5-sonnet-20241022",
      );
      expect(backfilledRun?.stimulus.sourceMessageId).toBe("m-hist-u");
      expect(backfilledRun?.lineage.triggerMessageId).toBe("m-hist-u");
      expect(backfilledRun?.attachments).toEqual([
        {
          artifactId: "art-hist",
          objectId: "obj-hist",
          version: 1,
          sha256: null,
          name: "hist.txt",
          mime: "text/plain",
          size: 21,
          published: false,
        },
      ]);
      expect(backfilledRun?.contentDigest).toBe(
        computeResultContentDigest(backfilledRun!),
      );

      const backfilledLegacy = getResult("owner-1", "run:r-legacy", upgradeDb);
      expect(backfilledLegacy?.outcome.body).toBe(
        "Legacy answer with unexpected metadata.",
      );
      expect(backfilledLegacy?.contentDigest).toBe(
        computeResultContentDigest(backfilledLegacy!),
      );

      // Historical placement is unknown rather than guessed from current organization.
      expect(backfilledRun?.provenance.placement).toEqual({
        status: "unknown",
        folderId: null,
        projectId: null,
        projectName: null,
        teamId: null,
      });
      // Backfilled results chain chronologically across kinds per conversation.
      const chain = listConversationResults("owner-1", "c-hist", upgradeDb);
      expect(chain.length).toBeGreaterThan(2);
      expect(new Set(chain.map((r) => r.kind)).size).toBeGreaterThan(1);
      expect(chain[0]?.lineage.parentResultId).toBeNull();
      for (let i = 1; i < chain.length; i++) {
        expect(chain[i]?.lineage.parentResultId).toBe(chain[i - 1]?.id);
      }

      // Re-importing / appending to a migrated multi-message imported thread succeeds without 409
      upgradeDb
        .prepare(
          `INSERT INTO messages(id, owner_id, conversation_id, run_id, role, content, metadata, created_at)
           VALUES ('m-hist-imp-a3', 'owner-1', 'c-hist', NULL, 'assistant', 'Newly appended imported answer.', '{}', 44)`,
        )
        .run();
      const reimported = publishImportedConversationResults(
        "owner-1",
        "c-hist",
        upgradeDb,
      );
      expect(reimported.map((r) => r.id)).toEqual([
        "message:m-hist-imp-a",
        "message:m-hist-imp-a2",
        "message:m-hist-imp-a3",
      ]);
      expect(reimported[2]?.lineage.parentResultId).toBe(
        "message:m-hist-imp-a2",
      );

      const backfilledReply = getResult(
        "owner-1",
        "reply:m-hist-rep",
        upgradeDb,
      );
      expect(backfilledReply).toBeDefined();
      expect(backfilledReply?.originCompleteness).toBe("migrated_backfill");
      expect(backfilledReply?.stimulus.text).toBe(
        "Historical steering question?",
      );
      expect(backfilledReply?.outcome.body).toBe("Historical steering reply.");
      expect(backfilledReply?.contentDigest).toBe(
        computeResultContentDigest(backfilledReply!),
      );

      const backfilledStandalone = getResult(
        "owner-1",
        "message:m-hist-imp-a",
        upgradeDb,
      );
      expect(backfilledStandalone).toBeDefined();
      expect(backfilledStandalone?.originCompleteness).toBe(
        "migrated_backfill",
      );
      expect(backfilledStandalone?.stimulus.text).toBe(
        "Standalone user prompt",
      );
      expect(backfilledStandalone?.outcome.body).toBe(
        "Standalone imported answer.",
      );
      expect(backfilledStandalone?.contentDigest).toBe(
        computeResultContentDigest(backfilledStandalone!),
      );

      // Partial draft was NOT sealed into results
      expect(
        getResult("owner-1", "message:m-hist-partial", upgradeDb),
      ).toBeUndefined();

      // User overlays remain intact
      expect(
        upgradeDb
          .prepare(
            "SELECT card_key, read_at FROM done_card_reads WHERE owner_id='owner-1'",
          )
          .get(),
      ).toEqual({ card_key: "run:r-hist", read_at: 51 });
      expect(
        upgradeDb
          .prepare(
            "SELECT card_id, thread_id FROM done_thread_members WHERE owner_id='owner-1'",
          )
          .get(),
      ).toEqual({ card_id: "d:run:r-hist", thread_id: "dt-1" });

      upgradeDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
