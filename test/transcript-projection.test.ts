import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  TranscriptProjection,
  type ProjectedMessage,
  type TranscriptEvent,
} from "../src/shared/transcript-projection";
import { historicalEvent } from "../src/shared/workspace-events";
const dir = mkdtempSync(join(tmpdir(), "loop-transcript-delta-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
const { conversationMessages } =
  await import("../src/server/conversation-messages");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function seed(key: string) {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','Projection',1)",
  ).run(key);
  db.prepare(
    "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,'owner',?,'Prompt','running',?,1,1)",
  ).run(key, key, key);
  return { id: key, owner_id: "owner" };
}
function events(conversation: string) {
  return (
    db
      .prepare("SELECT * FROM events WHERE type LIKE 'message.%' ORDER BY id")
      .all() as any[]
  )
    .map((row) => ({ id: row.id, event: historicalEvent(row) }))
    .filter(
      ({ event }) =>
        event.scope.kind === "conversation" && event.scope.id === conversation,
    ) as { id: number; event: TranscriptEvent }[];
}
it("reconstructs the production transcript byte for byte across duplicate and split Unicode appends, replacement and removal", () => {
  const run = seed("unicode");
  const saved = recordConversationUpdate(run, "turn:0", {
    content: "A",
    metadata: { final: false },
  })!;
  const projection = new TranscriptProjection();
  for (const e of events(run.id)) projection.apply(e.id, e.event);
  const initial = events(run.id).at(-1)!.id;
  const content = "A" + '🙂中\n"\\'.repeat(18000);
  recordConversationUpdate(run, "turn:0", {
    content,
    metadata: { final: false },
  });
  const chunks = events(run.id).filter((e) => e.id > initial);
  expect(chunks.length).toBeGreaterThan(3);
  expect(
    chunks.every(
      (e) =>
        e.event.type === "message.delta" &&
        Buffer.byteLength(JSON.stringify(e)) < 64000,
    ),
  ).toBe(true);
  for (const e of chunks) {
    expect(projection.apply(e.id, e.event)).toBe("applied");
    expect(projection.apply(e.id, e.event)).toBe("duplicate");
  }
  expect(projection.rows()).toEqual(
    conversationMessages("owner", run.id).messages,
  );
  expect(projection.messages.get(saved.id)!.content).toBe(content);
  const snapshot = new TranscriptProjection();
  snapshot.install(
    conversationMessages("owner", run.id).messages as ProjectedMessage[],
  );
  for (const e of chunks)
    expect(snapshot.apply(e.id, e.event)).toBe("duplicate");
  const gap = new TranscriptProjection();
  gap.install([{ ...projection.rows()[0], content: "A", revision: 1 }]);
  expect(gap.apply(chunks[1].id, chunks[1].event)).toBe("gap");
  recordConversationUpdate(run, "turn:0", {
    content: "replacement",
    metadata: { final: false },
  });
  const replace = events(run.id).at(-1)!;
  expect(projection.apply(replace.id, replace.event)).toBe("applied");
  recordConversationUpdate(run, "turn:0", {
    content: "replacement",
    metadata: { final: true },
  });
  const removed = events(run.id).at(-1)!;
  expect(removed.event.type).toBe("message.remove");
  projection.apply(removed.id, removed.event);
  projection.install(snapshot.rows()); // A late older page cannot resurrect it.
  expect(projection.rows()).toEqual([]);
});
it("makes rows and events invisible together until commit and rolls them back together", () => {
  const run = seed("atomic");
  const other = new Database(join(dir, "loop.db"));
  try {
    const start = other
      .prepare(
        "SELECT last_event_id FROM change_watermark WHERE owner_id='owner'",
      )
      .get();
    expect(() =>
      db
        .transaction(() => {
          recordConversationUpdate(run, "turn:0", { content: "uncommitted" });
          expect(
            other
              .prepare("SELECT id FROM messages WHERE conversation_id=?")
              .all(run.id),
          ).toEqual([]);
          expect(
            other
              .prepare(
                "SELECT last_event_id FROM change_watermark WHERE owner_id='owner'",
              )
              .get(),
          ).toEqual(start);
          throw Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(events(run.id)).toEqual([]);
    db.transaction(() =>
      recordConversationUpdate(run, "turn:0", { content: "committed" }),
    ).immediate();
    const snapshot = other.transaction(() => {
      const rows = other
        .prepare("SELECT content FROM messages WHERE conversation_id=?")
        .all(run.id);
      const cursor = other
        .prepare(
          "SELECT last_event_id FROM change_watermark WHERE owner_id='owner'",
        )
        .get() as any;
      return { rows, cursor: cursor.last_event_id };
    })();
    expect(snapshot.rows).toEqual([{ content: "committed" }]);
    expect(events(run.id).every((e) => e.id <= snapshot.cursor)).toBe(true);
  } finally {
    other.close();
  }
});
it("pins body and watermark in the production snapshot wrapper while a second process commits", async () => {
  const { projectionSnapshot } =
    await import("../src/server/projection-snapshot");
  const run = seed("snapshot-race");
  const message = recordConversationUpdate(run, "turn:0", {
    content: "before",
  })!;
  const writer = new Database(join(dir, "loop.db"));
  let captured: any;
  const response = {
    locals: { owner: "owner" },
    json(body: unknown) {
      captured = body;
      return this;
    },
  };
  try {
    projectionSnapshot((_req, res) => {
      const messages = conversationMessages("owner", run.id).messages;
      writer
        .prepare("UPDATE messages SET content='after' WHERE id=?")
        .run(message.id);
      res.json({ messages });
    })({} as any, response as any, () => {});
    const update = events(run.id).at(-1)!;
    expect(captured.messages[0].content).toBe("before");
    expect(captured.projection.cursor).toBeLessThan(update.id);
    expect(response.locals).toHaveProperty(
      "workspaceClock",
      captured.projection,
    );
    // Without the wrapper, the same interleaving acknowledges an unseen row.
    const stale = conversationMessages("owner", run.id).messages;
    writer
      .prepare("UPDATE messages SET content='third' WHERE id=?")
      .run(message.id);
    const newer = (
      db
        .prepare(
          "SELECT last_event_id FROM change_watermark WHERE owner_id='owner'",
        )
        .get() as any
    ).last_event_id;
    expect(stale[0].content).toBe("after");
    expect(newer).toBeGreaterThanOrEqual(events(run.id).at(-1)!.id);
  } finally {
    writer.close();
  }
});
it("buffers per-page handoffs, keeps newer retained pages, rejects reset and overflow generations", async () => {
  const { TranscriptHandoff } =
    await import("../src/shared/transcript-projection");
  const run = seed("handoff");
  recordConversationUpdate(run, "old", { content: "old" });
  recordConversationUpdate(run, "new", { content: "new" });
  const rows = conversationMessages("owner", run.id)
    .messages as ProjectedMessage[];
  const source = new TranscriptHandoff(),
    other = new TranscriptHandoff();
  source.reset("epoch");
  other.reset("other");
  const first = source.begin();
  expect(source.install(first, { epoch: "epoch", cursor: 0 }, rows)).toBe(true);
  const olderPage = source.begin();
  recordConversationUpdate(run, "new", { content: "newest" });
  const change = events(run.id).at(-1)!;
  source.receive(change.id, change.event);
  // The older page's watermark must not overwrite or acknowledge the new page.
  expect(
    source.install(olderPage, { epoch: "epoch", cursor: change.id }, [rows[0]]),
  ).toBe(true);
  expect(source.projection.rows().at(-1)!.content).toBe("newest");
  expect(other.projection.rows()).toEqual([]);
  const late = source.begin();
  source.reset("replacement");
  expect(
    source.install(late, { epoch: "epoch", cursor: change.id }, rows),
  ).toBe(false);
  const overflowing = source.begin();
  for (let i = 0; i < 513; i++) source.receive(change.id + i, change.event);
  expect(
    source.install(
      overflowing,
      { epoch: "replacement", cursor: change.id },
      rows,
    ),
  ).toBe(false);
});

it("demonstrates why committing a raw chunk ahead of its row loses content at the production snapshot boundary", async () => {
  const { projectionSnapshot } =
    await import("../src/server/projection-snapshot");
  const run = seed("ahead-of-row"),
    message = recordConversationUpdate(run, "turn:0", { content: "A" })!;
  const row = conversationMessages("owner", run.id)
    .messages[0] as ProjectedMessage;
  // Fault injection: bypass the transactional producer to model the forbidden ordering.
  const payload = {
    messageId: message.id,
    conversationId: run.id,
    baseRevision: row.revision,
    revision: row.revision + 1,
    offset: 1,
    chunkIndex: 0,
    text: "B",
  };
  const ahead = Number(
    db
      .prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES('owner',?,'message.delta',?,1)",
      )
      .run(run.id, JSON.stringify(payload)).lastInsertRowid,
  );
  let snapshot: any;
  projectionSnapshot((_req, res) =>
    res.json({ messages: conversationMessages("owner", run.id).messages }),
  )(
    {} as any,
    {
      locals: { owner: "owner" },
      json(body: unknown) {
        snapshot = body;
        return this;
      },
    } as any,
    () => {},
  );
  expect(snapshot.messages[0].content).toBe("A");
  expect(snapshot.projection.cursor).toBeGreaterThanOrEqual(ahead);
  expect(
    events(run.id).filter((event) => event.id > snapshot.projection.cursor),
  ).toEqual([]);
  // The actual write creates a new event only after materializing the full row.
  recordConversationUpdate(run, "turn:0", { content: "AB" });
  const reducer = new TranscriptProjection();
  reducer.install(snapshot.messages);
  for (const event of events(run.id).filter(
    (event) => event.id > snapshot.projection.cursor,
  ))
    reducer.apply(event.id, event.event);
  expect(reducer.rows()).toEqual(
    conversationMessages("owner", run.id).messages,
  );
});
it("publishes native decision states by server identity and signals cross-device memory preferences", () => {
  const run = seed("decision-life");
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES('server-decision',?,?,'generation','adapter-request','{}',1)",
  ).run(run.id, run.id);
  for (const state of ["deciding", "resolved", "expired", "unknown"])
    db.prepare(
      "UPDATE native_decisions SET state=? WHERE id='server-decision'",
    ).run(state);
  db.prepare("DELETE FROM native_decisions WHERE id='server-decision'").run();
  const lifecycle = (
    db
      .prepare(
        "SELECT * FROM events WHERE type LIKE 'decision.%' AND subject_id='server-decision' ORDER BY id",
      )
      .all() as any[]
  ).map(historicalEvent);
  expect(lifecycle.map((event) => event.type)).toEqual([
    "decision.pending",
    "decision.deciding",
    "decision.resolved",
    "decision.expired",
    "decision.unknown",
    "decision.remove",
  ]);
  for (const event of lifecycle)
    expect(event).toMatchObject({
      subject: { kind: "decision", id: "server-decision" },
      payload: {
        decisionId: "server-decision",
        nativeId: "adapter-request",
        generation: "generation",
        conversationId: run.id,
      },
    });
  const before = (db.prepare("SELECT max(id) n FROM events").get() as any).n;
  db.prepare("INSERT INTO memory_policy VALUES('owner',?,1)").run(
    "conversation:" + run.id,
  );
  db.prepare("UPDATE memory_policy SET enabled=0 WHERE owner_id='owner'").run();
  db.prepare("DELETE FROM memory_policy WHERE owner_id='owner'").run();
  const signals = (
    db
      .prepare(
        "SELECT * FROM events WHERE id>? AND subject_kind='collection' AND subject_id='metadata' ORDER BY id",
      )
      .all(before) as any[]
  ).map(historicalEvent);
  expect(signals).toHaveLength(3);
  expect(
    signals.every(
      (event) =>
        event.scope.kind === "collection" && event.scope.id === "metadata",
    ),
  ).toBe(true);
});

it("keeps oversized decision events bounded and scoped without truncating the request", () => {
  const run = seed("large-decision");
  const request = JSON.stringify({ prompt: "x".repeat(70 * 1024) });
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES('large-decision',?,?,'generation','adapter-request',?,1)",
  ).run(run.id, run.id, request);
  db.prepare(
    "UPDATE native_decisions SET state='resolved' WHERE id='large-decision'",
  ).run();
  expect(
    (
      db
        .prepare(
          "SELECT request FROM native_decisions WHERE id='large-decision'",
        )
        .get() as { request: string }
    ).request,
  ).toBe(request);
  db.prepare("DELETE FROM native_decisions WHERE id='large-decision'").run();
  const rows = db
    .prepare(
      "SELECT * FROM events WHERE subject_kind='decision' AND subject_id='large-decision' ORDER BY id",
    )
    .all() as { run_id: null; type: string; payload: string }[];
  expect(rows).toHaveLength(5); // Three lifecycle rows plus two existing invalidations.
  for (const row of rows) {
    expect(Buffer.byteLength(row.payload)).toBeLessThan(60 * 1024);
    expect(historicalEvent(row)).toMatchObject({
      type: "invalidate",
      scope: { kind: "collection", id: "decisions" },
      subject: { kind: "decision", id: "large-decision" },
    });
  }
});

it("reconciles deletions only inside a snapshot page and cannot resurrect them from an older response", async () => {
  const { TranscriptHandoff } =
    await import("../src/shared/transcript-projection");
  const run = seed("snapshot-deletion");
  for (let i = 0; i < 55; i++)
    recordConversationUpdate(run, String(i), { content: `Row ${i}` });
  const latest = conversationMessages("owner", run.id);
  const older = conversationMessages("owner", run.id, latest.next!);
  const cursor = () =>
    (
      db
        .prepare(
          "SELECT last_event_id FROM change_watermark WHERE owner_id='owner'",
        )
        .get() as any
    ).last_event_id;
  const before = cursor(),
    handoff = new TranscriptHandoff();
  handoff.reset("epoch");
  const install = (page: typeof latest, watermark = cursor()) =>
    handoff.install(
      handoff.begin(),
      { epoch: "epoch", cursor: watermark },
      page.messages as ProjectedMessage[],
      (page as any).range,
    );
  expect(install(latest)).toBe(true);
  expect(install(older)).toBe(true);
  const removed = latest.messages.at(-1)!.id;
  db.prepare("DELETE FROM messages WHERE id=?").run(removed);
  const refreshed = conversationMessages("owner", run.id);
  expect(install(refreshed)).toBe(true);
  expect(handoff.projection.messages.has(removed)).toBe(false);
  expect(handoff.projection.messages.has(older.messages[0].id)).toBe(true);
  expect(install(latest, before)).toBe(true);
  expect(handoff.projection.messages.has(removed)).toBe(false);
  // A late snapshot may not erase a row created after its watermark.
  const late = handoff.begin();
  const newRow = recordConversationUpdate(run, "new", {
    content: "newer than snapshot",
  })!;
  const change = events(run.id).at(-1)!;
  handoff.receive(change.id, change.event);
  expect(
    handoff.install(
      late,
      { epoch: "epoch", cursor: before },
      latest.messages as ProjectedMessage[],
      (latest as any).range,
    ),
  ).toBe(true);
  expect(handoff.projection.messages.has(newRow.id)).toBe(true);
});

it("reuses an initial snapshot only when it covers the first socket reset, in either arrival order", async () => {
  const { TranscriptHandoff } =
    await import("../src/shared/transcript-projection");
  const after = new TranscriptHandoff(),
    before = new TranscriptHandoff(),
    stale = new TranscriptHandoff();
  expect(after.install(after.begin(), { epoch: "epoch", cursor: 20 }, [])).toBe(
    true,
  );
  expect(after.connect("epoch", 20)).toBe(false);
  const pending = before.begin();
  expect(before.connect("epoch", 20)).toBe(false);
  expect(before.install(pending, { epoch: "epoch", cursor: 20 }, [])).toBe(
    true,
  );
  const old = stale.begin();
  expect(stale.connect("epoch", 20)).toBe(false);
  expect(stale.install(old, { epoch: "epoch", cursor: 19 }, [])).toBe(false);
  expect(after.connect("replacement", 20)).toBe(true);
  expect(after.ready).toBe(false);
});

it("keeps unloaded run upserts outside the visible transcript until their page is requested", async () => {
  const run = seed("outside-window");
  const insert = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,'owner',?,?,'assistant',?,?)",
  );
  for (let i = 0; i < 120; i++)
    insert.run(`outside-${i}`, run.id, run.id, `Row ${i}`, i + 1);
  const { workspaceClock } = await import("../src/server/db");
  const page = conversationMessages("owner", run.id);
  const clock = workspaceClock("owner");
  const projection = new TranscriptProjection();
  projection.install(
    page.messages as ProjectedMessage[],
    clock.cursor,
    page.range,
  );
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
  for (const event of events(run.id).filter((event) => event.id > clock.cursor))
    projection.apply(event.id, event.event);
  expect(projection.rows().map((row) => row.id)).toEqual(
    page.messages.map((row) => row.id),
  );
  expect(projection.rows().every((row) => row.run_state === "completed")).toBe(
    true,
  );
  expect(projection.needsLatest()).toBe(false);
  const recovered = conversationMessages(
    "owner",
    run.id,
    undefined,
    "outside-0",
  );
  projection.install(
    recovered.messages as ProjectedMessage[],
    workspaceClock("owner").cursor,
    recovered.range,
    false,
  );
  expect(projection.rows().map((row) => row.id)).toEqual(
    page.messages.map((row) => row.id),
  );
  const older = conversationMessages("owner", run.id, page.next!);
  projection.install(
    older.messages as ProjectedMessage[],
    workspaceClock("owner").cursor,
    older.range,
  );
  expect(projection.rows().map((row) => row.id)).toEqual(
    [...older.messages, ...page.messages].map((row) => row.id),
  );
});

