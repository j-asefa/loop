import { seedAgent, seedConnection } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testRootDirectory } from "./helpers/test-workspace.js";
import { fixtureAdapter, fixtureBinding } from "./fixtures/native-session.js";
import { afterAll, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

const dir = testRootDirectory();
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { teams, createPresetTeam } = await import("../src/server/teams");
const { core } = await import("../src/server/core-routes");
const { reviewContext } = await import("../src/server/review-access");
const { startCodeReview, reviewStatus } =
  await import("../src/server/code-reviews");
const { captureSnapshot } = await import("../src/server/review-snapshot");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { invokeTool } = await import("../src/server/mcp/broker");
const { claim, transition } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { nativeSessions } = await import("../src/server/native-sessions");
const { sendMail } = await import("../src/server/agent-mail");
const { setAgentPermissionMode } =
  await import("../src/server/mcp/approval-policy");

function connection(owner = "alice", metadata = "{}") {
  const c = id();
  seedConnection(db, {
    id: c,
    owner_id: owner,
    secret: seal("fixture", owner),
    models: JSON.stringify([{ id: "fixture-model" }]),
    metadata,
    created_at: now(),
  });
  return c;
}
const c = connection(),
  foreign = connection("bob"),
  native = connection("alice", '{"authMode":"subscription"}');
const repo = mkdtempSync(join(dir, "repo-"));
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
git("init", "-b", "main");
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "Fixture");
writeFileSync(join(repo, "index.ts"), "export const answer = 1;\n");
writeFileSync(join(repo, "caller.ts"), "import { answer } from './index';\n");
writeFileSync(join(repo, ".env"), "TOKEN=do-not-copy\n");
writeFileSync(join(repo, "stable.ts"), "export const stable = true;\n");
git("add", ".");
git("commit", "-m", "baseline");
const folder = id();
db.prepare(
  "INSERT INTO folders VALUES(?, 'alice', NULL, 'project', 'Fixture', ?)",
).run(folder, now());
db.prepare("INSERT INTO project_paths VALUES(?,?)").run(folder, repo);
const details = {
  presetId: "code-review",
  name: "Review team",
  folderId: folder,
  selection: { connectionId: c, model: "fixture-model" },
  idempotencyKey: "create-review-team",
};
let team: any;
const app = await productionApp("bob", [teams, core], {
  ownerHeader: "x-owner",
});
const url = app.url + "/api";
afterAll(async () => {
  await app.close();
  db.close();
});

it("creates all roles atomically, pins their configuration, and returns a durable creation receipt", () => {
  team = createPresetTeam("alice", details);
  expect(team.members).toHaveLength(3);
  expect(team.preset_version).toBe(1);
  expect(team.folder_id).toBe(folder);
  expect(JSON.parse(team.preset_config).assignments).toHaveLength(4);
  const count = (db.prepare("SELECT count(*) n FROM agents").get() as any).n;
  expect(createPresetTeam("alice", details).id).toBe(team.id);
  expect((db.prepare("SELECT count(*) n FROM agents").get() as any).n).toBe(
    count,
  );
  expect(() =>
    createPresetTeam("alice", { ...details, name: "Different" }),
  ).toThrow(/different team/);
  expect(() =>
    createPresetTeam("alice", {
      ...details,
      idempotencyKey: id(),
      roles: { regressions: { connectionId: foreign, model: "fixture-model" } },
    }),
  ).toThrow();
  expect((db.prepare("SELECT count(*) n FROM agents").get() as any).n).toBe(
    count,
  );
  expect(() =>
    createPresetTeam("alice", {
      ...details,
      idempotencyKey: id(),
      selection: { connectionId: c, model: "missing" },
    }),
  ).toThrow(/available model/);
  expect(() =>
    submit("alice", {
      agentId: team.manager_id,
      input: "Review",
      idempotencyKey: id(),
    }),
  ).toThrow(/capture a snapshot/);
});

it("captures staged contents separately from working changes, includes new files and callers, excludes secrets and symlinks, and leaves the index untouched", () => {
  writeFileSync(join(repo, "index.ts"), "export const answer = 2;\n");
  git("add", "index.ts");
  writeFileSync(join(repo, "index.ts"), "export const answer = 3;\n");
  writeFileSync(join(repo, "new.ts"), "export const added = true;\n");
  writeFileSync(join(repo, ".env"), "TOKEN=still-do-not-copy\n");
  symlinkSync(join(repo, ".env"), join(repo, "linked.ts"));
  const index = readFileSync(join(repo, ".git/index"));
  const staged = captureSnapshot(repo, "staged"),
    work = captureSnapshot(repo, "uncommitted");
  expect(staged.files["index.ts"]).toContain("= 2");
  expect(work.files["index.ts"]).toContain("= 3");
  expect(work.before["index.ts"]).toContain("= 1");
  expect(work.changed).toContain("new.ts");
  expect(work.context?.["caller.ts"]).toBe(
    git("rev-parse", "HEAD:caller.ts").trim(),
  );
  expect(staged.context?.["caller.ts"]).toBe(work.context?.["caller.ts"]);
  expect(work.files["new.ts"]).toContain("added");
  expect(JSON.stringify(work)).not.toContain("do-not-copy");
  expect(work.omitted).toContain("linked.ts");
  expect(work.omitted).toContain(".env");
  expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
  expect(() => captureSnapshot(repo, "branch", "--help")).toThrow(/capture/);
});

it("captures branch commits without including working edits and represents deleted files", () => {
  git("commit", "-m", "change staged value");
  const branch = captureSnapshot(repo, "branch", "HEAD~1");
  expect(branch.files["index.ts"]).toContain("= 2");
  expect(branch.before["index.ts"]).toContain("= 1");
  expect(branch.files["new.ts"]).toBeUndefined();
  rmSync(join(repo, "caller.ts"));
  const work = captureSnapshot(repo, "uncommitted");
  expect(work.files["caller.ts"]).toBeUndefined();
  expect(work.before["caller.ts"]).toContain("import");
  expect(work.diff).toContain("deleted file");
});

