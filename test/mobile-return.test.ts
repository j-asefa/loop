import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
import { PERSONAL_DECISION_RESPONSE_LIMIT, PERSONAL_DECISIONS_PAGE_LIMIT } from "../src/shared/personal-decisions";
const dir = mkdtempSync(join(tmpdir(), "loop-mobile-return-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now, emit } = await import("../src/server/db");
const { ownedRun, ownedConversation,  createAgent, owned, Problem } = await import("../src/server/domain");
const { recordConversationUpdate } = await import("../src/server/conversation-updates");
const { mobile } = await import("../src/server/mobile-routes");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { teams } = await import("../src/server/teams");
const { workflows } = await import("../src/server/workflows/routes");
const { sharing } = await import("../src/server/sharing");
const { transition } = await import("../src/server/queue");
const { requestApproval } = await import("../src/server/approvals");
const { seal } = await import("../src/server/secrets");
const { ensureWorkspaceProject } = await import("../src/server/workspace-project");
const { deliverNotifications } = await import("../src/server/notifications");
const { surfaceLater, deliverScheduledSends } = await import(
  "../src/server/mobile-return"
);

// Production routers, mounted in production order (mobile before core).
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", mobile, core, workspace, teams, workflows, sharing);
app.use((e: any, _req: any, res: any, _next: any) =>
  res
    .status(e instanceof Problem ? e.status : e instanceof ZodError ? 400 : 500)
    .json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function api(
  owner: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
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

function workspaceFor(owner = id()) {
  const connectionId = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',?)",
  ).run(connectionId, owner, JSON.stringify([{ id: "fixture" }]), now());
  const agent = (name = "m-" + randomBytes(6).toString("hex")) =>
    createAgent(owner, { name, connectionId, model: "fixture" });
  return { owner, agent };
}
let clock = 1_000_000;
function conversation(owner: string, agentId: string, title = "Topic") {
  const cid = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
  ).run(cid, owner, agentId, title, clock++);
  return cid;
}
function run(
  owner: string,
  agentId: string,
  cid: string,
  state = "completed",
  extra: { input?: string; payload?: object } = {},
) {
  const rid = id(),
    time = clock++;
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    rid,
    owner,
    agentId,
    cid,
    extra.input || "prompt",
    state,
    rid,
    JSON.stringify(extra.payload || {}),
    time,
    time,
  );
  return rid;
}
function message(
  owner: string,
  cid: string,
  role: string,
  content: string,
  runId: string | null = null,
) {
  const mid = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(mid, owner, cid, runId, role, content, "{}", clock++);
  return mid;
}
function subscribe(owner: string) {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/" + randomBytes(8).toString("hex"),
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString(
        "base64url",
      ),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  const sid = id();
  db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?)").run(
    sid,
    owner,
    subscription.endpoint,
    seal(JSON.stringify(subscription), owner),
    now(),
  );
  return sid;
}

it("persists team result visibility without hiding attention, history or unrelated agent work", async () => {
  const w = workspaceFor(), manager = w.agent(), worker = w.agent();
  const create = async (name: string) => {
    const response = await api(w.owner, "/teams", "POST", {
      name, managerId: manager.id, members: [worker.id],
    });
    expect(response.status).toBe(201);
    expect(response.data.hide_results_from_feed).toBe(0);
    return response.data;
  };
  const review = await create("PR review"), council = await create("LLM council");
  const completed = (cid: string, agentId = manager.id) => {
    const rid = run(w.owner, agentId, cid);
    return message(w.owner, cid, "assistant", "Team result", rid);
  };
  const reviewMessage = completed(review.conversation_id);
  completed(council.conversation_id);
  const delegated = conversation(w.owner, worker.id);
  db.prepare("UPDATE conversations SET team_id=? WHERE id=?").run(review.id, delegated);
  completed(delegated, worker.id);
  const solo = conversation(w.owner, worker.id);
  completed(solo, worker.id);
  const folder = (await api(w.owner, "/folders", "POST", { name: "Project", kind: "project" })).data.id;
  db.prepare("UPDATE conversations SET project_id=? WHERE owner_id=?").run(folder, w.owner);
  await api(w.owner, `/messages/${reviewMessage}/saved`, "POST");
  const cards = async (query = "filter=done&expand=results") => (await api(w.owner, `/feed?${query}`)).data;
  const ids = (page: any) => page.items.map((item: any) => item.conversation_id);
  const setHidden = (team: string, hidden: boolean, owner: string = w.owner) =>
    api(owner, `/teams/${team}/feed-visibility`, "PATCH", { hideResultsFromFeed: hidden });
  expect(ids(await cards())).toEqual(expect.arrayContaining([review.conversation_id, council.conversation_id, delegated, solo]));

  expect((await setHidden(review.id, true, "intruder")).status).toBe(404);
  expect((await api(w.owner, `/teams/${review.id}/feed-visibility`, "PATCH", { hideResultsFromFeed: "true" })).status).toBe(400);
  expect((await api(w.owner, `/teams/${review.id}/feed-visibility`, "PATCH", {})).status).toBe(400);
  expect((await setHidden(review.id, true)).data.hide_results_from_feed).toBe(1);
  expect((await api(w.owner, "/teams")).data.find((t: any) => t.id === review.id).hide_results_from_feed).toBe(1);
  expect(ids(await cards()).sort()).toEqual([council.conversation_id, solo].sort());
  expect(ids(await cards(`filter=done&expand=results&folder=${folder}`)).sort()).toEqual([council.conversation_id, solo].sort());
  expect(ids(await cards(`filter=done&expand=results&teams=${review.id}`)).sort()).toEqual([review.conversation_id, delegated].sort());
  expect(ids(await cards(`filter=done&expand=results&agent=${worker.id}`)).sort()).toEqual([delegated, solo].sort());
  expect(ids(await cards("filter=all"))).toContain(review.conversation_id);
  expect((await api(w.owner, "/saved")).data.items.some((item: any) => item.message?.message_id === reviewMessage)).toBe(true);
  expect((await api(w.owner, `/conversations/${review.conversation_id}`)).status).toBe(200);

  // Both teams can be hidden independently, including new results.
  await setHidden(council.id, true);
  completed(review.conversation_id);
  expect(ids(await cards())).toEqual([solo]);
  expect(ids(await cards("filter=outcomes"))).toEqual([solo]);
  run(w.owner, manager.id, review.conversation_id, "awaiting_approval");
  run(w.owner, worker.id, delegated, "running");
  run(w.owner, manager.id, council.conversation_id, "queued");
  const before = (await cards()).summary;
  expect(before).toMatchObject({ needs: 1, working: 1, queued: 1 });
  expect(ids(await cards("filter=needs"))).toEqual([review.conversation_id]);
  expect(ids(await cards("filter=working"))).toEqual([delegated]);
  expect(ids(await cards("filter=queued"))).toEqual([council.conversation_id]);
  await setHidden(review.id, false);
  expect((await cards()).summary).toEqual(before);
  expect(ids(await cards()).sort()).toEqual([review.conversation_id, review.conversation_id, delegated, solo].sort());

  await api(w.owner, `/teams/${council.id}`, "DELETE");
  expect((await setHidden(council.id, false)).status).toBe(404);
  expect(ids(await cards())).toContain(council.conversation_id);
});

it("filters hidden teams before paging through completed feed cards", async () => {
  const w = workspaceFor(), manager = w.agent(), worker = w.agent();
  const team = (await api(w.owner, "/teams", "POST", {
    name: "Review", managerId: manager.id, members: [worker.id],
  })).data;
  await api(w.owner, `/teams/${team.id}/feed-visibility`, "PATCH", { hideResultsFromFeed: true });
  const visible: string[] = [];
  for (let i = 0; i < 90; i++) {
    const cid = conversation(w.owner, worker.id);
    const rid = run(w.owner, worker.id, cid);
    message(w.owner, cid, "assistant", "Finished", rid);
    if (i < 45) visible.unshift(cid);
    else db.prepare("UPDATE conversations SET team_id=? WHERE id=?").run(team.id, cid);
  }
  const first = (await api(w.owner, "/feed?filter=done&expand=results")).data;
  expect(first.items.map((item: any) => item.conversation_id)).toEqual(visible.slice(0, 40));
  expect(first.next).toBeTruthy();
  const second = (await api(w.owner, `/feed?filter=done&expand=results&before=${encodeURIComponent(first.next)}`)).data;
  expect(second.items.map((item: any) => item.conversation_id)).toEqual(visible.slice(40));
  expect(second.next).toBeNull();
});

it("remembers where you stopped reading a thread, per owner", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const r = run(w.owner, a.id, cid);
  const prompt = message(w.owner, cid, "user", "Question", r);
  message(w.owner, cid, "assistant", "Answer one", r);
  let view = await api(w.owner, `/conversations/${cid}`);
  expect(view.data.position_message_id).toBeNull();
  // There is no unread state at all, only a reading position.
  expect(view.data).not.toHaveProperty("first_unread_message_id");
  expect(view.data).not.toHaveProperty("read");
  expect(
    (
      await api(w.owner, `/conversations/${cid}/position`, "PUT", {
        positionMessageId: prompt,
      })
    ).data,
  ).toEqual({ position_message_id: prompt });
  view = await api(w.owner, `/conversations/${cid}`);
  expect(view.data.position_message_id).toBe(prompt);
  expect(
    (await api(w.owner, "/feed")).data.items.find(
      (i: any) => i.conversation_id === cid,
    ).position_message_id,
  ).toBe(prompt);
  // Reaching the latest output clears the position.
  await api(w.owner, `/conversations/${cid}/position`, "PUT", {
    positionMessageId: null,
  });
  expect(
    (await api(w.owner, `/conversations/${cid}`)).data.position_message_id,
  ).toBeNull();
  // Another conversation's message is rejected; another owner sees nothing.
  const other = conversation(w.owner, a.id);
  const foreign = message(w.owner, other, "assistant", "Elsewhere");
  expect(
    (
      await api(w.owner, `/conversations/${cid}/position`, "PUT", {
        positionMessageId: foreign,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api("intruder", `/conversations/${cid}/position`, "PUT", {
        positionMessageId: null,
      })
    ).status,
  ).toBe(404);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM conversation_positions WHERE owner_id='intruder'",
      )
      .get(),
  ).toEqual({ n: 0 });
});

