import type { Live } from "../src/server/native-sessions";
import type { Item } from "../src/shared/protocol";
import { Codex } from "../src/adapters/codex";
import Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeOutput, NATIVE_OUTPUT_BYTES } from "../src/server/native-output";
const dir = mkdtempSync(join(tmpdir(), "loop-projection-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("flushes dirty native items and completes after exceeding the display window", async () => {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('conversation','owner','test',0)",
  ).run();
  const queued = enqueue("owner", "test", "projection-test", {
    conversation: "conversation",
    payload: {
      agentId: "agent",
      name: "Fixture",
      provider: "codex",
      connectionId: "connection",
      model: "fixture",
      instructions: "",
      folderId: null,
    },
  });
  const run = claim("worker")!;
  expect(run.id).toBe(queued.id);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('message','owner','conversation','assistant','',0)",
  ).run();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,role,content,created_at,updated_at) VALUES('artifact','owner','test','markdown','answer','',0,0)",
  ).run();
  db.prepare(
    "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,'message','artifact','[]')",
  ).run(run.id);
  db.exec(
    "CREATE TEMP TABLE item_writes(id TEXT); CREATE TEMP TRIGGER audit_native_updates AFTER UPDATE ON native_items BEGIN INSERT INTO item_writes VALUES(new.native_id); END;",
  );
  const sessions = new NativeSessions();
  const live: Live = {
    run,
    binding: {
      worktree_source: null,
      worktree_agent_id: "fixture-agent",
      conversation_id: "conversation",
      harness: "codex",
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation: "test",
      state: "idle",
    },
    adapter: new Codex(
      {
        harness: "codex",
        executable: "",
        version: "fixture",
        project: dir,
        billing: "existing",
      },
      () => {},
    ),
    generation: "test",
    ready: Promise.resolve(),
    bootstrapRun: run,
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
  };
  // Register the session as NativeSessions.ensure does: events from a Live
  // that is not the conversation's current session are stale and dropped.
  (sessions as any).live.set("conversation", live);
  const event = (item: Item) =>
    sessions.projector.event(live, { type: "item", item });
  try {
    event({ id: "one", kind: "assistant", text: "first" });
    event({ id: "two", kind: "assistant", text: "second" });
    sessions.projector.projectOutput(live, true);
    db.exec(
      "CREATE TEMP TABLE aggregate_writes(id TEXT); CREATE TEMP TRIGGER audit_message_updates AFTER UPDATE ON messages WHEN new.update_key IS NULL BEGIN INSERT INTO aggregate_writes VALUES(new.id); END;",
    );
    sessions.projector.projectOutput(live, true);
    expect(db.prepare("SELECT * FROM aggregate_writes").all()).toEqual([]);
    vi.useFakeTimers();
    event({ id: "two", kind: "assistant", text: "updated" });
    await vi.advanceTimersByTimeAsync(999);
    expect(db.prepare("SELECT * FROM aggregate_writes").all()).toEqual([]);
    const writer = new Database(join(dir, "loop.db"));
    const busyTimeout = db.pragma("busy_timeout", { simple: true });
    writer.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      await vi.advanceTimersByTimeAsync(1);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(busyTimeout);
      expect(live.items.dirty.has("two")).toBe(true);
      expect(live.flush).toBeDefined();
      expect(
        db
          .prepare(
            "SELECT content FROM messages WHERE update_key='native-message:two'",
          )
          .get(),
      ).toEqual({ content: "second" });
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "running" });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    // No new native event is needed after the lock clears; retained display
    // output is retried, without invoking the harness again.
    await vi.advanceTimersByTimeAsync(1000);
    expect(live.items.dirty.size).toBe(0);
    expect(db.prepare("SELECT * FROM aggregate_writes").all()).toHaveLength(0);
    expect(
      db
        .prepare(
          "SELECT content FROM messages WHERE update_key='native-message:two'",
        )
        .get(),
    ).toEqual({ content: "updated" });
    vi.useRealTimers();
    event({ id: "reclassified", kind: "assistant", text: "Interim display" });
    sessions.projector.projectOutput(live, true);
    const reclassified = db
      .prepare(
        "SELECT id FROM messages WHERE update_key='native-message:reclassified'",
      )
      .get() as { id: string };
    event({ id: "reclassified", kind: "tool", text: "Actually tool output" });
    sessions.projector.projectOutput(live, true);
    expect(
      db.prepare("SELECT id FROM messages WHERE id=?").get(reclassified.id),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT payload FROM events WHERE type='message.remove' AND json_extract(payload,'$.messageId')=?",
        )
        .get(reclassified.id),
    ).toBeDefined();
    event({ id: "one", kind: "assistant", text: "first" });
    sessions.projector.projectOutput(live, false);
    expect(db.prepare("SELECT * FROM item_writes").all()).toEqual([
      { id: "two" },
      { id: "reclassified" },
    ]);
    expect(
      db.prepare("SELECT content FROM messages WHERE id='message'").get(),
    ).toEqual({ content: "updated" });
    expect(
      db
        .prepare(
          "SELECT content FROM messages WHERE update_key IS NOT NULL AND json_extract(metadata,'$.final') IS NOT 1 ORDER BY rowid",
        )
        .all(),
    ).toEqual([{ content: "first" }]);
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    // A real Codex command can repeat a large stdout value in its native
    // fields. Display projection must stay bounded without cancelling review.
    event({
      id: "large-command",
      kind: "tool",
      title: "commandExecution",
      text: JSON.stringify({
        stdout: "x".repeat(500000),
        aggregatedOutput: "x".repeat(500000),
      }),
    });
    expect(interrupt).not.toHaveBeenCalled();
    sessions.projector.projectOutput(live, true);
    const preview = db
      .prepare("SELECT content FROM run_traces WHERE trace_key='large-command'")
      .get() as { content: string };
    expect(preview.content).toContain("Earlier native output omitted");
    expect(
      Buffer.byteLength(JSON.stringify(preview.content)),
    ).toBeLessThanOrEqual(64000);
    expect(preview.content.endsWith('x"}')).toBe(true);
    event({
      id: "oversized-display-metadata",
      kind: "tool",
      title: "x".repeat(256000),
      text: "display only",
    });
    expect(interrupt).not.toHaveBeenCalled();
    sessions.projector.event(live, {
      type: "request",
      request: {
        id: "oversized-approval",
        kind: "approval",
        title: "Approve command",
        detail: "x".repeat(70000),
      },
    });
    expect(interrupt).toHaveBeenCalledWith(
      run.id,
      "Native decision exceeds safe display bounds.",
    );
    expect(live.requests.size).toBe(0);
    interrupt.mockClear();
    event({
      id: "stream",
      kind: "assistant",
      phase: "commentary",
      text: "Reviewing",
    });
    for (let i = 0; i < 80; i++)
      event({ id: "large-" + i, kind: "assistant", text: "é".repeat(32000) });
    expect(interrupt).not.toHaveBeenCalled();
    expect(live.items.bytes).toBeLessThanOrEqual(NATIVE_OUTPUT_BYTES);
    expect(live.items.get("stream")).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT content FROM messages WHERE update_key='native-message:stream'",
        )
        .get(),
    ).toEqual({ content: "Reviewing" });
    // A delta for an evicted item must recover its text and commentary phase.
    sessions.projector.event(live, {
      type: "delta",
      id: "stream",
      text: " continued",
    });
    expect(live.items.get("stream")).toMatchObject({
      text: "Reviewing continued",
      phase: "commentary",
    });
    event({
      id: "long-stream",
      kind: "assistant",
      phase: "commentary",
      text: "",
    });
    for (let i = 0; i < 10; i++)
      sessions.projector.event(live, {
        type: "delta",
        id: "long-stream",
        text: "😀".repeat(10000),
      });
    expect(
      Buffer.byteLength(JSON.stringify(live.items.get("long-stream")!.text)),
    ).toBeLessThanOrEqual(64000);
    expect(live.items.get("long-stream")!.text).toContain(
      "Earlier native output omitted",
    );
    sessions.projector.projectOutput(live, true);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM native_items WHERE native_id LIKE 'large-%'",
        )
        .get(),
    ).toEqual({ n: 81 });
    event({
      id: "review-result",
      kind: "assistant",
      phase: "final_answer",
      text: "Review complete.",
    });
    event({
      id: "discarded-reply",
      kind: "assistant",
      text: "An obsolete reply.",
    });
    event({ id: "blank-reply", kind: "assistant", text: "\n\t" });
    // The item-count bound must also rotate without cancelling. A final reply
    // already saved before eviction must survive later tool bookkeeping.
    for (let i = 0; i < 2005; i++)
      event({ id: "tool-" + i, kind: "tool", text: "done" });
    expect(live.items.get("review-result")).toBeUndefined();
    expect([...live.items.values()].length).toBeLessThanOrEqual(2000);
    event({
      id: "discarded-reply",
      kind: "assistant",
      phase: "commentary",
      text: "Progress only.",
    });
    const finish = vi.fn();
    live.finish = finish;
    sessions.projector.event(live, { type: "status", status: "completed" });
    expect(interrupt).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith("completed");
    expect(
      db.prepare("SELECT result,error FROM runs WHERE id=?").get(run.id),
    ).toEqual({ result: "Review complete.", error: null });
    expect(
      db.prepare("SELECT content FROM artifacts WHERE id='artifact'").get(),
    ).toEqual({ content: "Review complete." });
    expect(
      db
        .prepare(
          "SELECT content FROM messages WHERE update_key='native-message:stream'",
        )
        .get(),
    ).toEqual({ content: "Reviewing continued" });
    interrupt.mockRestore();
    // A resumed session replays more than a turn's budget before run is set.
    live.run = undefined;
    live.items.clear();
    const dispose = vi.spyOn(live.adapter, "dispose").mockResolvedValue();
    for (let i = 0; i < 100; i++)
      event({ id: "history-" + i, kind: "assistant", text: "é".repeat(32000) });
    event({
      id: "oversized-history",
      kind: "assistant",
      text: "x".repeat(300000),
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(live.closed).toBe(false);
    expect(live.items.bytes).toBeLessThanOrEqual(NATIVE_OUTPUT_BYTES);
    expect(live.items.get("history-0")).toBeUndefined();
    expect(live.items.get("history-99")).toBeDefined();
    live.items.clear();
    live.run = run;
    event({ id: "follow-up", kind: "assistant", text: "Still usable" });
    sessions.projector.projectOutput(live, false);
    expect(
      db.prepare("SELECT content FROM messages WHERE id='message'").get(),
    ).toEqual({ content: "Still usable" });
  } finally {
    clearTimeout(live.flush);
    vi.useRealTimers();
  }
}, 15000);

