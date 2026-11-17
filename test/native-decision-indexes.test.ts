import { testDirectory } from "./helpers/test-workspace.js";
import { fixtureAdapter, fixtureBinding } from "./fixtures/native-session.js";
import { afterAll, expect, it, vi } from "vitest";

testDirectory();
const { db, id } = await import("../src/server/db");
const cleanupQueries = await import("../src/server/sql/native-decisions");
const {
  finishPendingRunSql,
  finishPendingGenerationSql,
  finishPendingSql,
  finishDecidingSql,
} = cleanupQueries;
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
afterAll(() => {
  db.close();
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
  const live = sessions.state.attach({
    run,
    binding: fixtureBinding({
      conversation_id: conversation,
      generation: "fixture",
      harness: "codex",
    }),
    generation: "fixture",
    adapter: fixtureAdapter({ dispose }),
    finish: vi.fn(),
    bootstrapRun: run,
  });
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
  for (const [sql, params] of [
    [finishPendingRunSql, ["expired", target.run.id, "expired"]],
    [
      finishPendingGenerationSql,
      ["expired", target.run.conversation_id, "fixture", "expired"],
    ],
    [finishPendingSql, ["expired", "expired"]],
    [finishDecidingSql, ["unknown", "unknown"]],
  ] as const) {
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params) as {
      detail: string;
    }[];
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.map((row) => row.detail).join("\n")).not.toMatch(
      /SCAN native_decisions/,
    );
    for (const row of plan) {
      const index = /USING (?:COVERING )?INDEX (native_decisions_\w+)/.exec(
        row.detail,
      )?.[1];
      if (index) indexes.add(index);
    }
  }
  const cleanupCalls = [
    vi.spyOn(cleanupQueries, "finishPendingRun"),
    vi.spyOn(cleanupQueries, "finishPendingGeneration"),
    vi.spyOn(cleanupQueries, "finishPending"),
    vi.spyOn(cleanupQueries, "finishDeciding"),
  ];
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
    for (const call of cleanupCalls) expect(call).toHaveBeenCalled();
  } finally {
    for (const call of cleanupCalls) call.mockRestore();
  }
});
