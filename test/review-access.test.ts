import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ReviewSnapshot } from "../src/server/review-snapshot";
import type { Run } from "../src/server/queue";

const dir = mkdtempSync(join(tmpdir(), "loop-review-access-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent, owned } = await import("../src/server/domain");
const { readReview, reviewRecord, reviewContext, assertReviewIdentity } = await import("../src/server/review-access");
const { reviewStatus } = await import("../src/server/code-reviews");
const { snapshotFingerprint } = await import("../src/server/review-snapshot");

const owner = id(), connection = id(), folder = id(), team = id();
db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','','connected',?,?)")
  .run(connection, owner, JSON.stringify([{ id: "fixture" }]), now());
const agent = createAgent(owner, { name: "review-" + id().slice(0, 8), connectionId: connection, model: "fixture" });
db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Fixture',?)").run(folder, owner, now());
db.prepare("INSERT INTO teams(id,owner_id,name,manager_id,created_at,preset_config) VALUES(?,?,'Fixture',?,?,?)")
  .run(team, owner, agent.id, now(), JSON.stringify({ assignments: [{ agentId: agent.id }] }));

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function snapshot(files: Record<string, string> = { "changed.ts": "new content" }): ReviewSnapshot {
  return { scope: "branch", base: "base", head: "head", diff: "+new content", files,
    before: { "changed.ts": "old content" }, changed: ["changed.ts"], omitted: [".env"] };
}
function fixture(value = snapshot()) {
  const review = id(), conversation = id(), rid = id();
  db.prepare("INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Review',?)")
    .run(conversation, owner, agent.id, now());
  db.prepare(`INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
    VALUES(?,?,?,?,'Review','completed',?,?,?,?)`)
    .run(rid, owner, agent.id, conversation, rid, JSON.stringify({ reviewId: review }), now(), now());
  db.prepare(`INSERT INTO code_reviews(id,owner_id,team_id,folder_id,request_key,request_hash,snapshot,fingerprint,run_id,created_at)
    VALUES(?,?,?,?,?,'fixture',?,?,?,?)`)
    .run(review, owner, team, folder, review, JSON.stringify(value), snapshotFingerprint(value), rid, now());
  return { review, run: owned<Run>("runs", rid, owner) };
}
function observeReads() {
  const prepare = db.prepare.bind(db);
  const queries: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    if (/FROM code_reviews/i.test(sql)) queries.push(sql);
    return prepare(sql);
  });
  return { queries, restore: () => spy.mockRestore(),
    blobs: () => queries.filter(sql => /^SELECT snapshot FROM code_reviews/.test(sql)).length };
}

it("loads a large snapshot once across chunk reads, listing, context and status, with covering identity checks", () => {
  const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`file-${i}.ts`, "x".repeat(400_000)]));
  files["changed.ts"] = "😀".repeat(15_000);
  const f = fixture(snapshot(files));
  const reads = observeReads();
  try {
    assertReviewIdentity(owner, f.review, team, agent.id);
    expect(reviewRecord(owner, f.review)).not.toHaveProperty("snapshot");
    expect(reads.blobs()).toBe(0);
    for (let offset = 0; offset < 30_000; offset += 12_000) {
      expect(readReview(f.run, { path: "changed.ts", offset })).toMatchObject({
        content: files["changed.ts"].slice(offset, offset + 12_000),
        nextOffset: offset + 12_000 < 30_000 ? offset + 12_000 : null,
      });
    }
    for (let i = 0; i < 40; i++) readReview(f.run, { path: `file-${i % 24}.ts`, offset: i * 100 });
    expect(readReview(f.run, { path: "changed.ts", version: "before" })).toMatchObject({ content: "old content" });
    const listing = readReview(f.run, {}) as { changed: string[]; omitted: string[]; files: string[] };
    expect(listing.files).toEqual(Object.keys(files).sort());
    listing.changed.push("not-captured");
    listing.omitted.length = 0;
    listing.files.length = 0;
    expect(readReview(f.run, {})).toMatchObject({ changed: ["changed.ts"], omitted: [".env"] });
    expect(() => readReview(f.run, { path: "../.env" })).toThrow(/not in this snapshot/);
    expect(reviewContext(f.run)).toContain("Captured diff");
    expect(reviewStatus(owner, f.review).state).toBe("completed");
    db.prepare("UPDATE runs SET state='failed',error='Late failure' WHERE id=?").run(f.run.id);
    expect(reviewStatus(owner, f.review).state).toBe("failed");
    expect(reads.blobs()).toBe(1);
    for (const query of reads.queries.filter(sql => !sql.startsWith("SELECT snapshot"))) {
      const plan = db.prepare("EXPLAIN QUERY PLAN " + query).all(owner, f.review) as { detail: string }[];
      expect(plan.some(row => /USING COVERING INDEX code_reviews_access/.test(row.detail))).toBe(true);
    }
  } finally { reads.restore(); }
});

it("rechecks ownership, deletion, team membership and fingerprint after a cache hit", () => {
  const f = fixture();
  readReview(f.run, {});
  expect(() => readReview({ ...f.run, owner_id: "another-owner" }, {})).toThrow(/not found/);
  expect(() => assertReviewIdentity(owner, f.review, "another-team", agent.id)).toThrow(/another team/);
  db.prepare("UPDATE teams SET preset_config=? WHERE id=?").run('{"assignments":[]}', team);
  expect(() => assertReviewIdentity(owner, f.review, team, agent.id)).toThrow(/not assigned/);
  db.prepare("UPDATE teams SET preset_config=? WHERE id=?")
    .run(JSON.stringify({ assignments: [{ agentId: agent.id }] }), team);
  const replacement = snapshot({ "changed.ts": "replacement content" });
  db.prepare("UPDATE code_reviews SET snapshot=?,fingerprint=? WHERE id=?")
    .run(JSON.stringify(replacement), snapshotFingerprint(replacement), f.review);
  expect(readReview(f.run, { path: "changed.ts" })).toMatchObject({ content: "replacement content" });
  db.prepare("DELETE FROM code_reviews WHERE id=?").run(f.review);
  expect(() => readReview(f.run, { path: "changed.ts" })).toThrow(/not found/);
});

it("evicts old snapshots by retained bytes and reloads them without dropping captured files", () => {
  const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`file-${i}.ts`, "x".repeat(500_000)]));
  const reviews = Array.from({ length: 6 }, () => fixture(snapshot(files)));
  const reads = observeReads();
  try {
    for (const f of reviews) expect(readReview(f.run, { path: "file-0.ts" })).toMatchObject({ content: "x".repeat(12_000) });
    expect(reads.blobs()).toBe(6);
    expect(readReview(reviews[0].run, { path: "file-23.ts", offset: 499_000 })).toMatchObject({ content: "x".repeat(1000), nextOffset: null });
    expect(reads.blobs()).toBe(7);
    readReview(reviews[0].run, {});
    expect(reads.blobs()).toBe(7);
  } finally { reads.restore(); }
});

it("also bounds the number of retained small snapshots", () => {
  const reviews = Array.from({ length: 17 }, () => fixture());
  const reads = observeReads();
  try {
    for (const f of reviews) readReview(f.run, {});
    expect(reads.blobs()).toBe(17);
    readReview(reviews[0].run, {});
    expect(reads.blobs()).toBe(18);
  } finally { reads.restore(); }
});
