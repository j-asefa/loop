import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
const dir = mkdtempSync(join(tmpdir(), "loop-project-status-"));
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, now } = await import("../src/server/db");
const { Problem } = await import("../src/server/domain");
const { mobile } = await import("../src/server/mobile-routes");
const { core } = await import("../src/server/core-routes");
const { briefs } = await import("../src/server/briefs/routes");
const { applyOutput } = await import("../src/server/briefs/apply");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", mobile);
app.use("/api", core);
app.use("/api", briefs);
app.use((e: any, _req: any, res: any, _next: any) =>
  res
    .status(e instanceof Problem ? e.status : e instanceof ZodError ? 400 : 500)
    .json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function api(
  owner: string,
  path = "/projects/status",
  method = "GET",
  body?: unknown,
) {
  const r = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: r.status, data: (await r.json()) as any };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(owner = id(), at = now()) {
  const project = id(),
    agent = id(),
    connection = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Release',?)",
  ).run(project, owner, at);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','private','connected','[]',?)",
  ).run(connection, owner, at);
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,folder_id,created_at) VALUES(?,?,?,?,'openai',?,'fixture',?,?)",
  ).run(agent, owner, agent, agent, connection, project, at);
  const run = (
    state: string,
    time = at,
    team: string | null = null,
    folder = project,
  ) => {
    const conversation = id(),
      run = id();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,team_id,created_at) VALUES(?,?,?,'Reconnect fix',?,?,?)",
    ).run(conversation, owner, agent, folder, team, time);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at,worker_id) VALUES(?,?,?,?,'Fix reconnect',?,?,?, ?,?,'worker')",
    ).run(
      run,
      owner,
      agent,
      conversation,
      state,
      run,
      JSON.stringify({ folderId: folder }),
      time,
      time,
    );
    return { run, conversation };
  };
  const approval = (r: ReturnType<typeof run>, time = at) => {
    const aid = id();
    db.prepare(
      "INSERT INTO approvals VALUES(?,?,?,?,?,'pending',NULL,?,?)",
    ).run(aid, owner, r.run, "digest", "{}", time, now() + 60_000);
    return aid;
  };
  const publish = (items: any[] = []) => {
    const r = run("completed"),
      message = id();
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Record this work',?)",
    ).run(message, owner, r.conversation, r.run, at);
    const cite = [{ ref: `msg_${message}` }];
    const result = applyOutput(
      owner,
      project,
      {
        headline: { text: "Reconnect is ready", cite },
        items: items.map((i) => ({ ...i, cite })),
      },
      { builtOnVersion: 0, ownerEditRev: 0, basisThrough: 0 },
    );
    expect(result.outcome).toBe("published");
    db.prepare(
      "UPDATE brief_state SET enabled=1,last_error=NULL WHERE owner_id=? AND project_id=?",
    ).run(owner, project);
  };
  const watch = (
    r: ReturnType<typeof run>,
    number: number,
    conclusion: string,
    time = at,
  ) => {
    const wid = id();
    db.prepare(
      "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,head_sha,ci_sha,ci_conclusion,seen_ci_sha,seen_ci_conclusion,read_at,created_at,updated_at) VALUES(?,?,?,?,'acme','web',?,'watching','head','head',?,'head',?,?,?,?)",
    ).run(
      wid,
      owner,
      r.conversation,
      agent,
      number,
      conclusion,
      conclusion,
      time,
      time,
      time,
    );
    return wid;
  };
  return { owner, project, agent, connection, run, approval, publish, watch };
}
const unfinished = (thread: string) => ({
  kind: "unfinished",
  text: "Await design",
  thread,
  next: "Review design",
  blocker: "Waiting for design",
  cite: [],
});

