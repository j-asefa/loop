import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Live } from "../src/server/native-sessions";
import { NativeOutput } from "../src/server/native-output";

const dir = mkdtempSync(join(tmpdir(), "loop-decision-indexes-"));
process.env.LOOP_DATA_DIR = dir;
const { db, id } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Fixture',0)",
  ).run(conversation, OWNER);
  const queued = enqueue(OWNER, "Fixture", id(), { conversation });
  const run = claim("fixture-worker")!;
  expect(run.id).toBe(queued.id);
  const sessions = new NativeSessions();
  const dispose = vi.fn().mockResolvedValue(undefined);
  const live = {
    run,
    binding: {
      conversation_id: conversation,
      generation: "fixture",
      harness: "codex",
    },
    generation: "fixture",
    adapter: { dispose },
    requests: new Map(),
    items: new NativeOutput(),
    closed: false,
    waiting: false,
    finish: vi.fn(),
  } as unknown as Live;
  (sessions as unknown as { live: Map<string, Live> }).live.set(
    conversation,
    live,
  );
  return { run, live, sessions, dispose };
}
function decision(
  f: ReturnType<typeof fixture>,
  state: string,
  generation = "fixture",
  request = "{}",
) {
  const decisionId = id();
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,?,?,?,?,0)",
  ).run(
    decisionId,
    f.run.id,
    f.run.conversation_id,
    generation,
    decisionId,
    request,
    state,
  );
  return decisionId;
}
const state = (decisionId: string) =>
  (
    db
      .prepare("SELECT state FROM native_decisions WHERE id=?")
      .get(decisionId) as { state: string }
  ).state;

it("uses indexed cleanup at real turn, disposal and recovery boundaries without changing decision semantics", async () => {
  const target = fixture(),
    other = fixture();
  const largeRequest = JSON.stringify({ detail: "x".repeat(60_000) });
  const history = db.transaction(() =>
    Array.from({ length: 128 }, () =>
      decision(target, "resolved", "fixture", largeRequest),
    ),
  )();
  const pending = decision(target, "pending");
  const deciding = decision(target, "deciding");
  const otherPending = decision(other, "pending");
  const indexes = new Set<string>();
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (/^\s*UPDATE native_decisions SET state=\?/.test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = (...params: unknown[]) => {
        const plan = prepare("EXPLAIN QUERY PLAN " + sql).all(...params) as {
          detail: string;
        }[];
        expect(
          plan.some((row) => /SCAN native_decisions/.test(row.detail)),
        ).toBe(false);
        for (const row of plan) {
          const index = /USING (?:COVERING )?INDEX (native_decisions_\w+)/.exec(
            row.detail,
          )?.[1];
          if (index) indexes.add(index);
        }
        return run(...params);
      };
    }
    return statement;
  });
  try {
    target.sessions.projector.event(target.live, {
      type: "status",
      status: "completed",
    });
    expect(target.live.finish).toHaveBeenCalledWith("completed");
    expect(state(pending)).toBe("expired");
    expect(state(deciding)).toBe("deciding");
    expect(state(otherPending)).toBe("pending");
    const disposable = decision(target, "pending");
    const otherGeneration = decision(target, "pending", "next-generation");
    await target.sessions.dispose(target.live);
    expect(state(disposable)).toBe("expired");
    expect(state(otherGeneration)).toBe("pending");
    expect(state(otherPending)).toBe("pending");
    expect(target.dispose).toHaveBeenCalledTimes(1);
    target.sessions.recover();
    expect(state(otherGeneration)).toBe("expired");
    expect(state(otherPending)).toBe("expired");
    expect(state(deciding)).toBe("unknown");
    expect(
      history.every((decisionId) => state(decisionId) === "resolved"),
    ).toBe(true);
    expect(
      db
        .prepare("SELECT request FROM native_decisions WHERE id=?")
        .get(history[0]),
    ).toEqual({ request: largeRequest });
    expect(indexes).toEqual(
      new Set([
        "native_decisions_run_state",
        "native_decisions_state_generation",
      ]),
    );
  } finally {
    spy.mockRestore();
  }
});
