import type { Live } from "../src/server/native-sessions";
import type { Item } from "../src/protocol";
import { Codex } from "../src/adapters/codex";
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

it("flushes only dirty native items and interrupts before exceeding the aggregate budget", async () => {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('conversation','owner','test',0)",
  ).run();
  const queued = enqueue("owner", "test", "projection-test", {
    conversation: "conversation",
  });
  const run = claim("worker")!;
  expect(run.id).toBe(queued.id);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('message','owner','conversation','assistant','',0)",
  ).run();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,content,created_at,updated_at) VALUES('artifact','owner','test','markdown','',0,0)",
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
  const event = (item: Item) => sessions.event(live, { type: "item", item });
  try {
    event({ id: "one", kind: "assistant", text: "first" });
    event({ id: "two", kind: "assistant", text: "second" });
    sessions.projectOutput(live, true);
    db.exec(
      "CREATE TEMP TABLE aggregate_writes(id TEXT); CREATE TEMP TRIGGER audit_message_updates AFTER UPDATE ON messages BEGIN INSERT INTO aggregate_writes VALUES(new.id); END;",
    );
    sessions.projectOutput(live, true);
    expect(db.prepare("SELECT * FROM aggregate_writes").all()).toEqual([]);
    vi.useFakeTimers();
    event({ id: "two", kind: "assistant", text: "updated" });
    await vi.advanceTimersByTimeAsync(999);
    expect(db.prepare("SELECT * FROM aggregate_writes").all()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.prepare("SELECT * FROM aggregate_writes").all()).toHaveLength(0);
    expect(
      db
        .prepare(
          "SELECT content FROM run_traces WHERE trace_key='native-message:two'",
        )
        .get(),
    ).toEqual({ content: "updated" });
    vi.useRealTimers();
    event({ id: "one", kind: "assistant", text: "first" });
    sessions.projectOutput(live, false);
    expect(db.prepare("SELECT * FROM item_writes").all()).toEqual([
      { id: "two" },
    ]);
    expect(
      db.prepare("SELECT content FROM messages WHERE id='message'").get(),
    ).toEqual({ content: "updated" });
    expect(
      db
        .prepare(
          "SELECT content FROM run_traces WHERE kind='message' AND json_extract(metadata,'$.final') IS NOT 1 ORDER BY id",
        )
        .all(),
    ).toEqual([{ content: "first" }]);
    const interrupt = vi.spyOn(sessions, "interrupt").mockResolvedValue();
    for (let i = 0; i < 80; i++)
      event({ id: "large-" + i, kind: "assistant", text: "é".repeat(32000) });
    expect(interrupt).toHaveBeenCalledWith(
      run.id,
      "Native turn exceeded the display output limit.",
    );
    expect(live.items.bytes).toBeLessThanOrEqual(NATIVE_OUTPUT_BYTES);
    sessions.projectOutput(live, true);
    const stored = db
      .prepare("SELECT sum(length(CAST(item AS BLOB))) bytes FROM native_items")
      .get() as { bytes: number };
    expect(stored.bytes).toBeLessThanOrEqual(NATIVE_OUTPUT_BYTES);
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
    sessions.projectOutput(live, false);
    expect(
      db.prepare("SELECT content FROM messages WHERE id='message'").get(),
    ).toEqual({ content: "Still usable" });
  } finally {
    clearTimeout(live.flush);
    vi.useRealTimers();
  }
});
