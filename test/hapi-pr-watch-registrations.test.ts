import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "loop-pr-registration-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { provisionEnvironment } =
  await import("../src/server/hapi/environments");
const { billingPolicy } = await import("../src/server/hapi/contracts");
const { ensureSession, projectMessages } =
  await import("../src/server/hapi/adapter");
const { pollPrWatchRegistrations } =
  await import("../src/server/hapi/pr-watch-registrations");
const { submit } = await import("../src/server/agent-runtime");
const { createAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { withGithubFixture, pollWatches, watchCreatedPullRequest, stopWatch } =
  await import("../src/server/pr-watches");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const owner = id();
  const host = provisionEnvironment(owner, {
    name: "Fixture",
    url: "https://worker.invalid:3010",
    instanceId: "i-1234567890abcdef0",
    namespace: owner,
    credential: "a".repeat(48),
    certificateFingerprint: "AB:".repeat(31) + "AB",
  });
  const connection = id();
  db.prepare(
    `INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at)
    VALUES(?,?,'codex','Fixture','','connected','[{"id":"fixture"}]',?,?)`,
  ).run(
    connection,
    owner,
    JSON.stringify({
      backend: "hapi",
      environmentId: host,
      flavor: "codex",
      billing: billingPolicy,
    }),
    now(),
  );
  db.prepare(
    `INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at)
    VALUES(?,?,'GitHub','https://api.githubcopilot.com/mcp/',?,'connected','{}',?)`,
  ).run(
    id(),
    owner,
    seal(JSON.stringify({ type: "bearer", token: "fixture" }), owner),
    now(),
  );
  const agent = createAgent(owner, {
    name: "fixture-" + owner.slice(0, 16),
    connectionId: connection,
    model: "fixture",
  });
  const run = submit(owner, {
    agentId: agent.id,
    input: "Create a PR",
    idempotencyKey: id(),
  });
  const session = ensureSession(run),
    localId = id();
  db.prepare(
    `INSERT INTO native_dispatches(run_id,conversation_id,local_id,payload_hash,envelope,billing,environment_id,generation,state,created_at,updated_at)
    VALUES(?,?,?,'hash','fixture',?,?,1,'accepted',?,?)`,
  ).run(
    run.id,
    run.conversation_id,
    localId,
    JSON.stringify(billingPolicy),
    host,
    now(),
    now(),
  );
  const event = {
    id: id(),
    content: {
      role: "agent",
      content: {
        type: "codex",
        data: {
          type: "loop-command",
          localId,
          id: "bash",
          command: "gh pr create --fill",
          output: "https://github.com/acme/api/pull/42\n",
        },
      },
    },
  };
  const pending = () =>
    db
      .prepare("SELECT * FROM pr_watch_registrations WHERE run_id=?")
      .get(run.id) as any;
  const watch = () =>
    db
      .prepare("SELECT * FROM pr_watches WHERE conversation_id=?")
      .get(run.conversation_id) as any;
  const project = () =>
    projectMessages(session, [event], 1, { seq: 10, at: now() });
  return { owner, host, run, session, event, pending, watch, project };
}
const success = () =>
  new Response(
    JSON.stringify({
      state: "open",
      created_at: new Date(now()).toISOString(),
      head: { sha: "a".repeat(40) },
    }),
  );