it("discovers a live tail after an anchored snapshot without exposing unloaded older history", async () => {
  const run = seed("anchored-tail");
  const insert = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,'owner',?,?,'assistant',?,?)",
  );
  for (let i = 0; i < 120; i++)
    insert.run(`anchor-${i}`, run.id, run.id, `Row ${i}`, i + 1);
  const { workspaceClock } = await import("../src/server/db");
  const page = conversationMessages("owner", run.id, undefined, "anchor-20");
  const clock = workspaceClock("owner"),
    projection = new TranscriptProjection();
  projection.install(
    page.messages as ProjectedMessage[],
    clock.cursor,
    page.range,
  );
  expect(projection.needsLatest()).toBe(false);
  insert.run("anchor-new", run.id, run.id, "New live answer", 200);
  for (const event of events(run.id).filter((event) => event.id > clock.cursor))
    projection.apply(event.id, event.event);
  expect(projection.needsLatest()).toBe(true);
  const latest = conversationMessages("owner", run.id);
  projection.install(
    latest.messages as ProjectedMessage[],
    workspaceClock("owner").cursor,
    latest.range,
  );
  expect(projection.needsLatest()).toBe(false);
  expect(projection.rows().at(-1)?.content).toBe("New live answer");
  expect(projection.rows().map((row) => row.id)).toEqual(
    [...page.messages, ...latest.messages].map((row) => row.id),
  );
});