it("filters the feed, hides snoozed conversations from all, and isolates owners", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const working = conversation(w.owner, a.id, "Working");
  const wr = run(w.owner, a.id, working, "running");
  db.prepare("UPDATE runs SET worker_id='w' WHERE id=?").run(wr);
  message(w.owner, working, "user", "Go", wr);
  const queued = run(w.owner, a.id, working, "queued");
  const needs = conversation(w.owner, a.id, "Needs");
  const nr = run(w.owner, a.id, needs, "failed");
  message(w.owner, needs, "user", "Try", nr);
  const done = conversation(w.owner, a.id, "Done");
  const dr = run(w.owner, a.id, done, "completed");
  message(w.owner, done, "user", "Hello", dr);
  message(w.owner, done, "assistant", "  Hi\n\n there  ", dr);
  const snoozed = conversation(w.owner, a.id, "Snoozed");
  const snoozedRun = run(w.owner, a.id, snoozed);
  message(w.owner, snoozed, "user", "Later please", snoozedRun);
  message(w.owner, snoozed, "assistant", "The completed result", snoozedRun);
  // Delegated work has its own visible Feed card.
  const child = conversation(w.owner, a.id, "Child");
  const cr = run(w.owner, a.id, child, "completed");
  message(w.owner, child, "assistant", "Delegated result", cr);
  db.prepare("INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments) VALUES(?,?,?,'{}')").run(nr, "call", cr);
  expect(
    (
      await api(w.owner, "/later", "POST", {
        kind: "conversation",
        targetId: snoozed,
        condition: "time",
        dueAt: now() + 3600000,
      })
    ).status,
  ).toBe(201);

  const all = await api(w.owner, "/feed");
  const ids = all.data.items.map((i: any) => i.conversation_id);
  expect(ids).toHaveLength(4);
  expect(ids).not.toContain(snoozed);
  expect(ids).toContain(child);
  expect(all.data.summary).toMatchObject({
    needs: 1,
    working: 1,
    queued: 1,
    later_due: 0,
  });
  const doneItem = all.data.items.find((i: any) => i.conversation_id === done);
  expect(doneItem).toMatchObject({
    // Named by its run's prompt, not the thread title.
    title: "prompt",
    agent_name: a.name,
    last_message: { role: "assistant", preview: "Hi there", content: "  Hi\n\n there  " },
    run: { id: dr, state: "completed", queue_position: null },
    later: null,
  });
  expect(doneItem).not.toHaveProperty("unread_count");
  const workingItem = all.data.items.find(
    (i: any) => i.conversation_id === working,
  );
  expect(workingItem.run).toMatchObject({ id: wr, state: "running" });
  const filter = async (name: string) =>
    (await api(w.owner, "/feed?filter=" + name + (name === "done" ? "&expand=results" : ""))).data.items.map(
      (i: any) => i.conversation_id,
    );
  expect(await filter("needs")).toEqual([needs]);
  expect(await filter("working")).toEqual([working]);
  expect(await filter("queued")).toEqual([working]);
  expect(await filter("later")).toEqual([snoozed]);
  // Done keeps completed results, including snoozed conversations, and
  // leaves out open work with no finished output.
  expect(await filter("done")).toEqual([child, snoozed, done]);
  // A finished output stays in Done when a follow-up is queued.
  const followUp = conversation(w.owner, a.id, "Follow-up");
  const first = run(w.owner, a.id, followUp, "completed");
  message(w.owner, followUp, "user", "First", first);
  message(w.owner, followUp, "assistant", "First answer", first);
  const second = run(w.owner, a.id, followUp, "queued");
  message(w.owner, followUp, "user", "Second", second);
  expect(await filter("done")).toEqual(expect.arrayContaining([done, followUp]));
  expect(await filter("queued")).toContain(followUp);
  // ...and while it works: Done keeps the finished answer, Working shows
  // only what the new run has produced.
  db.prepare("UPDATE runs SET state='running',worker_id='w' WHERE id=?").run(second);
  const items = async (name: string) =>
    (await api(w.owner, "/feed?filter=" + name + (name === "done" ? "&expand=results" : ""))).data.items;
  const doneCard = (await items("done")).find(
    (i: any) => i.conversation_id === followUp,
  );
  expect(doneCard).toMatchObject({
    last_message: { role: "assistant", content: "First answer" },
    run: { id: first, state: "completed" },
    live_preview: null,
    queued_runs: [],
    pending_approvals: 0,
    next_action: { kind: "result", run_id: first },
  });
  const workingCard = (await items("working")).find(
    (i: any) => i.conversation_id === followUp,
  );
  expect(workingCard).toMatchObject({
    last_message: null,
    run: { id: second, state: "running" },
  });
  // A GitHub update is still input, not an agent preview.
  db.prepare(
    "UPDATE messages SET metadata=json_set(metadata,'$.automation',json('{\"kind\":\"github_watch\",\"watchId\":\"w\"}')) WHERE run_id=? AND role='user'",
  ).run(second);
  const triggered = (await items("working")).find(
    (i: any) => i.conversation_id === followUp,
  );
  expect(triggered.last_message).toBeNull();
  // The hidden prompt still says who started the work.
  expect(triggered.run).toMatchObject({ automation: "github_watch" });
  // A saved progress row is not the agent's output.
  const progress = message(w.owner, followUp, "assistant", "Status ping", second);
  db.prepare(
    "UPDATE messages SET metadata=json_set(metadata,'$.progress',1) WHERE id=?",
  ).run(progress);
  expect(
    (await items("working")).find((i: any) => i.conversation_id === followUp)
      .last_message,
  ).toBeNull();
  message(w.owner, followUp, "assistant", "Checking the follow-up now.", second);
  expect(
    (await items("working")).find((i: any) => i.conversation_id === followUp)
      .last_message,
  ).toMatchObject({ role: "assistant", content: "Checking the follow-up now." });
  // A failed follow-up needs you, and the earlier answer is still done.
  db.prepare("UPDATE runs SET state='failed',worker_id=NULL WHERE id=?").run(second);
  expect(await filter("needs")).toContain(followUp);
  expect(await filter("done")).toContain(followUp);
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(second);
  // Imported history has messages but no runs, and is done.
  const imported = conversation(w.owner, a.id, "Imported");
  message(w.owner, imported, "user", "From an export");
  expect(await filter("done")).toEqual(
    expect.arrayContaining([child, done, followUp, imported]),
  );
  expect(await filter("done")).toHaveLength(6);
  // An agent profile lists only that agent's threads; foreign agents are rejected.
  const b = w.agent();
  const other = conversation(w.owner, b.id, "Other agent");
  message(w.owner, other, "user", "Hi", run(w.owner, b.id, other));
  const byAgent = async (agent: string) =>
    (await api(w.owner, "/feed?agent=" + agent)).data.items?.map(
      (i: any) => i.conversation_id,
    );
  expect(await byAgent(b.id)).toEqual([other]);
  expect(await byAgent(a.id)).not.toContain(other);
  expect((await api(workspaceFor().owner, "/feed?agent=" + a.id)).status).toBe(404);
  // Dismissing the failure removes it from needs.
  db.prepare("UPDATE runs SET attention_dismissed_at=1 WHERE id=?").run(nr);
  expect(await filter("needs")).toEqual([]);
  // ...and, with nothing else open, it is done.
  const doneNow = await filter("done");
  expect(doneNow).toEqual(expect.arrayContaining([done, needs, other]));
  expect(doneNow).not.toContain(working);
  expect(queued).toBeTruthy();
  // Surfacing brings the snoozed conversation back to "all".
  surfaceLater(now() + 7200000);
  expect(await filter("all")).toContain(snoozed);
  expect((await api(w.owner, "/feed")).data.summary.later_due).toBe(1);
  // Pagination: 45 conversations page as 40 + 5.
  const p = workspaceFor(),
    pa = p.agent();
  for (let i = 0; i < 45; i++)
    message(p.owner, conversation(p.owner, pa.id), "user", "x" + i);
  const page = await api(p.owner, "/feed");
  expect(page.data.items).toHaveLength(40);
  const rest = await api(p.owner, "/feed?before=" + page.data.next);
  expect(rest.data.items).toHaveLength(5);
  expect(rest.data.next).toBeNull();
  expect(
    new Set([...page.data.items, ...rest.data.items].map((i: any) => i.conversation_id)).size,
  ).toBe(45);
  // Done pages by when each output finished.
  const donePage = await api(p.owner, "/feed?filter=done&expand=results");
  expect(donePage.data.items).toHaveLength(40);
  const doneRest = await api(
    p.owner,
    "/feed?filter=done&expand=results&before=" + donePage.data.next,
  );
  expect(doneRest.data.items).toHaveLength(5);
  expect((await api("intruder", "/feed")).data.items).toEqual([]);
  expect((await api(w.owner, "/feed?filter=bogus")).status).toBe(400);
  expect((await api(w.owner, "/feed?filter=unread")).status).toBe(400);
  const away = await api(w.owner, "/feed/away?since=0");
  expect(away.data.completed.map((b: any) => b.run_id)).toContain(dr);
  expect(away.data.completed.map((b: any) => b.run_id)).toContain(cr);
  expect(away.data.failed.map((b: any) => b.run_id)).toEqual([nr]);
  expect((await api("intruder", "/feed/away?since=0")).data).toEqual({
    completed: [],
    needs: [],
    failed: [],
  });
});

it("surfaces a native run interrupted while awaiting approval, without replay or a stale approval action", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Merge after review");
  const rid = run(w.owner, a.id, cid, "awaiting_approval");
  message(w.owner, cid, "user", "Merge the PR after approval", rid);
  const pending = requestApproval(ownedRun(rid, w.owner), {
    type: "mcp_tool", tool: "merge_pull_request", arguments: { expectedHeadSha: "a".repeat(40) },
  });
  db.prepare("INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES(?,'stopped-host','digest','accepted',?)").run(rid, now());
  const page = async () => (await api(w.owner, "/feed?filter=needs")).data;
  expect((await page()).items[0]).toMatchObject({
    pending_approvals: 1, next_action: { kind: "approve", run_id: rid },
  });
  expect((await api(w.owner, "/approvals")).data).toHaveLength(1);

  const { NativeSessions } = await import("../src/server/native-sessions");
  new NativeSessions().recover();
  expect((await page()).items).toMatchObject([{
    conversation_id: cid, pending_approvals: 0, next_action: null,
    run: { id: rid, state: "interrupted", error: expect.stringContaining("Host stopped") },
  }]);
  expect((await page()).summary.needs).toBe(1);
  expect((await api(w.owner, "/approvals")).data).toEqual([]);
  expect(db.prepare("SELECT state FROM approvals WHERE id=?").get(pending.id)).toEqual({ state: "rejected" });
  expect((await api(w.owner, `/approvals/${pending.id}`, "POST", { decision: "approve" })).status).toBe(409);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(rid)).toEqual({ state: "interrupted" });
  expect(db.prepare("SELECT count(*) n FROM runs WHERE conversation_id=?").get(cid)).toEqual({ n: 1 });
  expect((await api("intruder", "/feed?filter=needs")).data.items).toEqual([]);
  await api(w.owner, `/runs/${rid}/dismiss`, "POST", {});
  expect((await page()).items).toEqual([]);
  expect((await page()).summary.needs).toBe(0);
});

it.each(["failed", "interrupted"])("ignores legacy pending approvals and native decisions on a %s run", async (state) => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id);
  const rid = run(w.owner, a.id, cid, state);
  // Reproduce an older source's stale records, after terminal-state cleanup.
  requestApproval(ownedRun(rid, w.owner), { type: "mcp_tool", tool: "merge_pull_request" });
  db.prepare("INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,'old','decision','{}','pending',?)")
    .run(id(), rid, cid, now());
  const page = (await api(w.owner, "/feed?filter=needs")).data;
  expect(page.items).toMatchObject([{
    conversation_id: cid, run: { id: rid, state }, pending_approvals: 0, next_action: null,
  }]);
  expect((await api(w.owner, "/approvals")).data).toEqual([]);
});

it.each(["delegation", "workflow"])("shows %s work through its Feed lifecycle", async (kind) => {
  const w = workspaceFor(), manager = w.agent(), worker = w.agent();
  const parent = run(w.owner, manager.id, conversation(w.owner, manager.id), "running");
  const cid = conversation(w.owner, worker.id);
  const child = run(w.owner, worker.id, cid, "queued", { input: "Investigate the failure" });
  if (kind === "delegation") {
    db.prepare("INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments) VALUES(?,?,?,'{}')").run(parent, "delegate", child);
  } else {
    db.prepare("INSERT INTO workflow_steps(run_id,step_id,position,state,child_run_id) VALUES(?,?,0,'running',?)").run(parent, "investigate", child);
  }
  message(w.owner, cid, "user", "Investigate the failure", child);
  const cards = async (filter: string, owner: string = w.owner) =>
    (await api(owner, `/feed?filter=${filter}${filter === "done" ? "&expand=results" : ""}`)).data.items.filter((item: any) => item.conversation_id === cid);
  expect(await cards("queued")).toMatchObject([{ agent_id: worker.id, run: { id: child, state: "queued" } }]);
  expect(await cards("done")).toEqual([]);

  db.prepare("UPDATE runs SET state='running',worker_id='worker' WHERE id=?").run(child);
  expect(await cards("working")).toMatchObject([{
    title: "Investigate the failure", agent_id: worker.id, last_message: null,
    run: { id: child, state: "running" },
  }]);
  expect(await cards("queued")).toEqual([]);
  expect(await cards("working", "intruder")).toEqual([]);

  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(child);
  expect(await cards("needs")).toMatchObject([{ run: { id: child, state: "awaiting_approval" } }]);
  expect(await cards("working")).toEqual([]);

  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(clock++, child);
  message(w.owner, cid, "assistant", "Found the cause", child);
  expect(await cards("done")).toMatchObject([{
    done_card_key: `run:${child}`, last_message: { content: "Found the cause" },
    run: { id: child, state: "completed" },
  }]);
  expect(await cards("needs")).toEqual([]);
  expect(await cards("done", "intruder")).toEqual([]);
  expect((await api(w.owner, "/feed/away?since=0")).data.completed.map((item: any) => item.run_id)).toContain(child);
});

it("keeps every completed result in Done through later work until that result is dismissed", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Ongoing thread");
  const first = run(w.owner, a.id, cid, "completed", { input: "First task" });
  const firstAnswer = message(w.owner, cid, "assistant", "First result", first);
  const page = async (filter = "done") => (await api(w.owner, `/feed?filter=${filter}${filter === "done" ? "&expand=results" : ""}`)).data;
  const original = (await page()).items[0];
  const second = run(w.owner, a.id, cid, "queued", { input: "Second task" });
  message(w.owner, cid, "user", "Second task", second);
  for (const state of ["queued", "running", "awaiting_approval", "failed", "interrupted"]) {
    db.prepare("UPDATE runs SET state=?,worker_id='worker',updated_at=? WHERE id=?").run(state, clock++, second);
    expect((await page()).items).toEqual([original]);
  }
  const secondAnswer = message(w.owner, cid, "assistant", "Second result", second);
  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(clock++, second);
  const completed = await page();
  expect(completed.items).toMatchObject([
    { done_card_key: `run:${second}`, title: "Second task", last_message: { id: secondAnswer, content: "Second result" } },
    original,
  ]);
  expect(completed.items).toHaveLength(2);
  expect(completed.items[1].next_action).toMatchObject({ run_id: first, message_id: firstAnswer });
  // A new run changes activity counts once, even with several Done cards.
  const third = run(w.owner, a.id, cid, "running");
  db.prepare("UPDATE runs SET worker_id='worker' WHERE id=?").run(third);
  message(w.owner, cid, "assistant", "Working on the third task", third);
  expect((await page()).items).toEqual(completed.items);
  expect((await page()).summary).toMatchObject({ working: 1, queued: 0, needs: 0 });
  expect((await page("working")).items).toMatchObject([{ run: { id: third } }]);
  // Reminding yourself about the conversation does not remove its results.
  await api(w.owner, "/later", "POST", { kind: "conversation", targetId: cid, condition: "time", dueAt: now() + 3600000 });
  expect((await page()).items.map((item: any) => item.done_card_key)).toEqual([`run:${second}`, `run:${first}`]);
  const dismiss = (hidden: boolean) => api(w.owner, `/feed/${cid}`, "PATCH", { hidden, cardKey: `run:${first}` });
  expect((await dismiss(true)).status).toBe(200);
  expect((await page()).items.map((item: any) => item.done_card_key)).toEqual([`run:${second}`]);
  expect((await dismiss(false)).status).toBe(200);
  expect((await page()).items.map((item: any) => item.done_card_key)).toEqual([`run:${second}`, `run:${first}`]);
  expect((await api(w.owner, `/messages/${firstAnswer}`)).data.content).toBe("First result");
  expect((await page("all")).items).toEqual([]); // The reminder still snoozes the thread view.
  expect((await api("intruder", "/feed?filter=done&expand=results")).data.items).toEqual([]);
});

