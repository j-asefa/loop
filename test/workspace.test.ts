import { afterAll, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-workspace-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { page: eventPage } = await import("../src/server/sql/events");
const importSignals = (owner: string) =>
  eventPage(db, owner, 0).filter(
    (e) => e.subject_kind === "collection" && e.subject_id === "imports",
  );
const { db, id, now } = await import("../src/server/db");
const { parseConversations, stageImport, executeImport, readArchive } =
  await import("../src/server/imports");
const { enqueue, claim, transition, recoverStale } =
  await import("../src/server/queue");
const { saveArtifact } = await import("../src/server/artifacts");
const { moveArtifact, undoMove, naturalDestination } =
  await import("../src/server/filing");
const { lexical } = await import("../src/server/search");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("preserves representative ChatGPT branches and Claude attachments without inventing bytes", () => {
  const a = parseConversations(
    JSON.parse(readFileSync("test/fixtures/chatgpt-export.json", "utf8")),
  );
  expect(a.conversations[0].messages).toHaveLength(3);
  expect(
    a.conversations[0].messages.find((m) => m.externalId === "m-alt")?.active,
  ).toBe(false);
  const b = parseConversations(
    JSON.parse(readFileSync("test/fixtures/claude-export.json", "utf8")),
  );
  expect(b.provider).toBe("anthropic");
  expect(b.conversations[0].messages[0].content).toContain("notes.pdf");
  expect(() => parseConversations({ random: [] })).toThrow();
});
it("rejects archive traversal and imports retained attachments", async () => {
  await expect(
    readArchive(readFileSync("test/fixtures/unsafe-path.zip"), "bad.zip"),
  ).rejects.toThrow();
  const p = await readArchive(
    readFileSync("test/fixtures/chatgpt-export.zip"),
    "export.zip",
  );
  expect(p.attachments[0].name).toBe("attachments/note.txt");
});
it("deduplicates repeated uploads and safely restarts import work", async () => {
  const bytes = readFileSync("test/fixtures/chatgpt-export.zip");
  const a = await stageImport("alice", bytes, "export.zip");
  expect(importSignals("alice")).toHaveLength(1);
  expect(JSON.parse(importSignals("alice")[0].payload)).toEqual({
    scope: { kind: "collection", id: "imports" },
  });
  expect((await stageImport("alice", bytes, "export.zip")).id).toBe(a.id);
  expect(importSignals("alice")).toHaveLength(1);
  enqueue("alice", "Import", "import-test-key", {
    kind: "import",
    payload: { importId: a.id },
  });
  const claimed = claim("importer")!;
  await executeImport(claimed);
  expect(importSignals("alice").length).toBeGreaterThan(3);
  expect(importSignals("bob")).toHaveLength(0);
  transition(claimed, "completed");
  const count = db.prepare("SELECT count(*) n FROM messages").get();
  await executeImport({ ...claimed, state: "running" });
  expect(db.prepare("SELECT count(*) n FROM messages").get()).toEqual(count);
  expect(
    db.prepare("SELECT count(*) n FROM messages WHERE owner_id=?").get("bob"),
  ).toEqual({ n: 0 });
  expect(db.prepare("SELECT status FROM imports WHERE id=?").get(a.id)).toEqual(
    { status: "completed" },
  );
  // Imported conversations carry an <provider>-import origin; reading them
  // through the saved-row schema (the path listings use) must succeed.
  const { owned } = await import("../src/server/sql/conversations");
  const imported = db
    .prepare(
      "SELECT id,origin FROM conversations WHERE owner_id='alice' AND origin LIKE '%-import'",
    )
    .all() as { id: string; origin: string }[];
  expect(imported.length).toBeGreaterThan(0);
  // The saved-row reader (ConversationRecord, with the closed origin enum)
  // must accept every imported conversation without raising InvalidRow.
  for (const row of imported)
    expect(owned(db, row.id, "alice")?.origin).toBe(row.origin);
});
it("projects supported imported fractional timestamps without rejecting their snapshots", async () => {
  const { ProjectedMessage } =
    await import("../src/shared/transcript-projection");
  const { conversationMessages } =
    await import("../src/server/conversation-messages");
  const bytes = Buffer.from(
    JSON.stringify([
      {
        id: "fractional",
        mapping: {
          one: {
            message: {
              id: "one",
              author: { role: "user" },
              content: { parts: ["Imported"] },
              create_time: 1699999999123.456,
            },
          },
        },
      },
    ]),
  );
  const imported = await stageImport(
    "fractional-owner",
    bytes,
    "conversations.json",
  );
  const run = enqueue("fractional-owner", "Import", "fractional-import", {
    kind: "import",
    payload: { importId: imported.id },
  });
  const claimed = claim("fractional-importer")!;
  expect(claimed.id).toBe(run.id);
  await executeImport(claimed);
  transition(claimed, "completed");
  const row = db
    .prepare(
      "SELECT conversation_id FROM messages WHERE owner_id='fractional-owner'",
    )
    .get() as { conversation_id: string };
  const messages = conversationMessages(
    "fractional-owner",
    row.conversation_id,
  ).messages;
  expect(messages[0].created_at).toBe(1699999999123.456);
  expect(ProjectedMessage.array().safeParse(messages).success).toBe(true);
});
it("moves and undoes atomically without duplicate objects and rejects stale undo", () => {
  const p = id(),
    f = id();
  db.prepare("INSERT INTO folders VALUES(?,?,?,?,?,?)").run(
    p,
    "alice",
    null,
    "project",
    "Research Radar",
    now(),
  );
  db.prepare("INSERT INTO folders VALUES(?,?,?,?,?,?)").run(
    f,
    "alice",
    p,
    "folder",
    "Reading",
    now(),
  );
  const a = saveArtifact("alice", {
    title: "Plan",
    content: "The plan",
    role: "answer",
  });
  expect(
    naturalDestination("alice", "Put this file in Research Radar / Reading"),
  ).toBe(f);
  const move = moveArtifact("alice", a, f);
  expect(
    db.prepare("SELECT folder_id FROM artifacts WHERE id=?").get(a),
  ).toEqual({ folder_id: f });
  undoMove("alice", move.operation);
  expect(
    db.prepare("SELECT folder_id FROM artifacts WHERE id=?").get(a),
  ).toEqual({ folder_id: null });
  expect(() => undoMove("alice", move.operation)).toThrow();
  expect(() => moveArtifact("bob", a, null)).toThrow();
  const first = moveArtifact("alice", a, f);
  moveArtifact("alice", a, p);
  expect(() => undoMove("alice", first.operation)).toThrow(/changed/);
});
// Allow fixture insertion on busy developer machines; the measured retrieval
// still has its own two-second performance assertion below.
it("performs tenant-scoped FTS retrieval across 10,000 messages", () => {
  const c = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(c, "scale-user", null, "Scale fixture", "fixture", null, now());
  const insert = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const begin = performance.now();
  db.transaction(() => {
    for (let i = 0; i < 10000; i++)
      insert.run(
        id(),
        "scale-user",
        c,
        null,
        i % 2 ? "assistant" : "user",
        `Fixture record ${i}: ${i === 7331 ? "quasar penguin latency anomaly" : "routine job completed"}`,
        "{}",
        now(),
      );
  })();
  const start = performance.now();
  const matches = lexical("scale-user", "quasar penguin");
  const elapsed = performance.now() - start;
  expect(matches.some((d) => d.content.includes("7331"))).toBe(true);
  expect(lexical("alice", "quasar penguin")).toHaveLength(0);
  expect(elapsed).toBeLessThan(2000);
  console.log(
    JSON.stringify({
      fixtureMessages: 10000,
      insertMs: Math.round(start - begin),
      lexicalSearchMs: Math.round(elapsed),
      paraphraseLive: "BLOCKED: no embedding credential",
    }),
  );
}, 20000);
it("labels abandoned runs interrupted rather than replaying an external request", () => {
  const run = enqueue("alice", "stale", "stale-test-key", {
    kind: "diagnostic",
  });
  const c = claim("dead-worker")!;
  db.prepare("UPDATE runs SET heartbeat=? WHERE id=?").run(
    now() - 120000,
    c.id,
  );
  recoverStale();
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "interrupted",
  });
  expect(claim("replacement")).toBeUndefined();
});

