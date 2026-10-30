import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pullStateFromWatch, pullStateLine } from "../src/shared/pull-state";

const dir = mkdtempSync(join(tmpdir(), "loop55-pull-state-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { pullStatus } = await import("../src/server/pr-watches");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  repo_owner: "acme",
  repo_name: "web",
  number: 42,
  state: "watching" as const,
  ended_reason: null,
  error: null,
  head_sha: "abcdef1234567890",
  ci_sha: "abcdef1234567890",
  ci_conclusion: "success",
  ci_pending: 0,
  read_at: 1_000_000,
};
const at = 1_000_000 + 3 * 60_000;

it("describes checks for the head they concluded on, and never as current for an older head", () => {
  expect(pullStateLine(pullStateFromWatch(base), at)).toBe(
    "PR #42 · checks passed for abcdef1 · checked 3m ago",
  );
  expect(
    pullStateLine(
      pullStateFromWatch({ ...base, ci_conclusion: "failure" }),
      at,
    ),
  ).toBe("PR #42 · checks failed for abcdef1 · checked 3m ago");
  // A new push: the last conclusion belongs to the previous head.
  expect(
    pullStateLine(
      pullStateFromWatch({ ...base, head_sha: "fedcba0987654321" }),
      at,
    ),
  ).toBe(
    "PR #42 · checks pending for fedcba0 (last passed for abcdef1) · checked 3m ago",
  );
  expect(
    pullStateLine(
      pullStateFromWatch({ ...base, ci_sha: null, ci_conclusion: null }),
      at,
    ),
  ).toBe("PR #42 · checks pending for abcdef1 · checked 3m ago");
  expect(
    pullStateLine(
      pullStateFromWatch({
        ...base,
        head_sha: null,
        ci_sha: null,
        ci_conclusion: null,
        read_at: null,
      }),
      at,
    ),
  ).toBe("PR #42 · not read yet");
  // A rerun on the same head: the last conclusion is not current.
  expect(
    pullStateLine(pullStateFromWatch({ ...base, ci_pending: 1 }), at),
  ).toBe(
    "PR #42 · checks rerunning for abcdef1 (last passed) · checked 3m ago",
  );
  // A result seen but not yet delivered (paused watch) is what the card shows.
  expect(
    pullStateLine(
      pullStateFromWatch({
        ...base,
        state: "paused",
        error: "Paused",
        seen_ci_sha: base.head_sha,
        seen_ci_conclusion: "failure",
      }),
      at,
    ),
  ).toBe("PR #42 · checks failed for abcdef1 · watch paused · checked 3m ago");
  expect(
    pullStateLine(
      pullStateFromWatch({
        ...base,
        state: "paused",
        error: "Paused after 5 updates",
      }),
      at,
    ),
  ).toBe("PR #42 · checks passed for abcdef1 · watch paused · checked 3m ago");
  expect(
    pullStateLine(
      pullStateFromWatch({ ...base, error: "GitHub rejected the connection" }),
      at,
    ),
  ).toBe(
    "PR #42 · checks passed for abcdef1 · last read failed · checked 3m ago",
  );
  expect(
    pullStateLine(
      pullStateFromWatch({ ...base, state: "stopped", ended_reason: "merged" }),
      at,
    ),
  ).toBe("PR #42 · merged");
  expect(pullStateLine(null)).toBe("No PR linked");
  // An unexpected conclusion value is not a conclusion.
  expect(
    pullStateFromWatch({ ...base, ci_conclusion: "neutral" }).ci,
  ).toBeNull();
  // An older linked server sends no freshness fields: never current, never "checked NaN ago".
  const { ci_pending: _p, read_at: _r, ...older } = base;
  expect(pullStateLine(pullStateFromWatch(older), at)).toBe(
    "PR #42 · last passed for abcdef1, freshness unknown",
  );
  expect(
    pullStateLine(
      pullStateFromWatch({ ...older, ci_sha: null, ci_conclusion: null }),
      at,
    ),
  ).toBe("PR #42 · checks state unknown");
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
