import { it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createRequire } from "node:module";
const dir = mkdtempSync(join(tmpdir(), "loop-recovery-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { tick, execute } = await import("../src/server/worker");
function account(owner: string) {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    c,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return c;
}
let finish: () => void = () => {},
  started: () => void = () => {},
  mode = "pause";
const reset = withTestAdapter("openai", {
  async models() {
    return [];
  },
  async *stream(_key, input) {
    yield { text: "Saved partial. " };
    started();
    if (mode === "cancel") {
      await new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("Fixture abort")),
          { once: true },
        );
      });
    } else await new Promise<void>((r) => (finish = r));
    yield { text: "Finished response." };
  },
});
afterAll(() => {
  reset();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("honors pause at response boundary and cancellation while retaining partial output", async () => {
  const a = createAgent("alice", {
    name: "recovery-agent",
    connectionId: account("alice"),
    model: "fixture",
  });
  const r = submit("alice", {
    agentId: a.id,
    input: "Pause me",
    idempotencyKey: "pause-boundary",
  });
  const began = new Promise<void>((r) => (started = r));
  const running = tick(execute);
  await began;
  transition(r, "pausing");
  finish();
  await running;
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(r.id)).toEqual({
    state: "paused",
  });
  expect(db.prepare("SELECT result FROM runs WHERE id=?").get(r.id)).toEqual({
    result: "Saved partial. Finished response.",
  });
  transition(r, "completed");
  mode = "cancel";
  const cancelled = submit("alice", {
    agentId: a.id,
    input: "Cancel me",
    idempotencyKey: "cancel-boundary",
  });
  const began2 = new Promise<void>((r) => (started = r)),
    working = tick(execute);
  await began2;
  transition(cancelled, "cancelled");
  await working;
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(cancelled.id),
  ).toEqual({ state: "cancelled" });
  const artifact = db
    .prepare("SELECT content,metadata FROM artifacts WHERE run_id=?")
    .get(cancelled.id) as any;
  expect(artifact.content).toBe("Saved partial. ");
  // The artifact's own metadata declares no partial (D4); the linked message
  // keeps the flag, so the cancellation preserved the streamed output as a
  // partial message.
  expect(JSON.parse(artifact.metadata).partial).toBeUndefined();
  expect(
    (
      db
        .prepare(
          "SELECT json_extract(metadata,'$.partial') p FROM messages WHERE id=?",
        )
        .get(
          (
            db
              .prepare(
                "SELECT message_id FROM agent_checkpoints WHERE run_id=?",
              )
              .get(cancelled.id) as { message_id: string }
          ).message_id,
        ) as { p: number }
    ).p,
  ).toBe(1);
});
it("allows only one concurrent cross-user claim of a normalized name", async () => {
  const accounts = [account("race-a"), account("race-b")];
  const children = accounts.map((c, i) => {
    const code = `const {createAgent}=await import('./src/server/domain.ts');process.send('ready');process.on('message',()=>{try{const a=createAgent('race-${i === 0 ? "a" : "b"}',{name:'RACE-SAME-NAME',connectionId:'${c}',model:'fixture'});process.send({ok:true,id:a.id})}catch(e){process.send({ok:false})}process.exit()})`;
    return spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
  });
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((resolve, reject) => {
          c.once("message", () => resolve());
          c.once("error", reject);
        }),
    ),
  );
  const results = await Promise.all(
    children.map(
      (c) =>
        new Promise<any>((resolve, reject) => {
          c.once("message", resolve);
          c.once("error", reject);
          c.send("start");
        }),
    ),
  );
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(
    db
      .prepare("SELECT count(*) n FROM handles WHERE name='race-same-name'")
      .get(),
  ).toEqual({ n: 1 });
});

