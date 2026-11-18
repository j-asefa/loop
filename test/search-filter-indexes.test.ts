import { seedConversation, seedMessage } from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { saveArtifact } = await import("../src/server/artifacts");
const { search } = await import("../src/server/search");
const { eligibleText, filterSql, indexCounts } =
  await import("../src/server/sql/search-documents");

afterAll(() => {
  db.close();
});

// Both filters run once for each keyword match. Expressions over the
// artifacts or memory_sources columns cannot use their indexes, so a common
// word made SQLite read every artifact per match and stalled the server.
const plan = (sql: string, params: unknown[]) =>
  (
    db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params) as {
      detail: string;
    }[]
  )
    .map((row) => row.detail)
    .join("\n");

function message(owner: string, content: string) {
  const conversation = id(),
    message = id();
  seedConversation(db, {
    id: conversation,
    owner_id: owner,
    title: "Search filters",
    created_at: now(),
  });
  seedMessage(db, {
    id: message,
    owner_id: owner,
    conversation_id: conversation,
    role: "user",
    content,
    created_at: now(),
  });
  return message;
}

function memorySource(owner: string, kind: string, sourceId: string) {
  db.prepare(
    `INSERT INTO memory_sources(id,owner_id,kind,source_id,origin,role,revision,content_hash,content,title,eligible,created_at,updated_at)
     VALUES(?,?,?,?,'capture','user',1,'hash','content','title',1,?,?)`,
  ).run(id(), owner, kind, sourceId, now(), now());
}

it("looks up artifacts and memory sources by index for each candidate document", () => {
  const owner = id();
  const filter = filterSql(owner, {}, now());
  const artifactPlan = plan(
    `SELECT d.id FROM search_documents d WHERE ${filter.sql}`,
    filter.params,
  );
  expect(artifactPlan).toMatch(
    /SEARCH a (?:EXISTS )?USING (?:COVERING )?INDEX \S+ \(id=\?/,
  );
  expect(artifactPlan).not.toMatch(
    /SEARCH a (?:EXISTS )?USING (?:COVERING )?INDEX \S+ \(owner_id=\?\)/,
  );
  expect(artifactPlan).not.toMatch(/SCAN a\b/);

  const mine = filterSql(owner, { scope: "mine" }, now());
  const minePlan = plan(
    `SELECT d.id FROM search_documents d WHERE ${mine.sql}`,
    mine.params,
  );
  expect(minePlan).toMatch(
    /SEARCH m (?:EXISTS )?USING (?:COVERING )?INDEX \S+ \(id=\?/,
  );
  expect(minePlan).not.toMatch(/SCAN m\b/);

  const memoryPlan = plan(
    `SELECT d.id FROM search_documents d WHERE d.owner_id=? AND ${eligibleText}`,
    [owner],
  );
  expect(memoryPlan).toMatch(
    /SEARCH ms (?:EXISTS )?USING (?:COVERING )?INDEX \S+ \(owner_id=\? AND kind=\? AND source_id=\?\)/,
  );
  expect(memoryPlan).not.toMatch(/SCAN ms\b/);
});

it("keeps excluding trace artifacts and memory-backed documents", async () => {
  const owner = id();
  const answer = saveArtifact(owner, {
    title: "Kestrel answer",
    content: "The kestrel report is ready.",
    role: "answer",
  });
  saveArtifact(owner, {
    title: "Kestrel trace",
    content: "Tool output about the kestrel.",
    role: "trace",
  });
  const plain = message(owner, "A kestrel note without memory.");
  const remembered = message(owner, "A kestrel note saved to memory.");
  memorySource(owner, "message", remembered);
  const found = await search(owner, "kestrel");
  expect(found.items.map((item) => item.id).sort()).toEqual(
    ["artifact:" + answer, "message:" + plain, "message:" + remembered].sort(),
  );

  const mineFound = await search(owner, "kestrel", { scope: "mine" });
  expect(mineFound.items.map((item) => item.id).sort()).toEqual(
    ["message:" + plain, "message:" + remembered].sort(),
  );

  // Semantic indexing skips only the memory-backed message.
  expect(indexCounts(db, "fixture-model", owner)).toEqual({
    total: 3,
    indexed: 0,
  });
});
