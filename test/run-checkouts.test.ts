import { afterAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gitProject } from "./git-project.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "loop-checkout-")));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const project = join(dir, "repo");
mkdirSync(project);
gitProject(project);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { encoding: "utf8" },
  ).trim();

const { db, id, now } = await import("../src/server/db");
const { agentWorktree } = await import("../src/server/agent-worktree");
const {
  startCheckout,
  completeCheckout,
  reconcileCheckouts,
  checkoutDetail,
  checkoutSummary,
  checkoutContent,
  PATCH_LIMIT,
} = await import("../src/server/run-checkouts");
const { checkoutLine, unquoteGitPath } = await import("../src/shared/checkout");
const { resolveCite, checkQuote } = await import("../src/server/briefs/cites");
const { transition } = await import("../src/server/queue");
import type { Run } from "../src/server/queue";

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const owner = "owner";
const agent = "checkout-agent";
const folder = id();
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'Fixture','fixture','codex','fixture',0)",
).run(agent, owner);
db.prepare(
  "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Repo',0)",
).run(folder, owner);
const otherFolder = id();
db.prepare(
  "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Other',0)",
).run(otherFolder, owner);

function runFixture(conversation: string, state = "running", at = now()): Run {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Thread',?,0)",
  ).run(conversation, owner, agent, folder);
  const runId = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Change things',?,?,'{}',?,?)",
  ).run(runId, owner, agent, conversation, state, runId, at, at);
  return db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Run;
}
function bind(conversation: string, checkout: string) {
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,model,instructions,updated_at,generation,worktree_source,worktree_agent_id) VALUES(?,'codex',?,NULL,'',0,'g1',?,?)",
  ).run(conversation, checkout, project, agent);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const checkout = agentWorktree(project, project, {
  ownerId: owner,
  agentId: agent,
  environmentId: dir,
  projectId: project,
});

it("records the worktree before and after a run, as Loop observed it", async () => {
  const run = runFixture("thread-1");
  bind("thread-1", checkout);
  await startCheckout(run, checkout, project, "g1");
  const started = checkoutDetail(owner, run.id)!;
  expect(started.state).toBe("started");
  expect(started.start_head).toBe(git(project, "rev-parse", "HEAD"));
  expect(started.branch).toMatch(/^loop\/agent-/);
  expect(started.base_sha).toBe(git(project, "rev-parse", "HEAD"));
  expect(started.start_dirty).toBe(0);
  expect(started.generation).toBe("g1");
  expect(checkoutSummary(owner, run.id)).toMatchObject({ state: "started", files: 0, ahead: null });
  expect(checkoutLine(checkoutSummary(owner, run.id)!)).not.toContain("undefined");

  // The agent commits one change, leaves another uncommitted, and adds a file.
  writeFileSync(join(checkout, "tracked.txt"), "committed\nby the agent\n");
  git(checkout, "commit", "-am", "agent change");
  writeFileSync(join(checkout, "tracked.txt"), "committed\nby the agent\nand more\n");
  writeFileSync(join(checkout, "new.txt"), "untracked");

  await completeCheckout(run.id);
  const detail = checkoutDetail(owner, run.id)!;
  expect(detail.state).toBe("captured");
  expect(detail.end_head).toBe(git(checkout, "rev-parse", "HEAD"));
  expect(detail.end_head).not.toBe(detail.start_head);
  expect(detail).toMatchObject({ ahead: 1, behind: 0, captured_late: false });
  expect(detail.files).toEqual([
    { path: "tracked.txt", additions: 3, deletions: 1, binary: false },
  ]);
  expect(detail.committed).toMatchObject({ additions: 2, deletions: 1 });
  expect(detail.working).toMatchObject({ additions: 1, deletions: 0 });
  expect(detail.untracked).toEqual(["new.txt"]);
  expect(detail.patch).toContain("+and more");
  expect(detail.patch_truncated).toBe(false);
  expect(detail.remote).toBeNull();
  expect(detail.overlap).toEqual([]);
  expect(detail.summary).toMatchObject({
    state: "captured",
    files: 1,
    additions: 3,
    deletions: 1,
    untracked: 1,
    remote: "none",
    ahead: 1,
    late: false,
  });
  expect(checkoutLine(detail.summary!)).toBe(
    `${detail.branch} · 1 commit ahead · 1 file +3 −1 · 1 untracked · no remote seen`,
  );
  // The worktree itself was only read.
  expect(git(checkout, "status", "--porcelain")).toContain("new.txt");
  expect(git(project, "status", "--porcelain")).toBe("");
});

