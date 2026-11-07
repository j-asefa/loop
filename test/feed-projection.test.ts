import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFeedFixture, NOW, OWNER } from "./helpers/feed-fixture";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { productionApp } from "./helpers/app";
let fixture: Awaited<ReturnType<typeof createFeedFixture>>;
let app: Awaited<ReturnType<typeof productionApp>>;
let readers: typeof import("../src/server/mobile-return");
beforeAll(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  fixture = await createFeedFixture();
  readers = await import("../src/server/mobile-return");
  app = await productionApp(OWNER);
});
afterAll(async () => {
  await app?.close();
  fixture?.close();
  vi.restoreAllMocks();
});
async function equivalent() {
  for (const filter of readers.FEED_FILTERS)
    for (const scope of [
      {},
      { folder: "proj" },
      { agent: "agent-api" },
      { teams: ["team-1"] },
    ]) {
      const options = { filter, ...scope };
      const query = new URLSearchParams({
        filter,
        ...("folder" in scope ? { folder: scope.folder! } : {}),
        ...("agent" in scope ? { agent: scope.agent! } : {}),
        ...("teams" in scope ? { teams: scope.teams!.join(",") } : {}),
      });
      const response = await app.fetch("/api/feed?" + query);
      expect(response.status).toBe(200);
      // Transport handoff metadata wraps the current Feed selection.
      // Compare every item, cursor and summary field through the route.
      const { projection, projectionRows, ...expected } = await response.json();
      expect(projection).toBeDefined();
      expect(projectionRows.delta).toBe(false);
      expect(readers.feed(OWNER, options), JSON.stringify(options)).toEqual(
        expected,
      );
    }
  expect(fixture.db.prepare("SELECT * FROM feed_card_dirty").all()).toEqual([]);
}
it(
  "matches every public Feed filter and Done card shape through the production projection reader",
  equivalent,
);

async function mutate(path: string, method: string, body?: unknown) {
  const response = await app.fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBeLessThan(300);
  await equivalent();
  return data;
}
it("tracks route mutations, folder subtree moves, saved state, dismiss/undo, Later and queue peers", async () => {
  await mutate("/messages/m-done-native-answer/saved", "POST");
  await mutate("/messages/m-done-native-answer/saved", "DELETE");
  await mutate("/feed/c-done-api", "PATCH", {
    cardKey: "run:r-done-api",
    hidden: true,
  });
  await mutate("/feed/c-done-api", "PATCH", {
    cardKey: "run:r-done-api",
    hidden: false,
  });
  await mutate("/conversations/c-done-api/position", "PUT", {
    positionMessageId: "m-done-api-answer",
  });
  const later = await mutate("/later", "POST", {
    kind: "conversation",
    targetId: "c-done-native",
    condition: "time",
    dueAt: NOW + 60_000,
  });
  await mutate("/later/" + later.id, "DELETE");
  await mutate("/folders/proj", "PATCH", { name: "Renamed project" });
  await mutate("/folders/proj-sub", "PATCH", { parentId: null });
  await mutate("/folders/proj-sub", "PATCH", { parentId: "proj" });
  const first = await mutate("/runs", "POST", {
    agentId: "agent-api",
    conversationId: "c-done-api",
    input: "First follow-up",
    idempotencyKey: "projection-followup-first",
    queue: true,
  });
  const second = await mutate("/runs", "POST", {
    agentId: "agent-api",
    conversationId: "c-surfaced",
    input: "Second follow-up",
    idempotencyKey: "projection-followup-second",
    queue: true,
  });
  await mutate("/runs/" + second.id + "/reorder", "POST", { direction: "up" });
  await mutate("/runs/" + first.id + "/cancel", "POST", {});
}, 60_000);

it("keeps expiry predicates live without a write, including a stopped watch fallback", async () => {
  const { db } = fixture;
  for (const [id, created, updated] of [
    ["watch-new", 20, NOW - 7 * 24 * 3600_000 + 1000],
    ["watch-old", 10, NOW - 7 * 24 * 3600_000 + 2000],
  ] as const)
    db.prepare(
      "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,ended_reason,created_at,updated_at) VALUES(?,?,'c-approval','agent-api','fixture','repo',1,'stopped','merged',?,?)",
    ).run(id, OWNER, created, updated);
  await equivalent();
  const projection = db
    .prepare(
      "SELECT * FROM feed_cards ORDER BY owner_id,conversation_id,kind,card_key",
    )
    .all();
  vi.mocked(Date.now).mockReturnValue(NOW + 1000);
  await equivalent();
  vi.mocked(Date.now).mockReturnValue(NOW + 3600_000 + 1);
  await equivalent();
  expect(
    db
      .prepare(
        "SELECT * FROM feed_cards ORDER BY owner_id,conversation_id,kind,card_key",
      )
      .all(),
  ).toEqual(projection);
  vi.mocked(Date.now).mockReturnValue(NOW);
}, 30_000);

