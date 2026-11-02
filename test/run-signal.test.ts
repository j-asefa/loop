import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historicalEvent } from "../src/shared/workspace-events";

const directory = mkdtempSync(join(tmpdir(), "loop55-run-signal-"));
process.env.LOOP55_DATA_DIR = directory;
const { db, changes, id } = await import("../src/server/db");
const { enqueue, transition } = await import("../src/server/queue");
const { watchRun } = await import("../src/server/run-signal");
const runQueries = await import("../src/server/sql/runs");
const { writeConnectionStatus } =
  await import("../src/server/connection-status");
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterAll(() => {
  changes.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("shares one fallback read and subscription until the last consumer releases", async () => {
  const run = enqueue("owner", "Wait", id());
  const baseline = changes.subscriberCount;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const one = watchRun(run),
    two = watchRun(run);
  const first = vi.fn(),
    second = vi.fn();
  one.on("fallback", first);
  two.on("fallback", second);
  try {
    expect(one.signal).toBe(two.signal);
    expect(changes.subscriberCount).toBe(baseline + 1);
    expect(vi.getTimerCount()).toBe(1);
    expect(() => watchRun({ ...run, owner_id: "other" })).toThrow(/workspace/);
    await turn();
    const read = vi.spyOn(runQueries, "signalState");
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledExactlyOnceWith(db, run.id, run.owner_id);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    one.release();
    one.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    two.release();
    expect(changes.subscriberCount).toBe(baseline);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    one.release();
    two.release();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("publishes only committed, owner-scoped connection status without credentials or a borrowed run", async () => {
  for (const owner of ["alice", "bob"])
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,created_at) VALUES(?,?,'openai','Fixture','private credential','connected',1)",
    ).run(owner, owner);
  const run = enqueue("alice", "Wait", id(), {
    payload: { connectionId: "alice" },
  });
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  const watched = watchRun(run);
  try {
    expect(() =>
      db.transaction(() => {
        writeConnectionStatus("alice", () =>
          db
            .prepare(
              "UPDATE connections SET status='disconnected' WHERE id='alice'",
            )
            .run(),
        );
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    await turn();
    expect(watched.signal.aborted).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM events WHERE type='connection.status'").get(),
    ).toBeUndefined();
    writeConnectionStatus("bob", () =>
      db
        .prepare("UPDATE connections SET status='disconnected' WHERE id='bob'")
        .run(),
    );
    await turn();
    expect(watched.signal.aborted).toBe(false);
    writeConnectionStatus("alice", () =>
      db
        .prepare(
          "UPDATE connections SET status='disconnected' WHERE id='alice'",
        )
        .run(),
    );
    await turn();
    expect(watched.signal.aborted).toBe(true);
    expect(watched.signal.reason.message).toContain("provider connection");
    const row = db
      .prepare(
        "SELECT * FROM events WHERE owner_id='alice' AND type='connection.status'",
      )
      .get() as any;
    expect(row).toMatchObject({
      run_id: null,
      subject_kind: "connection",
      subject_id: "alice",
      payload: '{"status":"disconnected"}',
    });
    expect(historicalEvent(row)).toEqual({
      type: "connection.status",
      scope: { kind: "connection", id: "alice" },
      subject: { kind: "connection", id: "alice" },
      payload: { status: "disconnected" },
    });
    expect(JSON.stringify(row)).not.toContain("private credential");
  } finally {
    watched.release();
  }
});

it("rechecks a change that commits before a pending operation registers its wait", async () => {
  const run = enqueue("owner", "Wait", id());
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    run.id,
  );
  const watched = watchRun(run);
  try {
    await turn();
    const revision = watched.revision;
    transition(run, "running");
    await turn();
    await watched.wait(revision);
    expect(watched.state).toBe("running");
  } finally {
    watched.release();
  }
});