it("provides only this owner's agent names and formats task previews before truncation", async () => {
  const f = fixture(),
    other = fixture();
  db.prepare("UPDATE agents SET name='forest' WHERE id=?").run(f.agent);
  db.prepare("UPDATE agents SET name='private-agent' WHERE id=?").run(
    other.agent,
  );
  const r = f.run("completed");
  const input = `Review ${"YWJj".repeat(100)} with @${f.agent}, then fix the layout.`;
  db.prepare("UPDATE runs SET input=? WHERE id=?").run(input, r.run);
  const { data, status } = await api(f.owner);
  expect(status).toBe(200);
  expect(data.agents).toEqual([{ id: f.agent, name: "forest" }]);
  expect(data.items[0].evidence).toMatchObject({
    run_id: r.run,
    conversation: r.conversation,
    agent: "forest",
    task: "Review [encoded content omitted] with @forest, then fix the layout.",
  });
  expect(db.prepare("SELECT input FROM runs WHERE id=?").get(r.run)).toEqual({
    input,
  });
});

it("uses live precedence, deduplicates waiting work with its request, and revalidates the selected action", async () => {
  const f = fixture(),
    active = f.run("running"),
    paused = f.run("awaiting_approval"),
    aid = f.approval(paused);
  f.publish([unfinished(paused.conversation)]);
  const view = await api(f.owner);
  expect(view.status).toBe(200);
  let p = view.data.items[0];
  expect(p).toMatchObject({
    status: "needs_you",
    counts: { needs: 1, working: 1, queued: 0 },
    brief: { blockers: 1 },
    older: false,
  });
  expect(p.actions[0]).toMatchObject({
    key: `approval:${aid}`,
    ref: aid,
    conversation: paused.conversation,
  });
  expect(
    (
      await api(
        f.owner,
        `/projects/${f.project}/status-action?key=approval:${aid}`,
      )
    ).status,
  ).toBe(200);
  db.prepare("UPDATE approvals SET state='approved' WHERE id=?").run(aid);
  expect(
    (
      await api(
        f.owner,
        `/projects/${f.project}/status-action?key=approval:${aid}`,
      )
    ).status,
  ).toBe(409);
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(paused.run);
  p = (await api(f.owner)).data.items[0];
  expect(p.status).toBe("working"); // blocker remains visible, work progresses
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(active.run);
  expect((await api(f.owner)).data.items[0].status).toBe("blocked");
  db.prepare("UPDATE brief_items SET status='done' WHERE project_id=?").run(
    f.project,
  );
  f.run("queued");
  expect((await api(f.owner)).data.items[0].status).toBe("queued");
});

it("removes cancelled approvals from Status and rejects their cached action targets", async () => {
  const f = fixture(),
    r = f.run("awaiting_approval"),
    aid = f.approval(r);
  const action = `/projects/${f.project}/status-action?key=approval:${aid}`;
  expect((await api(f.owner, action)).status).toBe(200);
  expect((await api(f.owner, `/runs/${r.run}/cancel`, "POST")).status).toBe(
    200,
  );
  // Cancellation leaves the pending row for its history; it is not actionable.
  expect(db.prepare("SELECT state FROM approvals WHERE id=?").get(aid)).toEqual(
    { state: "pending" },
  );
  expect((await api(f.owner)).data.items[0]).toMatchObject({
    status: "idle",
    counts: { needs: 0 },
    actions: [],
  });
  expect((await api(f.owner, action)).status).toBe(409);
});

