import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
const dir = mkdtempSync(join(tmpdir(), "loop-mobile-return-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now, emit } = await import("../src/server/db");
const { createAgent, owned, Problem } = await import("../src/server/domain");
const { recordTrace } = await import("../src/server/traces");
const { mobile } = await import("../src/server/mobile-routes");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { transition } = await import("../src/server/queue");
const { requestApproval } = await import("../src/server/approvals");
const { seal } = await import("../src/server/secrets");
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
app.use("/api", mobile, core, workspace);
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
    (await api(w.owner, "/inbox")).data.items.find(
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
  message(w.owner, snoozed, "user", "Later please", run(w.owner, a.id, snoozed));
  // Delegated child runs are internal and do not create inbox rows.
  const child = conversation(w.owner, a.id, "Child");
  const cr = run(w.owner, a.id, child, "completed");
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

  const all = await api(w.owner, "/inbox");
  const ids = all.data.items.map((i: any) => i.conversation_id);
  expect(ids).toHaveLength(3);
  expect(ids).not.toContain(snoozed);
  expect(ids).not.toContain(child);
  expect(all.data.summary).toMatchObject({
    needs: 1,
    working: 1,
    queued: 1,
    later_due: 0,
  });
  const doneItem = all.data.items.find((i: any) => i.conversation_id === done);
  expect(doneItem).toMatchObject({
    title: "Done",
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
    (await api(w.owner, "/inbox?filter=" + name)).data.items.map(
      (i: any) => i.conversation_id,
    );
  expect(await filter("needs")).toEqual([needs]);
  expect(await filter("working")).toEqual([working]);
  expect(await filter("queued")).toEqual([working]);
  expect(await filter("later")).toEqual([snoozed]);
  // Done leaves out open work with no finished output: needs you, working,
  // queued or snoozed.
  expect(await filter("done")).toEqual([done]);
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
    (await api(w.owner, "/inbox?filter=" + name)).data.items;
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
    expect.arrayContaining([done, followUp, imported]),
  );
  expect(await filter("done")).toHaveLength(3);
  // An agent profile lists only that agent's threads; foreign agents are rejected.
  const b = w.agent();
  const other = conversation(w.owner, b.id, "Other agent");
  message(w.owner, other, "user", "Hi", run(w.owner, b.id, other));
  const byAgent = async (agent: string) =>
    (await api(w.owner, "/inbox?agent=" + agent)).data.items?.map(
      (i: any) => i.conversation_id,
    );
  expect(await byAgent(b.id)).toEqual([other]);
  expect(await byAgent(a.id)).not.toContain(other);
  expect((await api(workspaceFor().owner, "/inbox?agent=" + a.id)).status).toBe(404);
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
  expect((await api(w.owner, "/inbox")).data.summary.later_due).toBe(1);
  // Pagination: 45 conversations page as 40 + 5.
  const p = workspaceFor(),
    pa = p.agent();
  for (let i = 0; i < 45; i++)
    message(p.owner, conversation(p.owner, pa.id), "user", "x" + i);
  const page = await api(p.owner, "/inbox");
  expect(page.data.items).toHaveLength(40);
  const rest = await api(p.owner, "/inbox?before=" + page.data.next);
  expect(rest.data.items).toHaveLength(5);
  expect(rest.data.next).toBeNull();
  expect(
    new Set([...page.data.items, ...rest.data.items].map((i: any) => i.conversation_id)).size,
  ).toBe(45);
  // Done pages by when each output finished.
  const donePage = await api(p.owner, "/inbox?filter=done");
  expect(donePage.data.items).toHaveLength(40);
  const doneRest = await api(
    p.owner,
    "/inbox?filter=done&before=" + donePage.data.next,
  );
  expect(doneRest.data.items).toHaveLength(5);
  expect((await api("intruder", "/inbox")).data.items).toEqual([]);
  expect((await api(w.owner, "/inbox?filter=bogus")).status).toBe(400);
  expect((await api(w.owner, "/inbox?filter=unread")).status).toBe(400);
  const away = await api(w.owner, "/inbox/away?since=0");
  expect(away.data.completed.map((b: any) => b.run_id)).toContain(dr);
  expect(away.data.completed.map((b: any) => b.run_id)).not.toContain(cr);
  expect(away.data.failed.map((b: any) => b.run_id)).toEqual([nr]);
  expect((await api("intruder", "/inbox/away?since=0")).data).toEqual({
    completed: [],
    needs: [],
    failed: [],
  });
});

it("archives a thread from the feed without changing its run or history", async () => {
  const w = workspaceFor(), a = w.agent();
  const cid = conversation(w.owner, a.id, "Archive me");
  const rid = run(w.owner, a.id, cid, "running");
  message(w.owner, cid, "user", "Keep working", rid);
  expect((await api(w.owner, "/inbox?filter=working")).data.items.some(
    (item: any) => item.conversation_id === cid,
  )).toBe(true);
  expect((await api("intruder", `/inbox/${cid}`, "PATCH", { hidden: true })).status).toBe(404);
  expect((await api(w.owner, `/inbox/${cid}`, "PATCH", { hidden: true })).status).toBe(200);
  for (const filter of ["all", "working", "queued", "done"]) {
    expect((await api(w.owner, `/inbox?filter=${filter}`)).data.items.some(
      (item: any) => item.conversation_id === cid,
    )).toBe(false);
  }
  expect((await api(w.owner, "/inbox?filter=unfinished")).data.items.some(
    (item: any) => item.conversation_id === cid,
  )).toBe(true);
  expect((await api(w.owner, `/conversations/${cid}`)).status).toBe(200);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(rid)).toEqual({ state: "running" });
  expect((await api(w.owner, `/inbox/${cid}`, "PATCH", { hidden: false })).status).toBe(200);
  expect((await api(w.owner, "/inbox?filter=working")).data.items.some(
    (item: any) => item.conversation_id === cid,
  )).toBe(true);
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
    (await api(w.owner, "/inbox?filter=" + filter)).data.items.find(
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
  expect(owned<any>("conversations", cid, w.owner).title).toBe(title);
  db.prepare("UPDATE runs SET input=? WHERE id=?").run("word ".repeat(100), active);
  expect((await card("working")).title).toHaveLength(200);
  db.prepare("UPDATE runs SET input='  ' WHERE id=?").run(active);
  expect((await card("working")).title).toBe(title);
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
    (await api(w.owner, "/inbox")).data.items.find(
      (i: any) => i.conversation_id === cid,
    );
  expect((await card()).live_preview).toBeNull();
  expect((await card()).last_message).toBeNull();
  expect((await card()).run.connection_id).toBe(connectionId);
  expect((await card()).run.automation).toBeUndefined();
  // The card's model badge uses the run's model, like its environment badge.
  expect((await card()).run.model).toBe("run-model");
  recordTrace(owned("runs", live, w.owner) as any, "update-1", {
    kind: "message",
    title: "Agent update",
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
    (await api(w.owner, "/inbox")).data.items.find(
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
  expect((await api("intruder", "/inbox")).data.items).toEqual([]);
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

it("surfaces Later items by time, finished run and project open, with a push", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    sid = subscribe(w.owner);
  const timed = conversation(w.owner, a.id, "Timed");
  const busy = conversation(w.owner, a.id, "Busy");
  const busyRun = run(w.owner, a.id, busy, "running");
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
  transition(owned("runs", runId, w.owner), "cancelled");
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
    const item = (await api(w.owner, "/inbox?filter=queued")).data.items.find(
      (i: any) => i.conversation_id === conversationId,
    );
    expect(item.run.state).toBe("queued");
    return { up: item.run.can_move_up, down: item.run.can_move_down };
  };
  // Turns in one thread keep their order, so the newest has nothing to swap.
  expect(await moves(cid)).toEqual({ up: false, down: false });
  // Queued follow-ups are listed separately with their own controls.
  const listed = (await api(w.owner, "/inbox?filter=queued")).data.items.find(
    (i: any) => i.conversation_id === cid,
  ).queued_runs;
  expect(listed.map((r: any) => r.id)).toEqual([first.id, second.id, third.id]);
  expect(listed.every((r: any) => r.can_edit)).toBe(true);
  // Opening a long queued prompt from the Inbox and saving it unchanged keeps
  // every character.
  const long = "Step " + "x".repeat(714);
  await api(w.owner, `/runs/${second.id}`, "PATCH", { input: long });
  const shown = (await api(w.owner, "/inbox?filter=queued")).data.items
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
  const positions = (await api(w.owner, "/inbox?filter=queued")).data.items.find(
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
    (await api(w.owner, "/inbox?filter=queued")).data.items
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
  emit(w.owner, none, "progress", {});
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
  expect(summary.map((s: any) => s.name)).toEqual(["Alpha", "Beta"]);
  expect(summary[0]).toMatchObject({ id: project, agents: 1, working: 1, needs: 0, latest_result: null });
  expect(summary[0].last_activity_at).toBeGreaterThan(0);
  expect(summary[1]).toMatchObject({ agents: 0, last_activity_at: null });
  expect((await api("intruder", "/projects/summary")).data.items).toEqual([]);
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