it("installs an anchored page while an unloaded newer message streams during its snapshot", async () => {
  const { TranscriptHandoff } =
    await import("../src/shared/transcript-projection");
  const { workspaceClock } = await import("../src/server/db");
  const run = seed("anchored-inflight");
  const insert = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,'owner',?,?,'assistant',?,?)",
  );
  for (let i = 0; i < 120; i++)
    insert.run(`inflight-${i}`, run.id, run.id, `Row ${i}`, i + 1);
  const handoff = new TranscriptHandoff(),
    ticket = handoff.begin();
  const page = conversationMessages("owner", run.id, undefined, "inflight-20"),
    clock = workspaceClock("owner");
  db.prepare(
    "UPDATE messages SET content=content||' streaming' WHERE id='inflight-119'",
  ).run();
  const changes = events(run.id).filter((event) => event.id > clock.cursor);
  expect(
    changes.map((change) => handoff.receive(change.id, change.event)),
  ).toContain("gap");
  expect(
    handoff.install(
      ticket,
      clock,
      page.messages as ProjectedMessage[],
      page.range,
    ),
  ).toBe(true);
  expect(handoff.ready).toBe(true);
  expect(handoff.projection.rows()).toEqual(page.messages);
  const recovered = conversationMessages(
    "owner",
    run.id,
    undefined,
    "inflight-119",
  );
  expect(
    handoff.install(
      handoff.begin(),
      workspaceClock("owner"),
      recovered.messages as ProjectedMessage[],
      recovered.range,
      false,
    ),
  ).toBe(true);
  expect(handoff.projection.rows()).toEqual(page.messages);
  expect(handoff.projection.needsLatest()).toBe(true);
  // A missed chunk belonging to the fetched page still rejects its install.
  const latest = conversationMessages("owner", run.id),
    latestClock = workspaceClock("owner"),
    latestTicket = handoff.begin();
  db.prepare(
    "UPDATE messages SET content=content||' missed' WHERE id='inflight-119'",
  ).run();
  db.prepare(
    "UPDATE messages SET content=content||' later' WHERE id='inflight-119'",
  ).run();
  const last = events(run.id).at(-1)!;
  expect(handoff.receive(last.id, last.event)).toBe("gap");
  expect(
    handoff.install(
      latestTicket,
      latestClock,
      latest.messages as ProjectedMessage[],
      latest.range,
    ),
  ).toBe(false);
});
