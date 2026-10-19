import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  LOOP_REPOSITORY,
  browserNeedsReload,
  publicBuild,
  type BuildStamp,
} from "../src/shared/build";
import type { Run } from "../src/server/queue";

const dir = mkdtempSync(join(tmpdir(), "loop-deployment-"));
vi.stubEnv("LOOP_PROFILE", "server");
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, now } = await import("../src/server/db");
const { startCheckout, completeCheckout, checkoutDetail } =
  await import("../src/server/run-checkouts");
const {
  observeProcess,
  refreshDeployments,
  projectDeployments,
  currentBuilds,
} = await import("../src/server/deployments");
const { resolveCite } = await import("../src/server/briefs/cites");
const { serveBrief } = await import("../src/server/briefs/serve");
const { buildInput } = await import("../src/server/briefs/input");
const { readState } = await import("../src/server/briefs/store");
const { projectStatuses } = await import("../src/server/project-status");
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const git = (directory: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

async function fixture(
  options: {
    remote?: string;
    dirty?: boolean;
    unchanged?: boolean;
    late?: boolean;
  } = {},
) {
  const owner = id(),
    project = id(),
    agent = id(),
    conversation = id(),
    runId = id();
  const directory = join(dir, id());
  mkdirSync(directory);
  git(directory, "init");
  git(
    directory,
    "remote",
    "add",
    "origin",
    options.remote ?? "https://github.com/j-asefa/loop.git",
  );
  writeFileSync(join(directory, "code.txt"), "before");
  git(directory, "add", ".");
  git(directory, "commit", "-m", "before");
  const before = git(directory, "rev-parse", "HEAD");
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','App',0)",
  ).run(project, owner);
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'codex','fixture',0)",
  ).run(agent, owner, agent, agent);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Fix Send',?,0)",
  ).run(conversation, owner, agent, project);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Fix Send','completed',?,'{}',?,?)",
  ).run(runId, owner, agent, conversation, runId, now(), now());
  const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Run;
  await startCheckout(run, directory, directory, null);
  if (!options.unchanged) {
    writeFileSync(join(directory, "code.txt"), "after");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "fix");
  }
  const commit = git(directory, "rev-parse", "HEAD");
  if (options.dirty)
    writeFileSync(join(directory, "uncommitted.txt"), "not part of the commit");
  await completeCheckout(runId, { late: options.late });
  const stamp = (sha = commit, clean = true): BuildStamp => ({
    id: id(),
    repository: LOOP_REPOSITORY,
    commit: sha,
    clean,
    builtAt: now(),
    ancestors: git(directory, "rev-list", sha).split("\n"),
  });
  const start = (sha = commit, clean = true) => {
    const build = stamp(sha, clean);
    const api = observeProcess("api", build),
      worker = observeProcess("worker", build);
    stops.push(api, worker);
    return { api, worker, build };
  };
  return {
    owner,
    project,
    conversation,
    runId,
    before,
    commit,
    stamp,
    start,
    directory,
    read: () => projectDeployments(owner, project),
    checkout: () => checkoutDetail(owner, runId)!,
  };
}

it("records a real committed checkout and feeds current evidence into Status, Brief and model input", async () => {
  const f = await fixture();
  f.start();
  const [observation] = f.read();
  expect(observation).toMatchObject({
    status: "included",
    current: true,
    commit: f.commit,
    run: f.runId,
  });
  expect(serveBrief(f.owner, f.project).deployments).toEqual(f.read());
  expect(
    projectStatuses(f.owner, { project: f.project }).items[0].deployments,
  ).toEqual(f.read());
  expect(buildInput(readState(f.owner, f.project)).prompt).toContain(
    observation.ref,
  );
  const cite = resolveCite(f.owner, f.project, { ref: observation.ref });
  expect(cite).toMatchObject({ kind: "deployment", runId: f.runId });
  expect(cite?.content).toContain(f.commit);
  expect(cite?.content).toContain("does not verify feature behavior");
  const count = () =>
    db
      .prepare(
        "SELECT count(*) n FROM deployment_observations WHERE owner_id=?",
      )
      .get(f.owner);
  const before = count();
  refreshDeployments();
  refreshDeployments();
  expect(count()).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT ref FROM project_changes WHERE owner_id=? AND ref LIKE 'deployment:%'",
      )
      .all(f.owner),
  ).not.toHaveLength(0);
});

