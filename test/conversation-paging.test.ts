import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop55-conversation-paging-"));
process.env.LOOP55_DATA_DIR = dir;
const { db, id } = await import("../src/server/db");
const { conversationMessages, transcriptPageSql } =
  await import("../src/server/conversation-messages");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
// Initialize the route graph with the fixture, so the HTTP case's timeout
// covers requests and assertions instead of cold module transformation.
const { core } = await import("../src/server/core-routes");
const { savePosition } = await import("../src/server/mobile-return");
const { Problem } = await import("../src/server/domain");
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
  const result =
    recordConversationUpdate({ id: run, owner_id: owner }, id(), {
      content: "progress",
      metadata: JSON.parse(metadata),
    })?.id || "not-owned";
  db.prepare("UPDATE messages SET created_at=10 WHERE id=?").run(result);
  return result;
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
  // This case measures reads of populated history. Reuse its fixture writes:
  // preparing thousands of trigger-heavy statements retains gigabytes of
  // native SQLite allocations before JavaScript's GC notices any pressure.
  const insertRun = db.prepare(
    "INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES(?,'alice',?,'agent','prompt','completed',?,1,1)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,?,?,?,10)",
  );
  db.transaction(() => {
    for (const c of [conversation, other])
      for (let i = 0; i < 1000; i++) {
        const r = id();
        insertRun.run(r, c, r);
        insertMessage.run(id(), c, r, "user", "prompt", "{}");
        insertMessage.run(
          id(),
          c,
          r,
          "assistant",
          "progress",
          '{"progress":true}',
        );
        insertMessage.run(id(), c, r, "assistant", "answer", "{}");
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
    expect(plan).toMatch(/messages_final_update/);
    expect(plan).not.toMatch(/run_traces/);
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
}, 30_000);

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
    progress,
    progress2,
    steering,
    answer,
    queued,
    answer2,
  ]);
  expect(
    JSON.parse(entries.find((entry) => entry.id === answer)!.metadata)
      .completedMessageId,
  ).toBe(finalTrace);
  db.prepare(
    "UPDATE runs SET state='failed',error='updated state' WHERE id=?",
  ).run(first);
  expect(
    conversationMessages("alice", c).messages.find(
      (entry) => entry.id === answer,
    ),
  ).toMatchObject({ run_state: "failed", run_error: "updated state" });
  const anchored = conversationMessages("alice", c, undefined, progress2);
  expect(anchored.messages.at(-1)?.id).toBe(progress2);
  expect(() => conversationMessages("bob", c, undefined, answer)).toThrow(
    "Message not found",
  );
});

it("tracks replay before the prompt, changed visibility and prompt deletion without stale entries", () => {
  const c = thread(),
    r = run(c);
  const answer = message(c, r, "assistant"),
    update = trace(r);
  expect(all(c).map((entry) => entry.id)).toEqual([update, answer]);
  const prompt = message(c, r);
  expect(all(c).map((entry) => entry.id)).toEqual([prompt, update, answer]);
  db.prepare(
    'UPDATE messages SET metadata=\'{"progress":true,"final":true}\' WHERE id=?',
  ).run(update);
  expect(all(c).map((entry) => entry.id)).toEqual([prompt, answer]);
  db.prepare(
    "UPDATE messages SET metadata='{\"progress\":true}',content=' ' WHERE id=?",
  ).run(update);
  expect(all(c).map((entry) => entry.id)).toEqual([prompt, answer]);
  db.prepare("UPDATE messages SET content='visible again' WHERE id=?").run(
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
  expect(all(c).map((entry) => entry.id)).toEqual([update, answer, hidden]);
  db.prepare("DELETE FROM messages WHERE id=?").run(answer);
  expect(all(c).map((entry) => entry.id)).toEqual([hidden, update]);
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
    conversationMessages("alice", c, undefined, update).messages.map(
      (entry) => entry.id,
    ),
  ).toEqual([update]);
  expect(all(c).map((entry) => entry.id)).toEqual([update, answer]);
  expect(() => conversationMessages("bob", c, undefined, update)).toThrow(
    "Message not found",
  );
});