it("drops item events from a superseded session generation", () => {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('superseded','owner','test',0)",
  ).run();
  const queued = enqueue("owner", "test", "superseded-test", {
    conversation: "superseded",
    payload: {
      agentId: "agent",
      name: "Fixture",
      provider: "codex",
      connectionId: "connection",
      model: "fixture",
      instructions: "",
      folderId: null,
    },
  });
  const run = claim("worker")!;
  expect(run.id).toBe(queued.id);
  const sessions = new NativeSessions();
  const make = (generation: string): Live => ({
    run,
    binding: {
      worktree_source: null,
      worktree_agent_id: "fixture-agent",
      conversation_id: "superseded",
      harness: "codex",
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    },
    adapter: new Codex(
      {
        harness: "codex",
        executable: "",
        version: "fixture",
        project: dir,
        billing: "existing",
      },
      () => {},
    ),
    generation,
    ready: Promise.resolve(),
    bootstrapRun: run,
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
  });
  const old = make("old");
  const current = make("current");
  (sessions as any).live.set("superseded", current);
  try {
    sessions.projector.event(old, {
      type: "item",
      item: { id: "late", kind: "assistant", text: "from the old process" },
    });
    sessions.projector.event(current, {
      type: "item",
      item: { id: "fresh", kind: "assistant", text: "current" },
    });
    expect(old.items.get("late")).toBeUndefined();
    expect(current.items.get("fresh")).toBeDefined();
  } finally {
    clearTimeout(old.flush);
    clearTimeout(current.flush);
  }
});

it("keeps an unavailable native session's binding readable", async () => {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('unavailable-conv','owner','un', 0)",
  ).run();
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,worktree_agent_id,state,updated_at) VALUES('unavailable-conv','codex','un', '/p','w','unavailable',0)",
  ).run();
  const { publicSession } =
    await import("../src/server/sql/companion-sessions");
  const row = publicSession(db, "unavailable-conv");
  expect(row?.state).toBe("unavailable");
  // The contractions-projection path the companion route uses must parse it.
  const { PublicNativeConversation } =
    await import("../src/shared/companion-contract-schemas");
  expect(
    PublicNativeConversation.safeParse({
      binding: {
        harness: "codex",
        project: "/p",
        model: null,
        state: "unavailable",
        updated_at: 0,
      },
      memoryIncluded: false,
      items: [],
      projection: true,
      note: "",
    }).success,
  ).toBe(true);
});