it("includes native questions, failed/interrupted work and unsent messages without needing a brief", async () => {
  const f = fixture(),
    r = f.run("awaiting_approval"),
    failed = f.run("failed"),
    interrupted = f.run("interrupted"),
    d = id(),
    send = id();
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,generation,state,updated_at) VALUES(?,'codex','/fixture','g','running',?)",
  ).run(r.conversation, now());
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,'g','q',?,'pending',?)",
  ).run(
    d,
    r.run,
    r.conversation,
    JSON.stringify({ questions: [{ question: "Choose" }] }),
    now(),
  );
  db.prepare(
    "INSERT INTO scheduled_sends(id,owner_id,agent_id,input,idempotency_key,send_at,state,created_at) VALUES(?,?,?,'Send',?,?,'failed',?)",
  ).run(send, f.owner, f.agent, send, now(), now());
  let p = (await api(f.owner)).data.items[0];
  expect(p.counts.needs).toBe(4);
  expect(p.actions.map((a: any) => a.kind)).toEqual([
    "answer",
    "failed",
    "failed",
    "not_sent",
  ]);
  expect(p.brief).toMatchObject({
    state: "never",
    unfinished: null,
    questions: null,
    blockers: null,
  });
  expect(p.actions[0].key).toBe(`decision:${d}`);
  db.prepare(
    "UPDATE companion_sessions SET generation='new' WHERE conversation_id=?",
  ).run(r.conversation);
  expect(
    (
      await api(
        f.owner,
        `/projects/${f.project}/status-action?key=decision:${d}`,
      )
    ).status,
  ).toBe(409);
  db.prepare("UPDATE runs SET attention_dismissed_at=? WHERE id IN (?,?)").run(
    now(),
    failed.run,
    interrupted.run,
  );
  p = (await api(f.owner)).data.items[0];
  expect(p.actions.map((a: any) => a.kind)).toEqual(["resume", "not_sent"]);
  db.prepare(
    "UPDATE companion_sessions SET generation='g' WHERE conversation_id=?",
  ).run(r.conversation);
  expect((await api(f.owner, `/runs/${r.run}/cancel`, "POST")).status).toBe(
    200,
  );
  expect(
    (
      await api(
        f.owner,
        `/projects/${f.project}/status-action?key=decision:${d}`,
      )
    ).status,
  ).toBe(409);
  expect(
    (await api(f.owner)).data.items[0].actions.map((a: any) => a.kind),
  ).toEqual(["not_sent"]);
});

it("remembers enablement when a brief is disabled before its first generation", async () => {
  const f = fixture();
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,goal) VALUES(?,?,'Goal without enabling')",
  ).run(f.owner, f.project);
  expect((await api(f.owner)).data.items[0].brief.state).toBe("never");
  db.prepare(
    'UPDATE connections SET models=\'[{"id":"fixture"}]\' WHERE id=?',
  ).run(f.connection);
  const settings = `/projects/${f.project}/brief/settings`;
  expect(
    (
      await api(f.owner, settings, "PUT", {
        enabled: true,
        connectionId: f.connection,
        model: "fixture",
      })
    ).status,
  ).toBe(200);
  expect((await api(f.owner)).data.items[0].brief.state).toBe("pending");
  expect(
    (
      await api(f.owner, settings, "PUT", {
        enabled: false,
        connectionId: null,
        model: null,
      })
    ).status,
  ).toBe(200);
  expect((await api(f.owner)).data.items[0].brief).toMatchObject({
    state: "off",
    headline: null,
    questions: null,
    unfinished: null,
  });
});

it("distinguishes all no-brief states, counts overflow, and never acknowledges a brief", async () => {
  const f = fixture();
  expect((await api(f.owner)).data.items[0].brief.state).toBe("never");
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,enabled) VALUES(?,?,1)",
  ).run(f.owner, f.project);
  expect((await api(f.owner)).data.items[0].brief.state).toBe("pending");
  db.prepare(
    "UPDATE brief_state SET last_error='provider unavailable' WHERE project_id=?",
  ).run(f.project);
  expect((await api(f.owner)).data.items[0].brief).toMatchObject({
    state: "failed",
    questions: null,
    unfinished: null,
  });
  f.publish(
    Array.from({ length: 12 }, (_, i) => ({
      kind: "question",
      text: `Question ${i}`,
      asked_by: "you",
      cite: [],
    })),
  );
  let p = (await api(f.owner)).data.items[0];
  expect(p.brief).toMatchObject({ state: "ready", questions: 12 });
  expect(p.brief.synthesized_at).toBeGreaterThan(0);
  db.prepare("UPDATE brief_state SET enabled=0 WHERE project_id=?").run(
    f.project,
  );
  p = (await api(f.owner)).data.items[0];
  expect(p.brief).toMatchObject({
    state: "off",
    headline: "Reconnect is ready",
    questions: 12,
  });
  expect(
    db.prepare("SELECT * FROM brief_acks WHERE owner_id=?").all(f.owner),
  ).toEqual([]);
});

