import { afterAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FeedPage } from "../src/shared/workspace-api";
import { reduceFeedPage } from "../src/shared/feed-projection";
import { z } from "zod";
import { ReplyState } from "../src/shared/steering-replies";

const dir = mkdtempSync(join(tmpdir(), "loop-replies-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "server";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { transition } = await import("../src/server/queue");
const { SteeringInbox, saveSteering } = await import("../src/server/steering");
const { invokeNative, nativeBindings } = await import("../src/server/native-tools");
const { withTestAdapter } = await import("../src/server/providers");
const { mobile } = await import("../src/server/mobile-routes");
const { feed: legacyFeed } = await import("./helpers/legacy-feed");
const { core } = await import("../src/server/core-routes");
const { recordConversationUpdate } = await import("../src/server/conversation-updates");
const app = express();
app.use(express.json(), (req, res, next) => { res.locals.owner = req.get("x-owner"); next(); });
app.use(mobile, core);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 400).json({ error: error.message }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function request(owner: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "PATCH",
    headers: { "x-owner": owner, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function replies(owner: string, query = "") {
  const response = await request(owner, "/feed?filter=replies" + query);
  expect(response.status).toBe(200);
  const page = FeedPage.parse(response.body);
  const params = new URLSearchParams(query);
  if (!params.has("known")) {
    const { projection, projectionRows, ...selection } = page;
    expect(selection).toEqual(legacyFeed(owner, {
      filter: "replies", folder: params.get("folder") ?? undefined,
      agent: params.get("agent") ?? undefined, teams: params.get("teams")?.split(","),
      before: params.get("before") ?? undefined,
    }));
  }
  return page;
}
function fixture(owner = id()) {
  const connection = id();
  db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)")
    .run(connection, owner, seal("fixture", owner), JSON.stringify([{ id: "fixture" }]), now());
  const agent = createAgent(owner, { name: "reply-" + id().slice(0, 8), connectionId: connection, model: "fixture" });
  const queued = submit(owner, { agentId: agent.id, input: "Investigate the long task", idempotencyKey: id() });
  db.prepare("UPDATE runs SET state='running',worker_id='fixture' WHERE id=?").run(queued.id);
  return { owner, agent, run: ownedRun(queued.id, owner) };
}
function steer(f: ReturnType<typeof fixture>, input = "What have you found?") {
  const receipt = submit(f.owner, { agentId: f.agent.id, conversationId: f.run.conversation_id!, input, idempotencyKey: id(), steer: true });
  expect(receipt).toHaveProperty("steeringId");
  const row = db.prepare("SELECT id,message_id FROM run_steering WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get(f.run.id) as { id: string; message_id: string };
  return row;
}
function replyTool(f: ReturnType<typeof fixture>, input: Record<string, unknown>, callId = id()) {
  const binding = nativeBindings(f.run).find(tool => tool.tool === "loop_reply")!;
  return invokeNative(f.run, binding, callId, input);
}
async function publish(f: ReturnType<typeof fixture>, replyTo: string, body = "The reconnect path needs one fix.", callId = id()) {
  const result = await replyTool(f, { replyTo, body }, callId);
  if (!("result" in result)) throw new Error("Replies must publish immediately");
  expect(result.result.isError).not.toBe(true);
  return { ...JSON.parse(result.result.content[0].text) as { messageId: string; replyTo: string }, callId };
}
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("delivers the durable message ID and accepts a native reply before the steering receipt closes", async () => {
  const f = fixture(), question = steer(f);
  let published: Awaited<ReturnType<typeof publish>> | undefined;
  const stop = new SteeringInbox(f.run, undefined, true).listen(async message => {
    expect(message.content).toContain(`Message ID: ${question.message_id}`);
    expect(message.content).toContain(`replyTo "${question.message_id}"`);
    expect(message.content).toContain("What have you found?");
    expect(db.prepare("SELECT state FROM run_steering WHERE id=?").get(question.id)).toEqual({ state: "sending" });
    published = await publish(f, question.message_id);
  });
  await stop();
  expect(published).toBeDefined();
  const page = await replies(f.owner);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    reply_card_key: `reply:${published!.messageId}`,
    reply: { message_id: question.message_id, content: "What have you found?", read_at: null },
    run: { id: f.run.id, state: "running" },
  });
  expect(page.summary.replies_unread).toBe(1);
  expect(db.prepare("SELECT content FROM messages WHERE id=?").get(question.message_id)).toEqual({ content: "What have you found?" });
  expect(db.prepare("SELECT state FROM run_steering WHERE id=?").get(question.id)).toEqual({ state: "delivered" });
});

it("publishes from the API runtime without finishing the task and keeps replies independent of Done", async () => {
  const f = fixture(), question = steer(f);
  let rounds = 0;
  const restore = withTestAdapter("openai", {
    async models() { return []; },
    async *stream(_secret, input) {
      expect(input.tools?.some(tool => tool.name === "loop_reply")).toBe(true);
      expect(input.messages.some(message => message.content?.includes(`Message ID: ${question.message_id}`))).toBe(true);
      if (++rounds === 1) {
        yield { toolCall: { id: "reply-first", name: "loop_reply", arguments: { replyTo: question.message_id, body: "I found a reconnect race." } } };
      } else if (rounds === 2) {
        const page = await replies(f.owner);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].run?.state).toBe("running");
        yield { toolCall: { id: "reply-second", name: "loop_reply", arguments: { replyTo: question.message_id, body: "The race is now fixed; testing continues." } } };
      } else yield { text: "The task is complete and tests pass." };
    },
  });
  try { expect(await executeAgent(f.run)).toBe(true); }
  finally { restore(); }
  transition(f.run, "completed");
  const before = await replies(f.owner);
  expect(before.items).toHaveLength(2);
  expect(new Set(before.items.map(item => item.reply_card_key)).size).toBe(2);
  const messageId = before.items[0].last_message!.id;
  expect((await request(f.owner, `/replies/${messageId}`, { read: true })).status).toBe(200);
  const read = await replies(f.owner);
  expect(read.items).toHaveLength(2);
  expect(read.summary.replies_unread).toBe(1);
  const firstReadAt = read.items[0].reply!.read_at;
  expect((await request(f.owner, `/replies/${messageId}`, { read: true })).status).toBe(200);
  expect((await replies(f.owner)).items[0].reply!.read_at).toBe(firstReadAt);
  const done = (await request(f.owner, "/feed?filter=done&expand=results")).body;
  expect(done.items).toHaveLength(1);
  expect(done.items[0].last_message.preview).toContain("The task is complete");
  await request(f.owner, `/feed/${f.run.conversation_id}`, { hidden: true, cardKey: `run:${f.run.id}` });
  expect((await replies(f.owner)).items).toHaveLength(2);
  // A later result in the same conversation does not replace either reply.
  const later = submit(f.owner, { agentId: f.agent.id, conversationId: f.run.conversation_id!, input: "Next task", idempotencyKey: id() });
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(later.id);
  db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','A new result',?)")
    .run(id(), f.owner, f.run.conversation_id, later.id, now());
  expect((await replies(f.owner)).items.map(item => item.reply_card_key)).toEqual(before.items.map(item => item.reply_card_key));
  await request(f.owner, `/replies/${messageId}`, { archived: true });
  expect((await replies(f.owner)).items).toHaveLength(1);
  expect((await request(f.owner, "/feed?filter=done&expand=results")).body.items).toHaveLength(1);
  await request(f.owner, `/replies/${messageId}`, { archived: false });
  expect((await replies(f.owner)).items).toHaveLength(2);
  expect((await replies(f.owner)).summary.replies_unread).toBe(1);
});