it("retains multiple results alongside active work and paginates ties identically", async () => {
  const { db } = fixture;
  db.transaction(() => {
    for (let i = 0; i < 46; i++) {
      const key = "history-" + String(i).padStart(2, "0");
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,'agent-api','c-running',?,'completed',?, ?,?,?)",
      ).run(
        key,
        OWNER,
        key,
        key,
        JSON.stringify({ folderId: i % 2 ? "proj-deep" : null }),
        NOW - 100,
        NOW - 10,
      );
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,'c-running',?,'assistant',?,?)",
      ).run(key, OWNER, key, "😀".repeat(1050) + key, NOW - 10);
    }
  }).immediate();
  await equivalent();
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 4; page++) {
    const current = readers.feed(OWNER, { filter: "done", before });
    for (const card of current.items) {
      const identity = card.conversation_id + ":" + card.done_card_key;
      expect(seen.has(identity)).toBe(false);
      seen.add(identity);
    }
    if (!current.next) break;
    expect(
      JSON.parse(Buffer.from(current.next, "base64url").toString()),
    ).toHaveLength(3);
    before = current.next;
  }
  expect(seen.size).toBeGreaterThan(40);
  expect(() =>
    readers.feed(OWNER, {
      filter: "done",
      before: Buffer.from(JSON.stringify([NOW - 10, "c-running"])).toString(
        "base64url",
      ),
    }),
  ).toThrow();
  const beforeHistory = db
    .prepare(
      "SELECT payload FROM feed_cards WHERE kind='result' AND conversation_id='c-running' ORDER BY card_key",
    )
    .all();
  db.transaction(() => {
    db.prepare(
      "UPDATE messages SET content=content||' chunk' WHERE id='m-running-answer'",
    ).run();
    db.prepare("UPDATE runs SET updated_at=? WHERE id='r-running'").run(
      NOW + 10,
    );
  }).immediate();
  expect(
    db
      .prepare(
        "SELECT payload FROM feed_cards WHERE kind='result' AND conversation_id='c-running' ORDER BY card_key",
      )
      .all(),
  ).toEqual(beforeHistory);
  await equivalent();
}, 30_000);

it("projects maintenance moves, owner changes and cascaded deletes through the production commit boundary", async () => {
  const { db } = fixture;
  // These maintenance operations have no public owner-transfer/delete route.
  db.prepare(
    "UPDATE conversations SET project_id='proj-deep' WHERE id='c-imported'",
  ).run();
  await equivalent();
  db.transaction(() => {
    db.prepare(
      "UPDATE messages SET conversation_id='c-imported' WHERE run_id='history-00'",
    ).run();
    db.prepare(
      "UPDATE runs SET conversation_id='c-imported' WHERE id='history-00'",
    ).run();
  }).immediate();
  await equivalent();
  db.transaction(() => {
    db.prepare(
      "UPDATE conversations SET owner_id='other' WHERE id='c-imported'",
    ).run();
    db.prepare(
      "UPDATE runs SET owner_id='other' WHERE conversation_id='c-imported'",
    ).run();
    db.prepare(
      "UPDATE messages SET owner_id='other' WHERE conversation_id='c-imported'",
    ).run();
  }).immediate();
  await equivalent();
  for (const filter of readers.FEED_FILTERS)
    expect(
      readers
        .feed("other", { filter })
        .items.every((item) => item.conversation_id === "c-imported"),
    ).toBe(true);
  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE conversation_id='c-imported'").run();
    db.prepare(
      "DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id='c-imported')",
    ).run();
    db.prepare("DELETE FROM runs WHERE conversation_id='c-imported'").run();
    db.prepare("DELETE FROM conversations WHERE id='c-imported'").run();
  }).immediate();
  expect(readers.feed("other", {}).items).toEqual([]);
  await equivalent();
}, 30_000);

