import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
import { ZodError } from "zod";
import { NativeOutput } from "../src/server/native-output";
import type { Live } from "../src/server/native-sessions";
import type { Run } from "../src/server/queue";

const dir = mkdtempSync(join(tmpdir(), "loop-brief-changes-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent, Problem } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { transition, claim } =
  await import("../src/server/queue");
const { dismissRun } = await import("../src/server/run-attention");
const { requestApproval, decide } = await import("../src/server/approvals");
const { saveArtifact } = await import("../src/server/artifacts");
const { setSaved, setSavedLabel } = await import("../src/server/mobile-return");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
const { createTeam } = await import("../src/server/teams");
const { sendMail, sweepAgentMail } = await import("../src/server/agent-mail");
const { pollWatch, watchCreatedPullRequest, withGithubFixture } =
  await import("../src/server/pr-watches");
const { recordChange } = await import("../src/server/project-changes");
const { seal } = await import("../src/server/secrets");
const { mobile } = await import("../src/server/mobile-routes");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");

const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", mobile, core, workspace);
app.use((error: any, _req: any, res: any, _next: any) =>
  res
    .status(
      error instanceof Problem
        ? error.status
        : error instanceof ZodError
          ? 400
          : 500,
    )
    .json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function api(owner: string, path: string, method: string, body?: object) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: response.status, data: (await response.json()) as any };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(scoped: boolean | "child" = true, owner: string = id()) {
  const project = scoped ? id() : null,
    connection = id();
  if (project)
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Brief',?)",
    ).run(project, owner, now());
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  let folder = project;
  if (scoped === "child") {
    for (let depth = 0; depth < 2; depth++) {
      const child = id();
      db.prepare(
        "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Child',?)",
      ).run(child, owner, folder, now());
      folder = child;
    }
  }
  const agent = () => {
    const a = createAgent(owner, {
      name: "brief-" + id().slice(0, 8),
      connectionId: connection,
      model: "fixture",
    });
    db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(folder, a.id);
    return a;
  };
  const a = agent();
  const send = (data: Partial<Parameters<typeof submit>[1]> = {}) =>
    submit(owner, {
      agentId: a.id,
      input: "Owner prompt",
      idempotencyKey: id(),
      ...data,
    }) as Run;
  return { owner, project, folder, agent, a, send };
}
type Change = {
  seq: number;
  owner_id: string;
  project_id: string;
  kind: string;
  ref: string;
  conversation_id: string | null;
  at: number;
};
function changes(owner: string, kind?: string) {
  return db
    .prepare(
      "SELECT * FROM project_changes WHERE owner_id=? AND (? IS NULL OR kind=?) ORDER BY seq",
    )
    .all(owner, kind ?? null, kind ?? null) as Change[];
}
const prompt = (run: Run) =>
  (
    db
      .prepare(
        "SELECT id FROM messages WHERE run_id=? AND role='user' ORDER BY rowid LIMIT 1",
      )
      .get(run.id) as { id: string }
  ).id;
function result(run: Run) {
  return saveArtifact(run.owner_id, {
    title: "Answer",
    content: "A cited answer",
    agent: run.agent_id,
    conversation: run.conversation_id,
    run: run.id,
    metadata: { messageId: prompt(run) },
  });
}
function running(run: Run) {
  const claimed = claim(
    "brief-fixture",
    (candidate) => candidate.id === run.id,
  );
  expect(claimed?.id).toBe(run.id);
  return claimed!;
}

it.each(["folder", "project"] as const)(
  "preserves a nested project's own identity inside a %s",
  async (parentKind) => {
    const w = setup(false);
    const parent = await api(w.owner, "/folders", "POST", {
      name: "Parent",
      kind: parentKind,
    });
    expect(parent.status).toBe(201);
    const project = await api(w.owner, "/folders", "POST", {
      name: "Nested project",
      kind: "project",
      parentId: parent.data.id,
    });
    expect(project.status).toBe(201);
    const child = await api(w.owner, "/folders", "POST", {
      name: "Sources",
      kind: "folder",
      parentId: project.data.id,
    });
    expect(child.status).toBe(201);
    db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(
      child.data.id,
      w.a.id,
    );
    const run = running(w.send()),
      artifact = result(run);
    transition(run, "completed");
    setSaved(w.owner, prompt(run), true);
    recordChange(
      w.owner,
      child.data.id,
      "mail",
      "nested-mail",
      run.conversation_id,
    );
    const rows = changes(w.owner);
    expect(rows.map((r) => r.kind)).toEqual([
      "prompt",
      "result",
      "saved",
      "mail",
    ]);
    expect(rows.map((r) => r.project_id)).toEqual(
      Array(4).fill(project.data.id),
    );
    expect(rows[1].ref).toBe(artifact);
  },
);

it.each([true, "child", false] as const)(
  "records owner prompts, including live replies, exactly once (project=%s)",
  async (scoped) => {
    const w = setup(scoped),
      key = id();
    const request = {
      agentId: w.a.id,
      input: "Start",
      idempotencyKey: key,
      queue: true,
    };
    const first = await api(w.owner, "/runs", "POST", request);
    expect(first.status).toBe(202);
    expect((await api(w.owner, "/runs", "POST", request)).data.id).toBe(
      first.data.id,
    );
    const run = running(first.data);
    const reply = {
      conversationId: run.conversation_id!,
      input: "A live correction",
      idempotencyKey: id(),
      steer: true,
    };
    const steered = w.send(reply);
    expect(w.send(reply).id).toBe(steered.id);
    w.send({
      conversationId: run.conversation_id!,
      input: "GitHub update",
      automation: { kind: "github_watch", watchId: "fixture" },
    });
    const rows = changes(w.owner);
    expect(rows).toHaveLength(scoped ? 2 : 0);
    if (scoped) {
      expect(rows.map((r) => r.kind)).toEqual(["prompt", "prompt"]);
      expect(rows.map((r) => r.project_id)).toEqual([w.project, w.project]);
      expect(rows[0].ref).toBe(prompt(run));
      expect(
        db.prepare("SELECT content FROM messages WHERE id=?").get(rows[1].ref),
      ).toEqual({ content: "A live correction" });
    }
  },
);

it.each([true, "child", false] as const)(
  "publishes results only at completion and rolls publication back with the run (project=%s)",
  (scoped) => {
    const w = setup(scoped),
      run = running(w.send()),
      artifact = result(run);
    const created = now() - 60_000;
    db.prepare("UPDATE artifacts SET created_at=? WHERE id=?").run(
      created,
      artifact,
    );
    expect(changes(w.owner, "result")).toEqual([]);
    expect(() =>
      db
        .transaction(() => {
          transition(run, "completed");
          throw new Error("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
    expect(changes(w.owner, "result")).toEqual([]);
    const publishing = now();
    transition(run, "completed");
    db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
    const rows = changes(w.owner, "result");
    expect(rows).toHaveLength(scoped ? 1 : 0);
    if (scoped) {
      expect(rows[0]).toMatchObject({
        project_id: w.project,
        ref: artifact,
        conversation_id: run.conversation_id,
      });
      expect(rows[0].at).toBeGreaterThanOrEqual(publishing);
      expect(rows[0].at).toBeLessThanOrEqual(now());
      expect(rows[0].at).toBeGreaterThan(created);
    }
  },
);

it.each([true, "child", false] as const)(
  "records approval creation and decisions without retry duplicates (project=%s)",
  (scoped) => {
    const w = setup(scoped),
      run = running(w.send());
    const approval = requestApproval(run, { tool: "shell" });
    expect(requestApproval(run, { tool: "shell" }).id).toBe(approval.id);
    transition(run, "awaiting_approval");
    expect(() => decide("intruder", approval.id, "approve")).toThrow();
    decide(w.owner, approval.id, "approve");
    expect(() => decide(w.owner, approval.id, "approve")).toThrow(
      /no longer pending/,
    );
    const automatic = requestApproval(run, { tool: "read" }, true);
    expect(changes(w.owner, "approval_created").map((r) => r.ref)).toEqual(
      scoped ? [approval.id, automatic.id] : [],
    );
    expect(changes(w.owner, "approval_resolved").map((r) => r.ref)).toEqual(
      scoped ? [approval.id, automatic.id] : [],
    );
  },
);

it("records pending approvals rejected by dismissal", () => {
  const w = setup(),
    dismissed = running(w.send());
  const first = requestApproval(dismissed, { tool: "write" });
  transition(dismissed, "awaiting_approval");
  dismissRun(w.owner, dismissed.id);
  dismissRun(w.owner, dismissed.id);
  expect(changes(w.owner, "approval_resolved").map((r) => r.ref)).toEqual([
    first.id,
  ]);
});

it.each([true, "child", false] as const)(
  "records Saved, labels, archive and deletion through production writers (project=%s)",
  async (scoped) => {
    const w = setup(scoped),
      run = running(w.send()),
      message = prompt(run);
    expect(
      (await api("intruder", `/messages/${message}/saved`, "POST")).status,
    ).toBe(404);
    for (let i = 0; i < 2; i++) setSaved(w.owner, message, true);
    for (let i = 0; i < 2; i++)
      setSavedLabel(w.owner, { key: "m:" + message, label: "Decision" });
    setSavedLabel(w.owner, { key: "m:" + message, label: "" });
    for (let i = 0; i < 2; i++) setSaved(w.owner, message, false);
    const artifact = result(run);
    for (let i = 0; i < 2; i++) setSaved(w.owner, message, true);
    setSavedLabel(w.owner, { key: "a:" + artifact, label: "Keep" });
    setSaved(w.owner, message, false);
    const version = () =>
      (
        db
          .prepare("SELECT version FROM artifacts WHERE id=?")
          .get(artifact) as { version: number }
      ).version;
    expect(
      (
        await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
          pinned: true,
          version: version(),
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
            archived: true,
            version: version(),
          })
        ).status,
      ).toBe(200);
    expect(changes(w.owner, "saved").map((r) => r.ref)).toEqual(
      scoped ? [message, artifact, artifact] : [],
    );
    expect(changes(w.owner, "unsaved").map((r) => r.ref)).toEqual(
      scoped ? [message, artifact] : [],
    );
    expect(changes(w.owner, "label").map((r) => r.ref)).toEqual(
      scoped ? [message, message, artifact] : [],
    );
    expect(changes(w.owner, "tombstone").map((r) => r.ref)).toEqual(
      scoped ? [artifact] : [],
    );
    // These tables currently have no hard-delete API; their SQL boundary also
    // serves cascades and future deletion routes.
    db.prepare("DELETE FROM artifacts WHERE id=?").run(artifact);
    db.prepare("DELETE FROM messages WHERE id=?").run(message);
    expect(changes(w.owner, "tombstone").map((r) => r.ref)).toEqual(
      scoped ? [artifact, artifact, message] : [],
    );
  },
);

function native(scoped: boolean | "child") {
  const w = setup(scoped, OWNER),
    run = running(w.send()),
    sessions = new NativeSessions();
  const live = {
    run,
    bootstrapRun: run,
    binding: {
      conversation_id: run.conversation_id!,
      project: dir,
      harness: "claude",
      state: "idle",
    },
    generation: id(),
    requests: new Map(),
    items: new NativeOutput(),
    ready: Promise.resolve(),
    closed: false,
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    adapter: { answer: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
  } as unknown as Live;
  (sessions as any).live.set(run.conversation_id, live);
  const request = (nativeId: string = id()) => {
    sessions.event(live, {
      type: "request",
      request: {
        id: nativeId,
        kind: "approval",
        title: "Run tool?",
        detail: "Fixture permission",
        choices: ["allow", "deny"],
      },
    });
    return db
      .prepare("SELECT id FROM native_decisions WHERE run_id=? AND native_id=?")
      .get(run.id, nativeId) as { id: string };
  };
  return { ...w, run, live, sessions, request };
}

it.each([true, "child", false] as const)(
  "records native decision transitions once, including echoes and recovery (project=%s)",
  async (scoped) => {
    const w = native(scoped),
      before = changes(OWNER).at(-1)?.seq ?? 0;
    const first = w.request("first");
    w.request("first");
    await w.sessions.answer(first.id, "answer", { choice: "allow" });
    await w.sessions.answer(first.id, "answer", { choice: "allow" });
    w.sessions.event(w.live, { type: "resolved", id: "first" });
    const second = w.request("second");
    w.sessions.event(w.live, { type: "resolved", id: "second" });
    w.sessions.event(w.live, { type: "resolved", id: "second" });
    const expired = w.request("expired");
    w.sessions.recover();
    w.sessions.recover();
    const rows = changes(OWNER).filter(
      (r) => r.seq > before && r.conversation_id === w.run.conversation_id,
    );
    expect(rows.map((r) => [r.kind, r.ref])).toEqual(
      scoped
        ? [
            ["decision_created", first.id],
            ["decision_resolved", first.id],
            ["decision_created", second.id],
            ["decision_resolved", second.id],
            ["decision_created", expired.id],
            ["decision_resolved", expired.id],
          ]
        : [],
    );
  },
);

it("records an uncertain native answer once without replaying it", async () => {
  const w = native(true),
    decision = w.request();
  vi.mocked(w.live.adapter.answer).mockRejectedValue(
    new Error("transport lost"),
  );
  await expect(
    w.sessions.answer(decision.id, "uncertain", { choice: "allow" }),
  ).rejects.toThrow(/outcome is unknown/);
  expect(
    await w.sessions.answer(decision.id, "uncertain", { choice: "allow" }),
  ).toEqual({ state: "unknown" });
  expect(w.live.adapter.answer).toHaveBeenCalledTimes(1);
  expect(
    changes(OWNER)
      .filter((r) => r.ref === decision.id)
      .map((r) => r.kind),
  ).toEqual(["decision_created", "decision_resolved"]);
});

it("keeps one confirmed resolution when the answer transport later fails", async () => {
  const w = native(true),
    decision = w.request("confirmed-in-flight");
  vi.mocked(w.live.adapter.answer).mockImplementation(async () => {
    w.sessions.event(w.live, { type: "resolved", id: "confirmed-in-flight" });
    throw new Error("transport closed after confirmation");
  });
  expect(
    await w.sessions.answer(decision.id, "confirmed-command", { choice: "allow" }),
  ).toEqual({ state: "resolved" });
  expect(
    await w.sessions.answer(decision.id, "confirmed-command", { choice: "allow" }),
  ).toEqual({ state: "resolved" });
  expect(w.live.adapter.answer).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT state FROM native_decisions WHERE id=?").get(decision.id))
    .toEqual({ state: "resolved" });
  expect(changes(OWNER).filter((r) => r.ref === decision.id).map((r) => r.kind))
    .toEqual(["decision_created", "decision_resolved"]);
});

it("keeps tombstones when deleting a conversation cascades to its messages", () => {
  const w = setup(),
    conversation = id(),
    message = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,project_id,created_at) VALUES(?,?,'Old thread',?,0)",
  ).run(conversation, w.owner, w.project);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'assistant','Old answer',0)",
  ).run(message, w.owner, conversation);
  db.prepare("DELETE FROM conversations WHERE id=?").run(conversation);
  expect(changes(w.owner, "tombstone").map((r) => r.ref)).toEqual([message]);
  expect(
    db.prepare("SELECT 1 FROM messages WHERE id=?").get(message),
  ).toBeUndefined();
});