it("is a brief citation scoped to the run's project, with checked quotes", () => {
  const run = db
    .prepare("SELECT * FROM runs WHERE conversation_id='thread-1'")
    .get() as Run;
  const detail = checkoutDetail(owner, run.id)!;
  const ref = "chk_" + detail.id;
  const cite = resolveCite(owner, folder, { ref, quote: "tracked.txt +3 −1" });
  expect(cite).toMatchObject({
    kind: "checkout",
    runId: run.id,
    agent,
    conversation: "thread-1",
  });
  expect(cite!.content).toBe(checkoutContent(detail));
  expect(checkQuote(cite!.content, "tracked.txt +3 −1")).toBe(true);
  expect(checkQuote(cite!.content, "tests pass")).toBe(false);
  expect(resolveCite(owner, otherFolder, { ref })).toBeNull();
  expect(resolveCite("someone-else", folder, { ref })).toBeNull();
});

it("is not citable while its capture is still in progress", async () => {
  const run = runFixture("thread-citing");
  bind("thread-citing", checkout);
  await startCheckout(run, checkout, project, "g1");
  const started = checkoutDetail(owner, run.id)!;
  expect(resolveCite(owner, folder, { ref: "chk_" + started.id })).toBeNull();
  await completeCheckout(run.id);
  expect(resolveCite(owner, folder, { ref: "chk_" + started.id })).toMatchObject({ kind: "checkout" });
});

it("lets one capture at a time own a run, and reruns for a request that arrived meanwhile", async () => {
  const run = runFixture("thread-race");
  bind("thread-race", checkout);
  await startCheckout(run, checkout, project, "g1");
  const raw = () =>
    db.prepare("SELECT state,capture_token,capture_pending,ended_at FROM run_checkouts WHERE run_id=?").get(run.id) as {
      state: string; capture_token: string | null; capture_pending: number; ended_at: number | null;
    };
  const first = completeCheckout(run.id);
  // The second request finds the claim held and leaves a request behind.
  const second = completeCheckout(run.id);
  await second;
  expect(raw().capture_token).not.toBeNull();
  expect(raw().capture_pending).toBe(1);
  await first;
  expect(raw()).toMatchObject({ state: "captured", capture_token: null, capture_pending: 0 });
  // Reconciliation never touches a run whose capture is in flight.
  db.prepare("UPDATE run_checkouts SET state='started',capture_token='held',capture_started_at=? WHERE run_id=?").run(now(), run.id);
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
  await completeCheckout(run.id, { ifIdle: true });
  expect(raw()).toMatchObject({ state: "started", capture_token: "held", capture_pending: 0 });
  // An abandoned claim is taken over.
  db.prepare("UPDATE run_checkouts SET capture_started_at=? WHERE run_id=?").run(now() - 600000, run.id);
  await completeCheckout(run.id, { ifIdle: true });
  expect(raw()).toMatchObject({ state: "captured", capture_token: null });
});

it("records other runs active on the same checkout as overlap, not authorship", async () => {
  const first = db
    .prepare("SELECT * FROM runs WHERE conversation_id='thread-1'")
    .get() as Run;
  const started = checkoutDetail(owner, first.id)!.started_at;
  // One sibling ended after this run started; one began earlier and is still
  // running, so its updated_at predates the start. Both overlap.
  const ended = runFixture("thread-2", "completed", started + 1);
  bind("thread-2", checkout);
  const longRunning = runFixture("thread-2b", "running", started - 60000);
  bind("thread-2b", checkout);
  const finishedBefore = runFixture("thread-2c", "completed", started - 60000);
  bind("thread-2c", checkout);
  await completeCheckout(first.id);
  const overlap = checkoutDetail(owner, first.id)!.overlap;
  expect(overlap).toContain(ended.id);
  expect(overlap).toContain(longRunning.id);
  expect(overlap).not.toContain(finishedBefore.id);
  expect(checkoutSummary(owner, first.id)!.overlap).toBe(overlap.length);
});

it("keeps filenames that contain tabs and renames intact", async () => {
  const run = runFixture("thread-tabs");
  bind("thread-tabs", checkout);
  await startCheckout(run, checkout, project, "g1");
  git(checkout, "add", "new.txt");
  git(checkout, "commit", "-m", "track new.txt");
  writeFileSync(join(checkout, "notes\tdraft.txt"), "tabbed\n");
  git(checkout, "add", "notes\tdraft.txt");
  git(checkout, "mv", "new.txt", "renamed.txt");
  git(checkout, "commit", "-m", "tabs and renames");
  await completeCheckout(run.id);
  const paths = checkoutDetail(owner, run.id)!.files.map((f) => f.path);
  expect(paths).toContain("notes\tdraft.txt");
  expect(paths).toContain("renamed.txt");
  expect(paths).not.toContain("notes");
});