it("rolls back sources, cards and events together when projection or a nested writer fails", async () => {
  const { db } = fixture;
  const before = db
    .prepare(
      "SELECT * FROM feed_cards ORDER BY owner_id,conversation_id,kind,card_key",
    )
    .all();
  const event = db.prepare("SELECT max(id) n FROM events").get();
  expect(() =>
    db
      .transaction(() => {
        db.prepare(
          "UPDATE messages SET content='not committed' WHERE id='m-done-api-answer'",
        ).run();
        db.transaction(() => {
          db.prepare(
            "UPDATE runs SET input='rolled back' WHERE id='history-01'",
          ).run();
          throw new Error("nested rollback");
        }).immediate();
      })
      .immediate(),
  ).toThrow("nested rollback");
  expect(
    db
      .prepare(
        "SELECT * FROM feed_cards ORDER BY owner_id,conversation_id,kind,card_key",
      )
      .all(),
  ).toEqual(before);
  expect(db.prepare("SELECT max(id) n FROM events").get()).toEqual(event);
  db.exec(
    "CREATE TEMP TRIGGER projection_failure BEFORE UPDATE ON feed_cards BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END",
  );
  try {
    const response = await app.fetch(
      "/api/messages/m-done-native-answer/saved",
      { method: "POST" },
    );
    expect(response.status).toBe(500);
    expect(
      db
        .prepare(
          "SELECT * FROM message_bookmarks WHERE message_id='m-done-native-answer'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT max(id) n FROM events").get()).toEqual(event);
  } finally {
    db.exec("DROP TRIGGER projection_failure");
  }
  await equivalent();
}, 30_000);