it.each([true, "child", false] as const)(
  "records mail delivery and a never-delivered requeue in the recipient's project (project=%s)",
  (scoped) => {
    const w = setup(scoped),
      recipient = w.agent();
    const team = createTeam(w.owner, {
      name: "Brief team",
      managerId: w.a.id,
      members: [recipient.id],
    });
    const sender = running(w.send({ teamId: team.id }));
    const target = running(w.send({ agentId: recipient.id, teamId: team.id }));
    const args = {
      to: recipient.id,
      body: "Review the choice",
      interrupt: true,
    };
    const sent = sendMail(sender, "mail-call", args);
    expect(sendMail(sender, "mail-call", args).messageId).toBe(sent.messageId);
    expect(changes(w.owner, "mail").map((r) => r.ref)).toEqual(
      scoped ? [sent.messageId] : [],
    );
    transition(target, "completed");
    sweepAgentMail();
    sweepAgentMail();
    const rows = changes(w.owner, "mail");
    expect(rows.map((r) => r.ref)).toEqual(
      scoped ? [sent.messageId, sent.messageId] : [],
    );
    for (const row of rows)
      expect(row).toMatchObject({
        project_id: w.project,
        conversation_id: target.conversation_id,
      });
  },
);

it.each([true, "child", false] as const)(
  "records delivered GitHub items and merge state without repeating polls (project=%s)",
  async (scoped) => {
    const w = setup(scoped),
      run = running(w.send());
    transition(run, "completed");
    db.prepare(
      "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,created_at) VALUES(?,?,'GitHub','https://api.githubcopilot.com/mcp/',?,'connected',?)",
    ).run(
      id(),
      w.owner,
      seal(JSON.stringify({ type: "bearer", token: "fixture" }), w.owner),
      now(),
    );
    const watch = watchCreatedPullRequest(run, {
      owner: "acme",
      repo: "brief",
      number: 42,
    })!;
    let merged = false;
    const restore = withGithubFixture(async (url) => {
      const path = new URL(url).pathname;
      const value =
        path === "/user"
          ? { login: "loop" }
          : path.endsWith("/pulls/42")
            ? {
                state: merged ? "closed" : "open",
                merged,
                head: { sha: "a".repeat(40) },
              }
            : path.endsWith("/check-runs")
              ? { total_count: 0, check_runs: [] }
              : path.endsWith("/issues/42/comments")
                ? [
                    {
                      id: 7,
                      user: { login: "owner" },
                      author_association: "OWNER",
                      body: "Proceed",
                      created_at: new Date().toISOString(),
                    },
                  ]
                : [];
      return new Response(JSON.stringify(value), { status: 200 });
    }, "https://github.test");
    try {
      expect(await pollWatch(watch.id)).toBe("delivered");
      expect(await pollWatch(watch.id)).toBe("busy");
      db.prepare(
        "UPDATE runs SET state='completed' WHERE conversation_id=?",
      ).run(run.conversation_id);
      expect(await pollWatch(watch.id)).toBe("quiet");
      merged = true;
      expect(await pollWatch(watch.id)).toBe("ended");
      await pollWatch(watch.id);
      expect(changes(w.owner, "pr_update").map((r) => r.ref)).toEqual(
        scoped ? [`${watch.id}:comment:7`, `${watch.id}:merged:42`] : [],
      );
      expect(changes(w.owner, "prompt")).toHaveLength(scoped ? 1 : 0);
    } finally {
      restore();
    }
  },
);

