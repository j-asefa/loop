import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
const dir = mkdtempSync(join(tmpdir(), "loop-mobile-continuity-"));
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
const { uploadFile } = await import("../src/server/uploads");
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

it("names the one next action on a feed card and links to its exact message", async () => {
  const w = workspaceFor(),
    a = w.agent();
  // A finished run opens at its answer, not the top of the thread.
  const done = conversation(w.owner, a.id, "Done");
  const r1 = run(w.owner, a.id, done, "completed");
  message(w.owner, done, "user", "Summarize", r1);
  const answer = message(w.owner, done, "assistant", "Here is the summary", r1);
  message(w.owner, done, "assistant", "", r1);
  // A pending approval opens at its run's last message.
  const asking = conversation(w.owner, a.id, "Asking");
  const r2 = run(w.owner, a.id, asking, "awaiting_approval");
  const askPrompt = message(w.owner, asking, "user", "Deploy", r2);
  requestApproval({ id: r2, owner_id: w.owner } as any, {
    tool: "deploy",
    arguments: { token: "never-shown" },
  });
  // Work still running has no specific action: only Reply.
  const working = conversation(w.owner, a.id, "Working");
  const r3 = run(w.owner, a.id, working, "running");
  message(w.owner, working, "user", "Keep going", r3);
  const items = (await api(w.owner, "/inbox")).data.items;
  const action = (cid: string) =>
    items.find((i: any) => i.conversation_id === cid).next_action;
  expect(action(done)).toEqual({ kind: "result", run_id: r1, message_id: answer });
  expect(action(asking)).toEqual({ kind: "approve", run_id: r2, message_id: askPrompt });
  expect(action(working)).toBeNull();
  expect(JSON.stringify(items)).not.toContain("never-shown");
  // Once the run has an answer message, even an empty one still streaming,
  // the thread shows the approval there, and so the Feed links there.
  const streaming = message(w.owner, asking, "assistant", "", r2);
  expect(
    (await api(w.owner, "/inbox")).data.items.find((i: any) => i.conversation_id === asking)
      .next_action,
  ).toEqual({ kind: "approve", run_id: r2, message_id: streaming });
  // Once decided, the approval is no longer the next action.
  db.prepare("UPDATE approvals SET state='approved' WHERE run_id=?").run(r2);
  expect(
    (await api(w.owner, "/inbox")).data.items.find((i: any) => i.conversation_id === asking)
      .next_action,
  ).toBeNull();
  // A native harness question is answered at the end of its thread.
  const native = conversation(w.owner, a.id, "Native");
  const r4 = run(w.owner, a.id, native, "running");
  message(w.owner, native, "user", "Pick one", r4);
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(id(), r4, native, "g", "n1", JSON.stringify({ questions: [{ question: "Which?" }] }), now());
  expect(
    (await api(w.owner, "/inbox")).data.items.find((i: any) => i.conversation_id === native)
      .next_action,
  ).toEqual({ kind: "answer", run_id: r4, message_id: null });
  // Another owner sees none of it.
  expect((await api("intruder", "/inbox")).data.items).toEqual([]);
});

it("lists project history: outcomes and unfinished work, scoped to the project", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const project = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,'Site','project',?)",
  ).run(project, w.owner, now());
  const inProject = (title: string, state: string) => {
    const cid = conversation(w.owner, a.id, title);
    db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(project, cid);
    const r = run(w.owner, a.id, cid, state);
    message(w.owner, cid, "user", title, r);
    return cid;
  };
  const finished = inProject("Finished", "completed");
  const failed = inProject("Failed", "failed");
  const queued = inProject("Queued", "queued");
  const elsewhere = conversation(w.owner, a.id, "Elsewhere");
  message(w.owner, elsewhere, "user", "x", run(w.owner, a.id, elsewhere, "completed"));
  const ids = async (filter: string) =>
    (await api(w.owner, `/inbox?filter=${filter}&folder=${project}`)).data.items.map(
      (i: any) => i.conversation_id,
    );
  expect(await ids("outcomes")).toEqual([finished]);
  expect((await ids("unfinished")).sort()).toEqual([failed, queued].sort());
  expect((await api("intruder", `/inbox?filter=outcomes&folder=${project}`)).status).toBe(404);
});

