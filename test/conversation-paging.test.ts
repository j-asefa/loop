import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "loop-conversation-paging-"));
process.env.LOOP_DATA_DIR = dir;
const { db, id } = await import("../src/server/db");
const { conversationMessages, transcriptPageSql } =
  await import("../src/server/conversation-messages");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function thread(owner = "alice") {
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'History',1)",
  ).run(conversation, owner);
  return conversation;
}
function run(conversation: string, owner = "alice") {
  const run = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,'agent','prompt','completed',?,1,1)",
  ).run(run, owner, conversation, id());
  return run;
}
function message(
  conversation: string,
  run: string | null,
  role = "user",
  metadata = "{}",
  owner = "alice",
) {
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,10)",
  ).run(message, owner, conversation, run, role, message, metadata);
  return message;
}
function trace(run: string, metadata = "{}", owner = "alice") {
  return Number(
    db
      .prepare(
        "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,?,'message','Update','progress',?,10)",
      )
      .run(owner, run, id(), metadata).lastInsertRowid,
  );
}
function all(conversation: string) {
  const entries: ReturnType<typeof conversationMessages>["messages"] = [];
  let cursor: string | null = null;
  do {
    const page = conversationMessages(
      "alice",
      conversation,
      cursor ?? undefined,
    );
    entries.unshift(...page.messages);
    cursor = page.next;
  } while (cursor);
  return entries;
}

it("range-reads only a transcript page without scanning source history, before or after ANALYZE", () => {
  const conversation = thread();
  const other = thread();
  db.transaction(() => {
    for (const c of [conversation, other])
      for (let i = 0; i < 1000; i++) {
        const r = run(c);
        message(c, r);
        trace(r);
        message(c, r, "assistant");
      }
  })();
  for (const analyze of [false, true]) {
    if (analyze) db.exec("ANALYZE");
    const plan = (
      db
        .prepare("EXPLAIN QUERY PLAN " + transcriptPageSql)
        .all(
          "alice",
          conversation,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        ) as { detail: string }[]
    )
      .map((step) => step.detail)
      .join("\n");
    expect(plan).toMatch(
      /SEARCH conversation_transcript USING INDEX conversation_transcript_page/,
    );
    expect(plan).toMatch(/run_traces_final_message/);
    expect(plan).not.toMatch(
      /SCAN (messages|run_traces|conversation_transcript)|personal_message_history/,
    );
    const page = conversationMessages("alice", conversation);
    expect(page.messages).toHaveLength(50);
    expect(page.next).not.toBeNull();
  }
  const entries = all(conversation);
  expect(entries).toHaveLength(3000);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(3000);
});

it("keeps queued prompts, tied progress timestamps, steering and final answers in turn order", () => {
  const c = thread();
  const first = run(c),
    second = run(c);
  const prompt = message(c, first);
  const queued = message(c, second);
  const progress = trace(first),
    progress2 = trace(first);
  const steering = message(c, first, "user", '{"steeringId":"s"}');
  const finalTrace = trace(first, '{"final":true}');
  const answer = message(c, first, "assistant");
  const answer2 = message(c, second, "assistant");
  const entries = all(c);
  expect(entries.map((entry) => entry.id)).toEqual([
    prompt,
    `trace:${progress}`,
    `trace:${progress2}`,
    steering,
    answer,
    queued,
    answer2,
  ]);
  expect(
    JSON.parse(entries.find((entry) => entry.id === answer)!.metadata)
      .completedTraceId,
  ).toBe(finalTrace);
  db.prepare(
    "UPDATE runs SET state='failed',error='updated state' WHERE id=?",
  ).run(first);
  expect(
    conversationMessages("alice", c).messages.find(
      (entry) => entry.id === answer,
    ),
  ).toMatchObject({ run_state: "failed", run_error: "updated state" });
  const anchored = conversationMessages(
    "alice",
    c,
    undefined,
    `trace:${progress2}`,
  );
  expect(anchored.messages.at(-1)?.id).toBe(`trace:${progress2}`);
  expect(() => conversationMessages("bob", c, undefined, answer)).toThrow(
    "Message not found",
  );
});

it("tracks replay before the prompt, changed visibility and prompt deletion without stale entries", () => {
  const c = thread(),
    r = run(c);
  const answer = message(c, r, "assistant"),
    update = trace(r);
  expect(all(c).map((entry) => entry.id)).toEqual([`trace:${update}`, answer]);
  const prompt = message(c, r);
  expect(all(c).map((entry) => entry.id)).toEqual([
    prompt,
    `trace:${update}`,
    answer,
  ]);
  db.prepare(
    "UPDATE run_traces SET metadata='{\"final\":true}' WHERE id=?",
  ).run(update);
  expect(all(c).map((entry) => entry.id)).toEqual([prompt, answer]);
  db.prepare("UPDATE run_traces SET metadata='{}',content=' ' WHERE id=?").run(
    update,
  );
  expect(all(c).map((entry) => entry.id)).toEqual([prompt, answer]);
  db.prepare("UPDATE run_traces SET content='visible again' WHERE id=?").run(
    update,
  );
  const hidden = message(c, r, "tool");
  expect(
    conversationMessages("alice", c, undefined, hidden).messages.map(
      (entry) => entry.id,
    ),
  ).not.toContain(hidden);
  db.prepare(
    'UPDATE messages SET metadata=\'{"native":{"type":"error"}}\' WHERE id=?',
  ).run(hidden);
  expect(all(c).map((entry) => entry.id)).toContain(hidden);
  const steering = message(c, r, "user", '{"steeringId":"s"}');
  db.prepare("DELETE FROM messages WHERE id=?").run(prompt);
  expect(
    all(c).every(
      (entry) =>
        entry.cursor[0] ===
        all(c).find((entry) => entry.id === steering)!.cursor[0],
    ),
  ).toBe(true);
  db.prepare("DELETE FROM messages WHERE id=?").run(steering);
  // Losing every prompt leaves the run's progress with its first remaining
  // entry rather than without a position, so its saved links still open.
  expect(all(c).map((entry) => entry.id)).toEqual([
    `trace:${update}`,
    answer,
    hidden,
  ]);
  db.prepare("DELETE FROM messages WHERE id=?").run(answer);
  expect(all(c).map((entry) => entry.id)).toEqual([hidden, `trace:${update}`]);
  expect(all(c).map((entry) => entry.id)).not.toContain(answer);
  expect(() => conversationMessages("alice", c, "bad cursor")).toThrow(
    "Invalid conversation cursor",
  );
});