it("keeps the brief in the conversation's project when a later turn uses another folder", async () => {
  const w = setup(),
    destination = setup("child", w.owner),
    first = running(w.send());
  transition(first, "completed");
  const before = changes(w.owner).at(-1)!.seq;
  const later = running(
    w.send({
      conversationId: first.conversation_id!,
      folderId: destination.folder,
    }),
  );
  expect(JSON.parse(later.payload).folderId).toBe(destination.folder);
  expect(
    db.prepare("SELECT project_id FROM conversations WHERE id=?").get(later.conversation_id),
  ).toEqual({ project_id: w.project });
  const message = prompt(later);
  setSaved(w.owner, message, true);
  // PR 0 explicitly gives the brief's conversation project precedence. Its
  // additive-only contract preserves Saved's existing run-folder filtering.
  expect((await api(w.owner, `/saved?folder=${w.project}`, "GET")).data.items).toEqual([]);
  expect(
    (await api(w.owner, `/saved?folder=${destination.project}`, "GET")).data.items.map(
      (item: any) => item.key,
    ),
  ).toEqual(["m:" + message]);
  const approval = requestApproval(later, { tool: "read" }, true),
    artifact = result(later);
  transition(later, "completed");
  setSaved(w.owner, message, true);
  const rows = changes(w.owner).filter((r) => r.seq > before);
  expect(rows.map((r) => [r.kind, r.ref])).toEqual([
    ["prompt", message],
    ["saved", message],
    ["approval_created", approval.id],
    ["approval_resolved", approval.id],
    ["result", artifact],
    ["saved", artifact],
    ["unsaved", message],
  ]);
  expect(rows.every((r) => r.project_id === w.project)).toBe(true);
});