it("keeps old running builds distinct from installation, detects mismatched roles and rollback", async () => {
  const f = await fixture();
  const old = f.start(f.before);
  expect(f.read()[0].status).toBe("predates");
  // Changing what is installed must not replace the identity of a live process.
  writeFileSync(
    join(f.directory, "installed-build.json"),
    JSON.stringify(f.stamp()),
  );
  refreshDeployments();
  expect(f.read()[0].status).toBe("predates");
  old.api();
  const api = observeProcess("api", f.stamp());
  stops.push(api);
  expect(f.read()[0].status).toBe("unknown");
  old.worker();
  const worker = observeProcess("worker", f.stamp());
  stops.push(worker);
  expect(f.read()[0].status).toBe("included");
  const included = f.read()[0];
  const original = resolveCite(f.owner, f.project, {
    ref: included.ref,
  })!.content;
  api();
  worker();
  f.start(f.before);
  expect(f.read()[0].status).toBe("predates");
  expect(resolveCite(f.owner, f.project, { ref: included.ref })!.content).toBe(
    original,
  );
});

it("expires missing processes immediately in reads even before another reconciliation", async () => {
  const f = await fixture();
  f.start();
  expect(f.read()[0].status).toBe("included");
  db.prepare("UPDATE deployment_instances SET seen_at=?").run(now() - 60_000);
  expect(f.read()[0]).toMatchObject({ status: "unknown", current: false });
  expect(currentBuilds()).toEqual([]);
  refreshDeployments();
  expect(f.read()[0]).toMatchObject({ status: "unknown", current: true });
});

it("removes superseded checkout targets from live status while preserving their historical citations", async () => {
  const f = await fixture();
  f.start();
  const old = f.read()[0];
  const cite = resolveCite(f.owner, f.project, { ref: old.ref });
  writeFileSync(join(f.directory, "uncommitted.txt"), "resumed work");
  await completeCheckout(f.runId);
  refreshDeployments();
  expect(f.read()).toEqual([]);
  expect(resolveCite(f.owner, f.project, { ref: old.ref })).toEqual(cite);
});

it("does not let a different owner or moved project read old deployment evidence", async () => {
  const f = await fixture();
  f.start();
  const ref = f.read()[0].ref;
  expect(projectDeployments(id(), f.project)).toEqual([]);
  expect(resolveCite(id(), f.project, { ref })).toBeNull();
  const other = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Other',0)",
  ).run(other, f.owner);
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    other,
    f.conversation,
  );
  expect(f.read()).toEqual([]);
  expect(resolveCite(f.owner, f.project, { ref })).toBeNull();
  refreshDeployments();
  expect(projectDeployments(f.owner, other)[0].status).toBe("included");
});

it.each([
  { dirty: true },
  { unchanged: true },
  { late: true },
  { remote: "https://github.com/example/other.git" },
])(
  "does not infer a target from ambiguous or unrelated work: %j",
  async (options) => {
    const f = await fixture(options);
    f.start();
    expect(f.read()).toEqual([]);
  },
);

it("leaves dirty builds and missing/divergent history unknown", async () => {
  const f = await fixture();
  const dirty = f.start(f.commit, false);
  expect(f.read()[0].status).toBe("unknown");
  dirty.api();
  dirty.worker();
  const unknown = { ...f.stamp(), commit: "f".repeat(40), ancestors: [] };
  stops.push(observeProcess("api", unknown), observeProcess("worker", unknown));
  expect(f.read()[0].status).toBe("unknown");
});

it("detects a page already stale on its first connection and needs no reload for the same build", async () => {
  const f = await fixture();
  const loaded = publicBuild(f.stamp(f.before));
  const server = publicBuild(f.stamp());
  expect(browserNeedsReload(loaded, server)).toBe(true);
  expect(browserNeedsReload(server, server)).toBe(false);
  expect(browserNeedsReload({ ...loaded, id: "development" }, server)).toBe(
    false,
  );
});