it("expands only completed runs with final answers, excluding historical prompts, commentary and empty output", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id);
  const promptOnly = run(w.owner, a.id, cid);
  message(w.owner, cid, "user", "Do this work", promptOnly);
  const commentaryOnly = run(w.owner, a.id, cid);
  recordConversationUpdate({ id: commentaryOnly, owner_id: w.owner }, "commentary", { content: "Still investigating" });
  for (const content of ["   ", "\n", "\t", " \r\n\t ", "\u00a0\u2003\ufeff"]) {
    const empty = run(w.owner, a.id, cid);
    message(w.owner, cid, "assistant", content, empty);
    message(w.owner, cid, "assistant", content);
  }
  run(w.owner, a.id, cid); // A completed turn with no recorded message.
  const finished = run(w.owner, a.id, cid);
  const answer = message(w.owner, cid, "assistant", "The final answer", finished);
  message(w.owner, cid, "assistant", "\n\t ", finished);
  const page = (await api(w.owner, "/feed?filter=done&expand=results")).data;
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ done_card_key: `run:${finished}`, last_message: { id: answer } });
  expect((await api(w.owner, `/messages/${answer}/saved`, "POST")).status).toBe(200);
});

it.each(["prompt", "commentary", "whitespace", "empty"])("keeps an idle %s-only thread without a result preview", async (kind) => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id);
  const rid = run(w.owner, a.id, cid);
  if (kind !== "empty") message(w.owner, cid, "user", "Do this work", rid);
  if (kind === "commentary")
    recordConversationUpdate({ id: rid, owner_id: w.owner }, "commentary", { content: "Still investigating" });
  if (kind === "whitespace") message(w.owner, cid, "assistant", "\n\t ", rid);
  const page = async () => (await api(w.owner, "/feed?filter=done&expand=results")).data.items;
  const items = await page();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ done_card_key: `run:${rid}`, last_message: null });
  await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: true, cardKey: `run:${rid}` });
  expect(await page()).toEqual([]);
  await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: false, cardKey: `run:${rid}` });
  expect(await page()).toEqual(items);
});

it("reads the production Done page and summary in one indexed projection query", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id);
  message(w.owner, cid, "assistant", "Run answer", run(w.owner, a.id, cid));
  message(w.owner, cid, "assistant", "Imported answer");
  const prepare = db.prepare.bind(db);
  let plan: { detail: string }[] = [];
  let selections = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.includes("FROM feed_cards p")) {
      selections++;
      const all = statement.all.bind(statement);
      statement.all = (...args: unknown[]) => {
        plan = prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as { detail: string }[];
        return all(...args);
      };
    }
    return statement;
  });
  try {
    const response = await api(w.owner, "/feed?filter=done&expand=results");
    expect(response.status).toBe(200);
    expect(response.data.items).toHaveLength(2);
  } finally {
    spy.mockRestore();
  }
  expect(selections).toBe(1);
  expect(plan.some(row => /SEARCH p USING INDEX feed_cards_results/.test(row.detail))).toBe(true);
  expect(plan.some(row => /SEARCH t USING COVERING INDEX feed_cards_summary/.test(row.detail))).toBe(true);
  expect(plan.some(row => /(?:runs|messages)/.test(row.detail))).toBe(false);
});

it.each(["run", "imported"])("updates indexed %s answer eligibility when message content or progress changes", async (kind) => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id);
  message(w.owner, cid, "assistant", "Existing answer", run(w.owner, a.id, cid));
  const rid = kind === "run" ? run(w.owner, a.id, cid) : undefined;
  const mid = message(w.owner, cid, "assistant", "\n\t", rid);
  const page = async () => (await api(w.owner, "/feed?filter=done&expand=results")).data.items;
  expect(await page()).toHaveLength(1);
  db.prepare("UPDATE messages SET content='New answer' WHERE id=?").run(mid);
  expect(await page()).toHaveLength(2);
  db.prepare("UPDATE messages SET metadata=? WHERE id=?").run('{"progress":true}', mid);
  expect(await page()).toHaveLength(1);
  db.prepare("UPDATE messages SET metadata='{}' WHERE id=?").run(mid);
  expect(await page()).toHaveLength(2);
  db.prepare("UPDATE messages SET content=? WHERE id=?").run("\n\t", mid);
  expect(await page()).toHaveLength(1);
});

it("filters and labels each completed result by its run's project", async () => {
  const w = workspaceFor(), a = w.agent();
  const project = async (name: string) => (await api(w.owner, "/folders", "POST", { name, kind: "project" })).data.id;
  const firstProject = await project("First project"), secondProject = await project("Second project");
  const cid = conversation(w.owner, a.id);
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(firstProject, cid);
  const completed: string[] = [];
  for (const folderId of [firstProject, secondProject, firstProject]) {
    const rid = run(w.owner, a.id, cid, "completed", { payload: { folderId } });
    message(w.owner, cid, "assistant", "Result for " + folderId, rid);
    completed.push(rid);
  }
  const cards = async (folder?: string) => (await api(w.owner,
    "/feed?filter=done&expand=results" + (folder ? "&folder=" + folder : ""))).data.items;
  expect((await cards()).map((item: any) => [item.run.id, item.project_id, item.project_name])).toEqual([
    [completed[2], firstProject, "First project"],
    [completed[1], secondProject, "Second project"],
    [completed[0], firstProject, "First project"],
  ]);
  expect((await cards(firstProject)).map((item: any) => item.run.id)).toEqual([completed[2], completed[0]]);
  expect((await cards(secondProject)).map((item: any) => item.run.id)).toEqual([completed[1]]);
});

it.each(["before", "after"])("keeps explicit Workspace results when the conversation project is assigned %s completion", async (assignment) => {
  const w = workspaceFor(), a = w.agent();
  const folder = (await api(w.owner, "/folders", "POST", { name: "Named project", kind: "project" })).data.id;
  const defaultWorkspace = ensureWorkspaceProject(w.owner);
  const cid = conversation(w.owner, a.id);
  const assign = () => db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(folder, cid);
  if (assignment === "before") assign();
  const unfiled = run(w.owner, a.id, cid, "completed", { payload: { folderId: null } });
  message(w.owner, cid, "assistant", "Workspace result", unfiled);
  if (assignment === "after") assign();
  const filed = run(w.owner, a.id, cid, "completed", { payload: { folderId: folder } });
  message(w.owner, cid, "assistant", "Named project result", filed);
  const cards = async (project?: string) => (await api(w.owner,
    "/feed?filter=done&expand=results" + (project ? "&folder=" + project : ""))).data.items;
  expect((await cards()).find((item: any) => item.run.id === unfiled)).toMatchObject({ project_id: null, project_name: null });
  expect((await cards(folder)).map((item: any) => item.run.id)).toEqual([filed]);
  expect((await cards(defaultWorkspace)).map((item: any) => item.run.id)).toEqual([unfiled]);
});

it("keeps unexpanded Done compatible with clients that identify rows by conversation", async () => {
  const w = workspaceFor(), a = w.agent();
  const latest = new Set<string>();
  for (let i = 0; i < 45; i++) {
    const cid = conversation(w.owner, a.id);
    for (let j = 0; j < 2; j++) {
      const rid = run(w.owner, a.id, cid);
      message(w.owner, cid, "assistant", `Result ${j}`, rid);
      if (j === 1) latest.add(`run:${rid}`);
    }
  }
  const first = (await api(w.owner, "/feed?filter=done")).data;
  expect(first.items).toHaveLength(40);
  expect(JSON.parse(Buffer.from(first.next, "base64url").toString())).toHaveLength(2);
  const second = (await api(w.owner, `/feed?filter=done&before=${first.next}`)).data;
  expect(second.items).toHaveLength(5);
  const rows = [...first.items, ...second.items];
  expect(new Set(rows.map((row: any) => row.conversation_id)).size).toBe(45);
  expect(new Set(rows.map((row: any) => row.done_card_key))).toEqual(latest);
  expect(second.next).toBeNull();
});