it.each([true, "child"] as const)(
  "uses the record's own run fallback and rejects foreign owners and ordinary folders (project=%s)",
  (scope) => {
    const w = setup(scope),
      other = setup(),
      run = running(w.send());
    db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
      run.conversation_id,
    );
    // A newer run without a project cannot reattribute this old result/prompt.
    w.send({ conversationId: run.conversation_id!, folderId: null });
    const artifact = result(run);
    transition(run, "completed");
    setSaved(w.owner, prompt(run), true);
    expect(changes(w.owner, "result")[0].project_id).toBe(w.project);
    expect(changes(w.owner, "saved")[0].project_id).toBe(w.project);
    recordChange(other.owner, w.project, "mail", "foreign-project");
    recordChange(
      other.owner,
      other.project,
      "mail",
      "foreign-conversation",
      run.conversation_id,
    );
    recordChange(other.owner, other.project, "saved", artifact);
    expect(changes(other.owner)).toEqual([]);
    const folder = id();
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'folder','Ordinary',0)",
    ).run(folder, w.owner);
    recordChange(w.owner, folder, "mail", "ordinary-folder");
    expect(changes(w.owner, "mail")).toEqual([]);
    // An invalid cross-owner hierarchy must not inherit anybody's project.
    const foreignChild = id();
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Foreign child',0)",
    ).run(foreignChild, other.owner, w.project);
    recordChange(other.owner, foreignChild, "mail", "foreign-child");
    expect(changes(other.owner)).toEqual([]);
  },
);