it("persists verification before projection commits and retries via the worker after restart without replaying history", async () => {
  const f = fixture();
  let attempts = 0;
  const restore = withGithubFixture(async () => {
    attempts++;
    expect(f.pending()).toMatchObject({ run_id: f.run.id, number: 42 });
    expect(
      db
        .prepare(
          "SELECT cursor_seq FROM native_sessions WHERE conversation_id=?",
        )
        .get(f.run.conversation_id),
    ).toEqual({ cursor_seq: 10 });
    return new Response("{}", { status: 503 });
  });
  try {
    await f.project();
    await pollPrWatchRegistrations();
    expect(f.pending()).toMatchObject({ attempts: 1 });
    await f.project();
    await pollPrWatchRegistrations(); // Same revision must neither lose intent nor bypass backoff.
    await pollWatches(f.pending().next_attempt_at - 1);
    expect(attempts).toBe(1);
    expect(f.watch()).toBeUndefined();
  } finally {
    restore();
  }
  // A new process opens the existing database and invokes the production worker
  // entrypoint; it has no HAPI history page or in-memory registration callback.
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const { db } = await import('./src/server/db.ts');
    const { pollWatches, withGithubFixture } = await import('./src/server/pr-watches.ts');
    withGithubFixture(async url => {
      const path = new URL(url).pathname;
      const data = path.endsWith('/pulls/42') ? { state: 'open', created_at: new Date(${f.run.created_at}).toISOString(), head: { sha: 'a'.repeat(40) } }
        : path === '/user' ? { login: 'author' } : path.endsWith('/check-runs') ? { total_count: 0, check_runs: [] }
        : path.endsWith('/check-suites') ? { check_suites: [] } : [];
      return new Response(JSON.stringify(data));
    });
    const { pollPrWatchRegistrations } = await import('./src/server/hapi/pr-watch-registrations.ts');
    await pollPrWatchRegistrations(${f.pending().next_attempt_at});
    db.close();
  `,
    ],
    { cwd: process.cwd(), env: process.env, timeout: 20000, stdio: "pipe" },
  );
  expect(f.pending()).toBeUndefined();
  expect(f.watch()).toMatchObject({
    owner_id: f.owner,
    agent_id: f.run.agent_id,
    since_at: f.run.created_at,
    state: "watching",
  });
  expect(
    db
      .prepare("SELECT count(*) n FROM native_dispatches WHERE run_id=?")
      .get(f.run.id),
  ).toEqual({ n: 1 });
}, 30000);

it("honors GitHub Retry-After and prevents concurrent verification of one registration", async () => {
  const f = fixture();
  let attempts = 0,
    release!: () => void;
  const restore = withGithubFixture(async () => {
    attempts++;
    if (attempts === 1)
      return new Response("{}", {
        status: 429,
        headers: { "retry-after": "300" },
      });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return success();
  });
  try {
    const before = now();
    await f.project();
    await pollPrWatchRegistrations();
    const due = f.pending().next_attempt_at;
    expect(due).toBeGreaterThanOrEqual(before + 300_000);
    await pollPrWatchRegistrations(due - 1);
    expect(attempts).toBe(1);
    const first = pollPrWatchRegistrations(due);
    await expect.poll(() => attempts).toBe(2);
    await pollPrWatchRegistrations(due);
    expect(attempts).toBe(2);
    release();
    await first;
    expect(f.pending()).toBeUndefined();
    expect(f.watch()).toMatchObject({ state: "watching" });
  } finally {
    release?.();
    restore();
  }
});

it.each(["generation", "owner", "revoked", "inflight"])(
  "rejects a pending registration fenced by %s",
  async (fence) => {
    const f = fixture();
    let attempts = 0;
    const change = () => {
      if (fence === "owner")
        db.prepare(
          "UPDATE native_sessions SET owner_id='other' WHERE conversation_id=?",
        ).run(f.run.conversation_id);
      else if (fence === "revoked")
        db.prepare(
          "UPDATE execution_environments SET revoked_at=? WHERE host_id=?",
        ).run(now(), f.host);
      else
        db.prepare(
          "UPDATE native_sessions SET generation=generation+1 WHERE conversation_id=?",
        ).run(f.run.conversation_id);
    };
    const restore = withGithubFixture(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary network failure");
      if (fence === "inflight") change();
      return success();
    });
    try {
      await f.project();
    await pollPrWatchRegistrations();
      const due = f.pending().next_attempt_at;
      if (fence !== "inflight") change();
      await pollPrWatchRegistrations(due);
      expect(attempts).toBe(fence === "inflight" ? 2 : 1);
      expect(f.pending()).toBeUndefined();
      expect(f.watch()).toBeUndefined();
    } finally {
      restore();
    }
  },
);

it("keeps an explicit Stop watching when delayed verification succeeds", async () => {
  const f = fixture();
  let attempts = 0;
  const restore = withGithubFixture(async () =>
    ++attempts === 1 ? new Response("{}", { status: 503 }) : success(),
  );
  try {
    await f.project();
    await pollPrWatchRegistrations();
    const watch = watchCreatedPullRequest(f.run, {
      owner: "acme",
      repo: "api",
      number: 42,
    })!;
    stopWatch(f.owner, watch.id);
    await pollPrWatchRegistrations(f.pending().next_attempt_at);
    expect(f.pending()).toBeUndefined();
    expect(f.watch()).toMatchObject({ id: watch.id, state: "stopped" });
  } finally {
    restore();
  }
});


it("projects and checkpoints without starting GitHub verification", () => {
  const f = fixture();
  let calls = 0;
  const restore = withGithubFixture(async () => { calls++; return success(); });
  try {
    expect(f.project()).toBeUndefined();
    expect(calls).toBe(0);
    expect(f.pending()).toMatchObject({ attempts: 0 });
  } finally { restore(); db.prepare("DELETE FROM pr_watch_registrations WHERE run_id=?").run(f.run.id); }
});

it.each(["loop-command", "loop-turn", "loop-delivery-unknown", "loop-interrupted", "tool-call-result"])(
  "does not wedge projection on malformed %s identities", type => {
    const f = fixture();
    const data: any = f.event.content.content.data;
    Object.assign(data, { type, localId: {}, turnId: [], threadId: {}, loop: { turnId: {} } });
    if (type === "tool-call-result") data.output = {
      type: "exec_command_end", exit_code: 0, status: "completed", turn_id: {},
      command: "gh pr create --fill", output: "https://github.com/acme/api/pull/42",
    };
    (f.event as any).localId = {};
    expect(() => f.project()).not.toThrow();
    expect(f.pending()).toBeUndefined();
    expect(db.prepare("SELECT cursor_seq FROM native_sessions WHERE conversation_id=?").get(f.run.conversation_id)).toEqual({ cursor_seq: 10 });
  },
);

it("does not count disconnected credentials as attempts and expires abandoned registrations", async () => {
  const f = fixture();
  f.project();
  db.prepare("UPDATE mcp_connections SET status='disconnected' WHERE owner_id=?").run(f.owner);
  await pollPrWatchRegistrations();
  expect(f.pending()).toMatchObject({ attempts: 0 });
  await pollPrWatchRegistrations(f.run.created_at + 8 * 86400_000);
  expect(f.pending()).toBeUndefined();
});

it("drops a registration after its bounded verification attempts", async () => {
  const f = fixture();
  f.project();
  db.prepare("UPDATE pr_watch_registrations SET attempts=8 WHERE run_id=?").run(f.run.id);
  await pollPrWatchRegistrations();
  expect(f.pending()).toBeUndefined();
});

it("rejects a stored truncation marker even without an envelope flag", () => {
  const f = fixture();
  const data: any = f.event.content.content.data;
  data.output += "\n[hapi: truncated 400 chars]";
  f.project();
  expect(f.pending()).toBeUndefined();
});