it("counts waiting and not-sent scheduled messages separately in the feed summary", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const schedule = async (key: string) =>
    (
      await api(w.owner, "/scheduled-sends", "POST", {
        agentId: a.id,
        input: "Later " + key,
        attachmentIds: [],
        idempotencyKey: "sum-" + key + randomBytes(4).toString("hex"),
        sendAt: now() + 60000,
      })
    ).data;
  const failing = await schedule("a");
  await schedule("b");
  db.prepare("UPDATE scheduled_sends SET state='failed',error='Refused' WHERE id=?").run(failing.id);
  expect((await api(w.owner, "/inbox")).data.summary).toMatchObject({
    scheduled_failed: 1,
    scheduled_pending: 1,
  });
  expect((await api("intruder", "/inbox")).data.summary).toMatchObject({
    scheduled_failed: 0,
    scheduled_pending: 0,
  });
});

it("labels saved items and searches Saved by text, title and label, per owner", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id, "Mobile review");
  const r = run(w.owner, a.id, cid);
  const decision = message(w.owner, cid, "assistant", "Keep four tabs", r);
  const other = message(w.owner, cid, "assistant", "Use 100% width", r);
  const unsaved = message(w.owner, cid, "assistant", "Not kept", r);
  const result = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,pinned,created_at,updated_at) VALUES(?,?,?,?,?,'Release plan','markdown','Ship Friday','{}',1,?,?)",
  ).run(result, w.owner, a.id, cid, r, now(), now());
  await api(w.owner, `/messages/${decision}/saved`, "POST");
  await api(w.owner, `/messages/${other}/saved`, "POST");
  expect(
    (await api(w.owner, "/saved/label", "PUT", { key: "m:" + decision, label: " Chosen approach " })).data,
  ).toEqual({ key: "m:" + decision, label: "Chosen approach" });
  await api(w.owner, "/saved/label", "PUT", { key: "a:" + result, label: "Plan" });
  const search = async (q: string, owner: string = w.owner) =>
    (await api(owner, "/saved?q=" + encodeURIComponent(q))).data.items.map((i: any) => i.key);
  // By label, by text, by thread title, and by a result's title.
  expect(await search("chosen")).toEqual(["m:" + decision]);
  expect(await search("four tabs")).toEqual(["m:" + decision]);
  expect((await search("mobile review")).sort()).toEqual(["m:" + decision, "m:" + other].sort());
  expect(await search("release")).toEqual(["a:" + result]);
  // Wildcards match literally.
  expect(await search("100%")).toEqual(["m:" + other]);
  expect(await search("%")).toEqual(["m:" + other]);
  // Labels are listed with their items; clearing removes the label.
  const all = (await api(w.owner, "/saved")).data.items;
  expect(all.find((i: any) => i.key === "m:" + decision).label).toBe("Chosen approach");
  expect(all.find((i: any) => i.key === "a:" + result).label).toBe("Plan");
  await api(w.owner, "/saved/label", "PUT", { key: "a:" + result, label: "" });
  expect((await api(w.owner, "/saved")).data.items.find((i: any) => i.key === "a:" + result).label).toBeNull();
  // Only a saved item can be labelled, and only by its owner.
  expect((await api(w.owner, "/saved/label", "PUT", { key: "m:" + unsaved, label: "x" })).status).toBe(404);
  expect((await api("intruder", "/saved/label", "PUT", { key: "m:" + decision, label: "x" })).status).toBe(404);
  expect((await api(w.owner, "/saved/label", "PUT", { key: "m:" + decision, label: "x".repeat(41) })).status).toBe(400);
  expect(await search("chosen", "intruder")).toEqual([]);
  expect(db.prepare("SELECT count(*) n FROM saved_labels WHERE owner_id='intruder'").get()).toEqual({ n: 0 });
});

