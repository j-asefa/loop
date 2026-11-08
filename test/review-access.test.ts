import { execFileSync } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ReviewSnapshot } from "../src/server/review-snapshot";

const dir = mkdtempSync(join(tmpdir(), "loop-review-access-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { readReview, reviewRecord, reviewContext, assertReviewIdentity } =
  await import("../src/server/review-access");
const { reviewStatus } = await import("../src/server/code-reviews");
const { snapshotFingerprint } = await import("../src/server/review-snapshot");

const owner = id(),
  connection = id(),
  folder = id(),
  team = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','','connected',?,?)",
).run(connection, owner, JSON.stringify([{ id: "fixture" }]), now());
const agent = createAgent(owner, {
  name: "review-" + id().slice(0, 8),
  connectionId: connection,
  model: "fixture",
});
db.prepare(
  "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Fixture',?)",
).run(folder, owner, now());
db.prepare(
  "INSERT INTO teams(id,owner_id,name,manager_id,created_at,preset_config) VALUES(?,?,'Fixture',?,?,?)",
).run(
  team,
  owner,
  agent.id,
  now(),
  JSON.stringify({ assignments: [{ agentId: agent.id }] }),
);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function snapshot(
  files: Record<string, string> = { "changed.ts": "new content" },
): ReviewSnapshot {
  return {
    scope: "branch",
    base: "base",
    head: "head",
    diff: "+new content",
    files,
    context: {},
    before: { "changed.ts": "old content" },
    changed: ["changed.ts"],
    omitted: [".env"],
  };
}
function fixture(value = snapshot()) {
  const review = id(),
    conversation = id(),
    rid = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Review',?)",
  ).run(conversation, owner, agent.id, now());
  db.prepare(
    `INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
    VALUES(?,?,?,?,'Review','completed',?,?,?,?)`,
  ).run(
    rid,
    owner,
    agent.id,
    conversation,
    rid,
    JSON.stringify({ reviewId: review }),
    now(),
    now(),
  );
  db.prepare(
    `INSERT INTO code_reviews(id,owner_id,team_id,folder_id,request_key,request_hash,snapshot,fingerprint,run_id,created_at)
    VALUES(?,?,?,?,?,'fixture',?,?,?,?)`,
  ).run(
    review,
    owner,
    team,
    folder,
    review,
    JSON.stringify(value),
    snapshotFingerprint(value),
    rid,
    now(),
  );
  return { review, run: ownedRun(rid, owner) };
}
let observedQueries: string[] | undefined;
const prepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const statement = prepare(sql);
  if (/FROM code_reviews/i.test(sql)) {
    const get = statement.get.bind(statement);
    statement.get = (...args: unknown[]) => {
      observedQueries?.push(sql);
      return get(...args);
    };
  }
  return statement;
}) as typeof db.prepare;
function observeReads() {
  const queries: string[] = [];
  observedQueries = queries;
  return {
    queries,
    restore: () => {
      observedQueries = undefined;
    },
    blobs: () =>
      queries.filter((sql) => /^SELECT snapshot FROM code_reviews/.test(sql))
        .length,
  };
}

it("loads a large snapshot once across chunk reads, listing, context and status, with covering identity checks", () => {
  const files = Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`file-${i}.ts`, "x".repeat(400_000)]),
  );
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
    for (let i = 0; i < 40; i++)
      readReview(f.run, { path: `file-${i % 24}.ts`, offset: i * 100 });
    expect(
      readReview(f.run, { path: "changed.ts", version: "before" }),
    ).toMatchObject({ content: "old content" });
    const listing = readReview(f.run, {}) as {
      changed: string[];
      omitted: string[];
      files: string[];
    };
    expect(listing.files).toEqual(Object.keys(files).sort());
    listing.changed.push("not-captured");
    listing.omitted.length = 0;
    listing.files.length = 0;
    expect(readReview(f.run, {})).toMatchObject({
      changed: ["changed.ts"],
      omitted: [".env"],
    });
    expect(() => readReview(f.run, { path: "../.env" })).toThrow(
      /not in this snapshot/,
    );
    expect(reviewContext(f.run)).toContain("Captured diff");
    expect(reviewStatus(owner, f.review).state).toBe("completed");
    db.prepare(
      "UPDATE runs SET state='failed',error='Late failure' WHERE id=?",
    ).run(f.run.id);
    expect(reviewStatus(owner, f.review).state).toBe("failed");
    expect(reads.blobs()).toBe(1);
    for (const query of reads.queries.filter(
      (sql) => !sql.startsWith("SELECT snapshot"),
    )) {
      const plan = db
        .prepare("EXPLAIN QUERY PLAN " + query)
        .all(owner, f.review) as { detail: string }[];
      expect(
        plan.some((row) =>
          /USING COVERING INDEX code_reviews_access/.test(row.detail),
        ),
      ).toBe(true);
    }
  } finally {
    reads.restore();
  }
});

