import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-turn-recovery-")));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue } = await import("../src/server/queue");
const { tick, execute } = await import("../src/server/worker");
const { nativeSessions } = await import("../src/server/native-sessions");
for (const harness of ["claude", "codex"]) {
  db.prepare("INSERT INTO harnesses VALUES(?,?,'{}','{}','[]',0)").run(
    harness,
    JSON.stringify({
      harness,
      executable: resolve("test/harness.mjs"),
      project: dir,
      billing: "existing",
      version: "fixture",
    }),
  );
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'local-workspace',?,?,'','connected','[]',?,0)",
  ).run(
    `native-${harness}`,
    harness === "claude" ? "anthropic" : "codex",
    harness,
    JSON.stringify({ loopHarness: harness }),
  );
}
afterEach(() => {
  delete process.env.LOOP_TEST_HARNESS;
  delete process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS;
  delete process.env.LOOP_TEST_CODEX_WRITER_BUSY;
  delete process.env.LOOP_TEST_AUDIT;
});
afterAll(async () => {
  await nativeSessions.close();
  db.close();
  delete process.env.LOOP_PROFILE;
  rmSync(dir, { recursive: true, force: true });
});
function submit(conversation: string, harness: string, key: string) {
  db.prepare(
    "INSERT OR IGNORE INTO conversations(id,owner_id,title,created_at) VALUES(?,'local-workspace','Recovery',0)",
  ).run(conversation);
  return enqueue("local-workspace", "Check the review", key, {
    conversation,
    payload: {
      connectionId: `native-${harness}`,
      model: "fixture",
      instructions: "",
    },
  });
}

it.each(["claude", "codex"])(
  "never resumes an archived %s conversation or replays its uncertain work",
  async (harness) => {
    const conversation = `${harness}-archived`;
    const audit = join(dir, `${harness}-prompts`);
    process.env.LOOP_TEST_HARNESS = harness;
    process.env.LOOP_TEST_AUDIT = audit;
    const first = submit(conversation, harness, `${harness}-first`);
    db.prepare(
      "INSERT INTO companion_sessions(conversation_id,harness,project,native_id,state,updated_at,generation) VALUES(?,?,?,'private-native-thread','unknown',0,'old')",
    ).run(conversation, harness, dir);
    const before = db
      .prepare("SELECT * FROM companion_sessions WHERE conversation_id=?")
      .get(conversation);
    for (const run of [
      first,
      submit(conversation, harness, `${harness}-explicit-retry`),
    ]) {
      expect(await tick(execute)).toBe(true);
      expect(
        db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
      ).toMatchObject({
        state: "failed",
        error: expect.stringContaining("requires HAPI"),
      });
      expect(
        db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
      ).toBeUndefined();
    }
    expect(
      db
        .prepare("SELECT * FROM companion_sessions WHERE conversation_id=?")
        .get(conversation),
    ).toEqual(before);
    expect(existsSync(audit)).toBe(false);
  },
);

it("upgrade disconnects only retired execution connections and preserves their history and identities", () => {
  for (const [key, metadata] of [
    ["old-sub", { authMode: "subscription" }],
    ["managed", { backend: "hapi", flavor: "codex" }],
    ["api", {}],
  ] as const)
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'other-owner','openai','Fixture','saved-secret','connected','[]',?,0)",
    ).run(key, JSON.stringify(metadata));
  db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('user-disconnected','other-owner','codex','Fixture','','disconnected','[]','{\"authMode\":\"subscription\"}',0)").run();
  const sessions = db
    .prepare("SELECT * FROM companion_sessions ORDER BY conversation_id")
    .all();
  const runs = db.prepare("SELECT * FROM runs ORDER BY id").all();
  db.transaction(() => {
    db.prepare("DELETE FROM schema_version WHERE version=67").run();
    db.exec(
      readFileSync(resolve("migrations/067-hapi-only-harnesses.sql"), "utf8"),
    );
  })();
  for (const key of ["old-sub", "native-codex", "native-claude"])
    expect(
      db.prepare("SELECT status FROM connections WHERE id=?").get(key),
    ).toEqual({ status: "disconnected" });
  expect(JSON.parse((db.prepare("SELECT metadata FROM connections WHERE id='old-sub'").get() as any).metadata).retiredDirectRuntime).toBe(true);
  expect(JSON.parse((db.prepare("SELECT metadata FROM connections WHERE id='user-disconnected'").get() as any).metadata).retiredDirectRuntime).toBeUndefined();
  for (const key of ["managed", "api"])
    expect(
      db.prepare("SELECT status,secret FROM connections WHERE id=?").get(key),
    ).toEqual({ status: "connected", secret: "saved-secret" });
  expect(
    db
      .prepare("SELECT * FROM companion_sessions ORDER BY conversation_id")
      .all(),
  ).toEqual(sessions);
  expect(db.prepare("SELECT * FROM runs ORDER BY id").all()).toEqual(runs);
});