it("stores a bounded patch and says when it was shortened", async () => {
  const run = runFixture("thread-3");
  bind("thread-3", checkout);
  writeFileSync(join(checkout, "tracked.txt"), "dirty before\n");
  await startCheckout(run, checkout, project, "g1");
  expect(checkoutDetail(owner, run.id)!.start_dirty).toBe(1);
  writeFileSync(
    join(checkout, "big.txt"),
    Array.from({ length: 20000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"),
  );
  git(checkout, "add", "big.txt");
  git(checkout, "commit", "-m", "big");
  await completeCheckout(run.id);
  const detail = checkoutDetail(owner, run.id)!;
  expect(detail.patch_truncated).toBe(true);
  expect(Buffer.byteLength(detail.patch!, "utf8")).toBeLessThanOrEqual(PATCH_LIMIT);
  expect(detail.patch!.endsWith("\n")).toBe(true);
  expect(detail.patch_bytes).toBeGreaterThan(PATCH_LIMIT);
  expect(detail.files.map((f) => f.path)).toContain("big.txt");
  expect(detail.summary!.started_dirty).toBe(true);
});

it("captures at the terminal transition without blocking it", async () => {
  const run = runFixture("thread-4");
  bind("thread-4", checkout);
  await startCheckout(run, checkout, project, "g1");
  expect(checkoutDetail(owner, run.id)!.ended_at).toBeNull();
  expect(transition(run, "completed")).toBe(true);
  for (let i = 0; i < 100 && !checkoutDetail(owner, run.id)!.ended_at; i++) await wait(20);
  const detail = checkoutDetail(owner, run.id)!;
  expect(detail.state).toBe("captured");
  expect(detail.ended_at).not.toBeNull();
  expect(detail.captured_late).toBe(false);
});

it("captures late, and says so, for runs that ended while the host was down", async () => {
  const run = runFixture("thread-late");
  bind("thread-late", checkout);
  await startCheckout(run, checkout, project, "g1");
  // Recovery marks runs interrupted directly, without a transition.
  db.prepare("UPDATE runs SET state='interrupted',updated_at=? WHERE id=?").run(now() - 120000, run.id);
  expect(checkoutDetail(owner, run.id)!.state).toBe("started");
  await reconcileCheckouts();
  const detail = checkoutDetail(owner, run.id)!;
  expect(detail.state).toBe("captured");
  expect(detail.captured_late).toBe(true);
  expect(detail.summary!.late).toBe(true);
  expect(checkoutContent(detail)).toContain("Captured after a restart");
  await reconcileCheckouts();
  expect(checkoutDetail(owner, run.id)!.ended_at).toBe(detail.ended_at);
});

it("reports the branch the checkout is on when the run ends", async () => {
  const run = runFixture("thread-branch");
  bind("thread-branch", checkout);
  await startCheckout(run, checkout, project, "g1");
  const before = checkoutDetail(owner, run.id)!.branch;
  git(checkout, "switch", "-c", "feature/side");
  try {
    await completeCheckout(run.id);
    const detail = checkoutDetail(owner, run.id)!;
    expect(detail.branch).toBe("feature/side");
    expect(detail.summary!.branch).toBe("feature/side");
    expect(detail.end_head).toBe(git(checkout, "rev-parse", "HEAD"));
  } finally {
    git(checkout, "switch", before);
    git(checkout, "branch", "-D", "feature/side");
  }
});

it("keeps the first start record when a run resumes", async () => {
  const run = runFixture("thread-5");
  bind("thread-5", checkout);
  await startCheckout(run, checkout, project, "g1");
  const first = checkoutDetail(owner, run.id)!;
  await startCheckout(run, checkout, project, "g2");
  expect(checkoutDetail(owner, run.id)).toMatchObject({ id: first.id, generation: "g1" });
});

it("clears an earlier observation when a recapture fails", async () => {
  const run = runFixture("thread-recapture");
  bind("thread-recapture", checkout);
  await startCheckout(run, checkout, project, "g1");
  await completeCheckout(run.id);
  const captured = checkoutDetail(owner, run.id)!;
  expect(captured.state).toBe("captured");
  expect(captured.files.length).toBeGreaterThan(0);
  // The worktree disappears before the run ends again.
  db.prepare("UPDATE run_checkouts SET directory=? WHERE run_id=?").run(join(dir, "gone"), run.id);
  await completeCheckout(run.id);
  const failed = checkoutDetail(owner, run.id)!;
  expect(failed.state).toBe("failed");
  expect(failed.error).toMatch(/git/);
  expect(failed.files).toEqual([]);
  expect(failed.patch).toBeNull();
  expect(failed.end_head).toBeNull();
  expect(failed.ended_at).toBeGreaterThanOrEqual(captured.ended_at!);
  expect(failed.summary).toMatchObject({ state: "failed", files: 0 });
});

it("refuses to capture when the repository configures commands Git would run", async () => {
  const run = runFixture("thread-config");
  bind("thread-config", checkout);
  git(project, "config", "filter.evil.clean", "touch /tmp/should-not-run");
  try {
    await startCheckout(run, checkout, project, "g1");
    const detail = checkoutDetail(owner, run.id)!;
    expect(detail.state).toBe("failed");
    expect(detail.error).toContain("filter.evil.clean");
    expect(checkoutLine(detail.summary!)).toContain("checkout not captured");
  } finally {
    git(project, "config", "--unset", "filter.evil.clean");
  }
});

it("never runs a filter a worktree's .gitattributes selects, whatever the user's configuration", async () => {
  const run = runFixture("thread-attrs");
  bind("thread-attrs", checkout);
  const marker = join(dir, "filter-ran");
  const globalConfig = join(dir, "global.gitconfig");
  writeFileSync(globalConfig, `[filter "evil"]\n\tclean = sh -c "touch ${marker}; cat"\n`);
  writeFileSync(join(checkout, ".gitattributes"), "* filter=evil\n");
  writeFileSync(join(checkout, "tracked.txt"), "touched again\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    await startCheckout(run, checkout, project, "g1");
    await completeCheckout(run.id);
    const detail = checkoutDetail(owner, run.id)!;
    expect(detail.state).toBe("captured");
    expect(detail.files.map((f) => f.path)).toContain("tracked.txt");
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    rmSync(join(checkout, ".gitattributes"));
  }
});

it("refuses a repository whose info/attributes selects a driver", async () => {
  const info = join(project, ".git", "info");
  mkdirSync(info, { recursive: true });
  const attempt = async (conversation: string, attributes: string) => {
    const run = runFixture(conversation);
    bind(conversation, checkout);
    writeFileSync(join(info, "attributes"), attributes);
    try {
      await startCheckout(run, checkout, project, "g1");
      return checkoutDetail(owner, run.id)!;
    } finally {
      rmSync(join(info, "attributes"));
    }
  };
  const refused = await attempt("thread-info-attrs", "# comment\n*.txt filter=evil\n");
  expect(refused.state).toBe("failed");
  expect(refused.error).toContain("info/attributes");
  // "#" inside a pattern is not a comment.
  const inline = await attempt("thread-info-attrs-hash", "tracked#file.txt filter=evil\n");
  expect(inline.state).toBe("failed");
  // A whole-line comment mentioning a driver is only a comment.
  const comment = await attempt("thread-info-attrs-comment", "# *.txt filter=evil\n*.md -text\n");
  expect(comment.state).toBe("started");
});

it("keeps a recapture request durable when the process stops before claiming it", async () => {
  const run = runFixture("thread-durable");
  bind("thread-durable", checkout);
  await startCheckout(run, checkout, project, "g1");
  await completeCheckout(run.id);
  const first = checkoutDetail(owner, run.id)!;
  // The terminal transition records the request in the same transaction.
  expect(transition(run, "completed")).toBe(true);
  const raw = () => db.prepare("SELECT capture_pending,capture_token FROM run_checkouts WHERE run_id=?").get(run.id) as any;
  // Simulate the process dying before the asynchronous capture claimed it.
  for (let i = 0; i < 100 && raw().capture_token === null && raw().capture_pending === 1; i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 100 && raw().capture_token !== null; i++) await new Promise((r) => setTimeout(r, 20));
  db.prepare("UPDATE run_checkouts SET capture_pending=1,capture_token=NULL WHERE run_id=?").run(run.id);
  await completeCheckout(run.id, { ifIdle: true });
  const recaptured = checkoutDetail(owner, run.id)!;
  expect(recaptured.id).not.toBe(first.id);
  expect(raw()).toMatchObject({ capture_pending: 0, capture_token: null });
});

it("keeps an earlier observation reachable under its own id after a recapture", async () => {
  const run = runFixture("thread-versions");
  bind("thread-versions", checkout);
  await startCheckout(run, checkout, project, "g1");
  await completeCheckout(run.id);
  const first = checkoutDetail(owner, run.id)!;
  const firstContent = checkoutContent(first);
  writeFileSync(join(checkout, "versioned.txt"), "later\n");
  await completeCheckout(run.id);
  const second = checkoutDetail(owner, run.id)!;
  expect(second.id).not.toBe(first.id);
  expect(second.untracked).toContain("versioned.txt");
  expect(second.summary!.id).toBe(second.id);
  const old = resolveCite(owner, folder, { ref: "chk_" + first.id });
  expect(old).toMatchObject({ kind: "checkout", runId: run.id });
  expect(old!.content).toBe(firstContent);
  expect(resolveCite(owner, folder, { ref: "chk_" + second.id })!.content).toBe(checkoutContent(second));
  rmSync(join(checkout, "versioned.txt"));
});

it("re-records a run's published results once their checkout evidence exists", async () => {
  const run = runFixture("thread-rediscover");
  bind("thread-rediscover", checkout);
  const artifact = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,'thread-rediscover',?,'Answer','markdown','Done.',1,1)",
  ).run(artifact, owner, agent, run.id);
  db.prepare("INSERT INTO artifact_publications(artifact_id) VALUES(?)").run(artifact);
  const changes = () =>
    (db.prepare("SELECT count(*) n FROM project_changes WHERE owner_id=? AND kind='result' AND ref=?").get(owner, artifact) as { n: number }).n;
  const before = changes();
  await startCheckout(run, checkout, project, "g1");
  await completeCheckout(run.id);
  expect(changes()).toBe(before + 1);
});