it("keeps approval transitions durable during independent API database writes", async () => {
  const shared = new SharedArrayBuffer(8),
    flags = new Int32Array(shared);
  const writer = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.module);
    const db=new Database(workerData.path);
    db.pragma('busy_timeout=5000');
    const flags=new Int32Array(workerData.shared);
    const write=db.prepare("INSERT INTO request_limits VALUES('concurrent-api',1,1) ON CONFLICT(owner_id) DO UPDATE SET count=count+1");
    write.run();
    parentPort.postMessage('ready');
    while(!Atomics.load(flags,0)) {
      write.run();
      Atomics.add(flags,1,1);
      Atomics.notify(flags,1);
      Atomics.wait(flags,0,0,1);
    }
    db.close();
  `,
    {
      eval: true,
      workerData: {
        module: createRequire(import.meta.url).resolve("better-sqlite3"),
        path: join(dir, "loop.db"),
        shared,
      },
    },
  );
  const exited = once(writer, "exit");
  try {
    await once(writer, "message");
    for (let i = 0; i < 500; i++) {
      const run = enqueue(
        "contention-owner",
        "Review tool request",
        "contention-" + i,
        { kind: "diagnostic" },
      );
      expect(claim("contention-worker")?.id).toBe(run.id);
      expect(transition(run, "awaiting_approval")).toBe(true);
      expect(transition(run, "queued")).toBe(true);
      expect(claim("contention-worker")?.id).toBe(run.id);
      expect(transition(run, "completed")).toBe(true);
      // Let the independent writer acquire the database between batches.
      // A tight synchronous loop can otherwise finish before its busy-handler
      // backoff expires, testing scheduler luck instead of WAL contention.
      if (i % 100 === 99) {
        const writes = Atomics.load(flags, 1);
        expect(Atomics.wait(flags, 1, writes, 1000)).not.toBe("timed-out");
      }
    }
    expect(Atomics.load(flags, 1)).toBeGreaterThan(1);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM runs WHERE owner_id='contention-owner' AND state='completed'",
        )
        .get(),
    ).toEqual({ n: 500 });
  } finally {
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
    await exited;
  }
}, 15000);

it("initializes a fresh database safely from simultaneous API and worker processes", async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cold = mkdtempSync(join(dir, "cold-start-"));
    const children = Array.from({ length: 2 }, () =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `process.send('ready');process.once('message',async()=>{const {db}=await import('./src/server/db.ts');const row=db.prepare('SELECT max(version) version FROM schema_version').get();process.stdout.write(JSON.stringify(row));db.close();process.disconnect();})`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, LOOP_DATA_DIR: cold },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      ),
    );
    const finished = children.map(
      (child) =>
        new Promise<{ code: number | null; out: string; error: string }>(
          (resolve, reject) => {
            let out = "",
              error = "";
            child.stdout!.on("data", (b) => (out += b));
            child.stderr!.on("data", (b) => (error += b));
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, out, error }));
          },
        ),
    );
    try {
      await Promise.all(children.map((child) => once(child, "message")));
      children.forEach((child) => child.send("start"));
      for (const result of await Promise.all(finished)) {
        expect(result.code, result.error).toBe(0);
        expect(JSON.parse(result.out)).toEqual(
          db.prepare("SELECT max(version) version FROM schema_version").get(),
        );
      }
    } finally {
      children.forEach((child) => child.kill());
    }
  }
}, 15000);

it("pauses a run from its current lease, not the request's earlier read", async () => {
  const { controlRun } = await import("../src/server/run-attention");
  const a = createAgent("alice", {
    name: "pause-lease-agent",
    connectionId: account("alice"),
    model: "fixture",
  });
  const r = submit("alice", {
    agentId: a.id,
    input: "Wait for children",
    idempotencyKey: "pause-lease",
  });
  // The run waits for its children with no worker; the request reads that.
  db.prepare(
    "UPDATE runs SET state='running',worker_id=NULL,heartbeat=NULL WHERE id=?",
  ).run(r.id);
  // Before the pause commits, a worker claims the run again.
  db.prepare("UPDATE runs SET worker_id='w2',heartbeat=? WHERE id=?").run(
    now(),
    r.id,
  );
  controlRun("alice", r.id, "pause");
  // The worker still holds it: it stops at its next boundary, so the run
  // cannot be resumed (and claimed again) while that worker still runs it.
  expect(
    db.prepare("SELECT state,worker_id FROM runs WHERE id=?").get(r.id),
  ).toEqual({ state: "pausing", worker_id: "w2" });
  expect(() => controlRun("alice", r.id, "resume")).toThrow(
    "Only a paused run can be resumed",
  );
  // With no worker, the pause applies at once.
  db.prepare("UPDATE runs SET state='running',worker_id=NULL WHERE id=?").run(
    r.id,
  );
  controlRun("alice", r.id, "pause");
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(r.id)).toEqual({
    state: "paused",
  });
  transition(r, "cancelled");
});

it("completes only under the worker's lease and keeps a pause that arrived after the last boundary", async () => {
  const { completeLeased } = await import("../src/server/queue");
  const { controlRun } = await import("../src/server/run-attention");
  const a = createAgent("alice", {
    name: "complete-lease-agent",
    connectionId: account("alice"),
    model: "fixture",
  });
  const lease = (key: string, result: string | null) => {
    const r = submit("alice", {
      agentId: a.id,
      input: "Finish me",
      idempotencyKey: key,
    });
    db.prepare(
      "UPDATE runs SET state='running',worker_id='w1',heartbeat=?,result=? WHERE id=?",
    ).run(now(), result, r.id);
    return r;
  };
  const state = (r: { id: string }) =>
    (db.prepare("SELECT state FROM runs WHERE id=?").get(r.id) as any).state;
  // The runtime saw `running` at its last boundary; the pause lands before
  // the worker records completion.
  const saved = lease("complete-lease-saved", "The answer");
  transition(saved, "pausing");
  expect(completeLeased(saved, "w1")).toBe(true);
  expect(state(saved)).toBe("paused");
  controlRun("alice", saved.id, "resume");
  expect(state(saved)).toBe("completed");
  // Finished work without a saved answer completes rather than stalling
  // until stale-lease recovery reports it interrupted.
  const unsaved = lease("complete-lease-unsaved", null);
  transition(unsaved, "pausing");
  expect(completeLeased(unsaved, "w1")).toBe(true);
  expect(state(unsaved)).toBe("completed");
  // A worker whose lease was replaced cannot finish the run.
  const replaced = lease("complete-lease-replaced", "Late");
  db.prepare("UPDATE runs SET worker_id='w2' WHERE id=?").run(replaced.id);
  expect(completeLeased(replaced, "w1")).toBe(false);
  expect(state(replaced)).toBe("running");
  transition(replaced, "cancelled");
});

it("refuses to pause a native run a worker claimed after the request read it", async () => {
  const { controlRun } = await import("../src/server/run-attention");
  const a = createAgent("alice", {
    name: "native-pause-agent",
    connectionId: account("alice"),
    model: "fixture",
  });
  const r = submit("alice", {
    agentId: a.id,
    input: "Native turn",
    idempotencyKey: "native-pause-claimed",
  });
  // The request read the run as queued; a worker then claimed and dispatched
  // it to its harness before the pause transaction.
  db.prepare(
    "UPDATE runs SET state='running',worker_id='w1',heartbeat=? WHERE id=?",
  ).run(now(), r.id);
  db.prepare(
    "INSERT INTO native_dispatch VALUES(?,'generation','digest','accepted',NULL,?)",
  ).run(r.id, now());
  expect(() => controlRun("alice", r.id, "pause")).toThrow(
    "cannot suspend an active native turn",
  );
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(r.id)).toEqual({
    state: "running",
  });
  transition(r, "cancelled");
});
