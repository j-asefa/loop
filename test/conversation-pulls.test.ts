import { afterAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Run } from "../src/server/queue";

const dir = mkdtempSync(join(tmpdir(), "loop-conversation-pulls-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { core } = await import("../src/server/core-routes");
const { seal } = await import("../src/server/secrets");
const { errorHandler } = await import("../src/server/error-handler");
const { withGithubFixture } = await import("../src/server/github-api");
const { watchCreatedPullRequest, watchNativeCreatedPullRequest } = await import("../src/server/pr-watches");
const app = express();
app.use((req, res, next) => { res.locals.owner = req.get("x-owner"); next(); });
app.use(core);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
async function read(owner: string, thread: string, refresh = false) {
  const response = await fetch(`${origin}/conversations/${thread}/pulls${refresh ? "?refresh=1" : ""}`, { headers: { "x-owner": owner } });
  return { status: response.status, data: await response.json() };
}
function fixture() {
  const owner = id(), agent = id(), thread = id(), run = id();
  db.prepare("INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'A',?,'codex','m',0)").run(agent, owner, agent);
  db.prepare("INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'T',0)").run(thread, owner, agent);
  db.prepare("INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'task','completed',?,0,0)").run(run, owner, agent, thread, id());
  const message = (content: string, role = "assistant") => db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)").run(id(), owner, thread, run, role, content, Date.now());
  const connect = (secret: string = id()) => {
    db.prepare("DELETE FROM mcp_connections WHERE owner_id=?").run(owner);
    db.prepare("INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,created_at) VALUES(?,?,'GitHub','https://api.githubcopilot.com/mcp',?,'connected',0)").run(id(), owner, seal(JSON.stringify({ type: "bearer", token: secret }), owner));
  };
  return { owner, agent, thread, message, connect, run: db.prepare("SELECT * FROM runs WHERE id=?").get(run) as Run };
}
const ref = { owner: "acme", repo: "api", number: 42 };
const url = "https://github.com/acme/api/pull/42";
const firstHead = "a".repeat(40);
let head = firstHead, decision = "APPROVED", state = "OPEN", fail = false, reads = 0;
let failureStatus = 503, retryAfter = 0;
const tokens: string[] = [];
beforeEach(() => {
  head = firstHead; decision = "APPROVED"; state = "OPEN"; fail = false;
  failureStatus = 503; retryAfter = 0;
});
const restore = withGithubFixture(async (_url, init) => {
  reads++;
  tokens.push((init.headers as Record<string, string>).authorization);
  const request = JSON.parse(String(init.body));
  expect(request.query).toContain("query ConversationPull");
  expect(request.query).not.toContain("statusCheckRollup");
  return new Response(JSON.stringify(fail ? { message: "Unavailable" } : { data: { repository: { pullRequest: {
    number: request.variables.number, title: "Small PR",
    url: `https://github.com/${request.variables.owner}/${request.variables.name}/pull/${request.variables.number}`,
    state, isDraft: false, headRefOid: head,
    changedFiles: 3, additions: 212, deletions: 9, reviewDecision: decision,
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "lee" } }] },
    latestReviews: { nodes: [{ author: { login: "kim" }, state: "APPROVED", commit: { oid: firstHead } }], pageInfo: { hasNextPage: false } },
  } } } }), { status: fail ? failureStatus : 200, headers: retryAfter ? { "retry-after": String(retryAfter) } : undefined });
});
afterAll(async () => {
  restore();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("recovers old transcript links without a watch, deduplicates, and keeps owners isolated", async () => {
  const f = fixture();
  f.message(`Created [the PR](${url}).`);
  for (let i = 0; i < 55; i++) f.message(`Later answer ${i}`);
  f.message(url.replace("acme", "ACME"), "user");
  f.message("https://github.com/elsewhere/repo/pull/17", "tool");
  const result = await read(f.owner, f.thread);
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ connected: false, hasMore: false, pulls: [{ repo: "api", number: 42 }] });
  expect(result.data.pulls).toHaveLength(1);
  expect((await read("another-owner", f.thread)).status).toBe(404);
  expect(db.prepare("SELECT * FROM pr_watches WHERE owner_id=?").all(f.owner)).toEqual([]);
});

it("retains created PR links without GitHub credentials and refuses obsolete native generations", async () => {
  const f = fixture();
  watchCreatedPullRequest(f.run, ref);
  watchCreatedPullRequest(f.run, ref);
  expect(db.prepare("SELECT count(*) count FROM conversation_pull_links WHERE owner_id=?").get(f.owner)).toEqual({ count: 1 });
  expect(db.prepare("SELECT count(*) count FROM events WHERE owner_id=? AND type='invalidate' AND json_extract(payload,'$.scope.id')='pulls'").get(f.owner)).toEqual({ count: 1 });
  await watchNativeCreatedPullRequest(f.run, "gh pr create --fill", url.replace("42", "43"));
  await watchNativeCreatedPullRequest(f.run, "gh pr create --fill", url.replace("42", "44"), () => false);
  await watchNativeCreatedPullRequest(f.run, "echo gh pr create", url.replace("42", "45"));
  const result = await read(f.owner, f.thread);
  expect(result.data.pulls.map((p: any) => p.number).sort()).toEqual([42, 43]);
  expect(db.prepare("SELECT * FROM pr_watches WHERE owner_id=?").all(f.owner)).toEqual([]);
});