it("queues three fresh read-only reviewers before the lead, preserves retries, and consolidates with actual failure coverage", async () => {
  db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?)").run(
    id(),
    "alice",
    "https://example.invalid/push",
    seal("{}", "alice"),
    now(),
  );
  const details = {
    folderId: folder,
    scope: "uncommitted",
    idempotencyKey: "first-code-review",
  };
  const review = startCodeReview("alice", team.id, details);
  expect(startCodeReview("alice", team.id, details).id).toBe(review.id);
  expect(() =>
    startCodeReview("alice", team.id, { ...details, scope: "staged" }),
  ).toThrow(/different review/);
  const parent = db
    .prepare("SELECT * FROM runs WHERE conversation_id=?")
    .get(review.conversationId) as any;
  const children = db
    .prepare(
      "SELECT r.* FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=?",
    )
    .all(parent.id) as any[];
  expect(children).toHaveLength(3);
  expect(
    new Set([parent, ...children].map((r) => r.conversation_id)).size,
  ).toBe(4);
  const calls: any[] = [];
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      calls.push(input);
      yield { text: "Evidence-backed review fixture." };
    },
  });
  try {
    const first = claim("review-test")!;
    expect(first.id).not.toBe(parent.id);
    expect(nativeBindings(first).map((b) => b.tool)).toEqual([
      "loop_review_read",
    ]);
    const read = await invokeNative(first, nativeBindings(first)[0], "read", {
      path: "index.ts",
    });
    expect(JSON.stringify(read)).toContain("= 3");
    const context = await invokeNative(
      first,
      nativeBindings(first)[0],
      "context",
      { path: "stable.ts" },
    );
    expect(JSON.stringify(context)).toContain("stable = true");
    await expect(
      invokeNative(first, nativeBindings(first)[0], "escape", {
        path: "../.env",
      }),
    ).rejects.toThrow(/not in this snapshot/);
    await expect(
      invokeTool(
        first,
        {
          name: "write",
          tool: "write",
          connectionId: "fake",
          description: "",
          inputSchema: {},
        },
        "write",
        {},
      ),
    ).rejects.toThrow(/only read/);
    expect(await executeAgent(first)).toMatchObject({ kind: "finished" });
    transition(first, "completed");
    for (let n = 0; n < 2; n++) {
      const child = claim("review-test")!;
      expect(child.id).not.toBe(parent.id);
      if (n === 0) {
        db.prepare(
          "UPDATE runs SET error='Fixture reviewer failure' WHERE id=?",
        ).run(child.id);
        transition(child, "failed");
      } else {
        await executeAgent(child);
        transition(child, "completed");
      }
    }
    const lead = claim("review-test")!;
    expect(lead.id).toBe(parent.id);
    await executeAgent(lead);
    transition(lead, "completed");
    expect(
      (db.prepare("SELECT count(*) n FROM push_deliveries").get() as any).n,
    ).toBe(1);
    expect(
      calls.every(
        (c) => c.tools.map((t: any) => t.name).join() === "loop_review_read",
      ),
    ).toBe(true);
    expect(JSON.stringify(calls.at(-1).messages)).toContain(
      "Fixture reviewer failure",
    );
    expect(JSON.stringify(calls[0].messages)).not.toContain(
      "Independent reviewer reports",
    );
    const status = reviewStatus("alice", review.id, true);
    expect(status.current).toBe(true);
    expect(
      status.reviewers.filter((r: any) => r.state === "failed"),
    ).toHaveLength(1);
    writeFileSync(join(repo, "new.ts"), "export const added = false;\n");
    expect(reviewStatus("alice", review.id, true).current).toBe(false);
    expect(
      JSON.stringify(
        await invokeNative(
          { ...first, state: "running" },
          nativeBindings(first)[0],
          "read",
          { path: "index.ts" },
        ).catch((e) => e.message),
      ),
    ).toContain("no longer executing");
    const followup = submit("alice", {
      agentId: team.manager_id,
      conversationId: review.conversationId!,
      input: "Explain the first finding",
      idempotencyKey: id(),
    });
    expect(followup.payload.reviewId).toBe(review.id);
    expect(reviewContext(followup)).toContain("Fixture reviewer failure");
    transition(followup, "cancelled");
    const denied = await fetch(
      url + `/reviews/conversation/${review.conversationId}`,
    );
    expect(denied.status).toBe(404);
    expect(() => reviewStatus("bob", review.id)).toThrow(/not found/);
  } finally {
    restore();
  }
});