it("recovers an abandoned recapture of an already captured run", async () => {
  const run = runFixture("thread-abandoned");
  bind("thread-abandoned", checkout);
  await startCheckout(run, checkout, project, "g1");
  await completeCheckout(run.id);
  db.prepare("UPDATE runs SET state='cancelled',updated_at=? WHERE id=?").run(now(), run.id);
  db.prepare("UPDATE run_checkouts SET capture_token='crashed',capture_started_at=?,capture_pending=1 WHERE run_id=?").run(now() - 600000, run.id);
  // The throttle is per process; reach past it for this check.
  await new Promise((r) => setTimeout(r, 0));
  const raw = () => db.prepare("SELECT capture_token,capture_pending,state FROM run_checkouts WHERE run_id=?").get(run.id) as any;
  await completeCheckout(run.id, { ifIdle: true });
  expect(raw()).toMatchObject({ capture_token: null, capture_pending: 0, state: "captured" });
});

it("refuses drivers with dotted names defined through an included file", async () => {
  const run = runFixture("thread-include");
  bind("thread-include", checkout);
  const included = join(dir, "included.gitconfig");
  writeFileSync(included, '[filter "evil.driver"]\n\tclean = touch /tmp/should-not-run\n');
  git(project, "config", "include.path", included);
  try {
    await startCheckout(run, checkout, project, "g1");
    const detail = checkoutDetail(owner, run.id)!;
    expect(detail.state).toBe("failed");
    expect(detail.error).toContain("filter.evil.driver.clean");
  } finally {
    git(project, "config", "--unset", "include.path");
  }
});