it("drains once for nested writes and RETURNING, and survives a writer killed before commit", async () => {
  const { db } = fixture;
  const before = (
    db.prepare("SELECT max(id) n FROM events").get() as { n: number }
  ).n;
  const updated = db
    .transaction(() => {
      db.prepare(
        "UPDATE messages SET content=content||' first' WHERE id='m-done-native-answer'",
      ).run();
      return db
        .transaction(() =>
          db
            .prepare(
              "UPDATE messages SET content=content||' last' WHERE id='m-done-native-answer' RETURNING content",
            )
            .get(),
        )
        .immediate();
    })
    .immediate() as { content: string };
  expect(updated.content).toMatch(/first last$/);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM events WHERE id>? AND type='feed.card' AND json_extract(payload,'$.kind')='thread' AND json_extract(payload,'$.removed')=0 AND json_extract(payload,'$.conversationId')='c-done-native'",
      )
      .get(before),
  ).toEqual({ n: 1 });
  const cards = db
    .prepare(
      "SELECT * FROM feed_cards ORDER BY owner_id,conversation_id,kind,card_key",
    )
    .all();
  const event = db.prepare("SELECT max(id) n FROM events").get();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const {db}=await import(${JSON.stringify(pathToFileURL(resolve("src/server/db.ts")).href)});
    db.transaction(() => {
      db.prepare("UPDATE messages SET content='crashed' WHERE id='m-done-native-answer'").run();
      process.kill(process.pid,'SIGKILL');
    }).immediate();
  `,
    ],
    {
      env: { ...process.env, LOOP_DATA_DIR: dirname(db.name) },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal, child.stderr).toBe("SIGKILL");
  expect(
    db
      .prepare("SELECT content FROM messages WHERE id='m-done-native-answer'")
      .get(),
  ).toEqual(updated);
  expect(
    db
      .prepare(
        "SELECT * FROM feed_cards ORDER BY owner_id,conversation_id,kind,card_key",
      )
      .all(),
  ).toEqual(cards);
  expect(db.prepare("SELECT max(id) n FROM events").get()).toEqual(event);
  await equivalent();
}, 30_000);

it("keeps oversized queued displays as bounded reconciliation events", async () => {
  const { db } = fixture;
  const before = (
    db.prepare("SELECT max(id) n FROM events").get() as { n: number }
  ).n;
  db.prepare(
    "UPDATE runs SET input=? WHERE conversation_id='c-queue' AND state='queued'",
  ).run("Queued input ".repeat(2500));
  const events = db
    .prepare(
      "SELECT payload FROM events WHERE type='feed.card' AND id>? AND json_extract(payload,'$.kind')='thread' AND json_extract(payload,'$.conversationId')='c-queue'",
    )
    .all(before) as { payload: string }[];
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0].payload)).toMatchObject({
    removed: false,
    card: null,
  });
  expect(events[0].payload.length).toBeLessThan(1000);
  await equivalent();
}, 30_000);

it("bounds dirty work for unrelated folders, queued payloads and connection scope changes", async () => {
  const { db } = fixture;
  const marked = (write: () => unknown) =>
    db
      .transaction(() => {
        write();
        return db
          .prepare(
            "SELECT DISTINCT conversation_id FROM feed_card_dirty ORDER BY conversation_id",
          )
          .all() as { conversation_id: string }[];
      })
      .immediate();
  expect(
    marked(() =>
      db
        .prepare(
          "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('projection-unrelated',?,'folder','Unrelated',1)",
        )
        .run(OWNER),
    ),
  ).toEqual([]);
  expect(
    marked(() =>
      db
        .prepare(
          "UPDATE folders SET name='Still unrelated' WHERE id='projection-unrelated'",
        )
        .run(),
    ),
  ).toEqual([]);
  expect(
    marked(() =>
      db
        .prepare(
          "UPDATE runs SET payload=json_set(payload,'$.model','changed-model') WHERE id='r-queue-1'",
        )
        .run(),
    ),
  ).toEqual([{ conversation_id: "c-queue" }]);
  expect(
    marked(() =>
      db
        .prepare(
          "UPDATE connections SET metadata=json_set(metadata,'$.displayLabel','Renamed') WHERE id='conn-native'",
        )
        .run(),
    ),
  ).toEqual([]);
  db.transaction(() => {
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('projection-peer',?,'agent-native','Peer',1)",
    ).run(OWNER);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES('projection-peer',?,'agent-native','projection-peer','Peer','queued','projection-peer',?, ?,?)",
    ).run(
      OWNER,
      JSON.stringify({ connectionId: "conn-native" }),
      NOW + 100_000,
      NOW + 100_000,
    );
  }).immediate();
  const queue = () =>
    readers
      .feed(OWNER, { filter: "queued" })
      .items.find((row) => row.conversation_id === "c-queue")!;
  expect(queue().queued_runs?.at(-1)?.can_move_down).toBe(false);
  expect(
    marked(() =>
      db
        .prepare(
          "UPDATE connections SET metadata=json_remove(metadata,'$.loopHarness') WHERE id='conn-native'",
        )
        .run(),
    ),
  ).toEqual([
    { conversation_id: "c-queue" },
    { conversation_id: "projection-peer" },
  ]);
  expect(queue().queued_runs?.at(-1)?.can_move_down).toBe(true);
  await equivalent();
  db.prepare(
    "UPDATE connections SET metadata=json_set(metadata,'$.loopHarness','codex') WHERE id='conn-native'",
  ).run();
  await equivalent();
}, 30_000);

it("recreates an idle fallback when the last result becomes ineligible without consulting retired columns", async () => {
  const { db } = fixture;
  db.transaction(() => {
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('projection-idle',?,'Imported',1)",
    ).run(OWNER);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('projection-idle',?,'projection-idle','assistant','Answer',2)",
    ).run(OWNER);
  }).immediate();
  const kinds = () =>
    db
      .prepare(
        "SELECT kind FROM feed_cards WHERE conversation_id='projection-idle' ORDER BY kind",
      )
      .all();
  expect(kinds()).toEqual([{ kind: "result" }, { kind: "thread" }]);
  db.prepare(
    "UPDATE messages SET metadata=json_object('progress',1) WHERE id='projection-idle'",
  ).run();
  expect(kinds()).toEqual([{ kind: "idle" }, { kind: "thread" }]);
  // Historical columns remain only so upgrades do not rebuild conversations.
  // The production reader must not depend on them.
  db.prepare(
    "UPDATE conversations SET feed_run_state='running',feed_visible=0,feed_approval_until=? WHERE id='projection-idle'",
  ).run(NOW + 100_000);
  await equivalent();
  const done = readers.doneCardRows(OWNER, {
    folders: null,
    teamIds: [],
    ids: ["d:message:projection-idle"],
    limit: 1,
  })[0]?.display;
  expect(done).toMatchObject({
    done_card_key: "message:projection-idle",
    last_message: null,
  });
  db.prepare(
    "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,worker_id,created_at,updated_at) VALUES('projection-idle-work',?,'projection-idle','Working','running','projection-idle-work','fixture',3,3)",
  ).run(OWNER);
  expect(kinds()).toEqual([{ kind: "thread" }]);
  await equivalent();
  db.prepare(
    "UPDATE runs SET state='cancelled' WHERE id='projection-idle-work'",
  ).run();
  expect(kinds()).toEqual([{ kind: "idle" }, { kind: "thread" }]);
  await equivalent();
  db.prepare(
    "UPDATE messages SET metadata='{}' WHERE id='projection-idle'",
  ).run();
  expect(kinds()).toEqual([{ kind: "result" }, { kind: "thread" }]);
  await equivalent();
}, 30_000);

it("bounds streamed thread display storage while preserving complete results and prompt titles", async () => {
  const { db } = fixture;
  const key = "projection-long-stream";
  const input =
    " ".repeat(32_000) +
    "Preserve the full normalized task title " +
    "detail ".repeat(6000);
  let content = "🧪".repeat(16_000);
  const metadata = JSON.stringify({ fixturePadding: "m".repeat(32_000) });
  db.transaction(() => {
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,'agent-api','Long stream',?)",
    ).run(key, OWNER, NOW + 300_000);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'agent-api',?,'Previous task','completed',?,?,?)",
    ).run(
      key + "-previous",
      OWNER,
      key,
      key + "-previous",
      NOW + 299_000,
      NOW + 299_000,
    );
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Previous result',?)",
    ).run(key + "-previous", OWNER, key, key + "-previous", NOW + 299_000);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,'agent-api',?,?,'running',?,'{}',?,?)",
    ).run(key, OWNER, key, input, key, NOW + 300_000, NOW + 300_000);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,?,?)",
    ).run(key, OWNER, key, key, content, metadata, NOW + 300_000);
  }).immediate();
  const storedBytes = () =>
    (
      db
        .prepare(
          "SELECT length(CAST(payload AS BLOB)) bytes FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='thread'",
        )
        .get(OWNER, key) as { bytes: number }
    ).bytes;
  const size = storedBytes();
  // Include the public 4000-UTF-16 live preview, Unicode message prefixes and
  // row context, while excluding the unbounded source text and metadata.
  expect(size).toBeLessThan(32_000);
  const check = async () => {
    const options = { filter: "working" as const, agent: "agent-api" };
    const response = await app.fetch(
      "/api/feed?filter=working&agent=agent-api",
    );
    expect(response.status).toBe(200);
    const { projection, projectionRows, ...page } = await response.json();
    const card = page.items.find(
      (item: { conversation_id: string }) => item.conversation_id === key,
    );
    expect(card.title).toBe(input.replace(/\s+/g, " ").trim().slice(0, 200));
    expect(card.run.input).toBe(input.slice(0, 1000));
    expect(card.last_message.content).toBe("🧪".repeat(1000));
    expect(readers.feed(OWNER, options)).toEqual(page);
    const doneOptions = { filter: "done" as const, agent: "agent-api" };
    const donePage = readers.feed(OWNER, doneOptions);
    expect(
      donePage.items.find((item) => item.conversation_id === key)?.title,
    ).toBe("Previous task");
  };
  await check();
  content += " tail".repeat(20_000);
  db.transaction(() => {
    db.prepare("UPDATE messages SET content=? WHERE id=?").run(content, key);
    db.prepare("UPDATE runs SET updated_at=updated_at+1 WHERE id=?").run(key);
  }).immediate();
  expect(storedBytes()).toBeLessThanOrEqual(size + 16);
  await check();
  const signal = db
    .prepare(
      "SELECT payload FROM events WHERE type='feed.card' AND json_extract(payload,'$.conversationId')=? AND json_extract(payload,'$.kind')='thread' ORDER BY id DESC LIMIT 1",
    )
    .get(key) as { payload: string };
  expect(Buffer.byteLength(signal.payload)).toBeLessThan(4096);
  expect(JSON.parse(signal.payload)).toMatchObject({
    conversationId: key,
    kind: "thread",
    removed: false,
    card: null,
  });
  expect(
    db.prepare("SELECT content,metadata FROM messages WHERE id=?").get(key),
  ).toEqual({ content, metadata });
  db.prepare(
    "UPDATE runs SET state='completed',updated_at=updated_at+1 WHERE id=?",
  ).run(key);
  const options = {
    folders: null,
    teamIds: [],
    ids: ["d:run:" + key],
    limit: 1,
    detail: true,
  };
  const complete = readers.doneCardRows(OWNER, options);
  expect(complete).toHaveLength(1);
  expect(complete[0].row.message_content).toBe(content);
  expect(complete[0].row.message_metadata).toBe(metadata);
  expect(complete[0].display.last_message?.content).toBe(content);
  await equivalent();
}, 30_000);