it("collapses only old inactive projects with known clear blockers, never on watch polling or synthesis", async () => {
  const old = now() - 40 * 24 * 3600_000,
    f = fixture(undefined, old),
    r = f.run("completed", old);
  f.publish();
  const watch = f.watch(r, 2, "success", old);
  db.prepare("UPDATE pr_watches SET updated_at=?,read_at=? WHERE id=?").run(
    now(),
    now(),
    watch,
  );
  let p = (await api(f.owner)).data.items[0];
  expect(p).toMatchObject({
    older: true,
    status: "idle",
    last_activity_at: old,
  });
  f.run("queued", old);
  expect((await api(f.owner)).data.items[0].older).toBe(false);
  const unknown = fixture(undefined, old);
  expect((await api(unknown.owner)).data.items[0]).toMatchObject({
    older: false,
    brief: { blockers: null },
  });
});

it("binds checks to the displayed run and preserves older red PRs with independent times", async () => {
  const f = fixture(),
    captured = f.run("completed", now() - 5000),
    other = f.run("completed", now());
  const summary = {
    id: "capture",
    state: "captured",
    branch: "feature",
    base_ref: "main",
    ahead: 1,
    behind: 0,
    files: 1,
    additions: 12,
    deletions: 3,
    untracked: 0,
    remote: "unknown",
    started_dirty: false,
    overlap: 0,
    late: false,
    error: null,
  };
  db.prepare(
    "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state,summary,ended_at) VALUES(?,?,?,?,?,'/work','/source','feature','sha',0,0,?,'captured',?,?)",
  ).run(
    "capture",
    f.owner,
    captured.run,
    f.agent,
    captured.conversation,
    now() - 5000,
    JSON.stringify(summary),
    now() - 4000,
  );
  const verification = id();
  db.prepare(
    "INSERT INTO run_verifications(id,owner_id,run_id,kind,tools,command,status,exit_code,observed_at) VALUES(?,?,?,'test','[\"vitest\"]','vitest','passed',0,?)",
  ).run(verification, f.owner, other.run, now() - 6000);
  const red = f.watch(captured, 1, "failure", now() - 20_000);
  f.watch(other, 2, "success", now());
  let p = (await api(f.owner)).data.items[0];
  expect(p.evidence).toMatchObject({
    run_id: captured.run,
    checkout: summary,
    verification: null,
    telemetry: "unavailable",
  });
  expect(p.pulls.map((p: any) => p.state.number)).toEqual([1, 2]);
  expect(p.pulls[0].id).toBe(red);
  expect(p.evidence).not.toHaveProperty("pull");
  expect(p.pulls[0].state.checked_at).toBeLessThan(p.evidence.checkout_at);
  db.prepare(
    "INSERT INTO agent_activities(owner_id,scope,activity_key,conversation_id,run_id,kind,record,sequence,created_at,updated_at) VALUES(?,?,'out',?,?,'output',?,1,?,?)",
  ).run(
    f.owner,
    captured.conversation,
    captured.conversation,
    captured.run,
    JSON.stringify({ data: { command: "git status", status: "exited" } }),
    now() - 3000,
    now() - 3000,
  );
  p = (await api(f.owner)).data.items[0];
  expect(p.evidence).toMatchObject({
    verification: null,
    telemetry: "observed",
  });
  // The newest observation wins, even when that run's checkout is older.
  const otherCapture = id();
  db.prepare(
    "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state,summary,ended_at) VALUES(?,?,?,?,?,'/work','/source','feature','sha',0,0,?,'captured',?,?)",
  ).run(
    otherCapture,
    f.owner,
    other.run,
    f.agent,
    other.conversation,
    now() - 8000,
    JSON.stringify({ ...summary, id: otherCapture }),
    now() - 7000,
  );
  db.prepare("UPDATE run_verifications SET observed_at=? WHERE id=?").run(
    now(),
    verification,
  );
  p = (await api(f.owner)).data.items[0];
  expect(p.evidence).toMatchObject({
    run_id: other.run,
    checkout: { id: otherCapture },
    verification: { items: [{ id: verification }] },
  });
  expect(p.evidence.verification_at).toBeGreaterThan(p.evidence.checkout_at);
});