it("keeps merged PRs linked after the old seven-day watch expiry", async () => {
  const f = fixture();
  db.prepare("INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,ended_reason,created_at,updated_at) VALUES(?,?,?,?,'acme','api',42,'stopped','merged',0,0)").run(id(), f.owner, f.thread, f.agent);
  expect((await read(f.owner, f.thread)).data.pulls).toEqual([ref]);
});

it("keeps a newly created PR ahead of a long history of other references", async () => {
  const f = fixture();
  f.message(Array.from({ length: 21 }, (_, i) => url.replace("42", String(100 + i))).join("\n"));
  watchCreatedPullRequest(f.run, ref);
  const result = await read(f.owner, f.thread);
  expect(result.data.hasMore).toBe(true);
  expect(result.data.pulls).toHaveLength(20);
  expect(result.data.pulls[0]).toEqual(ref);
});

it("collects newer PR cards independently of older transcript references", async () => {
  const f = fixture();
  f.message(Array.from({ length: 21 }, (_, i) => url.replace("42", String(100 + i))).join("\n"));
  for (const number of [70, 71]) {
    const at = Date.now() + number;
    db.prepare("INSERT INTO artifacts(id,owner_id,conversation_id,run_id,agent_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,'Created PR','github_pr',?,?,?)")
      .run(id(), f.owner, f.thread, f.run.id, f.agent, url.replace("42", String(number)), at, at);
  }
  const result = await read(f.owner, f.thread);
  expect(result.data.hasMore).toBe(true);
  expect(result.data.pulls).toHaveLength(20);
  expect(result.data.pulls.slice(0, 2).map((pull: any) => pull.number)).toEqual([71, 70]);
});

it("reads PR totals and reviews from GitHub, refreshes new heads, and retains links after errors", async () => {
  const f = fixture();
  f.message(url);
  f.connect("first-credential");
  const initial = await read(f.owner, f.thread);
  expect(initial.data.pulls[0]).toMatchObject({ title: "Small PR", additions: 212, deletions: 9, changedFiles: 3,
    review: "approved", requested: ["@lee"], headSha: firstHead,
    reviews: [{ author: "kim", state: "approved", headSha: firstHead }] });
  const count = reads;
  await read(f.owner, f.thread);
  expect(reads).toBe(count);
  head = "b".repeat(40); decision = "CHANGES_REQUESTED";
  const updated = await read(f.owner, f.thread, true);
  expect(updated.data.pulls[0]).toMatchObject({ review: "changes_requested", headSha: head });
  state = "MERGED";
  expect((await read(f.owner, f.thread, true)).data.pulls[0].state).toBe("merged");
  fail = true;
  const failed = (await read(f.owner, f.thread, true)).data.pulls[0];
  expect(failed).toMatchObject({ ...ref, error: expect.any(String) });
  expect(failed).not.toHaveProperty("review");
  expect(failed).not.toHaveProperty("additions");
  expect((await read(f.owner, f.thread)).data.pulls[0]).not.toHaveProperty("review");
  fail = false;
  f.connect("replacement-credential");
  const before = reads;
  await read(f.owner, f.thread);
  expect(reads).toBe(before + 1);
  expect(tokens.at(-1)).toContain("replacement-credential");
  expect(JSON.stringify(updated)).not.toContain("credential");
});

it("does not share cached private PR details between owners", async () => {
  const one = fixture(), two = fixture();
  for (const f of [one, two]) { f.message(url); f.connect("same-credential"); }
  const before = reads;
  await read(one.owner, one.thread);
  await read(two.owner, two.thread);
  expect(reads).toBe(before + 2);
});

it("backs off failed automatic reads without restoring stale approvals", async () => {
  const f = fixture();
  f.message(url); f.connect();
  expect((await read(f.owner, f.thread)).data.pulls[0].review).toBe("approved");
  const time = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  try {
    fail = true; failureStatus = 404;
    await read(f.owner, f.thread, true);
    const before = reads;
    for (let i = 0; i < 3; i++) {
      const pull = (await read(f.owner, f.thread)).data.pulls[0];
      expect(pull.error).toBeTruthy();
      expect(pull).not.toHaveProperty("review");
    }
    expect(reads).toBe(before);
    clock.mockReturnValue(time + 60_001);
    fail = false;
    expect((await read(f.owner, f.thread)).data.pulls[0].review).toBe("approved");
    expect(reads).toBe(before + 1);
    fail = true;
    await read(f.owner, f.thread, true);
    fail = false;
    // Explicit retries can recover ordinary errors before the backoff expires.
    expect((await read(f.owner, f.thread, true)).data.pulls[0].review).toBe("approved");
    expect(reads).toBe(before + 3);
  } finally { clock.mockRestore(); }
});

it("honors GitHub retry deadlines across PRs, including manual refresh", async () => {
  const f = fixture();
  f.message(url); f.connect();
  const time = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  try {
    fail = true; failureStatus = 429; retryAfter = 120;
    expect((await read(f.owner, f.thread)).data.pulls[0].error).toContain("rate limit");
    const before = reads;
    f.message(url.replace("42", "43"));
    fail = false;
    clock.mockReturnValue(time + 119_999);
    for (const refresh of [false, true]) {
      const result = await read(f.owner, f.thread, refresh);
      expect(result.data.pulls).toHaveLength(2);
      expect(result.data.pulls.every((pull: any) => pull.error?.includes("rate limit") && !pull.review)).toBe(true);
    }
    expect(reads).toBe(before);
    clock.mockReturnValue(time + 120_001);
    expect((await read(f.owner, f.thread)).data.pulls.every((pull: any) => pull.review === "approved")).toBe(true);
    expect(reads).toBe(before + 2);
  } finally { clock.mockRestore(); }
});
