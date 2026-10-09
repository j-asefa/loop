import { afterAll, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop-presets-"));
process.env.LOOP_DATA_DIR = join(dir, "data");
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
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

function connection(owner = "alice", metadata = "{}") {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
  ).run(
    c,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture-model" }]),
    metadata,
    now(),
  );
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
const app = express();
app.use(
  express.json(),
  (req, res, next) => {
    res.locals.owner = req.get("x-owner") || "bob";
    next();
  },
  teams,
  core,
);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const url = "http://127.0.0.1:" + (server.address() as any).port;
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
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
  for (const connectionId of [foreign, native]) {
    expect(() =>
      createPresetTeam("alice", {
        ...details,
        idempotencyKey: id(),
        roles: { regressions: { connectionId, model: "fixture-model" } },
      }),
    ).toThrow();
    expect((db.prepare("SELECT count(*) n FROM agents").get() as any).n).toBe(
      count,
    );
  }
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
  expect(work.files["caller.ts"]).toContain("import");
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
    expect(await executeAgent(first)).toBe(true);
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
      conversationId: review.conversationId,
      input: "Explain the first finding",
      idempotencyKey: id(),
    });
    expect(JSON.parse(followup.payload).reviewId).toBe(review.id);
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
    headers: { "x-owner": "alice", "content-type": "application/json" },
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