it("counts a review's lead and reviewers as review team usage, and a person's later turn in that thread as theirs", async () => {
  const { conversationUsage } = await import("../src/server/mobile-return");
  const { emit } = await import("../src/server/db");
  const review = startCodeReview("alice", team.id, {
    folderId: folder,
    scope: "uncommitted",
    idempotencyKey: "first-code-review",
  });
  const lead = db
    .prepare("SELECT * FROM runs WHERE conversation_id=? ORDER BY rowid")
    .get(review.conversationId) as any;
  const reviewer = db
    .prepare(
      "SELECT r.* FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=?",
    )
    .get(lead.id) as any;
  // submit() carries the thread's review binding into this turn's payload.
  const question = submit("alice", {
    agentId: lead.agent_id,
    conversationId: review.conversationId,
    input: "Why is the second finding a P1?",
    idempotencyKey: id(),
    personal: true,
  });
  expect(
    JSON.parse(
      (
        db.prepare("SELECT payload FROM runs WHERE id=?").get(question.id) as {
          payload: string;
        }
      ).payload,
    ).reviewId,
  ).toBe(review.id);
  for (const [run, input] of [
    [lead.id, 500],
    [reviewer.id, 300],
    [question.id, 40],
  ] as const)
    emit("alice", run, "native.usage", {
      usage: { input_tokens: input, output_tokens: 1 },
    });
  expect(conversationUsage("alice", review.conversationId).origins).toEqual({
    review_team: { turns: 1, input_tokens: 500, output_tokens: 1 },
    person: { turns: 1, input_tokens: 40, output_tokens: 1 },
  });
  expect(conversationUsage("alice", reviewer.conversation_id).origins).toEqual({
    review_team: { turns: 1, input_tokens: 300, output_tokens: 1 },
  });
  // Leave nothing queued for the tests that follow.
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(question.id);
});
it("cancels the whole review through the production run control and survives reopening the database", async () => {
  const review = startCodeReview("alice", team.id, {
    folderId: folder,
    scope: "uncommitted",
    idempotencyKey: "cancel-code-review",
  });
  const parent = db
    .prepare("SELECT id FROM runs WHERE conversation_id=?")
    .get(review.conversationId) as any;
  const response = await fetch(`${url}/runs/${parent.id}/cancel`, {
    method: "POST",
    headers: {
      "x-owner": "alice",
      "content-type": "application/json",
      connection: "close",
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect(
    reviewStatus("alice", review.id).reviewers.every(
      (r: any) => r.state === "cancelled",
    ),
  ).toBe(true);
  expect(claim("review-test")).toBeUndefined();
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { db } = await import('./src/server/db.ts'); db.close();",
    ],
    { cwd: process.cwd(), env: process.env, stdio: "pipe", timeout: 15000 },
  );
  expect(createPresetTeam("alice", details).id).toBe(team.id);
});

it("lets a working agent request a review of its own worktree, waits for the lead's report and cancels the whole review with the requester", async () => {
  const builder = id();
  seedAgent(db, {
    id: builder,
    owner_id: "alice",
    name: "Builder",
    normalized_name: "builder",
    provider: "openai",
    connection_id: c,
    model: "fixture-model",
    created_at: now(),
  });
  const worktree = join(dir, "builder-worktree");
  git("worktree", "add", "-b", "builder-feature", worktree, "HEAD");
  writeFileSync(join(worktree, "feature.ts"), "export const feature = 1;\n");
  execFileSync("git", ["add", "feature.ts"], { cwd: worktree });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: worktree });
  const start = (project: string) => {
    const run = submit("alice", {
      agentId: builder,
      folderId: folder,
      input: "Get the review team to review before opening a PR",
      idempotencyKey: id(),
    });
    db.prepare(
      "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,updated_at) VALUES('fixture-agent',?,'claude',?,?)",
    ).run(run.conversation_id, project, now());
    db.prepare(
      "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
    ).run(run.id);
    return { ...run, state: "running" } as any;
  };
  const binding = (run: any) =>
    nativeBindings(run).find((b) => b.tool === "loop_request_review")!;
  const run = start(worktree);
  expect(binding(run).description).toContain(team.id);
  const lead = db
    .prepare("SELECT * FROM agents WHERE id=?")
    .get(team.manager_id) as any;
  expect(
    nativeBindings({ ...run, agent_id: lead.id }).map((b) => b.tool),
  ).not.toContain("loop_request_review");
  const request = {
    teamId: team.id,
    scope: "branch",
    base: "main",
    wait: true,
  };
  expect(await invokeNative(run, binding(run), "ask", request)).toEqual({
    pending: "ask",
  });
  // An ordinary wait must not read repository contents. A SQLite view makes
  // payload reads observable while leaving the real receipt/progress queries
  // and native tool boundary in use.
  let snapshotReads = 0;
  db.function("count_review_snapshot_reads", (snapshot: string) => {
    snapshotReads++;
    return snapshot;
  });
  const columns = db.pragma("table_info(code_reviews)") as { name: string }[];
  db.exec("ALTER TABLE code_reviews RENAME TO stored_code_reviews");
  db.exec(
    `CREATE VIEW code_reviews AS SELECT ${columns
      .map(({ name }) =>
        name === "snapshot"
          ? "count_review_snapshot_reads(snapshot) AS snapshot"
          : `"${name}"`,
      )
      .join(",")} FROM stored_code_reviews`,
  );
  try {
    for (let poll = 0; poll < 3; poll++)
      expect(await invokeNative(run, binding(run), "ask", request)).toEqual({
        pending: "ask",
      });
    expect(snapshotReads).toBe(0);
  } finally {
    db.exec(
      "DROP VIEW code_reviews; ALTER TABLE stored_code_reviews RENAME TO code_reviews",
    );
  }
  const review = db
    .prepare(
      "SELECT * FROM code_reviews WHERE run_id=(SELECT child_run_id FROM delegations WHERE parent_run_id=?)",
    )
    .get(run.id) as any;
  expect(review.source_path).toBe(realpathSync(worktree));
  expect(JSON.parse(review.snapshot).changed).toEqual(["feature.ts"]);
  expect(
    (
      db
        .prepare("SELECT count(*) n FROM delegations WHERE parent_run_id=?")
        .get(run.id) as any
    ).n,
  ).toBe(1);
  db.prepare(
    "UPDATE runs SET state='completed' WHERE id IN (SELECT child_run_id FROM delegations WHERE parent_run_id=?)",
  ).run(review.run_id);
  db.prepare(
    "UPDATE runs SET state='completed',result='Consolidated fixture report' WHERE id=?",
  ).run(review.run_id);
  const done = (await invokeNative(run, binding(run), "ask", request)) as any;
  const report = JSON.parse(done.result.content[0].text);
  expect(done.result.isError).toBeUndefined();
  expect(
    db
      .prepare("SELECT 1 FROM review_continuations WHERE parent_run_id=?")
      .get(run.id),
  ).toBeUndefined();
  expect(report.report).toBe("Consolidated fixture report");
  expect(report.reviewers).toHaveLength(3);
  // The asynchronous default persists one recoverable request.
  const asyncRun = start(worktree);
  const accepted = (await invokeNative(asyncRun, binding(asyncRun), "async", {
    teamId: team.id,
    scope: "branch",
    base: "main",
  })) as any;
  const receipt = JSON.parse(accepted.result.content[0].text);
  expect(receipt.error).toBeUndefined();
  const persisted = db
    .prepare(
      "SELECT c.id FROM code_reviews c JOIN delegations d ON d.child_run_id=c.run_id WHERE d.parent_run_id=?",
    )
    .get(asyncRun.id) as { id: string };
  expect(receipt.reviewId).toBe(persisted.id);
  expect(receipt.state).toBe("queued");
  const replay = (await invokeNative(asyncRun, binding(asyncRun), "async", {
    teamId: team.id,
    scope: "branch",
    base: "main",
  })) as any;
  expect(JSON.parse(replay.result.content[0].text).reviewId).toBe(
    receipt.reviewId,
  );
  expect(
    (
      db
        .prepare("SELECT background FROM delegations WHERE parent_run_id=?")
        .get(asyncRun.id) as any
    ).background,
  ).toBe(1);
  // Completing ordinary delegated work must resume the requester even while
  // the asynchronous review is still queued.
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
  const ordinary = start(worktree);
  db.prepare("UPDATE runs SET state='completed',worker_id=NULL WHERE id=?").run(
    ordinary.id,
  );
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,'{}',0)",
  ).run(asyncRun.id, "ordinary", ordinary.id);
  db.prepare("UPDATE runs SET worker_id=NULL WHERE id=?").run(asyncRun.id);
  expect(
    claim("resume-requester", (candidate) => candidate.id === asyncRun.id)?.id,
  ).toBe(asyncRun.id);
  const later = start(worktree);
  const statusBinding = nativeBindings(later).find(
    (b) => b.tool === "loop_review_status",
  )!;
  const read = async (r: any, args: Record<string, unknown>) => {
    const value = (await invokeNative(r, statusBinding, id(), args)) as any;
    return {
      error: value.result.isError,
      body: JSON.parse(value.result.content[0].text),
    };
  };
  expect(
    (await read(later, {})).body.reviews.some(
      (r: any) => r.reviewId === receipt.reviewId,
    ),
  ).toBe(true);
  expect((await read(later, { reviewId: receipt.reviewId })).body.state).toBe(
    "queued",
  );
  expect(
    (
      await read(
        { ...later, agent_id: lead.id },
        { reviewId: receipt.reviewId },
      )
    ).error,
  ).toBe(true);
  await expect(
    read({ ...later, owner_id: "bob" }, { reviewId: receipt.reviewId }),
  ).rejects.toThrow("Item not found");
  db.prepare(
    "UPDATE runs SET state='failed',error='Reviewer unavailable' WHERE id=(SELECT run_id FROM code_reviews WHERE id=?)",
  ).run(receipt.reviewId);
  db.prepare(
    "UPDATE runs SET state='cancelled' WHERE id IN (SELECT d.child_run_id FROM delegations d JOIN code_reviews c ON c.run_id=d.parent_run_id WHERE c.id=?)",
  ).run(receipt.reviewId);
  const failure = await read(later, { reviewId: receipt.reviewId });
  expect(failure.error).toBe(true);
  expect(failure.body.error).toBe("Reviewer unavailable");
  const recovered = await read(later, { reviewId: review.id });
  expect(recovered.body.report).toBe("Consolidated fixture report");
  expect(recovered.body.reviewers).toHaveLength(3);

  const stranger = mkdtempSync(join(dir, "stranger-"));
  execFileSync("git", ["init"], { cwd: stranger });
  const outside = start(stranger);
  const refused = (await invokeNative(
    outside,
    binding(outside),
    "ask",
    request,
  )) as any;
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0].text).toMatch(/not part of this project/);

  const cancelled = start(worktree);
  await invokeNative(cancelled, binding(cancelled), "ask", {
    ...request,
    wait: false,
  });
  const { cancelRun } = await import("../src/server/run-attention");
  expect(cancelRun("alice", cancelled.id)).toEqual({ ok: true });
  const second = db
    .prepare("SELECT child_run_id id FROM delegations WHERE parent_run_id=?")
    .get(cancelled.id) as any;
  const states = db
    .prepare(
      "SELECT state FROM runs WHERE id=? UNION ALL SELECT r.state FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=?",
    )
    .all(second.id, second.id) as any[];
  expect(states.map((r) => r.state)).toEqual(Array(4).fill("cancelled"));
  expect(
    db
      .prepare(
        "SELECT state FROM runs WHERE id=(SELECT run_id FROM review_continuations WHERE parent_run_id=?)",
      )
      .get(cancelled.id),
  ).toEqual({ state: "cancelled" });
}, 30000);
it("reviews a repeat request as a lead-only follow-up only while a completed full review covers most of the change", async () => {
  const { reviewContext } = await import("../src/server/review-access");
  const { ownedRun } = await import("../src/server/domain");
  const builder = id();
  seedAgent(db, {
    id: builder,
    owner_id: "alice",
    name: "Follow-up builder",
    normalized_name: "follow-up-builder",
    provider: "openai",
    connection_id: c,
    model: "fixture-model",
    created_at: now(),
  });
  const worktree = join(dir, "follow-up-worktree");
  git("worktree", "add", "-b", "follow-up-feature", worktree, "HEAD");
  const commit = (file: string, lines: string[]) => {
    writeFileSync(join(worktree, file), lines.join("\n") + "\n");
    execFileSync("git", ["add", file], { cwd: worktree });
    execFileSync("git", ["commit", "-m", file], { cwd: worktree });
  };
  const body = Array.from(
    { length: 30 },
    (_, i) => `export const v${i} = ${i};`,
  );
  commit("follow.ts", body);
  const turn = (conversationId?: string) => {
    const run = submit("alice", {
      agentId: builder,
      folderId: folder,
      conversationId,
      input: "Get a review",
      idempotencyKey: id(),
    });
    if (!conversationId)
      db.prepare(
        "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,updated_at) VALUES(?,?,'claude',?,?)",
      ).run(id(), run.conversation_id, worktree, now());
    db.prepare(
      "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
    ).run(run.id);
    return { ...run, state: "running" } as any;
  };
  const request = async (run: any, extra: object = {}) => {
    const binding = nativeBindings(run).find(
      (b) => b.tool === "loop_request_review",
    )!;
    const accepted = (await invokeNative(run, binding, id(), {
      teamId: team.id,
      scope: "branch",
      base: "main",
      ...extra,
    })) as any;
    const reviewId = JSON.parse(accepted.result.content[0].text).reviewId;
    const review = db
      .prepare("SELECT id,run_id FROM code_reviews WHERE id=?")
      .get(reviewId) as { id: string; run_id: string };
    const followUp = db
      .prepare("SELECT * FROM review_follow_ups WHERE review_id=?")
      .get(reviewId) as { previous_review_id: string; owner_id: string };
    const reviewers = (
      db
        .prepare("SELECT count(*) n FROM delegations WHERE parent_run_id=?")
        .get(review.run_id) as { n: number }
    ).n;
    return { ...review, followUp, reviewers };
  };
  // Finishing the requester's turn lets the next turn of the thread ask again.
  const finish = (
    run: any,
    review: { run_id: string },
    result = "Finding: v3 is misnamed",
    reviewerState = "completed",
  ) => {
    db.prepare(
      "UPDATE runs SET state=? WHERE id IN (SELECT child_run_id FROM delegations WHERE parent_run_id=?)",
    ).run(reviewerState, review.run_id);
    db.prepare("UPDATE runs SET state='completed',result=? WHERE id=?").run(
      result,
      review.run_id,
    );
    db.prepare(
      "UPDATE runs SET state='completed',worker_id=NULL WHERE conversation_id=? AND state IN ('running','queued')",
    ).run(run.conversation_id);
  };
  const first = turn();
  const full = await request(first);
  expect(full.followUp).toBeUndefined();
  expect(full.reviewers).toBe(3);
  // Reviewers finish before a full review's lead may start.
  expect(claim("lead-waits", (run) => run.id === full.run_id)).toBeUndefined();
  // An unfinished earlier review is no basis for a follow-up.
  const racing = await request(first);
  expect(racing.followUp).toBeUndefined();
  finish(first, racing);
  finish(first, full);

  // A small fix on top of the reviewed change goes to the lead alone.
  commit("follow.ts", body.with(3, "export const third = 3;"));
  commit("constructor", ["prototype-named file"]);
  const second = turn(first.conversation_id);
  const followUp = await request(second);
  expect(followUp.followUp).toMatchObject({
    previous_review_id: racing.id,
    owner_id: "alice",
  });
  expect(followUp.reviewers).toBe(0);
  // With no reviewers to wait for, the production claim takes the lead.
  expect(claim("lead-starts", (run) => run.id === followUp.run_id)?.id).toBe(
    followUp.run_id,
  );
  const lead = ownedRun(followUp.run_id, "alice");
  expect(lead.input).toContain(
    `Review ${racing.id} covered an earlier snapshot`,
  );
  const context = reviewContext(lead);
  expect(context).toContain("Finding: v3 is misnamed");
  expect(context).toContain("Lines added (+) and removed (-) since");
  const delta = context.slice(context.indexOf("Lines added (+) and removed"));
  expect(delta).toContain("+prototype-named file");
  expect(delta).toContain("-export const v3 = 3;");
  expect(delta).toContain("+export const third = 3;");
  expect(delta).not.toContain("export const v20 = 20;");
  expect(context).not.toContain("Independent reviewer reports");
  finish(second, followUp, "v3 is fixed");
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
  ).run(second.id);
  const status = nativeBindings(second).find(
    (b) => b.tool === "loop_review_status",
  )!;
  const report = JSON.parse(
    (
      (await invokeNative({ ...second, state: "running" }, status, id(), {
        reviewId: followUp.id,
      })) as any
    ).result.content[0].text,
  );
  expect(report).toMatchObject({
    depth: "follow_up",
    previousReviewId: racing.id,
    reviewers: [],
    report: "v3 is fixed",
  });
  expect(report.note).toContain(
    "assigned this follow-up to the review lead alone",
  );
  const http = await fetch(
    `${url}/reviews/conversation/${lead.conversation_id}`,
    {
      headers: { "x-owner": "alice" },
    },
  );
  expect(await http.json()).toMatchObject({
    depth: "follow_up",
    previousReviewId: racing.id,
  });
  expect(
    (
      await fetch(`${url}/reviews/conversation/${lead.conversation_id}`, {
        headers: { "x-owner": "bob" },
      })
    ).status,
  ).toBe(404);

  db.prepare("UPDATE runs SET state='completed',worker_id=NULL WHERE id=?").run(
    second.id,
  );

  // Another small step still measures against the last full review.
  commit(
    "follow.ts",
    body
      .with(3, "export const third = 3;")
      .with(4, "export const fourth = 4;")
      .toSpliced(10, 1),
  );
  const third = turn(first.conversation_id);
  const chained = await request(third);
  expect(chained.followUp?.previous_review_id).toBe(followUp.id);
  const chainedContext = reviewContext(ownedRun(chained.run_id, "alice"));
  expect(chainedContext).toContain("v3 is fixed");
  // A line the earlier snapshot held and this one deleted is shown as removed.
  const chainedDelta = chainedContext.slice(
    chainedContext.indexOf("Lines added (+) and removed"),
  );
  expect(chainedDelta).toContain("-export const v10 = 10;");
  expect(chainedDelta).toContain("+export const fourth = 4;");
  // Already in the previous snapshot, so not repeated.
  expect(chainedDelta).not.toContain("+export const third = 3;");
  // The same request key with another depth is different work, at the tool
  // boundary and in the review receipt behind it.
  const { requestReview } = await import("../src/server/code-reviews");
  const sameCall = { teamId: team.id, scope: "branch", base: "main" } as const;
  requestReview(third, "replayed", sameCall);
  expect(() =>
    requestReview(third, "replayed", { ...sameCall, depth: "full" }),
  ).toThrow(/different review/);
  const replayed = db
    .prepare(
      "SELECT c.run_id FROM code_reviews c JOIN delegations d ON d.child_run_id=c.run_id WHERE d.parent_run_id=? AND d.call_id='replayed:review'",
    )
    .get(third.id) as { run_id: string };
  finish(third, replayed);
  finish(third, chained);

  // The same snapshot reviewed in full on request.
  const fourth = turn(first.conversation_id);
  const forced = await request(fourth, { depth: "full" });
  expect(forced.followUp).toBeUndefined();
  expect(forced.reviewers).toBe(3);
  // A reviewer that failed leaves that full review without coverage.
  finish(fourth, forced, "Partial report", "failed");
  const fifth = turn(first.conversation_id);
  const uncovered = await request(fifth);
  expect(uncovered.followUp).toBeUndefined();
  expect(uncovered.reviewers).toBe(3);
  finish(fifth, uncovered);

  // A full review against a later base covered a smaller change. The same
  // files against main are mostly unreviewed, though their text is identical.
  const narrowTurn = turn(first.conversation_id);
  const narrow = await request(narrowTurn, { base: "HEAD~1", depth: "full" });
  expect(narrow.reviewers).toBe(3);
  finish(narrowTurn, narrow);
  const widerTurn = turn(first.conversation_id);
  const wider = await request(widerTurn);
  expect(wider.followUp).toBeUndefined();
  expect(wider.reviewers).toBe(3);
  finish(widerTurn, wider);

  // Mostly new work is a new change: every reviewer runs again.
  commit(
    "more.ts",
    Array.from({ length: 80 }, (_, i) => `export const more${i} = ${i};`),
  );
  const sixth = turn(first.conversation_id);
  const grown = await request(sixth);
  expect(grown.followUp).toBeUndefined();
  expect(grown.reviewers).toBe(3);
  finish(sixth, grown);

  // A staged review in between captured other content: it neither blocks nor
  // supports the next branch follow-up.
  writeFileSync(join(worktree, "staged.ts"), "export const staged = 1;\n");
  execFileSync("git", ["add", "staged.ts"], { cwd: worktree });
  const seventh = turn(first.conversation_id);
  const staged = await request(seventh, { scope: "staged" });
  expect(staged.followUp).toBeUndefined();
  finish(seventh, staged);
  const eighth = turn(first.conversation_id);
  const resumed = await request(eighth);
  expect(resumed.followUp?.previous_review_id).toBe(grown.id);
  finish(eighth, resumed, "x".repeat(24_001));
  const oversized = await request(turn(first.conversation_id));
  expect(oversized.reviewers).toBe(3);

  // Another conversation asking about the same checkout has no history here.
  const elsewhere = await request(turn());
  expect(elsewhere.followUp).toBeUndefined();
  expect(elsewhere.reviewers).toBe(3);
});
it("runs review teams on native harness subscriptions with the snapshot in the first native turn", async () => {
  const harness = id();
  seedConnection(db, {
    id: harness,
    owner_id: "alice",
    provider: "anthropic",
    label: "Claude Code · this computer",
    secret: "",
    models: JSON.stringify([{ id: "native-default" }]),
    metadata: JSON.stringify({
      loopHarness: "claude",
      authMode: "subscription",
    }),
    created_at: now(),
  });
  const native = createPresetTeam("alice", {
    ...details,
    name: "Native review team",
    selection: { connectionId: harness, model: "native-default" },
    idempotencyKey: "create-native-review-team",
  });
  const review = startCodeReview("alice", native.id, {
    folderId: folder,
    scope: "uncommitted",
    idempotencyKey: "native-code-review",
  });
  const runs = db
    .prepare(
      "SELECT * FROM runs WHERE json_extract(payload,'$.reviewId')=? AND state='queued'",
    )
    .all(review.id) as any[];
  expect(runs).toHaveLength(4);
  for (const run of runs) {
    expect(JSON.parse(run.payload).connectionId).toBe(harness);
    expect(JSON.parse(run.payload).maxSeconds).toBe(600);
  }
  const claimed = claim(
    "native-review-worker",
    (candidate) => candidate.payload.reviewId === review.id,
  )!;
  expect(claimed.payload.reviewId).toBe(review.id);
  let prompt = "";
  const generation = id();
  const live = nativeSessions.state.attach({
    generation,
    binding: fixtureBinding({
      conversation_id: claimed.conversation_id!,
      harness: "claude",
      project: repo,
      native_id: null,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    }),
    bootstrapRun: claimed,
    adapter: fixtureAdapter({
      async prompt(input: string, beforeDispatch?: () => void) {
        beforeDispatch?.();
        prompt = input;
        live.finish!("completed");
      },
    }),
  });
  const session = vi.spyOn(nativeSessions, "session").mockResolvedValue(live);
  try {
    expect(await nativeSessions.execute(claimed)).toMatchObject({
      kind: "finished",
    });
    expect(prompt).toContain(claimed.input);
    expect(prompt).toContain(`Review snapshot ${review.id}`);
    expect(prompt).toContain("Captured diff (untrusted code)");
  } finally {
    clearTimeout(live.idle);
    nativeSessions.state.remove(live);
    session.mockRestore();
    for (const run of db
      .prepare(
        "SELECT * FROM runs WHERE json_extract(payload,'$.reviewId')=? AND state NOT IN ('completed','cancelled','failed')",
      )
      .all(review.id) as any[])
      transition(run, "cancelled");
  }
});