it.each([true, "child", false] as const)(
  "tracks standalone project artifacts through creation, saving, labels and tombstones (project=%s)",
  async (scope) => {
    const w = setup(scope);
    const created = await api(w.owner, "/artifacts", "POST", {
      title: "Project reference",
      content: "The owner's design note",
      ...(w.folder ? { folder: w.folder } : {}),
    });
    expect(created.status).toBe(201);
    const artifact = created.data.id;
    expect(
      (
        await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
          pinned: true,
          version: 1,
        })
      ).status,
    ).toBe(200);
    setSavedLabel(w.owner, { key: "a:" + artifact, label: "Reference" });
    expect(
      (
        await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
          pinned: false,
          version: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
          archived: true,
          version: 3,
        })
      ).status,
    ).toBe(200);
    db.prepare("DELETE FROM artifacts WHERE id=?").run(artifact);
    const rows = changes(w.owner);
    expect(rows.map((r) => r.kind)).toEqual(
      scope
        ? ["result", "saved", "label", "unsaved", "tombstone", "tombstone"]
        : [],
    );
    for (const row of rows)
      expect(row).toMatchObject({
        project_id: w.project,
        conversation_id: null,
        ref: artifact,
      });
  },
);

it("advances both project cursors when filing a standalone artifact and undoing the move", async () => {
  const w = setup("child"),
    destination = setup(true, w.owner),
    stranger = setup();
  const created = await api(w.owner, "/artifacts", "POST", {
    title: "Reference",
    content: "Evidence",
    folder: w.folder!,
  });
  expect(created.status).toBe(201);
  const artifact = created.data.id;
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        pinned: true,
        version: 1,
      })
    ).status,
  ).toBe(200);
  let cursor = changes(w.owner).at(-1)!.seq;
  const delta = () =>
    changes(w.owner)
      .filter((r) => r.seq > cursor)
      .map((r) => [r.project_id, r.kind, r.ref]);
  const move = (folderId: string | null) =>
    api(w.owner, `/artifacts/${artifact}/move`, "POST", { folderId });
  expect((await move(w.project)).status).toBe(200);
  expect(delta()).toEqual([]); // Child folder to its project: same brief.
  expect((await move(stranger.project)).status).toBe(404);
  expect(delta()).toEqual([]);
  const filed = await move(destination.project);
  expect(filed.status).toBe(200);
  expect(delta()).toEqual([
    [w.project, "tombstone", artifact],
    [destination.project, "result", artifact],
    [destination.project, "saved", artifact],
  ]);
  cursor = changes(w.owner).at(-1)!.seq;
  expect(
    (await api(w.owner, `/operations/${filed.data.operation}/undo`, "POST"))
      .status,
  ).toBe(200);
  expect(
    (await api(w.owner, `/operations/${filed.data.operation}/undo`, "POST"))
      .status,
  ).toBe(409);
  expect(delta()).toEqual([
    [destination.project, "tombstone", artifact],
    [w.project, "result", artifact],
    [w.project, "saved", artifact],
  ]);
  cursor = changes(w.owner).at(-1)!.seq;
  const outside = await move(null);
  expect(outside.status).toBe(200);
  expect(delta()).toEqual([[w.project, "tombstone", artifact]]);
  cursor = changes(w.owner).at(-1)!.seq;
  expect(
    (await api(w.owner, `/operations/${outside.data.operation}/undo`, "POST"))
      .status,
  ).toBe(200);
  expect(delta()).toEqual([
    [w.project, "result", artifact],
    [w.project, "saved", artifact],
  ]);
  cursor = changes(w.owner).at(-1)!.seq;
  expect(() =>
    db
      .transaction(() => {
        db.prepare(
          "UPDATE artifacts SET folder_id=?,updated_at=? WHERE id=?",
        ).run(destination.project, now(), artifact);
        throw new Error("rollback move");
      })
      .immediate(),
  ).toThrow("rollback move");
  expect(delta()).toEqual([]);
});