it("snoozes a reminder again in place, keeps Done, and reopens a replaced reminder", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id, "Remind");
  const first = (
    await api(w.owner, "/later", "POST", {
      kind: "conversation",
      targetId: cid,
      condition: "time",
      dueAt: now() + 60000,
    })
  ).data;
  expect(first.replaced).toBeNull();
  surfaceLater(now() + 120000);
  expect((await api(w.owner, "/later")).data.due.map((i: any) => i.id)).toEqual([first.id]);
  // Snooze again: the same reminder, a new trigger, out of "Back now".
  const dueAt = now() + 3600000;
  const again = await api(w.owner, `/later/${first.id}/snooze`, "POST", { condition: "time", dueAt });
  expect(again.data).toMatchObject({ id: first.id, due_at: dueAt, surfaced_at: null, snoozes: 1, target_id: cid });
  const listed = (await api(w.owner, "/later")).data;
  expect(listed.due).toEqual([]);
  expect(listed.upcoming.map((i: any) => i.id)).toEqual([first.id]);
  expect((await api(w.owner, `/later/${first.id}/snooze`, "POST", { condition: "time", dueAt: now() - 1 })).status).toBe(400);
  expect((await api("intruder", `/later/${first.id}/snooze`, "POST", { condition: "time", dueAt })).status).toBe(404);
  // A new reminder for the same thread replaces it and says which one.
  const second = (
    await api(w.owner, "/later", "POST", { kind: "conversation", targetId: cid, condition: "run_finished" })
  ).data;
  expect(second.replaced).toBe(first.id);
  // Undo: cancel the new one, reopen the one it replaced.
  await api(w.owner, `/later/${second.id}`, "DELETE");
  expect((await api(w.owner, `/later/${first.id}/reopen`, "POST")).data).toMatchObject({ id: first.id, done_at: null });
  // Reopening is refused while another reminder for the item is open.
  await api(w.owner, `/later/${second.id}`, "DELETE");
  const third = (
    await api(w.owner, "/later", "POST", { kind: "conversation", targetId: cid, condition: "run_finished" })
  ).data;
  expect((await api(w.owner, `/later/${first.id}/reopen`, "POST")).status).toBe(409);
  // Done persists, and a done reminder cannot be snoozed.
  await api(w.owner, `/later/${third.id}`, "DELETE");
  expect((await api(w.owner, "/later")).data).toEqual({ due: [], upcoming: [] });
  expect((await api(w.owner, `/later/${third.id}/snooze`, "POST", { condition: "time", dueAt })).status).toBe(409);
  expect((await api("intruder", `/later/${third.id}/reopen`, "POST")).status).toBe(404);
});