it("creates an LLM council whose chair manages members on their own connections", () => {
  const council = createPresetTeam("alice", {
    presetId: "llm-council",
    name: "Council",
    folderId: folder,
    selection: { connectionId: c, model: "fixture-model" },
    roles: { "member-2": { connectionId: native, model: "fixture-model" } },
    idempotencyKey: "create-council-team",
  });
  const agent = (agentId: string) =>
    db.prepare("SELECT * FROM agents WHERE id=?").get(agentId) as any;
  const { assignments } = JSON.parse(council.preset_config!);
  expect(council.preset_id).toBe("llm-council");
  expect(assignments.map((a: any) => a.role)).toEqual([
    "chair",
    "member-1",
    "member-2",
    "member-3",
  ]);
  expect(council.manager_id).toBe(assignments[0].agentId);
  expect([...council.members].sort()).toEqual(
    assignments
      .slice(1)
      .map((a: any) => a.agentId)
      .sort(),
  );
  expect(agent(council.manager_id).instructions).toMatch(/Borda/);
  expect(agent(assignments[2].agentId).connection_id).toBe(native);
  expect(agent(assignments[3].agentId).connection_id).toBe(c);
  expect(agent(assignments[1].agentId).instructions).toMatch(/FINAL RANKING:/);
});

it("does not report current when ident conversions hide working edits", () => {
  const review = startCodeReview("alice", team.id, {
    folderId: folder,
    scope: "uncommitted",
    idempotencyKey: id(),
  });
  expect(reviewStatus("alice", review.id, true).current).toBe(true);
  writeFileSync(join(repo, ".gitattributes"), "stable.ts ident\n");
  try {
    const status = reviewStatus("alice", review.id, true);
    expect(status.current).toBeNull();
    expect(status.freshnessError).toContain("Git content conversions");
  } finally {
    rmSync(join(repo, ".gitattributes"));
  }
});