it("keeps conversation and run scope when a linked result is filed elsewhere", async () => {
  const w = setup("child"),
    destination = setup(true, w.owner),
    run = running(w.send());
  const artifact = result(run);
  transition(run, "completed");
  const before = changes(w.owner);
  const move = () =>
    api(w.owner, `/artifacts/${artifact}/move`, "POST", {
      folderId: destination.project,
    });
  expect((await move()).status).toBe(200);
  db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
    run.conversation_id,
  );
  expect((await move()).status).toBe(200);
  expect(changes(w.owner)).toEqual(before);
  expect(
    db
      .prepare(
        "SELECT project_id FROM project_change_sources WHERE source='artifact' AND ref=?",
      )
      .get(artifact),
  ).toEqual({ project_id: w.project });
});

it("tracks ordinary folder reparenting while preserving nested projects", async () => {
  const w = setup("child"),
    destination = setup(true, w.owner),
    run = running(w.send());
  const artifact = result(run),
    approval = requestApproval(run, { tool: "read" }, true);
  transition(run, "completed");
  setSaved(w.owner, prompt(run), true);
  const decision = id();
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,'fixture',?,'{}','resolved',?)",
  ).run(decision, run.id, run.conversation_id, id(), now());
  const nested = await api(w.owner, "/folders", "POST", {
    name: "Independent project",
    kind: "project",
    parentId: w.folder,
  });
  expect(nested.status).toBe(201);
  const inner = running(w.send({ folderId: nested.data.id })),
    innerArtifact = result(inner);
  transition(inner, "completed");
  let cursor = changes(w.owner).at(-1)!.seq;
  const move = (parentId: string | null) =>
    api(w.owner, `/folders/${w.folder}`, "PATCH", {
      parentId,
      name: "Moved work",
    });
  const delta = () => changes(w.owner).filter((r) => r.seq > cursor);
  expect((await move(destination.project)).status).toBe(200);
  expect(
    delta()
      .filter((r) => r.project_id === w.project)
      .map((r) => [r.kind, r.ref])
      .sort(),
  ).toEqual(
    [
      ["tombstone", artifact],
      ["tombstone", prompt(run)],
      ["tombstone", approval.id],
      ["tombstone", decision],
    ].sort(),
  );
  expect(
    delta()
      .filter((r) => r.project_id === destination.project)
      .map((r) => [r.kind, r.ref])
      .sort(),
  ).toEqual(
    [
      ["result", artifact],
      ["prompt", prompt(run)],
      ["approval_created", approval.id],
      ["approval_resolved", approval.id],
      ["decision_created", decision],
      ["decision_resolved", decision],
      ["saved", artifact],
    ].sort(),
  );
  expect(
    delta().some(
      (r) => r.ref === innerArtifact || r.project_id === nested.data.id,
    ),
  ).toBe(false);
  cursor = changes(w.owner).at(-1)!.seq;
  expect((await move(destination.project)).status).toBe(200);
  expect(delta()).toEqual([]);
  expect((await move(null)).status).toBe(200);
  expect(delta()).toHaveLength(4);
  expect(
    delta().every(
      (r) => r.kind === "tombstone" && r.project_id === destination.project,
    ),
  ).toBe(true);
  cursor = changes(w.owner).at(-1)!.seq;
  expect((await move(w.project)).status).toBe(200);
  expect(delta()).toHaveLength(7);
  expect(delta().every((r) => r.project_id === w.project)).toBe(true);
  expect(
    db
      .prepare(
        "SELECT project_id FROM project_change_sources WHERE source='artifact' AND ref=?",
      )
      .get(innerArtifact),
  ).toEqual({ project_id: nested.data.id });
  cursor = changes(w.owner).at(-1)!.seq;
  expect(
    (
      await api(w.owner, `/folders/${nested.data.id}`, "PATCH", {
        parentId: destination.project,
      })
    ).status,
  ).toBe(200);
  expect(delta()).toEqual([]);
});

it("retains archived source history without making archived artifacts visible", async () => {
  const w = setup("child"),
    destination = setup(true, w.owner);
  const create = () =>
    api(w.owner, "/artifacts", "POST", {
      title: "Archived evidence",
      content: "Record",
      folder: w.folder!,
    });
  const first = await create(),
    second = await create();
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  for (const artifact of [first.data.id, second.data.id])
    expect(
      (
        await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
          archived: true,
          pinned: true,
          version: 1,
        })
      ).status,
    ).toBe(200);
  expect(
    (
      await api(w.owner, `/artifacts/${first.data.id}/move`, "POST", {
        folderId: destination.project,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(w.owner, `/folders/${w.folder}`, "PATCH", {
        parentId: destination.project,
      })
    ).status,
  ).toBe(200);
  expect(
    changes(w.owner).some(
      (r) =>
        r.project_id === destination.project &&
        r.kind === "result" &&
        r.ref === first.data.id,
    ),
  ).toBe(true);
  expect(
    changes(w.owner).some(
      (r) =>
        r.project_id === destination.project &&
        r.kind === "saved" &&
        r.ref === second.data.id,
    ),
  ).toBe(true);
  expect((await api(w.owner, "/artifacts", "GET")).data.items).toEqual([]);
  expect((await api(w.owner, "/saved", "GET")).data.items).toEqual([]);
  expect(
    db
      .prepare("SELECT archived FROM artifacts WHERE id IN (?,?)")
      .all(first.data.id, second.data.id),
  ).toEqual([{ archived: 1 }, { archived: 1 }]);
});

