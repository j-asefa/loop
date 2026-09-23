import { afterAll, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-workspace-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { parseConversations, stageImport, executeImport, readArchive } =
  await import("../src/server/imports");
const { enqueue, claim, transition, recoverStale } =
  await import("../src/server/queue");
const { saveArtifact } = await import("../src/server/artifacts");
const { moveArtifact, undoMove, naturalDestination } =
  await import("../src/server/filing");
const { lexical, cosine } = await import("../src/server/search");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("preserves representative ChatGPT branches and Claude attachments without inventing bytes", () => {
  const a = parseConversations(
    JSON.parse(readFileSync("tests/fixtures/chatgpt-export.json", "utf8")),
  );
  expect(a.conversations[0].messages).toHaveLength(3);
  expect(
    a.conversations[0].messages.find((m) => m.externalId === "m-alt")?.active,
  ).toBe(false);
  const b = parseConversations(
    JSON.parse(readFileSync("tests/fixtures/claude-export.json", "utf8")),
  );
  expect(b.provider).toBe("anthropic");
  expect(b.conversations[0].messages[0].content).toContain("notes.pdf");
  expect(() => parseConversations({ random: [] })).toThrow();
});
it("rejects archive traversal and imports retained attachments", async () => {
  await expect(
    readArchive(readFileSync("tests/fixtures/unsafe-path.zip"), "bad.zip"),
  ).rejects.toThrow();
  const p = await readArchive(
    readFileSync("tests/fixtures/chatgpt-export.zip"),
    "export.zip",
  );
  expect(p.attachments[0].name).toBe("attachments/note.txt");
});
it("deduplicates repeated uploads and safely restarts import work", async () => {
  const bytes = readFileSync("tests/fixtures/chatgpt-export.zip");
  const a = await stageImport("alice", bytes, "export.zip");
  expect((await stageImport("alice", bytes, "export.zip")).id).toBe(a.id);
  const run = enqueue("alice", "Import", "import-test-key", {
    kind: "import",
    payload: { importId: a.id },
  });
  const claimed = claim("importer")!;
  await executeImport(claimed);
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
    "Workflows",
    now(),
  );
  const a = saveArtifact("alice", { title: "Plan", content: "The plan" });
  expect(
    naturalDestination(
      "alice",
      "Put this workflow in Research Radar / Workflows",
    ),
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
it("performs tenant-scoped FTS retrieval across 10,000 messages", () => {
  const c = id();
  db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?,?)").run(
    c,
    "scale-user",
    null,
    "Scale fixture",
    "fixture",
    null,
    now(),
  );
  const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)");
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
});
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
    });
  const target = saveArtifact("filter-user", {
    title: "routine searchable task",
    content: "routine searchable task",
    kind: "workflow",
    folder,
  });
  const result = lexical("filter-user", "routine", {
    folder,
    kind: "workflow",
  });
  expect(result.map((r) => r.id)).toEqual(["artifact:" + target]);
  expect(
    lexical("other-user", "routine", { folder, kind: "workflow" }),
  ).toHaveLength(0);
});
