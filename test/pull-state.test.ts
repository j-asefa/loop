import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-pull-state-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { pullStatus } = await import("../src/server/pr-watches");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("picks the thread's active watch first, then a recently ended one, and nothing older", () => {
  const owner = "owner";
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('a',?,'A','a','codex','m',0)",
  ).run(owner);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('t1',?,'a','T',0)",
  ).run(owner);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('t2',?,'a','T',0)",
  ).run(owner);
  const insert = db.prepare(
    "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,ended_reason,head_sha,ci_sha,ci_conclusion,created_at,updated_at,read_at) VALUES(?,?,?,'a','acme','web',?,?,?,?,?,?,?,?,?)",
  );
  const time = now();
  insert.run(
    id(),
    owner,
    "t1",
    1,
    "stopped",
    "merged",
    "aaa",
    "aaa",
    "success",
    time - 10,
    time - 10,
    time - 10,
  );
  insert.run(
    id(),
    owner,
    "t1",
    2,
    "watching",
    null,
    "bbb",
    "bbb",
    "failure",
    time - 5,
    time - 5,
    time - 5,
  );
  expect(pullStatus(owner, "t1")).toMatchObject({
    number: 2,
    watch: "watching",
    ci: { sha: "bbb", conclusion: "failure" },
    checked_at: time - 5,
  });
  insert.run(
    id(),
    owner,
    "t2",
    3,
    "stopped",
    "closed",
    "ccc",
    null,
    null,
    time - 10 * 24 * 3600_000,
    time - 10 * 24 * 3600_000,
    null,
  );
  expect(pullStatus(owner, "t2")).toBeNull();
  insert.run(
    id(),
    owner,
    "t2",
    4,
    "stopped",
    "merged",
    "ddd",
    "ddd",
    "success",
    time - 60_000,
    time - 60_000,
    time - 60_000,
  );
  expect(pullStatus(owner, "t2")).toMatchObject({
    number: 4,
    watch: "stopped",
    ended_reason: "merged",
  });
  expect(pullStatus("someone-else", "t1")).toBeNull();
});