it("records restoring an archived artifact once, including its retained save", async () => {
  const w = setup(),
    created = await api(w.owner, "/artifacts", "POST", {
      title: "Record",
      content: "Evidence",
      folder: w.project!,
    });
  const artifact = created.data.id;
  expect(created.status).toBe(201);
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        pinned: true,
        archived: true,
        version: 1,
      })
    ).status,
  ).toBe(200);
  const cursor = changes(w.owner).at(-1)!.seq;
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        archived: false,
        version: 2,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        archived: false,
        version: 3,
      })
    ).status,
  ).toBe(200);
  expect(
    changes(w.owner)
      .filter((r) => r.seq > cursor)
      .map((r) => [r.kind, r.ref]),
  ).toEqual([
    ["result", artifact],
    ["saved", artifact],
  ]);
  expect(
    (await api(w.owner, "/artifacts", "GET")).data.items.map((a: any) => a.id),
  ).toEqual([artifact]);
  expect(
    (await api(w.owner, "/saved", "GET")).data.items.map(
      (item: any) => item.key,
    ),
  ).toEqual(["a:" + artifact]);
});

it("records earlier conversation history when submit first assigns a project", () => {
  const w = setup(false),
    destination = setup("child", w.owner),
    first = running(w.send());
  const artifact = result(first),
    approval = requestApproval(first, { tool: "read" }, true);
  transition(first, "completed");
  setSaved(w.owner, prompt(first), true);
  expect(changes(w.owner)).toEqual([]);
  const next = w.send({
    conversationId: first.conversation_id!,
    folderId: destination.folder,
  });
  expect(
    changes(w.owner)
      .map((r) => [r.kind, r.ref])
      .sort(),
  ).toEqual(
    [
      ["result", artifact],
      ["prompt", prompt(first)],
      ["approval_created", approval.id],
      ["approval_resolved", approval.id],
      ["saved", artifact],
      ["prompt", prompt(next)],
    ].sort(),
  );
  expect(
    changes(w.owner).every((r) => r.project_id === destination.project),
  ).toBe(true);
  const before = changes(w.owner).length;
  w.send({
    conversationId: first.conversation_id!,
    folderId: destination.folder,
  });
  expect(changes(w.owner)).toHaveLength(before + 1);
});

it("records queued prompt edits and published source edits without publishing running placeholders", async () => {
  const w = setup(),
    queued = w.send();
  const message = prompt(queued);
  for (let i = 0; i < 2; i++)
    expect(
      (
        await api(w.owner, `/runs/${queued.id}`, "PATCH", {
          input: "Corrected owner prompt",
        })
      ).status,
    ).toBe(200);
  expect(changes(w.owner, "prompt").map((r) => r.ref)).toEqual([
    message,
    message,
  ]);
  const run = running(queued),
    artifact = result(run);
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        content: "Draft edit",
        version: 1,
      })
    ).status,
  ).toBe(200);
  expect(changes(w.owner, "result")).toEqual([]);
  transition(run, "completed");
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        content: "Updated evidence",
        version: 2,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
        content: "Updated evidence",
        version: 3,
      })
    ).status,
  ).toBe(200);
  expect(changes(w.owner, "result").map((r) => r.ref)).toEqual([
    artifact,
    artifact,
  ]);
  const automatic = w.send({
    automation: { kind: "github_watch", watchId: "fixture" },
  });
  db.prepare("UPDATE messages SET content='Updated automation' WHERE id=?").run(
    prompt(automatic),
  );
  expect(changes(w.owner, "prompt").map((r) => r.ref)).toEqual([
    message,
    message,
  ]);
});

it.each(["unsave", "normalize", "legacy-both"] as const)(
  "records the disappearing message bookmark when a result appears (%s)",
  async (mode) => {
    const w = setup(),
      run = running(w.send()),
      message = prompt(run);
    setSaved(w.owner, message, true);
    const artifact = result(run);
    transition(run, "completed");
    if (mode === "legacy-both")
      expect(
        (
          await api(w.owner, `/artifacts/${artifact}`, "PATCH", {
            pinned: true,
            version: 1,
          })
        ).status,
      ).toBe(200);
    const cursor = changes(w.owner).at(-1)!.seq;
    const on = mode === "normalize";
    const send = () =>
      api(w.owner, `/messages/${message}/saved`, on ? "POST" : "DELETE");
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(
      changes(w.owner)
        .filter((r) => r.seq > cursor)
        .map((r) => [r.kind, r.ref]),
    ).toEqual([
      ...(mode === "normalize"
        ? [["saved", artifact]]
        : mode === "legacy-both"
          ? [["unsaved", artifact]]
          : []),
      ["unsaved", message],
    ]);
    expect(
      db
        .prepare("SELECT 1 FROM message_bookmarks WHERE message_id=?")
        .get(message),
    ).toBeUndefined();
    expect(
      (await api(w.owner, "/saved", "GET")).data.items.map(
        (item: any) => item.key,
      ),
    ).toEqual(on ? ["a:" + artifact] : []);
  },
);