it("applies project and type filters before the lexical candidate cap", () => {
  const folder = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,'filter-user','Scoped','project',?)",
  ).run(folder, now());
  for (let i = 0; i < 350; i++)
    saveArtifact("filter-user", {
      title: "routine searchable task",
      content: "routine searchable task",
      role: "answer",
    });
  const target = saveArtifact("filter-user", {
    title: "routine searchable task",
    content: "routine searchable task",
    kind: "diagram",
    folder,
    role: "answer",
  });
  const result = lexical("filter-user", "routine", {
    folder,
    kind: "diagram",
  });
  expect(result.map((r) => r.id)).toEqual(["artifact:" + target]);
  expect(
    lexical("other-user", "routine", { folder, kind: "diagram" }),
  ).toHaveLength(0);
});

it("skips null conversations before detecting an export provider", () => {
  for (const provider of ["chatgpt", "claude"]) {
    const conversations = JSON.parse(
      readFileSync(`test/fixtures/${provider}-export.json`, "utf8"),
    );
    const result = parseConversations([null, ...conversations]);
    expect(result.conversations.length).toBeGreaterThan(0);
    expect(result.warnings).toContain("Skipped a non-object conversation");
  }
  expect(() => parseConversations([null])).toThrow(
    "Unrecognized export format",
  );
});

