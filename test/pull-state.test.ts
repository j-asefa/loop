import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";
import { seedAgent, seedConversation } from "./helpers/seed.js";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { pullStatus } = await import("../src/server/pr-watches");

afterAll(() => {
  db.close();
});

it("picks the thread's active watch first, then a recently ended one, and nothing older", () => {
  const owner = "owner";
  seedAgent(db, {
    id: "a",
    owner_id: owner,
    name: "A",
    normalized_name: "a",
    provider: "codex",
    model: "m",
    created_at: 0,
  });
  seedConversation(db, {
    id: "t1",
    owner_id: owner,
    agent_id: "a",
    title: "T",
    created_at: 0,
  });
  seedConversation(db, {
    id: "t2",
    owner_id: owner,
    agent_id: "a",
    title: "T",
    created_at: 0,
  });
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
