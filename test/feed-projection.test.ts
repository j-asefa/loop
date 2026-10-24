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
      for (const expand of filter === "done"
        ? [undefined, "results" as const]
        : [undefined]) {
        const options = { filter, ...scope, expand };
        const query = new URLSearchParams({
          filter,
          ...(expand ? { expand } : {}),
          ...("folder" in scope ? { folder: scope.folder! } : {}),
          ...("agent" in scope ? { agent: scope.agent! } : {}),
          ...("teams" in scope ? { teams: scope.teams!.join(",") } : {}),
        });
        const response = await app.fetch("/api/feed?" + query);
        expect(response.status).toBe(200);
        // PR 7 adds transport handoff metadata around the unchanged Feed
        // selection. Keep comparing every item, cursor and summary field.
        const { projection, ...expected } = await response.json();
        expect(projection).toBeDefined();
        expect(
          readers.shadowFeed(OWNER, options),
          JSON.stringify(options),
        ).toEqual(expected);
      }
    }
  for (const folders of [null, ["proj", "nested", "deep"], [null]]) {
    const options = { folders, teamIds: [], limit: 100 };
    const old = readers.doneCardRows(OWNER, options);
    const projected = readers.shadowDoneCardRows(OWNER, options);
    expect(projected.map((r) => r.display)).toEqual(old.map((r) => r.display));
    const fields = [
      "conversation_id",
      "done_card_key",
      "sort_at",
      "message_id",
      "message_content",
      "message_metadata",
      "card_run",
      "folder_id",
      "project_id",
      "project_name",
    ] as const;
    expect(projected.map((r) => fields.map((k) => r.row[k]))).toEqual(
      old.map((r) => fields.map((k) => r.row[k])),
    );
  }
  expect(fixture.db.prepare("SELECT * FROM feed_card_dirty").all()).toEqual([]);
}
it(
  "matches every public Feed filter and Done card shape before switching readers",
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
  for (const expand of [undefined, "results" as const]) {
    let before: string | undefined;
    for (let page = 0; page < 4; page++) {
      const options = { filter: "done" as const, expand, before };
      const old = readers.feed(OWNER, options);
      expect(readers.shadowFeed(OWNER, options)).toEqual(old);
      if (!old.next) break;
      before = old.next;
    }
  }
  const legacyCursor = Buffer.from(
    JSON.stringify([NOW - 10, "c-running"]),
  ).toString("base64url");
  expect(
    readers.shadowFeed(OWNER, {
      filter: "done",
      expand: "results",
      before: legacyCursor,
    }),
  ).toEqual(
    readers.feed(OWNER, {
      filter: "done",
      expand: "results",
      before: legacyCursor,
    }),
  );
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
    expect(readers.shadowFeed("other", { filter, expand: "results" })).toEqual(
      readers.feed("other", { filter, expand: "results" }),
    );
  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE conversation_id='c-imported'").run();
    db.prepare(
      "DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id='c-imported')",
    ).run();
    db.prepare("DELETE FROM runs WHERE conversation_id='c-imported'").run();
    db.prepare("DELETE FROM conversations WHERE id='c-imported'").run();
  }).immediate();
  expect(readers.shadowFeed("other", {})).toEqual(readers.feed("other", {}));
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