it("accepts a first reply after an uncertain delivery acknowledgement without replaying steering", async () => {
  const f = fixture(), question = steer(f);
  expect(await replyTool(f, { replyTo: question.message_id, body: "Too soon" })).toMatchObject({ result: { isError: true } });
  let deliveries = 0;
  const stop = new SteeringInbox(f.run, undefined, true).listen(async message => {
    deliveries++;
    expect(message.content).toContain(`Message ID: ${question.message_id}`);
    throw new Error("The harness received the input but its acknowledgement was lost");
  });
  await stop();
  expect(db.prepare("SELECT state FROM run_steering WHERE id=?").get(question.id)).toEqual({ state: "failed" });
  const reply = await publish(f, question.message_id, "I received your question and here is the answer.");
  expect((await replies(f.owner)).items[0].last_message!.id).toBe(reply.messageId);
  const stopAgain = new SteeringInbox(f.run, undefined, true).listen(async () => { deliveries++; });
  await stopAgain();
  expect(deliveries).toBe(1);
  expect(db.prepare("SELECT state FROM run_steering WHERE id=?").get(question.id)).toEqual({ state: "failed" });
  expect(ownedRun(f.run.id, f.owner).state).toBe("running");
});

it("scopes replies and unread counts by project, team and agent while retaining replies when team results are hidden", async () => {
  const f = fixture(), other = fixture(f.owner), project = id(), movedTo = id(), team = id();
  for (const folder of [project, movedTo])
    db.prepare("INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,?,'project',?)")
      .run(folder, f.owner, folder, now());
  db.prepare("INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,?,?,?)")
    .run(team, f.owner, "Reply team", f.agent.id, now());
  db.prepare("UPDATE conversations SET project_id=?,team_id=? WHERE id=?").run(project, team, f.run.conversation_id);
  db.prepare("UPDATE runs SET payload=json_set(payload,'$.folderId',?) WHERE id=?").run(project, f.run.id);
  const question = steer(f), otherQuestion = steer(other);
  new SteeringInbox(f.run).appendPending([]);
  new SteeringInbox(other.run).appendPending([]);
  const reply = await publish(f, question.message_id);
  await publish(other, otherQuestion.message_id);
  // Replies follow the run's project, even when the conversation moves later.
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(movedTo, f.run.conversation_id);
  db.prepare("UPDATE teams SET hide_results_from_feed=1 WHERE id=?").run(team);
  expect((await replies(f.owner)).items).toHaveLength(2);
  for (const query of [`&folder=${project}`, `&teams=${team}`, `&agent=${f.agent.id}`]) {
    const page = await replies(f.owner, query);
    expect(page.items.map(item => item.last_message!.id)).toEqual([reply.messageId]);
    expect(page.summary.replies_unread).toBe(1);
  }
  const elsewhere = await replies(f.owner, `&folder=${movedTo}`);
  expect(elsewhere.items).toHaveLength(0);
  expect(elsewhere.summary.replies_unread).toBe(0);
});