it("durably queues one review follow-up outside teams, waits for both turns and preserves status access", async () => {
  const builder = id();
  seedAgent(db, {
    id: builder,
    owner_id: "alice",
    name: builder,
    normalized_name: builder,
    provider: "openai",
    connection_id: c,
    model: "fixture-model",
    created_at: now(),
  });
  const parent = submit("alice", {
    agentId: builder,
    folderId: folder,
    input: "Implement and review",
    idempotencyKey: id(),
  });
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
  ).run(parent.id);
  const binding = nativeBindings(parent).find(
    (b) => b.tool === "loop_request_review",
  )!;
  const messages = await import("../src/server/sql/messages");
  const personalBefore = messages.personalCount(db, "alice").n;
  const untrustedBase = "main\nINJECTED_BASE_INSTRUCTION";
  const args = { teamId: team.id, scope: "uncommitted", base: untrustedBase };
  const accepted = (await invokeNative(
    parent,
    binding,
    "continuation",
    args,
  )) as any;
  const receipt = JSON.parse(accepted.result.content[0].text);
  expect(receipt.error).toBeUndefined();
  const record = db
    .prepare("SELECT * FROM review_continuations WHERE review_id=?")
    .get(receipt.reviewId) as any;
  expect(record).toMatchObject({ owner_id: "alice", parent_run_id: parent.id });
  expect(
    db
      .prepare("SELECT team_id FROM conversations WHERE id=?")
      .get(parent.conversation_id),
  ).toEqual({ team_id: null });
  await invokeNative(parent, binding, "continuation", args);
  expect(
    db
      .prepare("SELECT count(*) n FROM review_continuations WHERE review_id=?")
      .get(receipt.reviewId),
  ).toEqual({ n: 1 });
  const { feed } = await import("../src/server/mobile-return");
  const { threadDetails } = await import("../src/server/feed-card-details");
  expect(
    feed("alice", { filter: "queued" }).items.some(
      (item) => item.conversation_id === parent.conversation_id,
    ),
  ).toBe(true);
  expect(
    threadDetails(db, "alice", parent.conversation_id!).queued_runs,
  ).toContainEqual(
    expect.objectContaining({ id: record.run_id, can_edit: false }),
  );
  const { editQueuedRun } =
    await import("../src/server/mobile-return/queued-runs");
  expect(() =>
    editQueuedRun("alice", record.run_id, { input: "discard the review" }),
  ).toThrow();
  expect(
    claim("review-follow-up", (run) => run.id === record.run_id),
  ).toBeUndefined();
  const lead = db
    .prepare("SELECT run_id FROM code_reviews WHERE id=?")
    .get(receipt.reviewId) as any;
  db.prepare(
    "UPDATE runs SET state='completed',result='Snapshot approved in fixture' WHERE id=?",
  ).run(lead.run_id);
  expect(
    claim("review-follow-up", (run) => run.id === record.run_id),
  ).toBeUndefined();
  db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(parent.id);
  expect(
    claim("paused-requester", (run) => run.id === record.run_id),
  ).toBeUndefined();
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(parent.id);
  transition(parent, "completed");
  db.prepare(
    "UPDATE review_continuations SET owner_id='bob' WHERE review_id=?",
  ).run(receipt.reviewId);
  expect(
    claim("foreign-owner", (run) => run.id === record.run_id),
  ).toBeUndefined();
  db.prepare(
    "UPDATE review_continuations SET owner_id='alice' WHERE review_id=?",
  ).run(receipt.reviewId);
  const claimed = claim("review-follow-up", (run) => run.id === record.run_id)!;
  expect(claimed).toMatchObject({
    agent_id: builder,
    conversation_id: parent.conversation_id,
  });
  expect(claimed.input).toContain(receipt.reviewId);
  expect(claimed.input).toContain("Completion is not approval");
  expect(claimed.input).not.toContain("INJECTED_BASE_INSTRUCTION");
  expect(claimed.payload.connectionId).toBe(parent.payload.connectionId);

  expect(claimed.input).toContain(
    `base commit: ${git("rev-parse", "HEAD").trim()}`,
  );
  expect(messages.personalCount(db, "alice").n).toBe(personalBefore);
  expect(
    messages
      .personalHistory(db, "alice", null, Number.MAX_SAFE_INTEGER, "z")
      .some((message) => message.content === claimed.input),
  ).toBe(false);
  const modelInputs: string[] = [];
  const restoreApi = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      modelInputs.push(JSON.stringify(input.messages));
      const report = input.messages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "status-via-model",
      );
      if (!report) {
        expect(
          input.tools?.some((tool) => tool.name === "loop_review_status"),
        ).toBe(true);
        yield {
          toolCall: {
            id: "status-via-model",
            name: "loop_review_status",
            arguments: { reviewId: receipt.reviewId },
          },
        };
        return;
      }
      expect(report.content).toContain("Snapshot approved in fixture");
      expect(report.content).toContain("reviewers");
      expect(report.content).toContain("completed");
      yield { text: "Review follow-up handled by API fixture." };
    },
  });
  try {
    expect(await executeAgent(claimed)).toMatchObject({ kind: "finished" });
  } finally {
    restoreApi();
  }
  expect(modelInputs.join("\n")).toContain(receipt.reviewId);

  expect(
    claim("another-worker", (run) => run.id === record.run_id),
  ).toBeUndefined();
  const statusBinding = nativeBindings(claimed).find(
    (b) => b.tool === "loop_review_status",
  )!;
  const status = (await invokeNative(claimed, statusBinding, "get-status", {
    reviewId: receipt.reviewId,
  })) as any;
  expect(JSON.parse(status.result.content[0].text)).toMatchObject({
    reviewId: receipt.reviewId,
    state: "completed",
    report: "Snapshot approved in fixture",
  });
  transition(claimed, "completed");
  expect(
    claim("after-restart", (run) => run.id === record.run_id),
  ).toBeUndefined();
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(parent.id),
  ).toEqual({ state: "completed" });
});