it("rechecks ownership, deletion, team membership and fingerprint after a cache hit", () => {
  const f = fixture();
  readReview(f.run, {});
  expect(() => readReview({ ...f.run, owner_id: "another-owner" }, {})).toThrow(
    /not found/,
  );
  expect(() =>
    assertReviewIdentity(owner, f.review, "another-team", agent.id),
  ).toThrow(/another team/);
  db.prepare("UPDATE teams SET preset_config=? WHERE id=?").run(
    '{"assignments":[]}',
    team,
  );
  expect(() => assertReviewIdentity(owner, f.review, team, agent.id)).toThrow(
    /not assigned/,
  );
  db.prepare("UPDATE teams SET preset_config=? WHERE id=?").run(
    JSON.stringify({ assignments: [{ agentId: agent.id }] }),
    team,
  );
  const replacement = snapshot({ "changed.ts": "replacement content" });
  db.prepare("UPDATE code_reviews SET snapshot=?,fingerprint=? WHERE id=?").run(
    JSON.stringify(replacement),
    snapshotFingerprint(replacement),
    f.review,
  );
  expect(readReview(f.run, { path: "changed.ts" })).toMatchObject({
    content: "replacement content",
  });
  db.prepare("UPDATE code_reviews SET snapshot=?,fingerprint=? WHERE id=?").run(
    JSON.stringify({ ...replacement, context: undefined }),
    "earlier-inline",
    f.review,
  );
  expect(() => readReview(f.run, {})).toThrow(/earlier Loop build/);
  db.prepare("DELETE FROM code_reviews WHERE id=?").run(f.review);
  expect(() => readReview(f.run, { path: "changed.ts" })).toThrow(/not found/);
});

it("evicts old snapshots by retained bytes and reloads them without dropping captured files", () => {
  const files = Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`file-${i}.ts`, "x".repeat(500_000)]),
  );
  const reviews = Array.from({ length: 6 }, () => fixture(snapshot(files)));
  const reads = observeReads();
  try {
    for (const f of reviews)
      expect(readReview(f.run, { path: "file-0.ts" })).toMatchObject({
        content: "x".repeat(12_000),
      });
    expect(reads.blobs()).toBe(6);
    expect(
      readReview(reviews[0].run, { path: "file-23.ts", offset: 499_000 }),
    ).toMatchObject({ content: "x".repeat(1000), nextOffset: null });
    expect(reads.blobs()).toBe(7);
    readReview(reviews[0].run, {});
    expect(reads.blobs()).toBe(7);
  } finally {
    reads.restore();
  }
});

it("also bounds the number of retained small snapshots", () => {
  const reviews = Array.from({ length: 17 }, () => fixture());
  const reads = observeReads();
  try {
    for (const f of reviews) readReview(f.run, {});
    expect(reads.blobs()).toBe(17);
    readReview(reviews[0].run, {});
    expect(reads.blobs()).toBe(18);
  } finally {
    reads.restore();
  }
});

it("caches verified context across pages and reports uncached missing objects", () => {
  const repo = join(dir, "context-repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  const content = "captured context\n".repeat(1000);
  writeFileSync(join(repo, "context.txt"), content);
  const hash = git("hash-object", "-w", "context.txt").trim();
  const value = { ...snapshot(), context: { "context.txt": hash } };
  const f = fixture(value);
  db.prepare("UPDATE code_reviews SET source_path=? WHERE id=?").run(
    repo,
    f.review,
  );
  writeFileSync(join(repo, "context.txt"), "unreviewed replacement");
  expect(readReview(f.run, {})).toMatchObject({
    files: ["changed.ts", "context.txt"],
  });
  expect(readReview(f.run, { path: "context.txt" })).toMatchObject({
    content: content.slice(0, 12000),
    nextOffset: 12000,
  });
  rmSync(join(repo, ".git", "objects", hash.slice(0, 2), hash.slice(2)));
  expect(
    readReview(f.run, { path: "context.txt", offset: 12000 }),
  ).toMatchObject({ content: content.slice(12000), nextOffset: null });
  expect(() =>
    readReview({ ...f.run, owner_id: "foreign" }, { path: "context.txt" }),
  ).toThrow(/Review not found/);
  expect(() =>
    readReview(f.run, { path: "context.txt", version: "before" }),
  ).toThrow(/not in this snapshot/);
  const missing = git("hash-object", "-w", "context.txt").trim();
  rmSync(join(repo, ".git", "objects", missing.slice(0, 2), missing.slice(2)));
  const unavailable = fixture({
    ...snapshot(),
    context: { "missing.txt": missing },
  });
  db.prepare("UPDATE code_reviews SET source_path=? WHERE id=?").run(
    repo,
    unavailable.review,
  );
  expect(() => readReview(unavailable.run, { path: "missing.txt" })).toThrow(
    /Context file no longer available/,
  );
  const other = fixture(value);
  expect(
    readReview(other.run, { path: "context.txt", offset: 12000 }),
  ).toMatchObject({ content: content.slice(12000) });
  expect(readReview(f.run, { path: "changed.ts" })).toMatchObject({
    content: "new content",
  });
});

it("keeps old inline context snapshots readable without a source repository", () => {
  const f = fixture(
    snapshot({ "changed.ts": "new content", "context.ts": "legacy context" }),
  );
  expect(readReview(f.run, { path: "context.ts" })).toMatchObject({
    content: "legacy context",
  });
});

it("reports and caches binary context omissions and ignores replacement refs", () => {
  const repo = join(dir, "binary-repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(repo, "binary"), Buffer.from([1, 0, 2, 42]));
  const binary = git("hash-object", "-w", "binary").trim();
  writeFileSync(join(repo, "text"), "original context with a replacement\n");
  const text = git("hash-object", "-w", "text").trim();
  git("replace", text, binary);
  const f = fixture({ ...snapshot(), context: { text: text, binary: binary } });
  db.prepare("UPDATE code_reviews SET source_path=? WHERE id=?").run(
    repo,
    f.review,
  );
  expect(readReview(f.run, { path: "text" })).toMatchObject({
    content: "original context with a replacement\n",
  });
  expect(readReview(f.run, { path: "binary" })).toEqual({
    path: "binary",
    version: "current",
    omitted: true,
    reason: "binary",
  });
  rmSync(join(repo, ".git", "objects", binary.slice(0, 2), binary.slice(2)));
  expect(readReview(f.run, { path: "binary" })).toMatchObject({
    omitted: true,
    reason: "binary",
  });
});