it("moves a queued message back to a draft only before it starts", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const submit = async (input: string) =>
    (
      await api(w.owner, "/runs", "POST", {
        agentId: a.id,
        conversationId: cid,
        input,
        idempotencyKey: "wd-" + randomBytes(6).toString("hex"),
        queue: true,
      })
    ).data;
  const active = await submit("active");
  // The message's files come back with its text, in order, as the composer
  // holds them, so resending it sends the same files.
  const file = (name: string) =>
    uploadFile(w.owner, { originalname: name, mimetype: "text/plain", buffer: Buffer.from("context " + name) });
  const one = file("review-context.txt"),
    two = file("notes.txt");
  const later = (
    await api(w.owner, "/runs", "POST", {
      agentId: a.id,
      conversationId: cid,
      input: "held text",
      attachmentIds: [one.id, two.id],
      idempotencyKey: "wd-" + randomBytes(6).toString("hex"),
      queue: true,
    })
  ).data;
  expect((await api("intruder", `/runs/${later.id}/withdraw`, "POST")).status).toBe(404);
  expect((await api(w.owner, `/runs/${later.id}/withdraw`, "POST")).data).toEqual({
    input: "held text",
    agent_id: a.id,
    conversation_id: cid,
    attachment_ids: [one.id, two.id],
    attachments: [one, two],
  });
  expect((db.prepare("SELECT state FROM runs WHERE id=?").get(later.id) as any).state).toBe("cancelled");
  // Repeating it does nothing more.
  expect((await api(w.owner, `/runs/${later.id}/withdraw`, "POST")).status).toBe(409);
  // A message whose files would not fit beside the draft's stays queued.
  const fits = (
    await api(w.owner, "/runs", "POST", {
      agentId: a.id,
      conversationId: cid,
      input: "one more file",
      attachmentIds: [one.id],
      idempotencyKey: "wd-" + randomBytes(6).toString("hex"),
      queue: true,
    })
  ).data;
  const full = Array.from({ length: 8 }, (_, i) => file(`draft-${i}.txt`).id);
  const crowded = await api(w.owner, `/runs/${fits.id}/withdraw`, "POST", {
    draftAttachmentIds: full,
  });
  expect(crowded.status).toBe(409);
  expect(crowded.data.error).toMatch(/left queued/);
  expect((db.prepare("SELECT state FROM runs WHERE id=?").get(fits.id) as any).state).toBe("queued");
  // A file the draft already holds does not count twice.
  const overlap = await api(w.owner, `/runs/${fits.id}/withdraw`, "POST", {
    draftAttachmentIds: [...full.slice(0, 7), one.id],
  });
  expect(overlap.status).toBe(200);
  expect(overlap.data.attachments).toEqual([one]);
  // A message whose file is gone stays queued instead of losing the file.
  const gone = file("gone.txt");
  const missing = (
    await api(w.owner, "/runs", "POST", {
      agentId: a.id,
      conversationId: cid,
      input: "with a deleted file",
      attachmentIds: [gone.id],
      idempotencyKey: "wd-" + randomBytes(6).toString("hex"),
      queue: true,
    })
  ).data;
  db.prepare("DELETE FROM objects WHERE id=?").run(gone.objectId);
  const kept = await api(w.owner, `/runs/${missing.id}/withdraw`, "POST");
  expect(kept.status).toBe(409);
  expect(kept.data.error).toMatch(/no longer available/);
  expect((db.prepare("SELECT state FROM runs WHERE id=?").get(missing.id) as any).state).toBe("queued");
  // A started run is never cancelled from here.
  db.prepare("UPDATE runs SET state='running',worker_id='w' WHERE id=?").run(active.id);
  const refused = await api(w.owner, `/runs/${active.id}/withdraw`, "POST");
  expect(refused.status).toBe(409);
  expect(refused.data.error).toMatch(/already started/);
  expect((db.prepare("SELECT state FROM runs WHERE id=?").get(active.id) as any).state).toBe("running");
});

it("reschedules a message that could not be sent, which then sends exactly once", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const key = "resched-" + randomBytes(6).toString("hex");
  const report = uploadFile(w.owner, {
    originalname: "report.csv",
    mimetype: "text/csv",
    buffer: Buffer.from("a,b"),
  });
  const created = (
    await api(w.owner, "/scheduled-sends", "POST", {
      agentId: a.id,
      input: "Weekly report",
      attachmentIds: [report.id],
      idempotencyKey: key,
      sendAt: now() + 60000,
    })
  ).data;
  db.prepare("UPDATE agents SET retired_at=1 WHERE id=?").run(a.id);
  deliverScheduledSends(now() + 120000);
  // Listed with its files, so Copy to a draft brings them back too.
  expect((await api(w.owner, "/scheduled-sends")).data.items[0]).toMatchObject({
    state: "failed",
    input: "Weekly report",
    attachments: [report],
  });
  // Editing a failed message needs a new time; it keeps its text and key.
  expect((await api(w.owner, `/scheduled-sends/${created.id}`, "PATCH", { input: "Weekly report v2" })).status).toBe(400);
  expect((await api("intruder", `/scheduled-sends/${created.id}`, "PATCH", { sendAt: now() + 60000 })).status).toBe(404);
  const sendAt = now() + 60000;
  const edited = (await api(w.owner, `/scheduled-sends/${created.id}`, "PATCH", { input: "Weekly report v2", sendAt })).data;
  expect(edited).toMatchObject({ state: "scheduled", error: null, send_at: sendAt, input: "Weekly report v2", idempotency_key: key });
  db.prepare("UPDATE agents SET retired_at=NULL WHERE id=?").run(a.id);
  expect(deliverScheduledSends(sendAt + 1)).toBe(1);
  expect(deliverScheduledSends(sendAt + 2)).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?").get(key)).toEqual({ n: 1 });
  // Once sent it can no longer be edited.
  expect((await api(w.owner, `/scheduled-sends/${created.id}`, "PATCH", { sendAt: now() + 60000 })).status).toBe(409);
});