it("unquotes the paths Git quotes in diff headers", () => {
  expect(unquoteGitPath("b/plain.txt")).toBe("b/plain.txt");
  expect(unquoteGitPath('"b/notes\\tdraft.txt"')).toBe("b/notes\tdraft.txt");
  expect(unquoteGitPath('"b/say \\"hi\\".txt"')).toBe('b/say "hi".txt');
  expect(unquoteGitPath('"b/caf\\303\\251.txt"')).toBe("b/café.txt");
  expect(unquoteGitPath('"b/back\\\\slash"')).toBe("b/back\\slash");
});

it("records a capture failure on the run instead of raising it", async () => {
  const run = runFixture("thread-6");
  const nowhere = join(dir, "not-a-repo");
  mkdirSync(nowhere);
  await startCheckout(run, nowhere, nowhere, null);
  const detail = checkoutDetail(owner, run.id)!;
  expect(detail.state).toBe("failed");
  expect(detail.error).toMatch(/git/);
  expect(detail.summary).toMatchObject({ state: "failed" });
  expect(checkoutLine(detail.summary!)).toContain("checkout not captured");
  // Nothing to complete: the run still ends normally.
  await completeCheckout(run.id);
  expect(checkoutDetail(owner, run.id)!.state).toBe("failed");
});

it("has no record for runs without a worktree", async () => {
  const run = runFixture("thread-7");
  expect(checkoutDetail(owner, run.id)).toBeNull();
  expect(checkoutSummary(owner, run.id)).toBeNull();
  await completeCheckout(run.id);
  expect(checkoutDetail(owner, run.id)).toBeNull();
});
