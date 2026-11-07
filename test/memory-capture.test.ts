import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-memory-capture-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { captureMemory } = await import("../src/server/memory");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function message(owner: string, content: string) {
  const conversation = id(),
    message = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)",
  ).run(conversation, owner, "Saved conversation", now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,'user',?,'{}',?)",
  ).run(message, owner, conversation, content, now());
  return message;
}

// The query module prepares once per connection; retain the captured SQL for
// subsequent query-plan assertions against this same fixture connection.
let query = "";
function captureQuery() {
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    if (sql.includes("SELECT m.*") && sql.includes("FROM memory_sources s"))
      query = sql;
    return prepare(sql);
  });
  try {
    captureMemory();
  } finally {
    spy.mockRestore();
  }
  expect(query).not.toBe("");
  return query;
}
const plan = (query: string) =>
  (db.prepare("EXPLAIN QUERY PLAN " + query).all() as { detail: string }[])
    .map((row) => row.detail)
    .join("\n");

it("uses an indexed source lookup and captures changed content without duplicating unchanged memory", () => {
  const owner = id(),
    mid = message(owner, "Initial saved answer");
  const query = captureQuery();
  expect(plan(query)).toMatch(/SEARCH s USING INDEX/);
  expect(plan(query)).not.toMatch(/SCAN s\b/);
  const source = () =>
    db
      .prepare(
        "SELECT id,revision,content FROM memory_sources WHERE owner_id=? AND source_id=?",
      )
      .get(owner, mid) as { id: string; revision: number; content: string };
  const first = source();
  expect(first).toMatchObject({ revision: 1, content: "Initial saved answer" });
  captureMemory();
  expect(source()).toEqual(first);
  db.prepare("UPDATE messages SET content=? WHERE id=?").run(
    "Corrected saved answer",
    mid,
  );
  captureMemory();
  expect(source()).toEqual({
    ...first,
    revision: 2,
    content: "Corrected saved answer",
  });
  expect(
    db.prepare("SELECT content FROM memory_fts WHERE id=?").get(first.id),
  ).toEqual({ content: "Corrected saved answer" });
});

it("does not let another owner's saved source suppress capture", () => {
  const alice = id(),
    bob = id(),
    mid = message(alice, "Owner-specific answer");
  db.prepare(
    `INSERT INTO memory_sources(id,owner_id,kind,source_id,origin,role,revision,content_hash,content,title,eligible,created_at,updated_at)
    VALUES(?,?,'message',?,'loop','user',1,'existing',?,'Other owner',1,?,?)`,
  ).run(id(), bob, mid, "Owner-specific answer", now(), now() + 1000);
  captureMemory();
  expect(
    db
      .prepare(
        "SELECT owner_id,content FROM memory_sources WHERE owner_id=? AND source_id=?",
      )
      .get(alice, mid),
  ).toEqual({ owner_id: alice, content: "Owner-specific answer" });
  expect(
    db
      .prepare("SELECT count(*) n FROM memory_sources WHERE source_id=?")
      .get(mid),
  ).toEqual({ n: 2 });
});

it("can add the lookup index before restart and migrate without rewriting existing sources", () => {
  const legacy = captureQuery().replace("s.owner_id=m.owner_id AND ", "");
  const before = db.prepare("SELECT * FROM memory_sources ORDER BY id").all();
  db.exec(
    "DROP INDEX memory_sources_capture; DELETE FROM schema_version WHERE version=111",
  );
  expect(plan(legacy)).toMatch(/SCAN s\b/);
  const migration = readFileSync(
    "migrations/111-memory-capture-index.sql",
    "utf8",
  );
  // The running deployment may receive just the additive index while its
  // agents finish. The ordinary startup migration must accept that state.
  db.exec(migration.split("INSERT INTO schema_version")[0]);
  expect(plan(legacy)).toMatch(/SEARCH s USING INDEX memory_sources_capture/);
  db.exec(migration);
  expect(db.prepare("SELECT * FROM memory_sources ORDER BY id").all()).toEqual(
    before,
  );
  expect(
    db.prepare("SELECT version FROM schema_version WHERE version=111").get(),
  ).toEqual({ version: 111 });
});