it.each(["current", "legacy"])("pages every completed result with a %s cursor, including equal completion times and dismissed cards", async (cursorKind) => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id);
  const results: string[] = [];
  for (let i = 0; i < 85; i++) {
    const rid = run(w.owner, a.id, cid);
    message(w.owner, cid, "assistant", `Result ${i}`, rid);
    results.push(`run:${rid}`);
  }
  const completedAt = clock++;
  db.prepare("UPDATE runs SET updated_at=? WHERE conversation_id=?").run(completedAt, cid);
  results.sort().reverse();
  await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: true, cardKey: results[12] });
  results.splice(12, 1);
  const received: string[] = [];
  // Legacy cursors identify only a timestamp and conversation. Revisit that
  // boundary to recover every tied result, then continue with exact-card cursors.
  let cursor = cursorKind === "legacy"
    ? Buffer.from(JSON.stringify([completedAt, cid])).toString("base64url")
    : "";
  for (const size of [40, 40, 4]) {
    const response = await api(w.owner, `/feed?filter=done&expand=results${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
    expect(response.status).toBe(200);
    expect(response.data.items).toHaveLength(size);
    received.push(...response.data.items.map((item: any) => item.done_card_key));
    cursor = response.data.next;
  }
  expect(cursor).toBeNull();
  expect(received).toEqual(results);
});

it("dismisses only the selected Done card, with exact-card retry and Undo", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Several results");
  const first = run(w.owner, a.id, cid, "completed");
  const answer = message(w.owner, cid, "assistant", "First result", first);
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  const page = async (filter: string) => (await api(w.owner, "/feed?filter=" + filter + (filter === "done" ? "&expand=results" : ""))).data;
  const card = (await page("done")).items[0];
  expect(card.done_card_key).toBe("run:" + first);
  const dismiss = (hidden: boolean, cardKey = card.done_card_key, owner: string = w.owner, conversationId = cid) =>
    api(owner, `/feed/${conversationId}`, "PATCH", { hidden, cardKey });

  expect((await dismiss(true, card.done_card_key, "intruder")).status).toBe(404);
  const other = conversation(w.owner, a.id);
  expect((await dismiss(true, card.done_card_key, w.owner, other)).status).toBe(404);
  expect((await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: true })).status).toBe(400);
  expect((await dismiss(true)).status).toBe(200);
  expect((await dismiss(true)).status).toBe(200);
  expect((await page("done")).items).toEqual([]);
  expect((await page("all")).items.map((i: any) => i.conversation_id)).toEqual([cid]);
  expect((await page("outcomes")).items.map((i: any) => i.conversation_id)).toEqual([cid]);
  expect((await api(w.owner, `/conversations/${cid}`)).status).toBe(200);
  expect(db.prepare("SELECT content FROM messages WHERE id=?").get(answer)).toEqual({ content: "First result" });
  expect(db.prepare("SELECT count(*) n FROM message_bookmarks WHERE owner_id=? AND message_id=?").get(w.owner, answer)).toEqual({ n: 1 });
  expect((await dismiss(false)).status).toBe(200);
  expect((await page("done")).items[0].done_card_key).toBe(card.done_card_key);

  const second = run(w.owner, a.id, cid, "completed");
  message(w.owner, cid, "assistant", "Second result", second);
  // The result can change between rendering a card and swiping it.
  expect((await dismiss(true)).status).toBe(200);
  const nextCard = (await page("done")).items[0];
  expect(nextCard.done_card_key).toBe("run:" + second);
  expect(nextCard.last_message.content).toBe("Second result");
  expect((await dismiss(true, nextCard.done_card_key)).status).toBe(200);
  expect((await dismiss(false)).status).toBe(200);
  expect((await page("done")).items.map((item: any) => item.done_card_key)).toEqual([card.done_card_key]);
  expect((await dismiss(false, nextCard.done_card_key)).status).toBe(200);
  expect((await page("done")).items.map((item: any) => item.done_card_key)).toEqual([nextCard.done_card_key, card.done_card_key]);
  expect(db.prepare("SELECT feed_hidden FROM conversations WHERE id=?").get(cid)).toEqual({ feed_hidden: 0 });
});

it.each(["running", "pausing", "waiting_children", "queued", "paused", "awaiting_approval", "failed", "interrupted"])(
  "Done dismissal has no effect on %s work, other lists or counts",
  async (state) => {
    const w = workspaceFor(), a = w.agent();
    const cid = conversation(w.owner, a.id);
    const first = run(w.owner, a.id, cid, "completed");
    message(w.owner, cid, "assistant", "Prior result", first);
    const active = run(w.owner, a.id, cid, state === "waiting_children" ? "running" : state);
    db.prepare("UPDATE runs SET worker_id=? WHERE id=?").run(state === "waiting_children" ? null : "worker", active);
    // Even a legacy client writing this obsolete flag cannot hide a thread.
    db.prepare("UPDATE conversations SET feed_hidden=1 WHERE id=?").run(cid);
    const filters = ["all", "needs", "working", "queued", "later", "outcomes", "unfinished"];
    const display = ({ projection, projectionRows, ...page }: any) => page;
    const before = await Promise.all(filters.map(async (filter) =>
      display((await api(w.owner, "/feed?filter=" + filter + (filter === "done" ? "&expand=results" : ""))).data)));
    const done = (await api(w.owner, "/feed?filter=done&expand=results")).data;
    expect(done.items[0].done_card_key).toBe("run:" + first);
    const working = ["running", "pausing", "waiting_children"].includes(state);
    expect(done.summary).toMatchObject({
      working: working ? 1 : 0,
      queued: state === "queued" ? 1 : 0,
      needs: ["paused", "awaiting_approval", "failed", "interrupted"].includes(state) ? 1 : 0,
    });
    expect((await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: true, cardKey: done.items[0].done_card_key })).status).toBe(200);
    expect((await api(w.owner, "/feed?filter=done&expand=results")).data).toMatchObject({ items: [], summary: done.summary });
    for (const [index, filter] of filters.entries()) {
      expect(display((await api(w.owner, "/feed?filter=" + filter + (filter === "done" ? "&expand=results" : ""))).data)).toEqual(before[index]);
    }
    expect((await api("intruder", "/feed?filter=working")).data.items).toEqual([]);
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(active)).toEqual({ state: state === "waiting_children" ? "running" : state });
    db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(active);
    message(w.owner, cid, "assistant", "New result", active);
    expect((await api(w.owner, "/feed?filter=done&expand=results")).data.items[0].done_card_key).toBe("run:" + active);
  },
);

it("dismisses a message-only Done card without suppressing later imported messages", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Imported history");
  const first = message(w.owner, cid, "assistant", "Imported answer");
  const key = (await api(w.owner, "/feed?filter=done&expand=results")).data.items[0].done_card_key;
  expect(key).toBe("message:" + first);
  expect((await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: true, cardKey: key })).status).toBe(200);
  expect((await api(w.owner, "/feed?filter=done&expand=results")).data.items).toEqual([]);
  expect((await api(w.owner, "/feed")).data.items[0].last_message.id).toBe(first);
  const second = message(w.owner, cid, "assistant", "Next imported answer");
  expect((await api(w.owner, "/feed?filter=done&expand=results")).data.items[0].done_card_key).toBe("message:" + second);
  await api(w.owner, `/feed/${cid}`, "PATCH", { hidden: false, cardKey: key });
  const imported = (await api(w.owner, "/feed?filter=done&expand=results")).data.items;
  expect(imported.map((item: any) => item.last_message.id)).toEqual([second, first]);
  const followUp = run(w.owner, a.id, cid, "running");
  message(w.owner, cid, "user", "Continue this imported thread", followUp);
  expect((await api(w.owner, "/feed?filter=done&expand=results")).data.items).toEqual(imported);
  message(w.owner, cid, "assistant", "The new result", followUp);
  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(clock++, followUp);
  expect((await api(w.owner, "/feed?filter=done&expand=results")).data.items.map((item: any) => item.done_card_key))
    .toEqual([`run:${followUp}`, `message:${second}`, `message:${first}`]);
});

it("heads Working cards with the active task's prompt instead of the thread's first prompt or newer queued input", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    title = "Why is MCP-catalog failing on main",
    cid = conversation(w.owner, a.id, title);
  const first = run(w.owner, a.id, cid, "completed", { input: title });
  message(w.owner, cid, "user", title, first);
  message(w.owner, cid, "assistant", "The test inherits companion mode.", first);
  const active = run(w.owner, a.id, cid, "running", {
    input: " Open a PR\nfor this ",
  });
  db.prepare("UPDATE runs SET worker_id='w' WHERE id=?").run(active);
  message(w.owner, cid, "user", " Open a PR\nfor this ", active);
  message(w.owner, cid, "assistant", "I’ll verify the fix and open the PR.", active);
  const queued = run(w.owner, a.id, cid, "queued", { input: "Deploy it next" });
  message(w.owner, cid, "user", "Deploy it next", queued);
  // Steering belongs to this run, but did not start it.
  message(w.owner, cid, "user", "Mention the reproduction in the PR", active);
  const card = async (filter: string) =>
    (await api(w.owner, "/feed?filter=" + filter + (filter === "done" ? "&expand=results" : ""))).data.items.find(
      (i: any) => i.conversation_id === cid,
    );
  for (const state of ["running", "pausing", "waiting_children"]) {
    db.prepare("UPDATE runs SET state=?,worker_id=? WHERE id=?").run(
      state === "waiting_children" ? "running" : state,
      state === "waiting_children" ? null : "w",
      active,
    );
    for (const filter of ["working", "all"]) {
      expect(await card(filter)).toMatchObject({
        title: "Open a PR for this",
        run: { id: active, state },
        last_message: {
          role: "assistant",
          content: "I’ll verify the fix and open the PR.",
        },
        queued_runs: [{ id: queued, input: "Deploy it next" }],
      });
    }
    expect(await card("done")).toMatchObject({ title, run: { id: first } });
  }
  // Only the card heading changes; the stored thread title stays available.
  expect(ownedConversation(cid, w.owner).title).toBe(title);
  db.prepare("UPDATE runs SET input=? WHERE id=?").run("word ".repeat(100), active);
  expect((await card("working")).title).toHaveLength(200);
  db.prepare("UPDATE runs SET input='  ' WHERE id=?").run(active);
  expect((await card("working")).title).toBe(title);
});

it("heads a Done card with the prompt its answer replies to, not the thread's first prompt", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    title = "How can we redesign the top bar",
    cid = conversation(w.owner, a.id, title);
  const first = run(w.owner, a.id, cid, "completed", { input: title });
  message(w.owner, cid, "user", title, first);
  message(w.owner, cid, "assistant", "Here is a mockup.", first);
  const latest = run(w.owner, a.id, cid, "completed", {
    input: " Yes, push\nto main ",
  });
  message(w.owner, cid, "user", " Yes, push\nto main ", latest);
  message(w.owner, cid, "assistant", "Pushed.", latest);
  const card = async (filter: string) =>
    (await api(w.owner, "/feed?filter=" + filter + (filter === "done" ? "&expand=results" : ""))).data.items.find(
      (i: any) => i.conversation_id === cid,
    );
  for (const filter of ["done", "all"])
    expect(await card(filter)).toMatchObject({
      title: "Yes, push to main",
      run: { id: latest },
      last_message: { role: "assistant", content: "Pushed." },
    });
  // A run without a prompt keeps the thread title.
  db.prepare("UPDATE runs SET input='  ' WHERE id=?").run(latest);
  expect((await card("done")).title).toBe(title);
});

it("shows a working agent's output so far on its feed card", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id, "Live work");
  const connectionId = (
    db.prepare("SELECT connection_id FROM agents WHERE id=?").get(a.id) as {
      connection_id: string;
    }
  ).connection_id;
  const live = run(w.owner, a.id, cid, "running", {
    payload: { connectionId, model: "run-model" },
  });
  db.prepare("UPDATE runs SET worker_id='w' WHERE id=?").run(live);
  message(w.owner, cid, "user", "Review the PR", live);
  // The answer placeholder is empty while the agent works.
  message(w.owner, cid, "assistant", "", live);
  const card = async () =>
    (await api(w.owner, "/feed")).data.items.find(
      (i: any) => i.conversation_id === cid,
    );
  expect((await card()).live_preview).toBeNull();
  expect((await card()).last_message).toBeNull();
  expect((await card()).run.connection_id).toBe(connectionId);
  expect((await card()).run.automation).toBeUndefined();
  // The card's model badge uses the run's model, like its environment badge.
  expect((await card()).run.model).toBe("run-model");
  recordConversationUpdate(ownedRun(live, w.owner) as any, "update-1", {
    content: "Reading the diff and checking the queue changes.",
  });
  expect((await card()).live_preview).toBe(
    "Reading the diff and checking the queue changes.",
  );
  // A finished run shows its last message instead.
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(live);
  expect((await card()).live_preview).toBeNull();
});

it("keeps saved messages and results in one list, newest save first, per owner", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id, "Saved");
  const r = run(w.owner, a.id, cid);
  const one = message(w.owner, cid, "assistant", "First", r);
  const two = message(w.owner, cid, "user", "Second", r);
  const answer = message(w.owner, cid, "assistant", "Final answer", r);
  const result = id();
  // A result may be published after its source reply has already been saved.
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  expect(db.prepare("SELECT 1 FROM message_bookmarks WHERE message_id=?").get(answer)).toBeDefined();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'Report','markdown','Final answer',?,?,?)",
  ).run(result, w.owner, a.id, cid, r, JSON.stringify({ messageId: answer }), now(), now());
  const savedAt = (key: string, at: number) =>
    key === result
      ? db.prepare("UPDATE artifact_bookmarks SET saved_at=? WHERE artifact_id=?").run(at, key)
      : db.prepare("UPDATE message_bookmarks SET created_at=? WHERE message_id=?").run(at, key);
  expect((await api(w.owner, `/messages/${one}/saved`, "POST")).data).toEqual({
    ok: true,
    saved: true,
  });
  savedAt(one, 100);
  await api(w.owner, `/messages/${two}/saved`, "POST");
  savedAt(two, 300);
  // Saving again is idempotent and keeps the original save time.
  await api(w.owner, `/messages/${one}/saved`, "POST");
  // Saving a reply that has a result card saves the result: one item, and
  // the result card shows as saved too.
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  savedAt(result, 200);
  expect(
    (db.prepare("SELECT pinned FROM artifacts WHERE id=?").get(result) as any).pinned,
  ).toBe(1);
  expect(
    db.prepare("SELECT 1 FROM message_bookmarks WHERE message_id=?").get(answer),
  ).toBeUndefined();
  const list = await api(w.owner, "/saved");
  expect(
    list.data.items.map((i: any) =>
      i.kind === "result" ? ["result", i.result.id] : ["message", i.message.message_id],
    ),
  ).toEqual([
    ["message", two],
    ["result", result],
    ["message", one],
  ]);
  expect(list.data.items[0].message).toMatchObject({
    conversation_id: cid,
    conversation_title: "Saved",
    role: "user",
    preview: "Second",
    content: "Second",
    agent_id: a.id,
    agent_name: a.name,
  });
  expect(list.data.items[1].result).toMatchObject({
    id: result,
    title: "Report",
    pinned: 1,
    name: a.name,
  });
  expect(list.data.next).toBeNull();
  // The thread marks the reply saved whichever way it was saved.
  expect(
    [...(await api(w.owner, `/conversations/${cid}`)).data.saved].sort(),
  ).toEqual([one, two, answer].sort());
  expect((await api("intruder", `/messages/${one}/saved`, "POST")).status).toBe(404);
  expect((await api("intruder", `/messages/${one}/saved`, "DELETE")).status).toBe(404);
  expect((await api("intruder", "/saved")).data.items).toEqual([]);
  // Removing the reply from Saved unpins its result.
  expect((await api(w.owner, `/messages/${answer}/saved`, "DELETE")).data).toEqual({
    ok: true,
    saved: false,
  });
  expect(
    (db.prepare("SELECT pinned FROM artifacts WHERE id=?").get(result) as any).pinned,
  ).toBe(0);
  await api(w.owner, `/messages/${one}/saved`, "DELETE");
  expect(
    (await api(w.owner, "/saved")).data.items.map((i: any) => i.key),
  ).toEqual(["m:" + two]);
});

it("says on a feed card whether its latest message is saved", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id, "Save the card");
  const r = run(w.owner, a.id, cid, "completed");
  message(w.owner, cid, "user", "Find a cheaper CI", r);
  const answer = message(w.owner, cid, "assistant", "Here are the options", r);
  const card = async () =>
    (await api(w.owner, "/feed")).data.items.find(
      (i: any) => i.conversation_id === cid,
    );
  expect((await card()).last_message).toMatchObject({
    id: answer,
    saved: false,
  });
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  expect((await card()).last_message.saved).toBe(true);
  await api(w.owner, `/messages/${answer}/saved`, "DELETE");
  expect((await card()).last_message.saved).toBe(false);
  // Saving the result card the message produced counts as saving the card.
  const result = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'Report','markdown','Here are the options',?,?,?)",
  ).run(result, w.owner, a.id, cid, r, JSON.stringify({ messageId: answer }), now(), now());
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  expect((await card()).last_message.saved).toBe(true);
  // Another owner's save is not this owner's.
  expect((await api("intruder", "/feed")).data.items).toEqual([]);
});

it("scopes the Saved list to a project and to teams like the results feed", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const folder = (name: string, parent: string | null = null) => {
    const f = id();
    db.prepare(
      "INSERT INTO folders(id,owner_id,name,kind,parent_id,created_at) VALUES(?,?,?,?,?,?)",
    ).run(f, w.owner, name, parent ? "folder" : "project", parent, now());
    return f;
  };
  const project = folder("Loop"),
    nested = folder("Docs", project),
    other = folder("Other");
  const team = id();
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,?,?,?)",
  ).run(team, w.owner, "Crew", a.id, now());
  const inProject = conversation(w.owner, a.id, "In project");
  db.prepare("UPDATE conversations SET project_id=?,team_id=? WHERE id=?").run(
    nested,
    team,
    inProject,
  );
  const elsewhere = conversation(w.owner, a.id, "Elsewhere");
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(other, elsewhere);
  const r1 = run(w.owner, a.id, inProject),
    r2 = run(w.owner, a.id, elsewhere);
  const m1 = message(w.owner, inProject, "assistant", "Kept here", r1);
  const m2 = message(w.owner, elsewhere, "assistant", "Kept there", r2);
  const result = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,folder_id,title,kind,content,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,'Spec','markdown','Spec',1,?,?)",
  ).run(result, w.owner, a.id, inProject, r1, nested, now(), now());
  await api(w.owner, `/messages/${m1}/saved`, "POST");
  await api(w.owner, `/messages/${m2}/saved`, "POST");
  const keys = async (query: string) =>
    (await api(w.owner, "/saved" + query)).data.items.map((i: any) => i.key).sort();
  expect(await keys("")).toEqual(["a:" + result, "m:" + m1, "m:" + m2].sort());
  expect(await keys("?folder=" + project)).toEqual(["a:" + result, "m:" + m1].sort());
  expect(await keys("?teams=" + team)).toEqual(["a:" + result, "m:" + m1].sort());
  expect(await keys("?folder=" + other)).toEqual(["m:" + m2]);
  expect((await api("intruder", "/saved?folder=" + project)).status).toBe(404);
});

it("pages the Saved list without gaps or repeats across equal save times", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const r = run(w.owner, a.id, cid);
  const saved: string[] = [];
  for (let i = 0; i < 35; i++) {
    const m = message(w.owner, cid, "assistant", "Answer " + i, r);
    await api(w.owner, `/messages/${m}/saved`, "POST");
    saved.push(m);
  }
  // Every save at the same instant: the cursor must still be exact.
  db.prepare("UPDATE message_bookmarks SET created_at=500 WHERE owner_id=?").run(w.owner);
  const first = await api(w.owner, "/saved");
  expect(first.data.items).toHaveLength(30);
  const second = await api(
    w.owner,
    "/saved?before=" + encodeURIComponent(first.data.next),
  );
  expect(second.data.next).toBeNull();
  const seen = [...first.data.items, ...second.data.items].map(
    (i: any) => i.message.message_id,
  );
  expect(new Set(seen).size).toBe(35);
  expect([...seen].sort()).toEqual([...saved].sort());
  expect((await api(w.owner, "/saved?before=not-a-cursor")).status).toBe(400);
});

it("builds an outline of prompts, results, failures, approvals and saved messages", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const ok = run(w.owner, a.id, cid, "completed");
  const p1 = message(w.owner, cid, "user", "Build it", ok);
  message(w.owner, cid, "assistant", "Working", ok);
  const answer = message(w.owner, cid, "assistant", "Built", ok);
  const bad = run(w.owner, a.id, cid, "running");
  const p2 = message(w.owner, cid, "user", "Deploy", bad);
  requestApproval(
    { id: bad, owner_id: w.owner } as any,
    { tool: "deploy", arguments: { token: "hidden-arg" } },
  );
  db.prepare("UPDATE runs SET state='failed',error='Deploy broke' WHERE id=?").run(bad);
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  const outline = await api(w.owner, `/conversations/${cid}/outline`);
  expect(
    outline.data.items.map((i: any) => [i.kind, i.message_id, i.preview]),
  ).toEqual([
    ["prompt", p1, "Build it"],
    ["result", answer, "Built"],
    ["saved", answer, "Built"],
    ["prompt", p2, "Deploy"],
    ["approval", p2, "Approval requested"],
    ["failure", p2, "Deploy broke"],
  ]);
  expect(JSON.stringify(outline.data)).not.toContain("hidden-arg");
  expect((await api("intruder", `/conversations/${cid}/outline`)).status).toBe(404);
});

it("keeps reminders on individual card messages when the conversation moves on", async () => {
  const w = workspaceFor(), a = w.agent(), sid = subscribe(w.owner);
  const cid = conversation(w.owner, a.id, "Original conversation title");
  const firstRun = run(w.owner, a.id, cid, "completed", { input: "First  task\nplan" });
  const firstMessage = message(w.owner, cid, "assistant", "The first result", firstRun);
  const dueAt = now() + 60000;
  const remind = (targetId: string) => api(w.owner, "/later", "POST", {
    kind: "message", targetId, condition: "time", dueAt,
  });
  const first = await remind(firstMessage);
  expect(first.status).toBe(201);
  const secondRun = run(w.owner, a.id, cid, "completed", { input: "Second task" });
  const secondMessage = message(w.owner, cid, "assistant", "The second result", secondRun);
  const second = await remind(secondMessage);
  expect(second.data.replaced).toBeNull();
  db.prepare("UPDATE conversations SET title=? WHERE id=?").run("A newer conversation title", cid);
  message(w.owner, cid, "assistant", "An unrelated latest update", secondRun);

  const replacement = await remind(firstMessage);
  expect(replacement.data.replaced).toBe(first.data.id);
  const upcoming = (await api(w.owner, "/later")).data.upcoming;
  expect(upcoming).toHaveLength(2);
  for (const [target, title, content] of [
    [firstMessage, "First task plan", "The first result"],
    [secondMessage, "Second task", "The second result"],
  ]) {
    expect(upcoming.find((item: any) => item.target_id === target)).toMatchObject({
      kind: "message", title, content, conversation_id: cid, message_id: target,
    });
  }
  expect((await api("intruder", "/later", "POST", {
    kind: "message", targetId: firstMessage, condition: "time", dueAt,
  })).status).toBe(404);
  expect((await api("intruder", "/later")).data).toEqual({ due: [], upcoming: [] });

  expect(surfaceLater(dueAt)).toBe(2);
  expect(surfaceLater(dueAt)).toBe(0);
  expect(db.prepare("SELECT body,url FROM push_messages WHERE subscription_id=? ORDER BY body").all(sid)).toEqual([
    { body: "First task plan", url: `/?conversation=${cid}&message=${firstMessage}` },
    { body: "Second task", url: `/?conversation=${cid}&message=${secondMessage}` },
  ]);
  await api(w.owner, `/later/${replacement.data.id}`, "DELETE");
  expect((await api(w.owner, "/later")).data.due.map((item: any) => item.id)).toEqual([second.data.id]);
  db.prepare("DELETE FROM push_messages WHERE subscription_id=?").run(sid);
  db.prepare("DELETE FROM push_subscriptions WHERE id=?").run(sid);
});

it("uses a published reply's own question for its reminder and keeps legacy fallbacks isolated", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Imported thread");
  const rid = run(w.owner, a.id, cid, "completed", { input: "The overall task" });
  const question = message(w.owner, cid, "user", "A specific  question?", rid);
  const reply = message(w.owner, cid, "assistant", "A specific answer", rid);
  const setReply = (to: string) => db.prepare("UPDATE messages SET metadata=? WHERE id=?")
    .run(JSON.stringify({ reply: { to, published: true } }), reply);
  setReply(question);
  const imported = message(w.owner, cid, "assistant", "Imported result");
  for (const targetId of [reply, imported]) {
    await api(w.owner, "/later", "POST", { kind: "message", targetId, condition: "time", dueAt: now() + 60000 });
  }
  const titles = async () => Object.fromEntries((await api(w.owner, "/later")).data.upcoming.map((item: any) => [item.target_id, item.title]));
  expect(await titles()).toEqual({ [reply]: "A specific question?", [imported]: "Imported thread" });
  const other = workspaceFor(), otherAgent = other.agent();
  const privateThread = conversation(other.owner, otherAgent.id);
  setReply(message(other.owner, privateThread, "user", "Private question"));
  expect(await titles()).toEqual({ [reply]: "The overall task", [imported]: "Imported thread" });
  for (const item of (await api(w.owner, "/later")).data.upcoming)
    await api(w.owner, `/later/${item.id}`, "DELETE");
});

it("surfaces Later items by time, finished run and project open, with a push", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    sid = subscribe(w.owner);
  const timed = conversation(w.owner, a.id, "Timed");
  const busy = conversation(w.owner, a.id, "Busy");
  const busyRun = run(w.owner, a.id, busy, "running", { input: "Busy" });
  const msg = message(w.owner, busy, "assistant", "Result text", busyRun);
  const project = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Garden',1)",
  ).run(project, w.owner);
  const artifact = (
    await api(w.owner, "/artifacts", "POST", { title: "Plan", content: "Do it" })
  ).data.id;
  const due = now() + 60000;
  const post = (body: object) => api(w.owner, "/later", "POST", body);
  expect((await post({ kind: "conversation", targetId: timed, condition: "time" })).status).toBe(400);
  expect((await post({ kind: "conversation", targetId: timed, condition: "time", dueAt: now() - 1 })).status).toBe(400);
  expect((await post({ kind: "conversation", targetId: timed, condition: "time", dueAt: now() + 400 * 86400000 })).status).toBe(400);
  expect((await api("intruder", "/later", "POST", { kind: "conversation", targetId: timed, condition: "time", dueAt: due })).status).toBe(404);
  const first = (await post({ kind: "conversation", targetId: timed, condition: "time", dueAt: due + 1 })).data;
  // Replacing keeps one open item per target.
  const t = (await post({ kind: "conversation", targetId: timed, condition: "time", dueAt: due })).data;
  expect(t.id).not.toBe(first.id);
  const m = (await post({ kind: "message", targetId: msg, condition: "run_finished" })).data;
  const p = (await post({ kind: "artifact", targetId: artifact, condition: "project_open", projectId: project })).data;
  let later = (await api(w.owner, "/later")).data;
  expect(later.due).toEqual([]);
  expect(later.upcoming.map((i: any) => i.id).sort()).toEqual([t.id, m.id, p.id].sort());
  expect(later.upcoming.find((i: any) => i.id === m.id)).toMatchObject({
    title: "Busy",
    preview: "Result text",
    content: "Result text",
    provider: "openai",
    conversation_id: busy,
    message_id: msg,
    agent_name: a.name,
  });
  expect(later.upcoming.find((i: any) => i.id === p.id)).toMatchObject({
    title: "Plan",
    project_name: "Garden",
  });
  // Nothing is due yet and the run is still active.
  expect(surfaceLater()).toBe(0);
  expect(surfaceLater(due)).toBe(1);
  transition({ id: busyRun, owner_id: w.owner } as any, "completed");
  expect(surfaceLater(due)).toBe(1);
  expect(surfaceLater(due + 1)).toBe(0);
  expect((await api("intruder", `/projects/${project}/opened`, "POST")).status).toBe(404);
  expect((await api(w.owner, `/projects/${project}/opened`, "POST")).data).toEqual({ surfaced: 1 });
  later = (await api(w.owner, "/later")).data;
  expect(later.upcoming).toEqual([]);
  expect(later.due.map((i: any) => i.id).sort()).toEqual([t.id, m.id, p.id].sort());
  const pushes = db
    .prepare("SELECT message_key,title,body,url FROM push_messages WHERE subscription_id=? ORDER BY message_key")
    .all(sid) as any[];
  expect(pushes).toEqual(
    [
      { message_key: "later-" + t.id, title: "Back from Later", body: "Timed", url: "/?conversation=" + timed },
      { message_key: "later-" + m.id, title: "Back from Later", body: "Busy", url: `/?conversation=${busy}&message=${msg}` },
    ].sort((x, y) => x.message_key.localeCompare(y.message_key)),
  );
  expect((await api("intruder", `/later/${t.id}`, "DELETE")).status).toBe(404);
  expect((await api("intruder", "/later")).data).toEqual({ due: [], upcoming: [] });
  expect((await api(w.owner, `/later/${t.id}`, "DELETE")).data).toEqual({ ok: true });
  expect((await api(w.owner, "/later")).data.due).toHaveLength(2);
});

it("submits a scheduled send exactly once, even when the job repeats", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const key = "schedule-" + randomBytes(6).toString("hex");
  const body = {
    agentId: a.id,
    conversationId: cid,
    input: "Morning check",
    attachmentIds: [],
    idempotencyKey: key,
    sendAt: now() + 60000,
  };
  expect((await api(w.owner, "/scheduled-sends", "POST", { ...body, sendAt: now() - 1 })).status).toBe(400);
  expect((await api("intruder", "/scheduled-sends", "POST", body)).status).toBe(404);
  const created = await api(w.owner, "/scheduled-sends", "POST", body);
  expect(created.status).toBe(201);
  expect(created.data).toMatchObject({ state: "scheduled", input: "Morning check" });
  expect((await api(w.owner, "/scheduled-sends", "POST", body)).data.id).toBe(created.data.id);
  expect((await api(w.owner, "/scheduled-sends", "POST", { ...body, input: "Other" })).status).toBe(409);
  expect((await api(w.owner, `/scheduled-sends?conversation=${cid}`)).data.items).toHaveLength(1);
  expect((await api("intruder", "/scheduled-sends")).data.items).toEqual([]);
  expect((await api("intruder", `/scheduled-sends/${created.data.id}`, "DELETE")).status).toBe(404);
  expect(deliverScheduledSends(now())).toBe(0);
  expect(deliverScheduledSends(now() + 120000)).toBe(1);
  expect(deliverScheduledSends(now() + 120000)).toBe(0);
  const row = db.prepare("SELECT * FROM scheduled_sends WHERE id=?").get(created.data.id) as any;
  expect(row.state).toBe("submitted");
  // Even if the row were replayed, the stored key finds the same run.
  db.prepare("UPDATE scheduled_sends SET state='scheduled' WHERE id=?").run(row.id);
  expect(deliverScheduledSends(now() + 120000)).toBe(1);
  const runs = db.prepare("SELECT id,state,conversation_id FROM runs WHERE owner_id=? AND idempotency_key=?").all(w.owner, key) as any[];
  expect(runs).toEqual([{ id: row.run_id, state: "queued", conversation_id: cid }]);
  expect(db.prepare("SELECT count(*) n FROM messages WHERE run_id=?").get(row.run_id)).toEqual({ n: 1 });
  expect((await api(w.owner, `/scheduled-sends/${row.id}`, "DELETE")).status).toBe(409);
  // A send whose agent was retired fails visibly instead of retrying.
  const retired = await api(w.owner, "/scheduled-sends", "POST", { ...body, idempotencyKey: key + "-2" });
  db.prepare("UPDATE agents SET retired_at=1 WHERE id=?").run(a.id);
  deliverScheduledSends(now() + 120000);
  expect(db.prepare("SELECT state,error FROM scheduled_sends WHERE id=?").get(retired.data.id)).toMatchObject({ state: "failed" });
  const cancelled = await api(w.owner, "/scheduled-sends", "POST", { ...body, agentId: w.agent().id, conversationId: undefined, idempotencyKey: key + "-3" });
  expect((await api(w.owner, `/scheduled-sends/${cancelled.data.id}`, "DELETE")).data).toEqual({ ok: true });
  expect(deliverScheduledSends(now() + 120000)).toBe(0);
});

it("keeps scheduled messages that could not be sent visible until you retry or dismiss them", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id, "Deploys");
  const key = "failed-" + randomBytes(6).toString("hex");
  const body = {
    agentId: a.id,
    conversationId: cid,
    input: "Ship it",
    attachmentIds: [],
    idempotencyKey: key,
    sendAt: now() + 60000,
  };
  const created = (await api(w.owner, "/scheduled-sends", "POST", body)).data;
  const other = (
    await api(w.owner, "/scheduled-sends", "POST", { ...body, idempotencyKey: key + "-b" })
  ).data;
  // The agent is retired before the messages are due: Loop refuses them.
  db.prepare("UPDATE agents SET retired_at=1 WHERE id=?").run(a.id);
  expect(deliverScheduledSends(now() + 120000)).toBe(0);
  const listed = (await api(w.owner, "/scheduled-sends")).data.items;
  expect(listed.find((i: any) => i.id === created.id)).toMatchObject({
    state: "failed",
    input: "Ship it",
    error: expect.stringContaining("retired"),
    agent_name: a.name,
    conversation_title: "Deploys",
  });
  // Nothing was sent, and the worker never retries it on its own.
  expect(db.prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?").get(key)).toEqual({ n: 0 });
  // Retrying while still refused keeps it failed, with the reason.
  const refused = await api(w.owner, `/scheduled-sends/${created.id}/retry`, "POST", {});
  expect(refused.data).toMatchObject({ run: null, row: { state: "failed" } });
  // After restoring the agent, a deliberate retry sends it exactly once.
  db.prepare("UPDATE agents SET retired_at=NULL WHERE id=?").run(a.id);
  const sent = await api(w.owner, `/scheduled-sends/${created.id}/retry`, "POST", {});
  expect(sent.data.row).toMatchObject({ state: "submitted", run_id: sent.data.run.id });
  expect(typeof sent.data.run.payload).toBe("string");
  expect(JSON.parse(sent.data.run.payload)).toMatchObject({ agentId: a.id });
  expect((await api(w.owner, `/scheduled-sends/${created.id}/retry`, "POST", {})).status).toBe(409);
  expect(db.prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?").get(key)).toEqual({ n: 1 });
  // Dismissing removes a failed message without sending it.
  expect((await api("intruder", `/scheduled-sends/${other.id}`, "DELETE")).status).toBe(404);
  expect((await api(w.owner, `/scheduled-sends/${other.id}`, "DELETE")).data).toEqual({ ok: true });
  expect((await api(w.owner, "/scheduled-sends")).data.items.map((i: any) => i.id)).not.toContain(other.id);
  expect(db.prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?").get(key + "-b")).toEqual({ n: 0 });
});

it("lists, edits and cancels scheduled messages for new threads from anywhere", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const body = {
    agentId: a.id,
    input: "Start the weekly report",
    attachmentIds: [],
    idempotencyKey: "global-" + randomBytes(6).toString("hex"),
    sendAt: now() + 60000,
  };
  const created = (await api(w.owner, "/scheduled-sends", "POST", body)).data;
  expect((await api(w.owner, "/scheduled-sends")).data.items).toEqual([
    expect.objectContaining({
      id: created.id,
      state: "scheduled",
      conversation_id: null,
      agent_name: a.name,
    }),
  ]);
  const later = now() + 7200000;
  const edited = await api(w.owner, `/scheduled-sends/${created.id}`, "PATCH", {
    input: "Start the monthly report",
    sendAt: later,
  });
  expect(edited.data).toMatchObject({ input: "Start the monthly report", send_at: later });
  expect(
    (await api(w.owner, `/scheduled-sends/${created.id}`, "PATCH", { sendAt: now() - 1 })).status,
  ).toBe(400);
  expect(
    (await api("intruder", `/scheduled-sends/${created.id}`, "PATCH", { input: "x" })).status,
  ).toBe(404);
  expect((await api(w.owner, `/scheduled-sends/${created.id}`, "DELETE")).data).toEqual({ ok: true });
  expect(
    (await api(w.owner, `/scheduled-sends/${created.id}`, "PATCH", { input: "late" })).status,
  ).toBe(409);
  expect((await api(w.owner, "/scheduled-sends")).data.items).toEqual([]);
});

it("returns the receipt for a matching retry of a scheduled send, even after it is due", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const body = {
    agentId: a.id,
    input: "Remind me",
    attachmentIds: [],
    idempotencyKey: "retry-" + randomBytes(6).toString("hex"),
    sendAt: now() + 60000,
  };
  const created = await api(w.owner, "/scheduled-sends", "POST", body);
  expect(created.status).toBe(201);
  // The response was lost and the retry arrives after the send time. One
  // fixed timestamp: the retry repeats the exact request.
  const due = now() - 1000;
  db.prepare("UPDATE scheduled_sends SET send_at=? WHERE id=?").run(due, created.data.id);
  const retried = await api(w.owner, "/scheduled-sends", "POST", { ...body, sendAt: due });
  expect(retried.status).toBe(200);
  expect(retried.data.id).toBe(created.data.id);
  // A changed intent never silently reuses the uncertain work.
  for (const changed of [
    { sendAt: now() + 120000 },
    { folderId: null, input: "Remind me later" },
    { replyToMessageId: "other" },
  ])
    expect(
      (await api(w.owner, "/scheduled-sends", "POST", { ...body, sendAt: due, ...changed })).status,
    ).toBe(409);
  expect(
    db.prepare("SELECT count(*) n FROM scheduled_sends WHERE idempotency_key=?").get(body.idempotencyKey),
  ).toEqual({ n: 1 });
});

it("keeps a highlighted excerpt with a scheduled reply", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const answer = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,'assistant',?,'{}',?)",
  ).run(answer, w.owner, cid, "First finding.\nSecond finding.", now());
  const body = {
    agentId: a.id,
    conversationId: cid,
    input: "Check this again",
    attachmentIds: [],
    replyToMessageId: answer,
    replyExcerpt: "Second finding.",
    idempotencyKey: "excerpt-" + randomBytes(6).toString("hex"),
    sendAt: now() + 60000,
  };
  expect(
    (await api(w.owner, "/scheduled-sends", "POST", { ...body, replyExcerpt: "Third" })).status,
  ).toBe(400);
  const created = await api(w.owner, "/scheduled-sends", "POST", body);
  expect(created.status).toBe(201);
  expect((await api(w.owner, "/scheduled-sends", "POST", body)).data.id).toBe(created.data.id);
  expect(
    (await api(w.owner, "/scheduled-sends", "POST", { ...body, replyExcerpt: "First finding." })).status,
  ).toBe(409);
  // Other tests' scheduled messages may also be due.
  deliverScheduledSends(now() + 120000);
  const runId = (
    db.prepare("SELECT run_id FROM scheduled_sends WHERE id=?").get(created.data.id) as { run_id: string }
  ).run_id;
  const payload = JSON.parse(
    (db.prepare("SELECT payload FROM runs WHERE id=?").get(runId) as { payload: string }).payload,
  );
  expect(payload.replyTo).toMatchObject({ id: answer, content: "Second finding.", excerpt: true });
  transition(ownedRun(runId, w.owner), "cancelled");
});

it("delivers a scheduled message to its chosen project, to no project, or to the agent's", async () => {
  const w = workspaceFor();
  const project = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,parent_id,created_at) VALUES(?,?,?,'project',NULL,?)",
  ).run(project, w.owner, "Agent home", now());
  const a = w.agent();
  db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(project, a.id);
  const schedule = async (extra: object) => {
    const created = await api(w.owner, "/scheduled-sends", "POST", {
      agentId: a.id,
      input: "Kick off",
      attachmentIds: [],
      idempotencyKey: "project-" + randomBytes(6).toString("hex"),
      sendAt: now() + 60000,
      ...extra,
    });
    expect(created.status).toBe(201);
    return created.data.id as string;
  };
  const cleared = await schedule({ folderId: null });
  const omitted = await schedule({});
  deliverScheduledSends(now() + 120000);
  const folderOf = (sendId: string) => {
    const run = db
      .prepare(
        "SELECT r.payload FROM scheduled_sends s JOIN runs r ON r.id=s.run_id WHERE s.id=?",
      )
      .get(sendId) as { payload: string };
    return JSON.parse(run.payload).folderId ?? null;
  };
  // "No project" stays no project; not choosing uses the agent's project.
  expect(folderOf(cleared)).toBeNull();
  expect(folderOf(omitted)).toBe(project);
});

it("never lets failed scheduled messages hide the ones still waiting", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const pending = (
    await api(w.owner, "/scheduled-sends", "POST", {
      agentId: a.id,
      input: "Still going out",
      attachmentIds: [],
      idempotencyKey: "pending-" + randomBytes(6).toString("hex"),
      sendAt: now() + 3600000,
    })
  ).data.id;
  const insert = db.prepare(
    `INSERT INTO scheduled_sends(id,owner_id,agent_id,input,idempotency_key,send_at,state,error,created_at)
    VALUES(?,?,?,?,?,?,'failed','Refused',?)`,
  );
  // One fixed base time, so "Old 0" is exactly the newest failure.
  const base = now() - 1000;
  for (let i = 0; i < 201; i++)
    insert.run(id(), w.owner, a.id, "Old " + i, "old-" + i + "-" + id(), base - i, base - i);
  const first = (await api(w.owner, "/scheduled-sends")).data;
  expect(first.items.find((i: any) => i.id === pending)).toMatchObject({ state: "scheduled" });
  expect(first.items.filter((i: any) => i.state === "failed")).toHaveLength(100);
  expect(first.items[0]).toMatchObject({ state: "failed", input: "Old 0" });
  // Every failure stays reachable: page newest first to the oldest.
  const failed: any[] = first.items.filter((i: any) => i.state === "failed");
  let next = first.failed_next;
  while (next) {
    const page = (
      await api(w.owner, "/scheduled-sends?failedBefore=" + encodeURIComponent(next))
    ).data;
    // Later pages hold failures only; pending sends are on the first page.
    expect(page.items.every((i: any) => i.state === "failed")).toBe(true);
    failed.push(...page.items);
    next = page.failed_next;
  }
  expect(failed).toHaveLength(201);
  expect(new Set(failed.map((i) => i.id)).size).toBe(201);
  // The oldest failure can still be recovered: dismiss it.
  const oldest = failed.at(-1);
  expect(oldest.input).toBe("Old 200");
  expect((await api(w.owner, `/scheduled-sends/${oldest.id}`, "DELETE")).data).toEqual({ ok: true });
  expect((await api(w.owner, "/scheduled-sends?failedBefore=bogus")).status).toBe(400);
});

it("queues a follow-up instead of steering when POST /runs asks to queue", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  // Steering depends on the connection the run started with.
  const active = run(w.owner, a.id, cid, "running", {
    payload: { connectionId: a.connection_id },
  });
  const queued = await api(w.owner, "/runs", "POST", {
    agentId: a.id,
    conversationId: cid,
    input: "After this",
    idempotencyKey: "queue-" + randomBytes(6).toString("hex"),
    queue: true,
  });
  expect(queued.status).toBe(202);
  expect(queued.data).toMatchObject({ state: "queued", conversation_id: cid });
  expect(queued.data.id).not.toBe(active);
  const steered = await api(w.owner, "/runs", "POST", {
    agentId: a.id,
    conversationId: cid,
    input: "Steer",
    idempotencyKey: "steer-" + randomBytes(6).toString("hex"),
  });
  expect(steered.data).toMatchObject({ id: active, steeringId: expect.any(String) });
});

it("edits, reorders and moves only queued runs of the owner", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    b = w.agent(),
    cid = conversation(w.owner, a.id);
  const submitRun = async (input: string) =>
    (
      await api(w.owner, "/runs", "POST", {
        agentId: a.id,
        conversationId: cid,
        input,
        idempotencyKey: "q-" + randomBytes(6).toString("hex"),
        queue: true,
      })
    ).data;
  const first = await submitRun("first");
  const second = await submitRun("second");
  const third = await submitRun("third");
  expect((await api(w.owner, `/runs/${third.id}`, "PATCH", { input: "third, edited" })).data).toEqual({ ok: true });
  expect((db.prepare("SELECT input FROM runs WHERE id=?").get(third.id) as any).input).toBe("third, edited");
  expect((db.prepare("SELECT content FROM messages WHERE run_id=?").get(third.id) as any).content).toBe("third, edited");
  expect((await api("intruder", `/runs/${third.id}`, "PATCH", { input: "x" })).status).toBe(404);
  expect((await api(w.owner, `/runs/${third.id}`, "PATCH", { input: "" })).status).toBe(400);
  // The inbox offers only the moves a reorder can make.
  const moves = async (conversationId: string) => {
    const item = (await api(w.owner, "/feed?filter=queued")).data.items.find(
      (i: any) => i.conversation_id === conversationId,
    );
    expect(item.run.state).toBe("queued");
    return { up: item.run.can_move_up, down: item.run.can_move_down };
  };
  // Turns in one thread keep their order, so the newest has nothing to swap.
  expect(await moves(cid)).toEqual({ up: false, down: false });
  // Queued follow-ups are listed separately with their own controls.
  const listed = (await api(w.owner, "/feed?filter=queued")).data.items.find(
    (i: any) => i.conversation_id === cid,
  ).queued_runs;
  expect(listed.map((r: any) => r.id)).toEqual([first.id, second.id, third.id]);
  expect(listed.every((r: any) => r.can_edit)).toBe(true);
  // Opening a long queued prompt from the Inbox and saving it unchanged keeps
  // every character.
  const long = "Step " + "x".repeat(714);
  await api(w.owner, `/runs/${second.id}`, "PATCH", { input: long });
  const shown = (await api(w.owner, "/feed?filter=queued")).data.items
    .find((i: any) => i.conversation_id === cid)
    .queued_runs.find((r: any) => r.id === second.id).input;
  expect(shown).toHaveLength(719);
  await api(w.owner, `/runs/${second.id}`, "PATCH", { input: shown });
  expect((db.prepare("SELECT input FROM runs WHERE id=?").get(second.id) as any).input).toBe(long);
  await api(w.owner, `/runs/${second.id}`, "PATCH", { input: "second" });
  const elsewhere = conversation(w.owner, a.id);
  const other = (
    await api(w.owner, "/runs", "POST", {
      agentId: a.id,
      conversationId: elsewhere,
      input: "other thread",
      idempotencyKey: "q-" + randomBytes(6).toString("hex"),
      queue: true,
    })
  ).data;
  expect(await moves(elsewhere)).toEqual({ up: true, down: false });
  expect(await moves(cid)).toEqual({ up: false, down: true });
  // A paused run ahead in line is not a swap partner for a lone queued run.
  const c = w.agent(),
    lone = conversation(w.owner, c.id);
  run(w.owner, c.id, conversation(w.owner, c.id), "paused");
  const loneRun = run(w.owner, c.id, lone, "queued");
  db.prepare("UPDATE runs SET created_at=created_at+10 WHERE id=?").run(loneRun);
  expect(await moves(lone)).toEqual({ up: false, down: false });
  expect((await api(w.owner, `/runs/${first.id}/reorder`, "POST", { direction: "up" })).status).toBe(409);
  expect((await api("intruder", `/runs/${third.id}/reorder`, "POST", { direction: "up" })).status).toBe(404);
  const sameThread = await api(w.owner, `/runs/${third.id}/reorder`, "POST", { direction: "up" });
  expect(sameThread.status).toBe(409);
  expect(sameThread.data.error).toMatch(/order they were sent/);
  expect((await api(w.owner, `/runs/${other.id}/reorder`, "POST", { direction: "up" })).data).toEqual({ ok: true });
  const order = () =>
    (
      db
        .prepare("SELECT id FROM runs WHERE agent_id=? AND state='queued' ORDER BY COALESCE(queue_rank,created_at),rowid")
        .all(a.id) as { id: string }[]
    ).map((r) => r.id);
  expect(order()).toEqual([first.id, second.id, other.id, third.id]);
  const positions = (await api(w.owner, "/feed?filter=queued")).data.items.find(
    (i: any) => i.conversation_id === cid,
  ).run;
  // The other thread's message moved ahead of this thread's newest one.
  expect(positions).toMatchObject({ id: third.id, queue_position: 4 });
  // Moving to another agent cancels the queued run and returns the new run.
  const key = "move-" + randomBytes(6).toString("hex");
  const moved = await api(w.owner, `/runs/${second.id}/move`, "POST", { agentId: b.id, idempotencyKey: key });
  expect(moved.status).toBe(202);
  expect(moved.data).toMatchObject({ agent_id: b.id, state: "queued", input: "second", conversation_id: expect.any(String) });
  expect(moved.data.conversation_id).not.toBe(cid);
  expect((db.prepare("SELECT state FROM runs WHERE id=?").get(second.id) as any).state).toBe("cancelled");
  const again = await api(w.owner, `/runs/${second.id}/move`, "POST", { agentId: b.id, idempotencyKey: key });
  expect(again.data.id).toBe(moved.data.id);
  expect((await api(w.owner, `/runs/${second.id}/move`, "POST", { agentId: b.id, idempotencyKey: key + "x" })).status).toBe(409);
  expect((await api("intruder", `/runs/${third.id}/move`, "POST", { agentId: b.id, idempotencyKey: key + "y" })).status).toBe(404);
  // Once claimed, a run cannot be edited, reordered or moved.
  db.prepare("UPDATE runs SET state='running',worker_id='w' WHERE id=?").run(first.id);
  expect((await api(w.owner, `/runs/${first.id}`, "PATCH", { input: "late" })).status).toBe(409);
  expect((await api(w.owner, `/runs/${first.id}/move`, "POST", { agentId: b.id, idempotencyKey: key + "z" })).status).toBe(409);
  expect((await api(w.owner, `/runs/${first.id}/reorder`, "POST", { direction: "down" })).status).toBe(409);
  // A paused-then-resumed run is queued again but has already started: its
  // checkpointed history would still run the original instruction.
  db.prepare("UPDATE runs SET state='queued',worker_id=NULL,active_since=? WHERE id=?").run(now(), first.id);
  expect((await api(w.owner, `/runs/${first.id}`, "PATCH", { input: "late" })).status).toBe(409);
  expect((await api(w.owner, `/runs/${first.id}/move`, "POST", { agentId: b.id, idempotencyKey: key + "r" })).status).toBe(409);
  db.prepare("UPDATE runs SET active_since=NULL WHERE id=?").run(first.id);
  const checkpointMessage = (db.prepare("SELECT id FROM messages WHERE run_id=? AND role='assistant'").get(first.id) as any)?.id
    ?? message(w.owner, cid, "assistant", "", first.id);
  const checkpointArtifact = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,'Draft','markdown','',?,?)",
  ).run(checkpointArtifact, w.owner, a.id, cid, first.id, now(), now());
  db.prepare("INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,?,?,'[]')").run(first.id, checkpointMessage, checkpointArtifact);
  expect((await api(w.owner, `/runs/${first.id}`, "PATCH", { input: "late" })).status).toBe(409);
  expect(
    (await api(w.owner, "/feed?filter=queued")).data.items
      .find((i: any) => i.conversation_id === cid)
      .queued_runs.find((r: any) => r.id === first.id).can_edit,
  ).toBe(false);
  expect((db.prepare("SELECT input FROM runs WHERE id=?").get(first.id) as any).input).toBe("first");
});

it("binds a fork to a native agent's backend and carries the copied turns", async () => {
  const { selectedContext } = await import("../src/server/carried-context");
  const w = workspaceFor(),
    source = w.agent();
  const nativeConnection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Native','','connected',?,?,?)",
  ).run(
    nativeConnection,
    w.owner,
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify({loopHarness:"codex",authMode:"subscription"}),
    now(),
  );
  const native = createAgent(w.owner, {
    name: "n-" + randomBytes(6).toString("hex"),
    connectionId: nativeConnection,
    model: "fixture",
  });
  const cid = conversation(w.owner, source.id, "Origin");
  const r = run(w.owner, source.id, cid);
  message(w.owner, cid, "user", "Plan the release", r);
  const answer = message(w.owner, cid, "assistant", "Ship on Friday", r);
  const fork = await api(w.owner, `/conversations/${cid}/fork`, "POST", { messageId: answer, agentId: native.id });
  expect(fork.status).toBe(200);
  expect(db.prepare("SELECT execution_backend,execution_connection_id FROM conversations WHERE id=?").get(fork.data.id)).toEqual({
    execution_backend: "legacy",
    execution_connection_id: nativeConnection,
  });
  const context = selectedContext(fork.data.id);
  expect(context).toContain("Plan the release");
  expect(context).toContain("Ship on Friday");
  // The first prompt is accepted instead of "belongs to its original backend".
  const sent = await api(w.owner, "/runs", "POST", {
    agentId: native.id,
    conversationId: fork.data.id,
    input: "Continue",
    idempotencyKey: "fork-" + randomBytes(6).toString("hex"),
  });
  expect(sent.status).toBe(202);
  // A fork to an API agent stays on the managed backend.
  const apiFork = await api(w.owner, `/conversations/${cid}/fork`, "POST", { messageId: answer });
  expect((db.prepare("SELECT execution_backend FROM conversations WHERE id=?").get(apiFork.data.id) as any).execution_backend).toBe("legacy");
});

it("forks a conversation through the chosen message", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    b = w.agent(),
    cid = conversation(w.owner, a.id, "Origin");
  const r = run(w.owner, a.id, cid);
  const m1 = message(w.owner, cid, "user", "One", r);
  message(w.owner, cid, "assistant", "   ", r);
  const m2 = message(w.owner, cid, "assistant", "Two", r);
  message(w.owner, cid, "user", "Three", r);
  const fork = await api(w.owner, `/conversations/${cid}/fork`, "POST", { messageId: m2 });
  expect(fork.data.agentId).toBe(a.id);
  const created = db.prepare("SELECT * FROM conversations WHERE id=?").get(fork.data.id) as any;
  expect(created).toMatchObject({ title: "Fork: Origin", origin: "loop-fork", owner_id: w.owner });
  const copied = db
    .prepare("SELECT content,json_extract(metadata,'$.sourceMessage') source FROM messages WHERE conversation_id=? ORDER BY created_at,rowid")
    .all(fork.data.id);
  expect(copied).toEqual([
    { content: "One", source: m1 },
    { content: "Two", source: m2 },
  ]);
  expect((await api(w.owner, `/conversations/${cid}/fork`, "POST", { messageId: m2, agentId: b.id })).data.agentId).toBe(b.id);
  const other = conversation(w.owner, a.id);
  expect((await api(w.owner, `/conversations/${other}/fork`, "POST", { messageId: m2 })).status).toBe(404);
  expect((await api("intruder", `/conversations/${cid}/fork`, "POST", { messageId: m2 })).status).toBe(404);
});

it("sums provider receipts per run without double counting cumulative deltas", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const openai = run(w.owner, a.id, cid),
    anthropic = run(w.owner, a.id, cid),
    chat = run(w.owner, a.id, cid),
    none = run(w.owner, a.id, cid);
  emit(w.owner, openai, "provider.receipt", { externalId: "resp_1", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
  emit(w.owner, openai, "provider.receipt", { externalId: "resp_2", usage: { input_tokens: 150, output_tokens: 30 } });
  emit(w.owner, anthropic, "provider.receipt", { externalId: "msg_1", usage: { input_tokens: 50, output_tokens: 1 } });
  emit(w.owner, anthropic, "provider.receipt", { usage: { output_tokens: 40 } });
  emit(w.owner, chat, "provider.receipt", { usage: { prompt_tokens: 7, completion_tokens: 3 } });
  emit(w.owner, none, "progress", { message: "fixture" });
  // Only runs with a memory receipt are listed, so "Memory used" is not shown
  // on every reply.
  db.prepare("INSERT INTO memory_receipts VALUES(?,?,?,?,?)").run(
    chat,
    "semantic",
    "[]",
    12,
    now(),
  );
  const usage = await api(w.owner, `/conversations/${cid}/usage`);
  expect(usage.data).toEqual({
    runs: {
      [openai]: { input_tokens: 250, output_tokens: 50 },
      [anthropic]: { input_tokens: 50, output_tokens: 40 },
      [chat]: { input_tokens: 7, output_tokens: 3 },
    },
    total: { input_tokens: 307, output_tokens: 93 },
    memory: [chat],
  });
  expect((await api("intruder", `/conversations/${cid}/usage`)).status).toBe(404);
});

it("pushes approval requests without their arguments and delivers app messages", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id),
    sid = subscribe(w.owner);
  const other = workspaceFor();
  subscribe(other.owner);
  const r = run(w.owner, a.id, cid, "running");
  const approval = requestApproval(
    { id: r, owner_id: w.owner } as any,
    { tool: "shell", arguments: { command: "cat secret-token-123" } },
  );
  const rows = db.prepare("SELECT * FROM push_messages WHERE message_key=?").all("approval-" + approval.id) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    subscription_id: sid,
    title: `@${a.name} needs your approval`,
    body: "Open Loop to review the request.",
    url: "/?conversation=" + cid,
  });
  expect(JSON.stringify(rows)).not.toContain("secret-token");
  // Auto-approved requests do not notify.
  requestApproval({ id: r, owner_id: w.owner } as any, { tool: "read" }, true);
  expect(db.prepare("SELECT count(*) n FROM push_messages WHERE subscription_id=? AND message_key LIKE 'approval-%'").get(sid)).toEqual({ n: 1 });
  db.prepare("UPDATE push_messages SET available_at=0").run();
  const failure = vi.fn(async () => {
    throw { statusCode: 503 };
  });
  await deliverNotifications(failure as any);
  const retried = db.prepare("SELECT attempts,available_at,delivered_at FROM push_messages WHERE subscription_id=? AND message_key=?").get(sid, "approval-" + approval.id) as any;
  expect(retried.attempts).toBe(1);
  expect(retried.available_at).toBeGreaterThan(now());
  expect(retried.delivered_at).toBeNull();
  db.prepare("UPDATE push_messages SET available_at=0").run();
  const send = vi.fn(async () => ({ statusCode: 201, body: "", headers: {} }));
  await Promise.all([deliverNotifications(send as any), deliverNotifications(send as any)]);
  const payloads = send.mock.calls.map((call: any) => JSON.parse(call[1]));
  const mine = payloads.filter((p) => p.tag === "approval-" + approval.id);
  expect(mine).toEqual([
    {
      title: `@${a.name} needs your approval`,
      body: "Open Loop to review the request.",
      tag: "approval-" + approval.id,
      url: "/?conversation=" + cid,
    },
  ]);
  expect(Object.keys(mine[0]).sort()).toEqual(["body", "tag", "title", "url"]);
  const sent = send.mock.calls.length;
  await deliverNotifications(send as any);
  expect(send.mock.calls.length).toBe(sent);
});

it("lists snippets, searches personal prompts and summarizes projects", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const snippet = await api(w.owner, "/artifacts", "POST", {
    title: "Standup",
    content: "Summarize yesterday",
    metadata: { snippet: true },
  });
  expect(snippet.status).toBe(201);
  await api(w.owner, "/artifacts", "POST", { title: "Saved prompt: Deploy", content: "Ship it" });
  await api(w.owner, "/artifacts", "POST", { title: "Report", content: "Not a snippet" });
  expect((await api(w.owner, "/artifacts", "POST", { title: "X", content: "y", metadata: { tool: "exec" } })).status).toBe(400);
  // The same text saved again is offered once.
  await api(w.owner, "/artifacts", "POST", {
    title: "Standup again",
    content: "Summarize yesterday ",
    metadata: { snippet: true },
  });
  const snippets = (await api(w.owner, "/snippets")).data.items;
  expect(snippets.map((s: any) => s.title).sort()).toEqual(["Saved prompt: Deploy", "Standup again"]);
  // More repeated saves than the list holds don't hide older snippets.
  const repeats = db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,'markdown',?,'{\"snippet\":true}',?,?)",
  );
  const later = now() + 1000;
  for (let i = 0; i < 250; i++)
    repeats.run(id(), w.owner, "Snippet: Check CI", "Check CI", later + i, later + i);
  const crowded = (await api(w.owner, "/snippets")).data.items;
  expect(crowded.map((s: any) => s.content).sort()).toEqual([
    "Check CI",
    "Ship it",
    "Summarize yesterday ",
  ]);
  expect((await api("intruder", "/snippets")).data.items).toEqual([]);

  const project = id();
  db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Alpha',1)").run(project, w.owner);
  const empty = id();
  db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Beta',1)").run(empty, w.owner);
  db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(project, a.id);
  const cid = conversation(w.owner, a.id);
  for (const input of ["Deploy the Garden", "write tests"])
    await api(w.owner, "/runs", "POST", {
      agentId: a.id,
      conversationId: cid,
      input,
      idempotencyKey: "p-" + randomBytes(6).toString("hex"),
      queue: true,
      folderId: project,
    });
  const found = await api(w.owner, "/me/prompts?q=GARDEN");
  expect(found.data.items.map((i: any) => i.content)).toEqual(["Deploy the Garden"]);
  expect((await api(w.owner, "/me/prompts")).data.items).toHaveLength(2);
  expect((await api(w.owner, "/me/prompts?q=" + "x".repeat(201))).status).toBe(400);
  const r = db.prepare("SELECT id FROM runs WHERE conversation_id=? ORDER BY rowid LIMIT 1").get(cid) as any;
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(r.id);
  const summary = (await api(w.owner, "/projects/summary")).data.items;
  expect(summary.map((s: any) => s.name).sort()).toEqual(["Alpha", "Beta", "Workspace"]);
  const alpha = summary.find((s: any) => s.id === project);
  expect(alpha).toMatchObject({ agents: 1, working: 1, needs: 0, latest_result: null });
  expect(alpha.last_activity_at).toBeGreaterThan(0);
  expect(summary.find((s: any) => s.id === empty)).toMatchObject({ agents: 0, last_activity_at: null });
  const foreign = (await api("intruder", "/projects/summary")).data.items;
  expect(foreign).toHaveLength(1);
  expect(foreign[0]).toMatchObject({ name: "Workspace", agents: 0, working: 0, needs: 0, last_activity_at: null });
});

it("keeps your profile per owner, with counts matching your prompt history", async () => {
  const w = workspaceFor(),
    a = w.agent();
  w.agent();
  const blank = (await api(w.owner, "/me/profile")).data;
  expect(blank).toMatchObject({ display_name: null, handle: null, bio: null });
  expect(blank.counts).toEqual({ messages: 0, agents: 2, projects: 0 });

  const project = id();
  db.prepare("INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Alpha',1)").run(project, w.owner);
  db.prepare("INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Inner',1)").run(id(), w.owner, project);
  db.prepare("UPDATE agents SET retired_at=1 WHERE id=?").run(a.id);
  const live = w.agent();
  const cid = conversation(w.owner, live.id);
  for (const input of ["first", "second"])
    await api(w.owner, "/runs", "POST", {
      agentId: live.id,
      conversationId: cid,
      input,
      idempotencyKey: "pp-" + randomBytes(6).toString("hex"),
      queue: true,
    });
  const prompts = (await api(w.owner, "/me/prompts")).data.items.length;
  expect((await api(w.owner, "/me/profile")).data.counts).toEqual({
    messages: prompts,
    agents: 2,
    projects: 1,
  });
  expect(prompts).toBe(2);

  const saved = await api(w.owner, "/me/profile", "PUT", {
    display_name: "  Jamie A  ",
    handle: "@Jamie_A",
    bio: "Building with agents.",
  });
  expect(saved.status).toBe(200);
  expect(saved.data).toMatchObject({ display_name: "Jamie A", handle: "jamie_a", bio: "Building with agents." });
  // Empty text clears a field.
  expect((await api(w.owner, "/me/profile", "PUT", { display_name: "", handle: "jamie_a", bio: "" })).data)
    .toMatchObject({ display_name: null, handle: "jamie_a", bio: null });
  expect((await api(w.owner, "/me/profile", "PUT", { display_name: null, handle: "bad handle!", bio: null })).status).toBe(400);
  expect((await api(w.owner, "/me/profile", "PUT", { display_name: null, handle: null, bio: "x".repeat(201) })).status).toBe(400);

  // Handles are unique across owners, ignoring case; others' profiles stay private.
  const other = workspaceFor();
  expect((await api(other.owner, "/me/profile", "PUT", { display_name: null, handle: "JAMIE_A", bio: null })).status).toBe(409);
  expect((await api(other.owner, "/me/profile")).data).toMatchObject({ handle: null, counts: { messages: 0, agents: 0, projects: 0 } });
});

it("pages your explicit approvals through the profile API without mixing owners or automatic decisions", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Release review");
  const rid = run(w.owner, a.id, cid, "awaiting_approval");
  const approvals = [];
  for (let i = 0; i < 53; i++) {
    db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(rid);
    const approval = requestApproval(ownedRun(rid, w.owner), {
      type: "mcp_tool", tool: "merge_pull_request", arguments: { pullNumber: i },
    });
    expect((await api(w.owner, `/approvals/${approval.id}`, "POST", { decision: i === 0 ? "reject" : "approve" })).status).toBe(200);
    approvals.push(approval.id);
  }
  // Equal timestamps still page each decision exactly once.
  db.prepare("UPDATE personal_decisions SET created_at=100 WHERE owner_id=?").run(w.owner);
  expect((await api(w.owner, `/approvals/${approvals[1]}`, "POST", { decision: "approve" })).status).toBe(409);
  const auto = requestApproval(ownedRun(rid, w.owner), { type: "mcp_tool", tool: "automatic" }, true);
  const expired = requestApproval(ownedRun(rid, w.owner), { type: "mcp_tool", tool: "expired" });
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(rid);
  db.prepare("UPDATE approvals SET expires_at=0 WHERE id=?").run(expired.id);
  expect((await api(w.owner, `/approvals/${expired.id}`, "POST", { decision: "approve" })).status).toBe(409);

  const first = (await api(w.owner, "/me/decisions?kind=approval&owner=someone-else")).data;
  expect(first.items).toHaveLength(50);
  expect(first.next).toBeTruthy();
  const second = (await api(w.owner, "/me/decisions?kind=approval&before=" + first.next)).data;
  expect(second.items).toHaveLength(3);
  expect(second.next).toBeNull();
  const items = [...first.items, ...second.items];
  expect(new Set(items.map((item: any) => item.id)).size).toBe(53);
  expect(items.map((item: any) => item.choice).filter((choice: string) => choice === "reject")).toHaveLength(1);
  expect(items.every((item: any) => item.agent_name === a.name && item.conversation_id === cid && item.conversation_title === "Release review")).toBe(true);
  expect(items.some((item: any) => [auto.id, expired.id].some((id) => item.id.endsWith(id)))).toBe(false);
  expect((await api("other-owner", `/me/decisions?kind=approval&owner=${w.owner}`)).data.items).toEqual([]);
  expect((await api(w.owner, "/me/decisions?kind=answer")).data.items).toEqual([]);
  for (const query of ["kind=invalid", "kind=answer&before=not-a-cursor", "kind=answer&before=" + Buffer.from('[null,"id"]').toString("base64url")])
    expect((await api(w.owner, "/me/decisions?" + query)).status).toBe(400);
  // A malformed legacy cross-owner reference must not expose its history.
  db.prepare("UPDATE conversations SET owner_id='other-owner' WHERE id=?").run(cid);
  expect((await api(w.owner, "/me/decisions?kind=approval")).data.items).toEqual([]);
});

it("bounds large workflow and tool request previews and resumes from any visible decision", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Large request previews");
  const rid = run(w.owner, a.id, cid, "awaiting_approval");
  const huge = "Request prefix " + "x".repeat(4 * 1024 * 1024) + "TAIL_SHOULD_NOT_BE_SENT";
  for (const request of [
    { type: "workflow_review", content: huge },
    { type: "mcp_tool", tool: "large_tool", arguments: { input: huge } },
    { type: "mcp_tool", tool: "large_message", message: huge },
  ]) {
    db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(rid);
    const approval = requestApproval(ownedRun(rid, w.owner), request);
    expect((await api(w.owner, `/approvals/${approval.id}`, "POST", { decision: "approve" })).status).toBe(200);
  }
  const page = (await api(w.owner, "/me/decisions?kind=approval")).data;
  expect(page.items).toHaveLength(3);
  for (const item of page.items) {
    expect(item.detail.length).toBeLessThanOrEqual(8192);
    expect(item.detail_truncated).toBe(true);
    expect(item.detail).toContain("Request prefix");
  }
  expect(JSON.stringify(page).length).toBeLessThan(30_000);
  expect(JSON.stringify(page)).not.toContain("TAIL_SHOULD_NOT_BE_SENT");
  const older = (await api(w.owner, "/me/decisions?kind=approval&before=" + page.items[0].cursor)).data;
  expect(older.items.map((item: any) => item.id)).toEqual(page.items.slice(1).map((item: any) => item.id));
});

it("bounds a full answer-history page including oversized pre-preview records", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Large answer previews");
  const rid = run(w.owner, a.id, cid, "completed");
  const questions = Array.from({ length: 50 }, (_, i) => ({ id: "q" + i, title: "Question " + i + "🙂\u0001".repeat(40) }));
  const request = JSON.stringify({ kind: "question", title: "Long responses", detail: "\u0001".repeat(6000), questions });
  const legacy = JSON.stringify(Object.fromEntries(questions.map((q) => [q.id, Array(30).fill("x".repeat(8000))])));
  const insertRequest = db.prepare(`INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,command_id,created_at)
    VALUES(?,?,?,'fixture',?,?,'resolved',?,?)`);
  const insertHistory = db.prepare(`INSERT INTO personal_decisions(id,owner_id,run_id,native_decision_id,kind,response,response_truncated,created_at)
    VALUES(?,?,?,?,'answer',?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < 50; i++) {
      const decision = id();
      insertRequest.run(decision, rid, cid, decision, request, id(), i);
      insertHistory.run("native:" + decision, w.owner, rid, decision,
        i === 0 ? legacy : JSON.stringify({ q0: ["Recorded answer " + "x".repeat(7000)] }), Number(i !== 0), i);
    }
  }).immediate();
  const { status, data: page } = await api(w.owner, "/me/decisions?kind=answer");
  expect(status).toBe(200);
  expect(page.items).toHaveLength(50);
  expect(page.next).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PERSONAL_DECISIONS_PAGE_LIMIT);
  for (const item of page.items) {
    expect(item.response_recorded).toBe(true);
    expect(item.response_truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(item.answers))).toBeLessThanOrEqual(PERSONAL_DECISION_RESPONSE_LIMIT);
  }
  expect(page.items[0].answers[0].values[0]).toContain("Recorded answer");
  expect(page.items.at(-1).answers[0].values).toBeNull();
});


it("keeps shared-source runs serialized and owner-scoped over HTTP", async () => {
  const w = workspaceFor(), a = w.agent();
  const source = { url: "https://example.com/shared", title: "Shared source", excerpt: "Fixture" };
  const body = { question: "@" + a.name + " Read this", source, idempotencyKey: id() };
  const sent = await api(w.owner, "/share/send", "POST", body);
  expect(sent.status).toBe(200);
  expect(typeof sent.data.payload).toBe("string");
  expect(JSON.parse(sent.data.payload)).toMatchObject({ agentId: a.id, source });
  expect((await api(w.owner, "/share/send", "POST", body)).data).toEqual(sent.data);
  expect((await api("intruder", "/share/send", "POST", body)).status).toBe(404);
});