it("searches a thread's text across prompts, answers, updates, results and failures", async () => {
  const w = workspaceFor(),
    a = w.agent(),
    cid = conversation(w.owner, a.id);
  const ok = run(w.owner, a.id, cid, "completed");
  const prompt = message(w.owner, cid, "user", "Check the cache layer", ok);
  const update = message(w.owner, cid, "assistant", "Reading cache code", ok);
  db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(JSON.stringify({ progress: true }), update);
  const middle = message(w.owner, cid, "assistant", "The cache is stale", ok);
  const answer = message(w.owner, cid, "assistant", "Fixed the cache 100%", ok);
  const bad = run(w.owner, a.id, cid, "failed");
  const failedPrompt = message(w.owner, cid, "user", "Deploy", bad);
  db.prepare("UPDATE runs SET error='Cache warmup timed out' WHERE id=?").run(bad);
  await api(w.owner, `/messages/${answer}/saved`, "POST");
  const elsewhere = conversation(w.owner, a.id);
  message(w.owner, elsewhere, "user", "cache elsewhere");
  const search = async (q: string, owner: string = w.owner) =>
    api(owner, `/conversations/${cid}/outline?q=${encodeURIComponent(q)}`);
  const found = (await search("cache")).data.matches.map((m: any) => [m.kind, m.message_id, m.saved]);
  expect(found).toEqual([
    ["failure", failedPrompt, false],
    ["result", answer, true],
    ["response", middle, false],
    ["update", update, false],
    ["prompt", prompt, false],
  ]);
  expect((await search("100%")).data.matches.map((m: any) => m.message_id)).toEqual([answer]);
  expect((await search("%")).data.matches.map((m: any) => m.message_id)).toEqual([answer]);
  expect((await search("timed out")).data.matches[0]).toMatchObject({ kind: "failure", preview: "Cache warmup timed out" });
  expect((await search("cache", "intruder")).status).toBe(404);
});

it("searches within a project, including its subfolders and its threads' messages", async () => {
  const w = workspaceFor(),
    a = w.agent();
  const project = id(),
    sub = id(),
    other = id();
  const folder = (fid: string, name: string, parent: string | null) =>
    db
      .prepare(
        "INSERT INTO folders(id,owner_id,name,kind,parent_id,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(fid, w.owner, name, parent ? "folder" : "project", parent, now());
  folder(project, "Site", null);
  folder(sub, "Docs", project);
  folder(other, "Other", null);
  // A thread filed in the project (by its run's folder) and one elsewhere.
  const inside = conversation(w.owner, a.id, "Inside");
  const r = run(w.owner, a.id, inside, "completed", { payload: { folderId: sub } });
  const hit = message(w.owner, inside, "assistant", "Decided on zebra caching", r);
  const outside = conversation(w.owner, a.id, "Outside");
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(other, outside);
  message(w.owner, outside, "assistant", "Also zebra caching");
  const result = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,folder_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'Zebra plan','markdown','zebra outcome','{}',?,?)",
  ).run(result, w.owner, a.id, inside, project, now(), now());
  const found = (await api(w.owner, `/search?q=zebra&project=${project}`)).data.items.map(
    (i: any) => i.id,
  );
  expect(found.sort()).toEqual(["artifact:" + result, "message:" + hit].sort());
  expect((await api("intruder", `/search?q=zebra&project=${project}`)).status).toBe(404);
});