it("rolls back preview storage when its import notification cannot commit", async () => {
  db.exec(
    "CREATE TEMP TRIGGER refuse_import_signal BEFORE INSERT ON events WHEN NEW.owner_id='rollback-import' AND NEW.subject_id='imports' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END",
  );
  try {
    await expect(
      stageImport(
        "rollback-import",
        readFileSync("test/fixtures/chatgpt-export.zip"),
        "export.zip",
      ),
    ).rejects.toThrow("fixture event failure");
    expect(
      db
        .prepare("SELECT id FROM imports WHERE owner_id=?")
        .all("rollback-import"),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT id FROM objects WHERE owner_id=?")
        .all("rollback-import"),
    ).toEqual([]);
    expect(importSignals("rollback-import")).toHaveLength(0);
  } finally {
    db.exec("DROP TRIGGER refuse_import_signal");
  }
});
it("notifies import history when the production worker fails reading an export", async () => {
  const owner = "failed-import",
    job = await stageImport(
      owner,
      readFileSync("test/fixtures/chatgpt-export.zip"),
      "export.zip",
    );
  db.prepare("UPDATE objects SET bytes=? WHERE owner_id=?").run(
    Buffer.from("broken archive"),
    owner,
  );
  const run = enqueue(owner, "Import failure", id(), {
    kind: "import",
    payload: { importId: job.id },
  });
  const { tick } = await import("../src/server/worker");
  expect(await tick(executeImport)).toBe(true);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "failed",
  });
  expect(
    db.prepare("SELECT status FROM imports WHERE id=?").get(job.id),
  ).toEqual({ status: "failed" });
  expect(importSignals(owner)).toHaveLength(2);
});

it.each(["pausing", "cancelled"] as const)(
  "notifies history when import execution observes %s",
  async (state) => {
    const owner = "import-" + state,
      job = await stageImport(
        owner,
        readFileSync("test/fixtures/chatgpt-export.zip"),
        "export.zip",
      );
    enqueue(owner, "Import status", id(), {
      kind: "import",
      payload: { importId: job.id },
    });
    const run = claim("fixture-" + state)!;
    transition(run, state);
    expect(await executeImport(run)).toBe(false);
    expect(
      db.prepare("SELECT status FROM imports WHERE id=?").get(job.id),
    ).toEqual({ status: state === "pausing" ? "paused" : "cancelled" });
    expect(importSignals(owner).length).toBeGreaterThanOrEqual(4);
  },
);

it("does not mark an import paused when cancellation wins the run transition", async () => {
  const owner = "import-pause-race";
  const job = await stageImport(
    owner,
    readFileSync("test/fixtures/chatgpt-export.zip"),
    "export.zip",
  );
  const queued = enqueue(owner, "Pause race", id(), {
    kind: "import",
    payload: { importId: job.id },
  });
  const run = claim("pause-race", (candidate) => candidate.id === queued.id)!;
  expect(transition(run, "pausing")).toBe(true);
  const queries = await import("../src/server/sql/runs");
  const state = queries.state;
  const spy = vi.spyOn(queries, "state").mockImplementation((db, target) => {
    const observed = state(db, target);
    if (target === run.id && observed?.state === "pausing") {
      expect(transition(run, "cancelled")).toBe(true);
    }
    return observed;
  });
  try {
    expect(await executeImport(run)).toBe(false);
    expect(
      db.prepare("SELECT status FROM imports WHERE id=?").get(job.id),
    ).toEqual({ status: "cancelled" });
    expect(state(db, run.id)).toEqual({ state: "cancelled" });
  } finally {
    spy.mockRestore();
  }
});