it("opens progress whose run never stored a prompt, as agent links still do", () => {
  const c = thread(),
    r = run(c);
  // Imported and replayed runs reach the transcript as a partial answer and
  // its update; Messages and Traces link to that update by trace id.
  const answer = message(c, r, "assistant"),
    update = trace(r);
  expect(
    conversationMessages("alice", c, undefined, `trace:${update}`).messages.map(
      (entry) => entry.id,
    ),
  ).toEqual([`trace:${update}`]);
  expect(all(c).map((entry) => entry.id)).toEqual([`trace:${update}`, answer]);
  expect(() =>
    conversationMessages("bob", c, undefined, `trace:${update}`),
  ).toThrow("Message not found");
});

it("reprojects a moved run and scopes progress by both run owner and conversation", () => {
  const c = thread(),
    destination = thread(),
    r = run(c);
  message(c, r);
  const progress = trace(r);
  const alien = trace(r, "{}", "bob");
  expect(all(c).map((entry) => entry.id)).not.toContain(`trace:${alien}`);
  db.prepare("UPDATE runs SET conversation_id=? WHERE id=?").run(
    destination,
    r,
  );
  expect(all(c).map((entry) => entry.id)).not.toContain(`trace:${progress}`);
  expect(all(destination).map((entry) => entry.id)).toEqual([
    `trace:${progress}`,
  ]);
});

it("backfills a populated database, preserves legacy cursors and keeps new sequences stable through VACUUM", () => {
  const old = new Database(":memory:");
  old.pragma("foreign_keys=ON");
  try {
    const files = readdirSync("migrations")
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files.filter((file) => file < "065"))
      old.exec(readFileSync(`migrations/${file}`, "utf8"));
    old.exec(`INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c','alice','Old',1);
      INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at)
        VALUES('r','alice','c','agent','prompt','completed','key',1,1);
      INSERT INTO messages(rowid,id,owner_id,conversation_id,run_id,role,content,created_at)
        VALUES(10,'prompt','alice','c','r','user','prompt',10),(20,'answer','alice','c','r','assistant','answer',20);
      INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,created_at)
        VALUES('alice','r','progress','message','Update','progress',15);
      INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c2','alice','Imported',1);
      INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at)
        VALUES('r2','alice','c2','agent','prompt','running','key2',1,1);
      INSERT INTO messages(rowid,id,owner_id,conversation_id,run_id,role,content,created_at)
        VALUES(30,'reply','alice','c2','r2','assistant','reply',30);
      INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,created_at)
        VALUES('alice','r2','progress','message','Update','progress',35);`);
    old.exec(
      readFileSync("migrations/065-conversation-transcript.sql", "utf8"),
    );
    const page = (conversation = "c") =>
      old
        .prepare(transcriptPageSql)
        .all(
          "alice",
          conversation,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        ) as any[];
    expect(
      page().map((entry) => [
        entry.id,
        entry.position,
        entry.phase,
        entry.ordinal,
      ]),
    ).toEqual([
      ["answer", 10, Number.MAX_SAFE_INTEGER, 40],
      ["trace:1", 10, 15, 3],
      ["prompt", 10, 0, 20],
    ]);
    // Backfilled history with no prompt row keeps its progress at the run's
    // first stored entry instead of leaving it without a position.
    expect(
      page("c2").map((entry) => [entry.id, entry.position, entry.phase]),
    ).toEqual([
      ["reply", 30, Number.MAX_SAFE_INTEGER],
      ["trace:2", 30, 35],
    ]);
    const before = page();
    old.exec("VACUUM");
    expect(page()).toEqual(before);
    old.exec(
      "DELETE FROM messages WHERE id='answer'; INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('new','alice','c','user','new',30)",
    );
    expect(
      page().find((entry) => entry.id === "new")?.position,
    ).toBeGreaterThan(20);
    expect(old.pragma("foreign_key_check")).toEqual([]);
    old.exec(
      "DELETE FROM messages WHERE run_id IN ('r','r2'); DELETE FROM runs WHERE id IN ('r','r2'); DELETE FROM conversations WHERE id IN ('c','c2')",
    );
    expect(
      old.prepare("SELECT count(*) n FROM conversation_transcript").get(),
    ).toEqual({ n: 0 });
  } finally {
    old.close();
  }
});
