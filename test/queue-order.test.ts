import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop55-queue-order-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { listRuns } = await import("../src/server/run-attention");
const { reorderRun } = await import("../src/server/mobile-return");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(metadata: object = {}) {
  const owner = id(),
    connectionId = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Queue','','connected',?,?,?)",
  ).run(
    connectionId,
    owner,
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify(metadata),
    now(),
  );
  const agent = createAgent(owner, {
    name: "order-" + randomBytes(6).toString("hex"),
    connectionId,
    model: "fixture",
  });
  const conversation = () => {
    const cid = id();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Queue',?)",
    ).run(cid, owner, agent.id, now());
    return cid;
  };
  const make = (cid: string, createdAt?: number) => {
    const run = enqueue(owner, "task", id(), {
      agent: agent.id,
      conversation: cid,
      payload: { connectionId },
    });
    if (createdAt !== undefined)
      db.prepare("UPDATE runs SET created_at=? WHERE id=?").run(
        createdAt,
        run.id,
      );
    return run;
  };
  const drain = () => {
    const order: string[] = [];
    for (let run = claim("worker"); run; run = claim("worker")) {
      order.push(run.id);
      transition(run, "completed");
    }
    return order;
  };
  return { owner, conversation, make, drain };
}

it("keeps enqueue order by default, including equal timestamps", () => {
  const f = fixture(),
    cid = f.conversation();
  const runs = [
    f.make(cid, 10),
    f.make(cid, 10),
    f.make(cid, 5),
    f.make(cid, 20),
  ];
  const positions = Object.fromEntries(
    listRuns(f.owner).map((r: any) => [r.id, r.queue_position]),
  );
  expect(positions).toEqual({
    [runs[2].id]: 1,
    [runs[0].id]: 2,
    [runs[1].id]: 3,
    [runs[3].id]: 4,
  });
  expect(f.drain()).toEqual([runs[2].id, runs[0].id, runs[1].id, runs[3].id]);
});

it("claims a reordered run first and reports its new position", () => {
  const f = fixture();
  // Agent-wide queue across three threads.
  const [a, b, c] = [
    f.make(f.conversation(), 100),
    f.make(f.conversation(), 200),
    f.make(f.conversation(), 300),
  ];
  reorderRun(f.owner, c.id, { direction: "up" });
  const positions = () =>
    Object.fromEntries(
      listRuns(f.owner).map((r: any) => [r.id, r.queue_position]),
    );
  expect(positions()).toEqual({ [a.id]: 1, [c.id]: 2, [b.id]: 3 });
  reorderRun(f.owner, c.id, { direction: "up" });
  expect(positions()).toEqual({ [c.id]: 1, [a.id]: 2, [b.id]: 3 });
  expect(() => reorderRun(f.owner, c.id, { direction: "up" })).toThrow(
    /no queued message/,
  );
  expect(() => reorderRun("someone-else", c.id, { direction: "down" })).toThrow(
    /not found/,
  );
  expect(f.drain()).toEqual([c.id, a.id, b.id]);
});

it("swaps runs with identical timestamps", () => {
  const f = fixture();
  const [a, b, c] = [
    f.make(f.conversation(), 50),
    f.make(f.conversation(), 50),
    f.make(f.conversation(), 50),
  ];
  reorderRun(f.owner, b.id, { direction: "down" });
  expect(f.drain()).toEqual([a.id, c.id, b.id]);
});

it("keeps each thread's turns in the order they were sent", () => {
  // A thread's model history is built in send order, so a later turn never
  // overtakes an earlier one in the same conversation.
  const f = fixture(),
    one = f.conversation(),
    two = f.conversation();
  const a = f.make(one, 10),
    b = f.make(one, 20),
    c = f.make(two, 30);
  expect(() => reorderRun(f.owner, b.id, { direction: "up" })).toThrow(
    /order they were sent/,
  );
  // Crossing into another thread is still allowed.
  reorderRun(f.owner, c.id, { direction: "up" });
  expect(f.drain()).toEqual([a.id, c.id, b.id]);
});

it("does not reorder per-conversation harness queues", () => {
  const f = fixture({ loop55Harness: "codex" });
  const one = f.conversation(),
    two = f.conversation();
  const a = f.make(one, 10),
    b = f.make(two, 20),
    c = f.make(one, 30);
  // Each conversation is its own queue; its only peers share the thread.
  expect(() => reorderRun(f.owner, c.id, { direction: "up" })).toThrow(
    /order they were sent/,
  );
  expect(() => reorderRun(f.owner, b.id, { direction: "up" })).toThrow(
    /no queued message/,
  );
  const first = claim("worker")!;
  const second = claim("worker")!;
  expect([first.id, second.id].sort()).toEqual([a.id, b.id].sort());
  expect(claim("worker")).toBeUndefined();
  transition(first, "completed");
  transition(second, "completed");
  expect(claim("worker")?.id).toBe(c.id);
});

it.each(["run payload", "mail attempts"])(
  "rejects malformed %s without blocking another owner's healthy run",
  (corruption) => {
    const broken = fixture(),
      healthy = fixture();
    const damaged = broken.make(broken.conversation()),
      ready = healthy.make(healthy.conversation());
    const thread = id(),
      mail = id(),
      time = now();
    db.prepare(
      "INSERT INTO agent_threads(id,owner_id,scope,subject,created_by,created_at,updated_at) VALUES(?,?,'direct','Queue recovery',?,?,?)",
    ).run(thread, broken.owner, damaged.agent_id, time, time);
    db.prepare(
      "INSERT INTO agent_mail(id,owner_id,thread_id,kind,sender_agent_id,recipient_agent_id,body,idempotency_key,request,state,run_id,created_at) VALUES(?,?,?,'message',?,?,'Queued mail',?,'{}','pending',?,?)",
    ).run(
      mail,
      broken.owner,
      thread,
      damaged.agent_id,
      damaged.agent_id,
      mail,
      damaged.id,
      time,
    );
    const payload =
      corruption === "run payload"
        ? '{"maxTokens":0}'
        : JSON.stringify(damaged.payload);
    if (corruption === "run payload")
      db.prepare("UPDATE runs SET payload=? WHERE id=?").run(
        payload,
        damaged.id,
      );
    else
      db.prepare("UPDATE agent_mail SET attempts='bad' WHERE id=?").run(mail);
    const claimed = claim("mail-recovery", (run) => run.id === ready.id);
    expect(claimed?.id).toBe(ready.id);
    expect(claimed?.owner_id).toBe(healthy.owner);
    expect(
      db
        .prepare("SELECT state,payload,worker_id FROM runs WHERE id=?")
        .get(damaged.id),
    ).toEqual({ state: "failed", payload, worker_id: null });
    expect(
      claim("mail-recovery", (run) => run.id === damaged.id),
    ).toBeUndefined();
    transition(claimed!, "completed");
  },
);
