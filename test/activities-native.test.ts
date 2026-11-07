import type { Live } from "../src/server/native-sessions";
import { Codex } from "../src/adapters/codex";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeOutput } from "../src/server/native-output";
const dir = mkdtempSync(join(tmpdir(), "loop-activity-native-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { listActivities, ingestNativeActivity } =
  await import("../src/server/activities");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function live(conversation: string, run: any, generation: string): Live {
  return {
    run,
    binding: {
      conversation_id: conversation,
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
  } as Live;
}
const source = {
  transport: "native" as const,
  harness: "codex",
  origin: "codex:item",
};

it("ingests adapter activities under the live turn and generation only", () => {
  for (const c of ["c1", "c2"])
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','t',0)",
    ).run(c);
  enqueue("owner", "t", "k1", { conversation: "c1" });
  const run = claim("w")!;
  const current = live("c1", run, "gen-2");
  const emit = (update: any) => ingestNativeActivity(current, update);
  emit({
    v: 1,
    kind: "plan",
    id: "p",
    source,
    generation: "gen-2",
    patch: { steps: [{ id: "a", title: "Do", status: "in_progress" }] },
  });
  // A late event from the previous process generation is quarantined.
  emit({
    v: 1,
    kind: "plan",
    id: "p",
    source,
    generation: "gen-1",
    patch: { steps: [] },
  });
  // Malformed and oversized display data is dropped without interrupting the run.
  emit({ v: 1, kind: "plan", id: "p", source, patch: { steps: "nope" } });
  emit({
    v: 1,
    kind: "file_change",
    id: "big",
    source,
    patch: {
      files: [
        { path: "x", operation: "modify", patch: "x".repeat(2 * 1024 * 1024) },
      ],
    },
  });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "running",
  });
  const items = listActivities("owner", "c1").items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "plan", run: run.id });
  expect(items[0].record.data.steps).toHaveLength(1);
  // Other conversations see nothing.
  expect(listActivities("owner", "c2").items).toEqual([]);
});

it("keys replayed history outside a turn so reloads de-duplicate", () => {
  const idle = live("c2", undefined, "gen-a");
  const replay = (generation: string) =>
    ingestNativeActivity({ ...idle, generation } as Live, {
      v: 1,
      kind: "tool",
      id: "native-7",
      source,
      generation,
      replay: true,
      patch: { title: "Edit", status: "completed" },
    });
  replay("gen-a");
  replay("gen-b");
  const items = listActivities("owner", "c2").items;
  expect(items).toHaveLength(1);
  expect(items[0].key).toBe("tool:native:codex:item:history:native-7");
  expect(items[0].record).toMatchObject({
    replayed: true,
    data: { status: "completed" },
  });
  expect(
    db
      .prepare(
        "SELECT run_id,subject_kind,subject_id FROM events WHERE type='activity.updated' AND subject_id='c2'",
      )
      .all(),
  ).toEqual([{ run_id: null, subject_kind: "conversation", subject_id: "c2" }]);
});