it("scopes owners and teams while retaining whole-project brief counts", async () => {
  const f = fixture(),
    stranger = fixture(),
    team = id();
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,'Review',?,?)",
  ).run(team, f.owner, f.agent, now());
  f.run("running", now(), team);
  f.approval(f.run("paused"));
  f.publish([
    { kind: "question", text: "Whole project?", asked_by: "you", cite: [] },
  ]);
  const response = await api(f.owner, `/projects/status?teams=${team}`);
  expect(response.status).toBe(200);
  expect(response.data.owner_id).toBe(f.owner);
  expect(response.data.teams).toEqual([team]);
  expect(response.data.items).toHaveLength(1);
  expect(response.data.items[0]).toMatchObject({
    id: f.project,
    status: "working",
    counts: { needs: 0, working: 1, queued: 0 },
    brief: { questions: 1 },
  });
  expect(
    (await api(stranger.owner, `/projects/status?project=${f.project}`)).status,
  ).toBe(404);
  expect(
    (await api(stranger.owner, `/projects/status?teams=${team}`)).status,
  ).toBe(404);
  expect(JSON.stringify(response.data)).not.toContain("private");
});

it("deduplicates observed PR review requests and ignores stale-head reviewer lists", async () => {
  const f = fixture(),
    first = f.run("completed"),
    second = f.run("completed");
  const watch = f.watch(first, 42, "failure"),
    duplicate = f.watch(second, 42, "failure");
  db.prepare("UPDATE pr_watches SET login='james' WHERE id IN (?,?)").run(
    watch,
    duplicate,
  );
  const artifact = id();
  const content = (headSha: string, reviewers: string[]) =>
    JSON.stringify({
      type: "github_pull_requests",
      pulls: [
        {
          owner: "acme",
          repo: "web",
          number: 42,
          state: "open",
          headSha,
          reviewers,
        },
      ],
    });
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,'PR','github_pr',?,?,?)",
  ).run(
    artifact,
    f.owner,
    f.agent,
    first.conversation,
    first.run,
    content("head", ["james"]),
    now(),
    now(),
  );
  db.prepare(
    "INSERT OR IGNORE INTO artifact_publications(artifact_id) VALUES(?)",
  ).run(artifact);
  let p = (await api(f.owner)).data.items[0];
  expect(p.counts.needs).toBe(1);
  expect(p.actions[0]).toMatchObject({
    kind: "review",
    key: "review:acme/web/42",
    pull: { owner: "acme", repo: "web", number: 42 },
  });
  expect(p.pulls).toHaveLength(2);
  const target = p.actions[0].key;
  expect(
    (
      await api(
        f.owner,
        `/projects/${f.project}/status-action?key=${encodeURIComponent(target)}`,
      )
    ).data,
  ).toMatchObject({
    kind: "review",
    pull: { owner: "acme", repo: "web", number: 42 },
  });
  db.prepare("UPDATE artifacts SET content=? WHERE id=?").run(
    content("old-head", ["james"]),
    artifact,
  );
  p = (await api(f.owner)).data.items[0];
  expect(p.counts.needs).toBe(0);
  expect(
    (
      await api(
        f.owner,
        `/projects/${f.project}/status-action?key=${encodeURIComponent(target)}`,
      )
    ).status,
  ).toBe(409);
});