it.each([true, "child"] as const)(
  "backfills the same scoped records as live writers and uses the indexed monotonic cursor (project=%s)",
  async (scope) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const w = setup(scope);
    try {
      const run = running(w.send()),
        message = prompt(run);
      setSaved(w.owner, message, true);
      const artifact = result(run);
      // Preserve both legacy saves (the backfill must not drop either).
      db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(artifact);
      recordChange(w.owner, undefined, "saved", artifact);
      const approval = requestApproval(run, { tool: "read" }, true);
      requestApproval(run, { tool: "write" });
      transition(run, "completed");
      w.send({ automation: { kind: "github_watch", watchId: "fixture" } });
      const unscoped = setup(false),
        unscopedRun = running(unscoped.send());
      result(unscopedRun);
      transition(unscopedRun, "completed");
      const standalone = await api(w.owner, "/artifacts", "POST", {
        title: "Project note",
        content: "Saved evidence",
        folder: w.folder!,
      });
      expect(standalone.status).toBe(201);
      expect(
        (
          await api(w.owner, `/artifacts/${standalone.data.id}`, "PATCH", {
            pinned: true,
            version: 1,
          })
        ).status,
      ).toBe(200);
      // Historical publication time is unavailable: PR 0 explicitly uses the
      // artifact's creation time for backfill, while live publication uses now.
      const expected = changes(w.owner).map(({ seq, ...row }) => ({
        ...row,
        at:
          row.kind === "result"
            ? (
                db
                  .prepare("SELECT created_at FROM artifacts WHERE id=?")
                  .get(row.ref) as { created_at: number }
              ).created_at
            : row.at,
      }));
      // Existing native decisions predate the new application hooks. Seed the
      // upgrade fixture and assert their exact historical cursor entries.
      const historical = ["pending", "resolved", "unknown", "expired"];
      for (const state of historical) {
        const decision = id();
        db.prepare(
          "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,'legacy',?,'{}',?,?)",
        ).run(decision, run.id, run.conversation_id, id(), state, now());
        for (const kind of state === "pending"
          ? ["decision_created"]
          : ["decision_created", "decision_resolved"])
          expected.push({
            owner_id: w.owner,
            project_id: w.project!,
            kind,
            ref: decision,
            conversation_id: run.conversation_id,
            at: now(),
          });
      }
      expect(
        expected.some(
          (r) => r.ref === approval.id && r.kind === "approval_resolved",
        ),
      ).toBe(true);
      const legacyPath = join(dir, `legacy-${id()}.db`);
      await db.backup(legacyPath);
      const legacy = new Database(legacyPath);
      try {
        // A copy without PR 0 represents the pre-upgrade database. No source
        // rows are recreated or rewritten; run the actual migration over them.
        for (const { name } of legacy
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'project_change_%'",
          )
          .all() as { name: string }[])
          legacy.exec(`DROP TRIGGER ${name}`);
        legacy.exec(
          "DROP VIEW project_change_entries; DROP VIEW project_change_sources; DROP VIEW project_change_folders; DROP TABLE project_changes; DELETE FROM schema_version WHERE version=77",
        );
        // The handoff explicitly backfills retained publications/pins and skips
        // inferred historical tombstones, even if a source was archived before
        // upgrade. Its current archived state must remain authoritative.
        legacy
          .prepare("UPDATE artifacts SET archived=1 WHERE id=?")
          .run(standalone.data.id);
        legacy.exec(readFileSync("migrations/077-project-changes.sql", "utf8"));
        expect(
          legacy
            .prepare("SELECT archived FROM artifacts WHERE id=?")
            .get(standalone.data.id),
        ).toEqual({ archived: 1 });
        const actual = legacy
          .prepare(
            "SELECT owner_id,project_id,kind,ref,conversation_id,at FROM project_changes WHERE owner_id=?",
          )
          .all(w.owner);
        const sort = (rows: any[]) =>
          rows.sort((a, b) =>
            `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`),
          );
        expect(sort(actual)).toEqual(sort(expected));
        expect(
          legacy
            .prepare("SELECT * FROM project_changes WHERE owner_id=?")
            .all(unscoped.owner),
        ).toEqual([]);
      } finally {
        legacy.close();
      }
      const rows = changes(w.owner);
      expect(rows.every((row, i) => i === 0 || row.seq > rows[i - 1].seq)).toBe(
        true,
      );
      const page = db
        .prepare(
          "SELECT * FROM project_changes WHERE owner_id=? AND project_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(w.owner, w.project, rows[1].seq, 2);
      expect(page).toEqual(rows.slice(2, 4));
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM project_changes WHERE owner_id=? AND project_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(w.owner, w.project, 0, 40) as { detail: string }[];
      expect(plan.map((p) => p.detail).join("\n")).toContain(
        "USING INDEX project_changes_cursor",
      );
    } finally {
      clock.mockRestore();
    }
  },
);