it.each(["completed", "failed", "cancelled", "interrupted"])(
  "review outcome %s releases a follow-up only after its requester completes",
  async (state) => {
    const builder = id();
    seedAgent(db, {
      id: builder,
      owner_id: "alice",
      name: builder,
      normalized_name: builder,
      provider: "openai",
      connection_id: c,
      model: "fixture-model",
      created_at: now(),
    });
    const parent = submit("alice", {
      agentId: builder,
      folderId: folder,
      input: "review",
      idempotencyKey: id(),
    });
    db.prepare(
      "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
    ).run(parent.id);
    const binding = nativeBindings(parent).find(
      (b) => b.tool === "loop_request_review",
    )!;
    const result = (await invokeNative(parent, binding, "ask", {
      teamId: team.id,
      scope: "uncommitted",
      base: "main",
    })) as any;
    const reviewId = JSON.parse(result.result.content[0].text).reviewId;
    const record = db
      .prepare(
        "SELECT rc.run_id,cr.run_id lead FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.review_id=?",
      )
      .get(reviewId) as any;
    transition(parent, "completed");
    expect(claim("waiting", (r) => r.id === record.run_id)).toBeUndefined();
    db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, record.lead);
    db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(now(), builder);
    expect(claim("retired", (r) => r.id === record.run_id)).toBeUndefined();
    db.prepare("UPDATE agents SET retired_at=NULL WHERE id=?").run(builder);
    const resumed = claim("ready", (r) => r.id === record.run_id)!;
    expect(resumed?.id).toBe(record.run_id);
    transition(resumed, "completed");
  },
);