it("enforces owner, run and human steering scope and preserves immutable call identities", async () => {
  const f = fixture(), other = fixture(), sameOwner = fixture(f.owner);
  const question = steer(f), foreign = steer(other), anotherTask = steer(sameOwner);
  new SteeringInbox(f.run).appendPending([]);
  new SteeringInbox(other.run).appendPending([]);
  new SteeringInbox(sameOwner.run).appendPending([]);
  const prompt = (db.prepare("SELECT id FROM messages WHERE run_id=? AND role='user' ORDER BY rowid LIMIT 1").get(f.run.id) as { id: string }).id;
  for (const invalid of [prompt, foreign.message_id, anotherTask.message_id, id()])
    expect(await replyTool(f, { replyTo: invalid, body: "Answer" })).toMatchObject({ result: { isError: true } });
  expect(await replyTool(f, { replyTo: question.message_id, body: "  " })).toMatchObject({ result: { isError: true } });
  const first = await publish(f, question.message_id, "First reply");
  expect(await publish(f, question.message_id, "First reply", first.callId)).toEqual(first);
  // Simulate the response receipt being lost after a committed publication.
  db.prepare("UPDATE native_calls SET result=NULL WHERE run_id=? AND call_id=?").run(f.run.id, first.callId);
  db.prepare("UPDATE run_steering SET state='failed' WHERE id=?").run(question.id);
  expect(await publish(f, question.message_id, "First reply", first.callId)).toEqual(first);
  db.prepare("UPDATE run_steering SET state='delivered' WHERE id=?").run(question.id);
  await expect(publish(f, question.message_id, "Replacement", first.callId)).rejects.toMatchObject({ status: 409 });
  await request(f.owner, `/replies/${first.messageId}`, { archived: true });
  const next = await publish(f, question.message_id, "A later reply");
  expect((await replies(f.owner)).items.map(row => row.last_message!.id)).toEqual([next.messageId]);
  expect((await request(other.owner, `/replies/${next.messageId}`, { read: true, archived: true })).status).toBe(404);
  expect((await request(f.owner, `/replies/${next.messageId}`, { read: false })).status).toBe(400);
  expect((await request(f.owner, `/replies/${next.messageId}`, {})).status).toBe(400);
  expect((await request(f.owner, `/replies/${next.messageId}`, { archived: "true" })).status).toBe(400);
  expect((await request(f.owner, `/replies/${next.messageId}`, { read: true, owner: other.owner })).status).toBe(400);
  expect((await replies(other.owner)).items).toHaveLength(0);
  const mail = saveSteering(f.run, id(), "mail", "A teammate asks", { automation: { kind: "agent_message" } });
  const mailMessage = db.prepare("SELECT message_id FROM run_steering WHERE id=?").get(mail.steeringId) as { message_id: string };
  const history: import("../src/server/providers").ChatMessage[] = [];
  new SteeringInbox(f.run).appendPending(history);
  expect(history[0].content).toBe("A teammate asks");
  expect(await replyTool(f, { replyTo: mailMessage.message_id, body: "Answer" })).toMatchObject({ result: { isError: true } });
  expect(nativeBindings({ ...f.run, payload: { ...f.run.payload, reviewId: id() } }).map(tool => tool.tool)).toEqual(["loop_review_read"]);
});