it("reprojects a moved run and scopes progress by both run owner and conversation", () => {
  const c = thread(),
    destination = thread(),
    r = run(c);
  message(c, r);
  const progress = trace(r);
  const alien = trace(r, "{}", "bob");
  expect(all(c).map((entry) => entry.id)).not.toContain(alien);
  db.prepare("UPDATE runs SET conversation_id=? WHERE id=?").run(
    destination,
    r,
  );
  expect(all(c).map((entry) => entry.id)).not.toContain(progress);
  expect(all(destination).map((entry) => entry.id)).toEqual([progress]);
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
    for (const file of files.filter(
      (file) => file > "065-conversation-transcript.sql",
    ))
      old.exec(readFileSync(`migrations/${file}`, "utf8"));
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
    // Copied updates survive trace retention/deletion and keep legacy links.
    old.exec("DELETE FROM run_traces");
    expect(page()).toEqual(before);
    expect(
      old.prepare("SELECT content FROM messages WHERE id='trace:1'").get(),
    ).toEqual({ content: "progress" });
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

it("persists idempotent public messages independently of traces and scopes their writer", () => {
  const c = thread(),
    r = run(c);
  message(c, r);
  const first = recordConversationUpdate(
    { id: r, owner_id: "alice" },
    "update",
    { content: "First" },
  )!;
  const revised = recordConversationUpdate(
    { id: r, owner_id: "alice" },
    "update",
    { content: "Revised" },
  )!;
  expect(revised.id).toBe(first.id);
  expect(
    recordConversationUpdate({ id: r, owner_id: "bob" }, "update", {
      content: "Wrong owner",
    }),
  ).toBeUndefined();
  expect(
    db.prepare("SELECT count(*) n FROM run_traces WHERE run_id=?").get(r),
  ).toEqual({ n: 0 });
  db.exec("ALTER TABLE run_traces RENAME TO unavailable_traces");
  try {
    expect(all(c).filter((m) => m.id === first.id)).toMatchObject([
      { content: "Revised" },
    ]);
    expect(
      conversationMessages("alice", c, undefined, first.id).messages.at(-1)?.id,
    ).toBe(first.id);
  } finally {
    db.exec("ALTER TABLE unavailable_traces RENAME TO run_traces");
  }
});

it("serves a saved-position page in one resume request while ordinary refreshes, anchors and cursors retain their meaning", async () => {
  const conversation = thread();
  const ids = Array.from({ length: 125 }, () => message(conversation, null));
  savePosition("alice", conversation, { positionMessageId: ids[30] });
  let requests = 0;
  const app = express();
  app.use((req, res, next) => {
    requests++;
    res.locals.owner = req.get("x-owner") || "alice";
    next();
  });
  app.use(core);
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(error instanceof Problem ? error.status : 400)
        .json({ error: error.message });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const get = async (query = "", owner = "alice") => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/conversations/${conversation}${query}`,
      { headers: { "x-owner": owner } },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  try {
    const resumed = await get("?resume=1");
    expect(requests).toBe(1);
    expect(resumed.status).toBe(200);
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.messages.at(-1).id).toBe(ids[30]);
    const latest = await get();
    expect(latest.body.resumed).toBe(false);
    expect(latest.body.messages.map((m: any) => m.id)).toEqual(ids.slice(-50));
    const anchored = await get("?resume=1&message=" + ids[60]);
    expect(anchored.body.resumed).toBe(false);
    expect(anchored.body.messages.at(-1).id).toBe(ids[60]);
    const before = await get("?resume=1&before=" + latest.body.next);
    expect(before.body.resumed).toBe(false);
    expect(before.body.messages.map((m: any) => m.id)).toEqual(
      ids.slice(25, 75),
    );
    expect((await get("?resume=1", "bob")).status).toBe(404);
    savePosition("alice", conversation, { positionMessageId: ids[124] });
    expect((await get("?resume=1")).body.resumed).toBe(false);
    savePosition("alice", conversation, { positionMessageId: ids[30] });
    db.prepare("DELETE FROM messages WHERE id=?").run(ids[30]);
    expect((await get("?resume=1")).body.messages.at(-1).id).toBe(ids[124]);
    expect((await get("?message=" + ids[30])).status).toBe(404);
    expect((await get("?before=invalid")).status).toBe(400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