it.each(["cancelled", "failed", "interrupted"])(
  "does not wake a requester that %s",
  async (state) => {
    const builder = id();
    seedAgent(db, {
      id: builder,
      owner_id: "alice",
      name: builder,
      normalized_name: builder,
      provider: "openai",
      connection_id: c,
      model: "fixture-model",
      created_at: now(),
    });
    const parent = submit("alice", {
      agentId: builder,
      folderId: folder,
      input: "review",
      idempotencyKey: id(),
    });
    db.prepare(
      "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
    ).run(parent.id);
    const binding = nativeBindings(parent).find(
      (b) => b.tool === "loop_request_review",
    )!;
    await invokeNative(parent, binding, "ask", {
      teamId: team.id,
      scope: "uncommitted",
      base: "main",
    });
    const record = db
      .prepare("SELECT run_id FROM review_continuations WHERE parent_run_id=?")
      .get(parent.id) as any;
    db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, parent.id);
    expect(claim("no-replay", (r) => r.id === record.run_id)).toBeUndefined();
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(record.run_id),
    ).toEqual({ state: "cancelled" });

    const next = submit("alice", {
      agentId: builder,
      conversationId: parent.conversation_id!,
      input: "A new explicit task",
      idempotencyKey: id(),
    });
    const nextClaimed = claim("explicit-recovery", (r) => r.id === next.id)!;
    const history = await import("../src/server/sql/messages");
    expect(
      history
        .nativeTransferHistory(db, parent.conversation_id, next.id)
        .some((message) => message.content.includes("Wait for review")),
    ).toBe(false);
    const modelInputs: string[] = [];
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_secret, input) {
        modelInputs.push(JSON.stringify(input.messages));
        yield { text: "New explicit task completed." };
      },
    });
    try {
      expect(await executeAgent(nextClaimed)).toMatchObject({
        kind: "finished",
      });
    } finally {
      restore();
    }
    expect(modelInputs.join("\n")).not.toContain("Wait for review");
    expect(
      db
        .prepare("SELECT content FROM messages WHERE run_id=? AND role='user'")
        .get(record.run_id),
    ).toMatchObject({ content: expect.stringContaining("Wait for review") });
    transition(nextClaimed, "completed");
  },
);

it.each(["claude", "opencode"] as const)(
  "resumes %s in its original session and does not replay uncertain continuation dispatch",
  async (harness) => {
    setAgentPermissionMode("alice", "bypassPermissions");
    const selected = connection(
      "alice",
      JSON.stringify({ loopHarness: harness, authMode: "subscription" }),
    );
    const builder = id();
    seedAgent(db, {
      id: builder,
      owner_id: "alice",
      name: builder,
      normalized_name: builder,
      provider: "openai",
      connection_id: selected,
      model: "fixture-model",
      created_at: now(),
    });
    const parent = submit("alice", {
      agentId: builder,
      folderId: folder,
      input: "review then continue",
      idempotencyKey: id(),
    });
    const first = claim("native-parent", (r) => r.id === parent.id)!;
    expect(first.payload.permissionMode).toBe("bypassPermissions");
    const generation = id();
    const prompts: string[] = [];
    const live = nativeSessions.state.attach({
      generation,
      binding: fixtureBinding({
        conversation_id: first.conversation_id!,
        harness,
        project: repo,
        native_id: "retained-native-context",
        model: null,
        instructions: "",
        generation,
        state: "idle",
      }),
      bootstrapRun: first,
      adapter: fixtureAdapter({
        async prompt(input: string, beforeDispatch?: () => void) {
          beforeDispatch?.();
          prompts.push(input);
          if (prompts.length === 2)
            throw new Error("fixture disconnected after possible acceptance");
          // Tighten the policy during the original turn, before its review request.
          setAgentPermissionMode("alice", "default");
          const binding = nativeBindings(first).find(
            (b) => b.tool === "loop_request_review",
          )!;
          await invokeNative(first, binding, "ask", {
            teamId: team.id,
            scope: "uncommitted",
            base: "main",
          });
          live.finish!("completed");
        },
        async dispose() {},
      }),
    });
    const session = vi.spyOn(nativeSessions, "session").mockResolvedValue(live);
    try {
      expect(await nativeSessions.execute(first)).toMatchObject({
        kind: "finished",
      });
      transition(first, "completed");
      const record = db
        .prepare(
          "SELECT rc.run_id,cr.run_id lead FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.parent_run_id=?",
        )
        .get(first.id) as any;
      expect(record).toBeDefined();
      expect(claim("not-ready", (r) => r.id === record.run_id)).toBeUndefined();
      const sibling = submit("alice", {
        agentId: builder,
        folderId: folder,
        input: "Other conversation",
        idempotencyKey: id(),
      });
      const busy = claim("sibling", (r) => r.id === sibling.id)!;
      expect(busy?.id).toBe(sibling.id);
      db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(
        record.lead,
      );
      expect(
        claim("busy-elsewhere", (r) => r.id === record.run_id),
      ).toBeUndefined();
      transition(busy, "completed");
      const follow = claim("native-follow", (r) => r.id === record.run_id)!;
      expect(follow.conversation_id).toBe(first.conversation_id);
      expect(follow.payload.permissionMode).toBe("default");
      expect(follow.payload.connectionId).toBe(selected);
      expect(await nativeSessions.execute(follow)).not.toMatchObject({
        kind: "finished",
      });
      expect(prompts).toHaveLength(2);
      expect(
        db
          .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
          .get(follow.id),
      ).toEqual({ state: "unknown" });
      // Even explicit queue recovery cannot bypass the existing dispatch receipt.
      transition(follow, "queued");
      expect(claim("restart", (r) => r.id === follow.id)).toBeUndefined();
      await expect(nativeSessions.execute(follow)).rejects.toThrow(
        /already dispatched|uncertain/,
      );
      expect(prompts).toHaveLength(2);
    } finally {
      setAgentPermissionMode("alice", "default");
      clearTimeout(live.idle);
      nativeSessions.state.remove(live);
      session.mockRestore();
    }
  },
);