it("returns reply validation errors to the API model so it can correct them and finish its task", async () => {
  const f = fixture(), question = steer(f);
  let round = 0;
  const restore = withTestAdapter("openai", {
    async models() { return []; },
    async *stream(_secret, input) {
      round++;
      if (round === 1) {
        yield { toolCall: { id: "wrong-id", name: "loop_reply", arguments: { replyTo: id(), body: "An answer" } } };
      } else if (round === 2 || round === 3) {
        expect(input.messages.filter(message => message.role === "tool").at(-1)?.content).toContain("Reply was not published");
        expect((await replies(f.owner)).items).toHaveLength(0);
        yield { toolCall: { id: `correction-${round}`, name: "loop_reply", arguments: round === 2
          ? { replyTo: question.message_id }
          : { replyTo: question.message_id, body: "The corrected reply" } } };
      } else {
        expect((await replies(f.owner)).items).toHaveLength(1);
        expect(ownedRun(f.run.id, f.owner).state).toBe("running");
        yield { text: "The original task is complete." };
      }
    },
  });
  try { expect(await executeAgent(f.run)).toBe(true); }
  finally { restore(); }
  transition(f.run, "completed");
  expect(round).toBe(4);
  expect((await replies(f.owner)).items[0].last_message!.preview).toBe("The corrected reply");
  const refused = db.prepare("SELECT result FROM native_calls WHERE run_id=? AND call_id='wrong-id'").get(f.run.id) as { result: string };
  expect(JSON.parse(refused.result)).toMatchObject({ isError: true });
});

it("does not ask an agent to use a reply tool its runtime did not advertise", () => {
  const f = fixture();
  steer(f, "Continue the task");
  const history: import("../src/server/providers").ChatMessage[] = [];
  new SteeringInbox(f.run).appendPending(history);
  expect(history[0].content).toBe("Continue the task");
});

it("requires a state change in both runtime validation and the published JSON Schema", () => {
  expect(ReplyState.safeParse({}).success).toBe(false);
  const schema = z.toJSONSchema(ReplyState);
  expect(schema.anyOf).toHaveLength(2);
  expect(schema.anyOf!.map(branch => branch.required)).toEqual([["read"], ["archived"]]);
});

it("does not classify transcript text and paginates independent replies and their read deltas", async () => {
  const f = fixture(), question = steer(f);
  new SteeringInbox(f.run).appendPending([]);
  recordConversationUpdate(f.run, "turn:0", { content: `I am replying to ${question.message_id}.` });
  expect((await replies(f.owner)).items).toHaveLength(0);
  const publications = [];
  for (let n = 0; n < 43; n++) publications.push(await publish(f, question.message_id, `Answer ${n}`));
  // Exercise tied publication times and stable cursor ordering.
  db.prepare("UPDATE steering_replies SET created_at=123456 WHERE owner_id=?").run(f.owner);
  const first = await replies(f.owner);
  expect(first.items).toHaveLength(40);
  expect(first.summary.replies_unread).toBe(43);
  const second = await replies(f.owner, "&before=" + encodeURIComponent(first.next!));
  expect(second.items).toHaveLength(3);
  expect(second.next).toBeNull();
  expect(new Set([...first.items, ...second.items].map(item => item.reply_card_key)).size).toBe(43);
  const published = first.items[0].last_message!.id;
  const known = JSON.stringify({ epoch: first.projection!.epoch, ...first.projectionRows });
  await request(f.owner, `/replies/${published}`, { read: true });
  const delta = await replies(f.owner, "&known=" + encodeURIComponent(known));
  expect(delta.projectionRows!.delta).toBe(true);
  expect(delta.items).toHaveLength(1);
  expect(reduceFeedPage(first, delta).items).toHaveLength(40);
  expect(delta.summary.replies_unread).toBe(42);
  expect((await replies(f.owner, "&agent=" + f.agent.id)).items).toHaveLength(40);
  const another = fixture(f.owner);
  expect((await replies(f.owner, "&agent=" + another.agent.id)).items).toHaveLength(0);
  expect((await replies(f.owner, "&agent=" + another.agent.id)).summary.replies_unread).toBe(0);
  expect((await request(f.owner, "/feed?filter=replies&before=invalid")).status).toBe(400);
});