it("keeps nested project evidence in its recorded scope and a deterministic action order", async () => {
  const f = fixture(),
    nested = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,parent_id,created_at) VALUES(?,?,'project','Nested',?,?)",
  ).run(nested, f.owner, f.project, now());
  const r = f.run("awaiting_approval", now(), null, nested);
  const first = f.approval(r, 100),
    second = f.approval(r, 100);
  const page = (await api(f.owner)).data;
  const p = page.items.find((p: any) => p.id === nested);
  expect(p.counts.needs).toBe(2); // two requests, no third waiting-run item
  expect(p.actions.map((a: any) => a.ref)).toEqual([first, second].sort());
  expect(p.evidence.run_id).toBe(r.run);
  expect(page.items.find((p: any) => p.id === f.project).counts.needs).toBe(0);
});

it("summarizes active project records with paired blockers and next steps, bounded and owner scoped", async () => {
  const f = fixture(),
    other = fixture(f.owner),
    outsider = fixture();
  const task = f.run("completed"),
    unblocked = f.run("completed");
  f.publish([
    ...Array.from({ length: 4 }, (_, i) => ({
      kind: "state",
      text: `Progress ${i}`,
    })),
    {
      ...unfinished(task.conversation),
      text: "Repair tab persistence",
      next: "Save the selected tab",
      blocker: "Tab resets on reload",
    },
    {
      ...unfinished(unblocked.conversation),
      text: "Update docs",
      next: "Write setup guide",
      blocker: "",
    },
    { kind: "question", text: "Should filters persist too?", asked_by: "you" },
    {
      kind: "question",
      text: "Already answered",
      asked_by: "you",
      status: "dropped",
    },
    { kind: "state", text: "Old progress", status: "retired" },
  ]);
  other.publish([{ kind: "state", text: "Other project" }]);
  outsider.publish([{ kind: "state", text: "Private project" }]);
  const team = id();
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?, ?, 'Summary scope', ?, ?)",
  ).run(team, f.owner, f.agent, now());
  let result = await api(
    f.owner,
    `/projects/status?project=${f.project}&teams=${team}`,
  );
  let p = result.data.items[0];
  expect(result.data.items).toHaveLength(1);
  expect(p.brief.highlights.progress).toHaveLength(2);
  expect(p.brief.highlights.task).toMatchObject({
    text: "Repair tab persistence",
    next: "Save the selected tab",
    blocker: "Tab resets on reload",
  });
  expect(p.brief.highlights.question.text).toBe("Should filters persist too?");
  expect(p.brief.highlights.updated_at).toBeGreaterThan(0);
  expect(JSON.stringify(p.brief.highlights)).not.toMatch(
    /Other project|Private project|Old progress|Already answered/,
  );
  expect(p.counts).toEqual({ needs: 0, working: 0, queued: 0 });
  db.prepare(
    "UPDATE brief_items SET status='done' WHERE project_id=? AND text='Repair tab persistence'",
  ).run(f.project);
  db.prepare(
    "UPDATE brief_items SET cite_stale=1 WHERE project_id=? AND kind IN ('state','question')",
  ).run(f.project);
  p = (await api(f.owner, `/projects/status?project=${f.project}`)).data
    .items[0];
  expect(p.brief.highlights.task).toMatchObject({
    text: "Update docs",
    next: "Write setup guide",
    blocker: null,
  });
  expect(p.brief.highlights.progress).toEqual([]);
  expect(p.brief.highlights.question).toBeNull();
  expect(
    db.prepare("SELECT * FROM brief_acks WHERE owner_id=?").all(f.owner),
  ).toEqual([]);
});