it("retains a disconnected review continuation through the production worker claim and execution race", async () => {
  // Earlier fixtures intentionally leave pending work; isolate this worker pass.
  db.prepare(
    "UPDATE runs SET state='cancelled' WHERE state IN ('queued','running','pausing','paused','awaiting_approval')",
  ).run();
  const provider = connection();
  const builder = id();
  seedAgent(db, {
    id: builder,
    owner_id: "alice",
    name: builder,
    normalized_name: builder,
    provider: "openai",
    connection_id: provider,
    model: "fixture-model",
    created_at: now(),
  });
  const parent = submit("alice", {
    agentId: builder,
    folderId: folder,
    input: "Review and finish",
    idempotencyKey: id(),
  });
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
  ).run(parent.id);
  const binding = nativeBindings(parent).find(
    (b) => b.tool === "loop_request_review",
  )!;
  await invokeNative(parent, binding, "ask", {
    teamId: team.id,
    scope: "uncommitted",
    base: "main",
  });
  const record = db
    .prepare(
      "SELECT rc.run_id,cr.run_id lead FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.parent_run_id=?",
    )
    .get(parent.id) as any;
  db.prepare(
    "UPDATE runs SET state='completed' WHERE id=? OR id IN (SELECT child_run_id FROM delegations WHERE parent_run_id=?)",
  ).run(record.lead, record.lead);
  transition(parent, "completed");
  const { tick } = await import("../src/server/worker");
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    provider,
  );
  expect(await tick(executeAgent)).toBe(false);
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    provider,
  );
  expect(
    await tick(async (run) => {
      expect(run.id).toBe(record.run_id);
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        provider,
      );
      return executeAgent(run);
    }),
  ).toBe(true);
  expect(
    db
      .prepare("SELECT state,worker_id FROM runs WHERE id=?")
      .get(record.run_id),
  ).toEqual({ state: "queued", worker_id: null });
  expect(
    db
      .prepare(
        "SELECT 1 FROM native_dispatch WHERE run_id=? UNION ALL SELECT 1 FROM agent_checkpoints WHERE run_id=?",
      )
      .get(record.run_id, record.run_id),
  ).toBeUndefined();
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    provider,
  );
  let requests = 0;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      requests++;
      yield { text: "Continued after reconnect." };
    },
  });
  try {
    expect(await tick(executeAgent)).toBe(true);
  } finally {
    restore();
  }
  expect(requests).toBe(1);
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(record.run_id),
  ).toEqual({ state: "completed" });
  expect(await tick(executeAgent)).toBe(false);
}, 30000);

it.each(["api", "claude"])(
  "lets unrelated %s work and mail pass a waiting review without breaking conversation order",
  async (harness) => {
    const provider = connection(
      "alice",
      harness === "api"
        ? "{}"
        : JSON.stringify({ loopHarness: harness, authMode: "subscription" }),
    );
    const makeAgent = () => {
      const agent = id();
      seedAgent(db, {
        id: agent,
        owner_id: "alice",
        name: agent,
        normalized_name: agent,
        provider: "openai",
        connection_id: provider,
        model: "fixture-model",
        created_at: now(),
      });
      return agent;
    };
    const builder = makeAgent();
    const enqueue = (agentId: string, conversationId?: string) =>
      submit("alice", {
        agentId,
        conversationId,
        folderId: folder,
        input: "Continue work",
        idempotencyKey: id(),
      });
    const parent = enqueue(builder);
    const active = claim("parent", (r) => r.id === parent.id)!;
    expect(active).toBeDefined();
    await invokeNative(
      active,
      nativeBindings(active).find((b) => b.tool === "loop_request_review")!,
      "review",
      { teamId: team.id, scope: "uncommitted", base: "main" },
    );
    const record = db
      .prepare(
        "SELECT rc.run_id,cr.run_id lead FROM review_continuations rc JOIN code_reviews cr ON cr.id=rc.review_id WHERE rc.parent_run_id=?",
      )
      .get(parent.id) as any;
    transition(active, "completed");
    const later = enqueue(builder, parent.conversation_id!);
    expect(claim("later", (r) => r.id === later.id)).toBeUndefined();
    const unrelated = enqueue(builder);
    const other = claim("unrelated", (r) => r.id === unrelated.id)!;
    expect(other?.id).toBe(unrelated.id);
    transition(other, "completed");
    const sender = enqueue(makeAgent());
    const source = claim("sender", (r) => r.id === sender.id)!;
    const receipt = sendMail(source, "direct", {
      to: builder,
      body: "Unrelated message",
      scope: "direct",
      conversationId: unrelated.conversation_id!,
    });
    const mail = db
      .prepare("SELECT run_id FROM agent_mail WHERE id=?")
      .get(receipt.messageId) as any;
    const delivered = claim("mail", (r) => r.id === mail.run_id)!;
    expect(delivered?.id).toBe(mail.run_id);
    transition(delivered, "completed");
    transition(source, "completed");
    expect(
      claim(
        "still-waiting",
        (r) => r.id === record.run_id || r.id === later.id,
      ),
    ).toBeUndefined();
    db.prepare(
      "UPDATE runs SET state='completed' WHERE id=? OR id IN (SELECT child_run_id FROM delegations WHERE parent_run_id=?)",
    ).run(record.lead, record.lead);
    const follow = claim("follow", (r) => r.id === record.run_id)!;
    expect(follow?.id).toBe(record.run_id);
    expect(claim("ordered", (r) => r.id === later.id)).toBeUndefined();
    transition(follow, "completed");
    const last = claim("last", (r) => r.id === later.id)!;
    expect(last?.id).toBe(later.id);
    transition(last, "completed");
  },
  30000,
);
