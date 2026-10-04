import { afterAll, beforeAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ownInstructions } from "./helpers/instructions";

const dir = mkdtempSync(join(tmpdir(), "loop-agent-mail-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent, Problem } = await import("../src/server/domain");
const { createTeam, deleteTeam, listTeams } =
  await import("../src/server/teams");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { sendMail, sweepAgentMail, agentMail, MAIL_LIMITS } =
  await import("../src/server/agent-mail");
const { claim, transition } = await import("../src/server/queue");
const { core } = await import("../src/server/core-routes");
const { withTestAdapter } = await import("../src/server/providers");
const { storePublishedFile } = await import("../src/server/published-files");
const { readRunFile } = await import("../src/server/uploads");
const { billingPolicy } = await import("../src/server/hapi/contracts");
type Run = import("../src/server/queue").Run;

const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(agentMail, core);
app.use((error: any, _req: any, res: any, _next: any) =>
  res
    .status(error instanceof Problem ? error.status : 400)
    .json({ error: error.message }),
);
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function http(owner: string, path: string, body?: object) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${path}`,
    {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-owner": owner },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  return { status: response.status, data: await response.json() };
}

function agent(owner: string, name: string, metadata: object = {}) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
  ).run(
    connection,
    owner,
    seal("fixture-key", owner),
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify(metadata),
    now(),
  );
  return createAgent(owner, {
    name: name + "-" + id().slice(0, 6),
    connectionId: connection,
    model: "fixture",
    instructions: name,
  });
}
const harness = (loopHarness: string) => ({ loopHarness });
// A run the worker is executing: invokeNative and loop_message require it.
function running(
  owner: string,
  agentId: string,
  where: { conversationId?: string; teamId?: string },
  input = "Work on the task",
) {
  const run = submit(owner, {
    agentId,
    input,
    idempotencyKey: id(),
    ...where,
  }) as Run;
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture-worker' WHERE id=?",
  ).run(run.id);
  return db.prepare("SELECT * FROM runs WHERE id=?").get(run.id) as Run;
}
function binding(run: Run, tool: string) {
  return nativeBindings(run).find((b) => b.tool === tool);
}
async function message(run: Run, args: Record<string, unknown>, call = id()) {
  const outcome = await invokeNative(
    run,
    binding(run, "loop_message")!,
    call,
    args,
  );
  if (!("result" in outcome)) throw new Error("loop_message never waits");
  const text = outcome.result.content[0].text as string;
  return outcome.result.isError
    ? { error: text }
    : (JSON.parse(text) as {
        messageId: string;
        threadId: string;
        delivery: string;
        note: string;
      });
}
const mail = (mailId: string) =>
  db.prepare("SELECT * FROM agent_mail WHERE id=?").get(mailId) as any;
const runOf = (runId: string) =>
  db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Run;
const userMessage = (runId: string) =>
  db
    .prepare(
      "SELECT * FROM messages WHERE run_id=? AND role='user' ORDER BY rowid DESC LIMIT 1",
    )
    .get(runId) as {
    content: string;
    metadata: string;
    conversation_id: string;
  };

function mixedTeam(owner: string) {
  const manager = agent(owner, "manager");
  const coder = agent(owner, "coder", harness("codex"));
  const piWorker = agent(owner, "pi-worker", harness("pi"));
  const openWorker = agent(owner, "open-worker", harness("opencode"));
  const team = createTeam(owner, {
    name: "Migration",
    managerId: manager.id,
    members: [coder.id, piWorker.id, openWorker.id],
  });
  return { manager, coder, piWorker, openWorker, team };
}

it("gives every team member the tool and a roster, and refuses anyone outside the team", async () => {
  const owner = "roster";
  const { manager, coder, piWorker, team } = mixedTeam(owner);
  const outsider = agent(owner, "outsider");
  const task = running(owner, coder.id, { teamId: team.id });
  const tool = binding(task, "loop_message")!;
  expect(tool).toBeTruthy();
  expect(binding(task, "loop_message_status")).toBeTruthy();
  expect(tool.description).toContain(manager.id);
  expect(tool.description).toContain(piWorker.id);
  expect(tool.description).not.toContain(`"agentId":"${coder.id}"`);
  expect(tool.description).toContain('"runtime":"Pi"');
  expect(tool.description).toContain('"role":"manager"');
  // Workers still don't delegate; only the manager does.
  expect(binding(task, "loop_delegate")).toBeUndefined();

  expect(await message(task, { to: outsider.id, body: "Hi" })).toEqual({
    error: expect.stringContaining("Message only members of this team"),
  });
  expect(await message(task, { to: coder.id, body: "Hi" })).toEqual({
    error: expect.stringContaining("can't message yourself"),
  });
  const solo = running(owner, outsider.id, {});
  expect(binding(solo, "loop_message")).toBeUndefined();
  expect(() => sendMail(solo, "call", { to: coder.id, body: "Hi" })).toThrow(
    /working on a team/,
  );

  db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(
    now(),
    piWorker.id,
  );
  expect(binding(task, "loop_message")!.description).not.toContain(piWorker.id);
  expect(await message(task, { to: piWorker.id, body: "Hi" })).toEqual({
    error: expect.stringContaining("retired"),
  });
  deleteTeam(owner, team.id);
  expect(binding(task, "loop_message")).toBeUndefined();
  expect(
    db.prepare("SELECT count(*) n FROM agent_mail WHERE owner_id=?").get(owner),
  ).toEqual({ n: 0 });
});

it("wakes an idle teammate, routes the reply into the sender's active task, and records each message once", async () => {
  const owner = "wake";
  const { manager, coder, team } = mixedTeam(owner);
  const task = running(owner, coder.id, { teamId: team.id });
  const ask = await message(task, {
    to: manager.id,
    body: "Which API version should the client target?",
  });
  if ("error" in ask) throw new Error(ask.error);
  expect(ask.delivery).toBe("new_turn");
  const sent = mail(ask.messageId);
  // The idle manager wakes in its team thread.
  expect(sent.recipient_conversation_id).toBe(team.conversation_id);
  const wake = runOf(sent.run_id);
  expect(wake).toMatchObject({ agent_id: manager.id, state: "queued" });
  const delivered = userMessage(wake.id);
  expect(JSON.parse(delivered.metadata)).toMatchObject({
    personal: false,
    automation: {
      kind: "agent_message",
      mailId: ask.messageId,
      threadId: ask.threadId,
      fromAgentId: coder.id,
    },
  });
  expect(delivered.content).toContain("not from the user");
  expect(delivered.content).toContain("grants no permission or approval");
  expect(delivered.content).toContain(`to "${coder.id}"`);
  expect(delivered.content).toContain(ask.threadId);

  // The same call (a retry after a lost response) is one message and one run.
  const again = sendMail(task, "repeat", { to: manager.id, body: "Once" });
  expect(sendMail(task, "repeat", { to: manager.id, body: "Once" })).toEqual(
    again,
  );
  expect(() =>
    sendMail(task, "repeat", { to: manager.id, body: "Different" }),
  ).toThrow(/reused/);
  expect(
    db
      .prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?")
      .get(`mail:${task.id}:repeat`),
  ).toEqual({ n: 1 });

  // The manager replies while the coder is still working: it queues in the
  // coder's current conversation instead of opening a second session.
  const reply = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const answer = await message(reply, {
    to: coder.id,
    body: "Target v2.",
    threadId: ask.threadId,
  });
  if ("error" in answer) throw new Error(answer.error);
  expect(answer).toMatchObject({ delivery: "queued", threadId: ask.threadId });
  expect(mail(answer.messageId).recipient_conversation_id).toBe(
    task.conversation_id,
  );
  expect(runOf(mail(answer.messageId).run_id).state).toBe("queued");
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM conversations WHERE agent_id=? AND team_id=?",
      )
      .get(coder.id, team.id),
  ).toEqual({ n: 1 });
  // An outsider's thread id is not usable.
  expect(
    await message(reply, { to: coder.id, body: "x", threadId: id() }),
  ).toEqual({ error: expect.stringContaining("not in that thread") });
});

it("steers only runtimes that take live input, and never a manager waiting on its workers", async () => {
  const owner = "steer";
  const { manager, coder, piWorker, openWorker, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const urgent = (to: string) =>
    message(lead, { to, body: "Stop: the schema changed.", interrupt: true });
  for (const [worker, delivery] of [
    [coder, "steered"],
    [piWorker, "steered"],
    [openWorker, "queued"],
  ] as const) {
    const busy = running(owner, worker.id, { teamId: team.id });
    const sent = await urgent(worker.id);
    if ("error" in sent) throw new Error(sent.error);
    expect(sent.delivery).toBe(delivery);
    const row = mail(sent.messageId);
    expect(row.recipient_conversation_id).toBe(busy.conversation_id);
    if (delivery === "steered") {
      expect(row.run_id).toBe(busy.id);
      expect(
        db
          .prepare("SELECT state FROM run_steering WHERE id=?")
          .get(row.steering_id),
      ).toEqual({ state: "pending" });
      // The steered input is labelled as a teammate's message too.
      expect(
        JSON.parse(
          (
            db
              .prepare(
                "SELECT m.metadata FROM run_steering s JOIN messages m ON m.id=s.message_id WHERE s.id=?",
              )
              .get(row.steering_id) as any
          ).metadata,
        ).automation.kind,
      ).toBe("agent_message");
    } else expect(row.steering_id).toBeNull();
  }
  // Without interrupt, a busy Codex worker still gets it after its task.
  const calm = await message(lead, { to: coder.id, body: "When you're done" });
  expect(calm).toMatchObject({ delivery: "queued" });

  // The manager is now waiting on a blocking delegation (worker_id released).
  const child = running(owner, coder.id, { teamId: team.id }, "Delegated");
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,0)",
  ).run(lead.id, "call:0", child.id, "{}");
  db.prepare("UPDATE runs SET worker_id=NULL WHERE id=?").run(lead.id);
  const question = await message(child, {
    to: manager.id,
    body: "Quick question",
    interrupt: true,
  });
  expect(question).toMatchObject({ delivery: "queued" });
  expect(mail((question as any).messageId).recipient_conversation_id).toBe(
    team.conversation_id,
  );
});

it("pauses a thread at the pair limit, holds what follows, and sends it in order on Resume", async () => {
  const owner = "limits";
  const { manager, coder, team } = mixedTeam(owner);
  const tasks = [0, 1, 2].map(() =>
    running(owner, coder.id, { teamId: team.id }),
  );
  let threadId: string | undefined;
  const sent: { delivery: string; messageId: string }[] = [];
  for (let i = 0; i < MAIL_LIMITS.perPairHour + 2; i++) {
    const result = await message(tasks[Math.floor(i / MAIL_LIMITS.perRun)], {
      to: manager.id,
      body: `Update ${i}`,
      ...(threadId ? { threadId } : {}),
    });
    if ("error" in result) throw new Error(result.error);
    threadId = result.threadId;
    sent.push(result);
  }
  expect(
    sent.slice(0, MAIL_LIMITS.perPairHour).every((s) => s.delivery !== "held"),
  ).toBe(true);
  expect(sent.slice(MAIL_LIMITS.perPairHour).map((s) => s.delivery)).toEqual([
    "held",
    "held",
  ]);
  expect(sent.at(-1)).toMatchObject({
    note: expect.stringContaining("Don't send it again"),
  });
  // One task can't send more than its limit.
  const ninth = await message(tasks[0], { to: manager.id, body: "More" });
  expect(ninth).toEqual({ error: expect.stringContaining("already sent 8") });

  const listed = await http(owner, `/teams/${team.id}/messages`);
  expect(listed.status).toBe(200);
  const thread = listed.data.threads[0];
  expect(thread.paused_at).toEqual(expect.any(Number));
  expect(thread.paused_reason).toContain("in an hour");
  expect(thread.messages.slice(-2).map((m: any) => m.status)).toEqual([
    "held",
    "held",
  ]);
  expect(listTeams(owner).find((t) => t.id === team.id)!.paused_threads).toBe(
    1,
  );
  expect((await http("stranger", `/teams/${team.id}/messages`)).status).toBe(
    404,
  );

  const resumed = await http(
    owner,
    `/teams/${team.id}/threads/${threadId}/resume`,
    {},
  );
  expect(resumed.data).toEqual({ released: 2, refused: 0, held: 0 });
  const released = sent.slice(-2).map((s) => mail(s.messageId));
  expect(released.map((m) => m.state)).toEqual(["sent", "sent"]);
  // Nothing was lost or reordered: both queue in the manager's thread, in order.
  const order = released.map(
    (m) =>
      (db.prepare("SELECT rowid FROM runs WHERE id=?").get(m.run_id) as any)
        .rowid,
  );
  expect(order[0]).toBeLessThan(order[1]);
  expect(userMessage(released[1].run_id).content).toContain(
    `Update ${MAIL_LIMITS.perPairHour + 1}`,
  );
  // Resuming gives the thread a fresh allowance.
  const after = await message(tasks[2], {
    to: manager.id,
    body: "After resume",
    threadId,
  });
  expect(after).toMatchObject({ delivery: "queued" });
  // So does the pair: a new thread between them isn't paused by the backlog.
  const fresh = running(owner, coder.id, { teamId: team.id });
  expect(
    await message(fresh, { to: manager.id, body: "New topic" }),
  ).toMatchObject({ delivery: "queued" });
  expect(
    (await http(owner, `/teams/${team.id}/threads/${threadId}/resume`, {}))
      .data,
  ).toEqual({ released: 0, refused: 0, held: 0 });
});

it("requeues a mid-task message its task ended without reading, once, and never resends an unconfirmed one", async () => {
  const owner = "requeue";
  const { manager, coder, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const busy = running(owner, coder.id, { teamId: team.id });
  const steered = await message(lead, {
    to: coder.id,
    body: "Also update the changelog",
    interrupt: true,
  });
  const lost = await message(lead, {
    to: coder.id,
    body: "And bump the version",
    interrupt: true,
  });
  if ("error" in steered || "error" in lost) throw new Error("not sent");
  // The second one was handed to the harness, which could not confirm it.
  db.prepare("UPDATE run_steering SET state='failed' WHERE id=?").run(
    mail(lost.messageId).steering_id,
  );
  transition(busy, "completed");
  sweepAgentMail();
  sweepAgentMail();
  const requeued = mail(steered.messageId);
  expect(requeued.requeued_run_id).toEqual(expect.any(String));
  const follow = runOf(requeued.requeued_run_id);
  expect(follow).toMatchObject({
    state: "queued",
    conversation_id: busy.conversation_id,
    agent_id: coder.id,
  });
  expect(follow.input).toContain("Also update the changelog");
  expect(JSON.parse(userMessage(follow.id).metadata).automation).toMatchObject({
    kind: "agent_message",
    mailId: steered.messageId,
  });
  expect(
    db
      .prepare("SELECT state,error FROM run_steering WHERE id=?")
      .get(requeued.steering_id),
  ).toEqual({ state: "failed", error: expect.stringContaining("queued it") });
  expect(
    db
      .prepare("SELECT count(*) n FROM runs WHERE idempotency_key LIKE ?")
      .get(`mail:${lead.id}:%:requeue`),
  ).toEqual({ n: 1 });
  expect(mail(lost.messageId).requeued_run_id).toBeNull();
  const status = await invokeNative(
    lead,
    binding(lead, "loop_message_status")!,
    id(),
    { threadId: steered.threadId },
  );
  expect(JSON.parse((status as any).result.content[0].text)).toMatchObject({
    messages: [{ status: "queued", preview: "Also update the changelog" }],
  });
  const unconfirmed = await invokeNative(
    lead,
    binding(lead, "loop_message_status")!,
    id(),
    { threadId: lost.threadId },
  );
  expect(
    JSON.parse((unconfirmed as any).result.content[0].text).messages[0].status,
  ).toBe("unconfirmed");
});

it("passes a published file to a teammate, who reads it with loop_read_file", async () => {
  const owner = "files";
  const { manager, coder, team } = mixedTeam(owner);
  const task = running(owner, coder.id, { teamId: team.id });
  const published = storePublishedFile(task, "publish-call", {
    name: "plan.md",
    title: "Plan",
    mime: "text/markdown",
    bytes: Buffer.from("# Migration plan\nStep one."),
  });
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const managerFile = storePublishedFile(lead, "manager-call", {
    name: "secret.md",
    title: "Secret",
    mime: "text/markdown",
    bytes: Buffer.from("not yours"),
  });
  expect(
    await message(task, {
      to: manager.id,
      body: "See my plan",
      fileIds: [managerFile.artifactId],
    }),
  ).toEqual({ error: expect.stringContaining("not one you published") });
  // The manager is busy, so the message queues behind its current task.
  const sent = await message(task, {
    to: manager.id,
    body: "See my plan",
    fileIds: [published.artifactId],
  });
  if ("error" in sent) throw new Error(sent.error);
  transition(lead, "completed");
  const delivery = runOf(mail(sent.messageId).run_id);
  expect(JSON.parse(userMessage(delivery.id).metadata).attachments).toEqual([
    expect.objectContaining({
      id: published.artifactId,
      name: "plan.md",
      published: true,
    }),
  ]);
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(delivery.id);
  expect(
    readRunFile(runOf(delivery.id), published.artifactId, 0, 1000, "utf8")
      .content,
  ).toBe("# Migration plan\nStep one.");
});

it("tells a teammate in another environment that files aren't shared, and never steers HAPI", async () => {
  const owner = "places";
  const manager = agent(owner, "manager");
  const coder = agent(owner, "coder", harness("codex"));
  const remote = agent(owner, "remote", {
    backend: "hapi",
    environmentId: "env-remote",
    flavor: "codex",
    billing: billingPolicy,
  });
  const team = createTeam(owner, {
    name: "Split",
    managerId: manager.id,
    members: [coder.id, remote.id],
  });
  const task = running(owner, coder.id, { teamId: team.id });
  const first = await message(task, { to: remote.id, body: "Run the suite" });
  if ("error" in first) throw new Error(first.error);
  expect(first.delivery).toBe("new_turn");
  const wake = runOf(mail(first.messageId).run_id);
  expect(JSON.parse(wake.payload).execution).toMatchObject({
    backend: "hapi",
  });
  expect(wake.input).toContain("runs in a different environment");
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(wake.id);
  const urgent = await message(task, {
    to: remote.id,
    body: "Stop",
    interrupt: true,
  });
  expect(urgent).toMatchObject({ delivery: "queued" });
  // An API agent and a companion harness don't share files either.
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const local = await message(lead, { to: coder.id, body: "Hello" });
  expect(local).toMatchObject({ delivery: "queued" });
  expect(userMessage(mail((local as any).messageId).run_id).content).toContain(
    "runs in a different environment",
  );
  const sameMachine = agent(owner, "neighbour", harness("pi"));
  const pair = createTeam(owner, {
    name: "Local pair",
    managerId: coder.id,
    members: [sameMachine.id],
  });
  const own = running(owner, coder.id, {
    conversationId: pair.conversation_id!,
  });
  const near = await message(own, { to: sameMachine.id, body: "Hello" });
  expect(
    userMessage(mail((near as any).messageId).run_id).content,
  ).not.toContain("different environment");
});

it("lets a manager delegate without waiting, answer a worker mid-task, and get each result once", async () => {
  const owner = "background";
  db.prepare(
    "UPDATE runs SET state='cancelled' WHERE state IN ('queued','running')",
  ).run();
  const manager = agent(owner, "lead");
  const first = agent(owner, "first");
  const second = agent(owner, "second");
  const team = createTeam(owner, {
    name: "Async",
    managerId: manager.id,
    members: [first.id, second.id],
  });
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      const who = ownInstructions(input.instructions);
      const last = input.messages.findLast((m) => m.role === "user")!.content;
      const thread = /threadId "([^"]+)"/.exec(last)?.[1];
      if (who === "lead" && !input.messages.some((m) => m.role === "tool")) {
        if (last.includes("Message from @"))
          yield {
            toolCall: {
              id: "answer",
              name: "loop_message",
              arguments: { to: first.id, body: "Use v2.", threadId: thread },
            },
          };
        else if (last.includes("Result from @")) yield { text: "Noted." };
        else
          yield {
            toolCall: {
              id: "fan-out",
              name: "loop_delegate",
              arguments: {
                wait: false,
                tasks: [
                  { agentId: first.id, input: "Port the client" },
                  { agentId: second.id, input: "Port the server" },
                ],
              },
            },
          };
      } else if (who === "lead")
        yield { text: "Dispatched; results will follow." };
      else yield { text: `${who} evidence` };
    },
  });
  try {
    submit(owner, {
      agentId: manager.id,
      conversationId: team.conversation_id!,
      input: "Port everything",
      idempotencyKey: "background-start",
    });
    const lead = claim("lead-worker")!;
    expect(lead.agent_id).toBe(manager.id);
    // The manager finishes its turn instead of waiting for its workers.
    expect(await executeAgent(lead)).toBe(true);
    transition(lead, "completed");
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM delegations WHERE parent_run_id=? AND background=1",
        )
        .get(lead.id),
    ).toEqual({ n: 2 });
    const tool = JSON.parse(
      (
        db
          .prepare("SELECT result FROM native_calls WHERE run_id=?")
          .get(lead.id) as any
      ).result,
    ).content[0].text;
    expect(JSON.parse(tool).delegated).toHaveLength(2);

    const a = claim("worker-a")!,
      b = claim("worker-b")!;
    const workers = new Map([a, b].map((r) => [r.agent_id, r]));
    const firstTask = workers.get(first.id)!,
      secondTask = workers.get(second.id)!;
    // The first worker asks a question while both are still working.
    const asked = await message(firstTask, {
      to: manager.id,
      body: "Which API version?",
    });
    if ("error" in asked) throw new Error(asked.error);
    expect(asked.delivery).toBe("new_turn");
    expect(mail(asked.messageId).recipient_conversation_id).toBe(
      lead.conversation_id,
    );
    const answerTurn = claim("lead-answer")!;
    expect(answerTurn.agent_id).toBe(manager.id);
    expect(await executeAgent(answerTurn)).toBe(true);
    transition(answerTurn, "completed");
    // The answer queues in the first worker's task conversation, before the
    // second worker has finished.
    const answer = db
      .prepare(
        "SELECT * FROM agent_mail WHERE sender_run_id=? AND kind='message'",
      )
      .get(answerTurn.id) as any;
    expect(answer).toMatchObject({
      recipient_agent_id: first.id,
      recipient_conversation_id: firstTask.conversation_id,
      thread_id: asked.threadId,
      delivery: "queued",
    });
    expect(runOf(secondTask.id).state).toBe("running");

    for (const task of [firstTask, secondTask]) {
      expect(await executeAgent(task)).toBe(true);
      transition(task, "completed");
    }
    sweepAgentMail();
    sweepAgentMail();
    const results = db
      .prepare(
        "SELECT * FROM agent_mail WHERE owner_id=? AND kind='result' ORDER BY created_at,rowid",
      )
      .all(owner) as any[];
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.recipient_agent_id).toBe(manager.id);
      expect(result.recipient_conversation_id).toBe(lead.conversation_id);
      const turn = runOf(result.run_id);
      expect(turn.input).toContain("evidence");
      expect(turn.input).toContain("Result from @");
      expect(JSON.parse(userMessage(turn.id).metadata).automation.kind).toBe(
        "agent_result",
      );
    }
  } finally {
    restore();
  }
});

it("does not wake a cancelled manager with its cancelled workers' results", () => {
  const owner = "cancelled";
  const { manager, coder, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const child = running(owner, coder.id, { teamId: team.id }, "Background");
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,1)",
  ).run(lead.id, "call:0", child.id, "{}");
  transition(lead, "cancelled");
  transition(child, "cancelled");
  sweepAgentMail();
  expect(
    db.prepare("SELECT count(*) n FROM agent_mail WHERE owner_id=?").get(owner),
  ).toEqual({ n: 0 });
});

it("does not wake a manager cancelled after its workers finished, including deferred results", async () => {
  const owner = "cancelled-after";
  const { manager, coder, piWorker, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const done = running(owner, coder.id, { teamId: team.id }, "Background");
  const failed = running(owner, piWorker.id, { teamId: team.id }, "Background");
  for (const [index, child] of [done, failed].entries())
    db.prepare(
      "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,1)",
    ).run(lead.id, `call:${index}`, child.id, "{}");
  db.prepare("UPDATE runs SET result='Ported' WHERE id=?").run(done.id);
  transition(done, "completed");
  transition(failed, "failed");
  // The manager's provider is disconnected, so both results are deferred.
  const connection = (status: string) =>
    db
      .prepare(
        "UPDATE connections SET status=? WHERE id=(SELECT connection_id FROM agents WHERE id=?)",
      )
      .run(status, manager.id);
  connection("disconnected");
  sweepAgentMail();
  connection("connected");
  // Workers finished before the cancel, so it has nothing of theirs to stop.
  expect((await http(owner, `/runs/${lead.id}/cancel`, {})).status).toBe(200);
  sweepAgentMail(now() + 600_000);
  sweepAgentMail(now() + 1_200_000);
  expect(
    db.prepare("SELECT count(*) n FROM agent_mail WHERE owner_id=?").get(owner),
  ).toEqual({ n: 0 });
  expect(
    db
      .prepare("SELECT count(*) n FROM runs WHERE agent_id=? AND id<>?")
      .get(manager.id, lead.id),
  ).toEqual({ n: 0 });
});

it("retries a result the manager can't take yet, and holds it while the manager works elsewhere", () => {
  const owner = "retry";
  const { manager, coder, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const child = running(owner, coder.id, { teamId: team.id }, "Background");
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,1)",
  ).run(lead.id, "call:0", child.id, "{}");
  transition(lead, "completed");
  db.prepare("UPDATE runs SET result='Ported' WHERE id=?").run(child.id);
  transition(child, "completed");
  const results = () =>
    db
      .prepare("SELECT * FROM agent_mail WHERE owner_id=? AND kind='result'")
      .all(owner) as any[];
  // The manager's provider is disconnected: nothing is recorded as refused.
  db.prepare(
    "UPDATE connections SET status='disconnected' WHERE id=(SELECT connection_id FROM agents WHERE id=?)",
  ).run(manager.id);
  sweepAgentMail();
  expect(results()).toEqual([]);
  db.prepare(
    "UPDATE connections SET status='connected' WHERE id=(SELECT connection_id FROM agents WHERE id=?)",
  ).run(manager.id);
  // Now busy in another team conversation: the result waits rather than
  // starting a second session in the delegating conversation.
  const elsewhere = running(owner, manager.id, { teamId: team.id }, "Other");
  expect(elsewhere.conversation_id).not.toBe(lead.conversation_id);
  sweepAgentMail(now() + 60_000);
  expect(results()).toEqual([]);
  transition(elsewhere, "completed");
  sweepAgentMail(now() + 120_000);
  sweepAgentMail(now() + 180_000);
  expect(results()).toEqual([
    expect.objectContaining({
      state: "sent",
      recipient_conversation_id: lead.conversation_id,
      delivery: "new_turn",
    }),
  ]);
  expect(runOf(results()[0].run_id).input).toContain("Ported");
});

it("doesn't restart a cancelled task with its unread messages, and cancels results waiting for a cancelled manager", async () => {
  const owner = "cancel-reads";
  const { manager, coder, piWorker, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const busy = running(owner, coder.id, { teamId: team.id });
  const steered = await message(lead, {
    to: coder.id,
    body: "Also check the docs",
    interrupt: true,
  });
  if ("error" in steered) throw new Error(steered.error);
  transition(busy, "cancelled");
  sweepAgentMail();
  const row = mail(steered.messageId);
  expect(row).toMatchObject({ state: "refused", requeued_run_id: null });
  expect(row.error).toContain("cancelled");
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM runs WHERE agent_id=? AND state='queued'",
      )
      .get(coder.id),
  ).toEqual({ n: 0 });

  // A worker's background result is queued behind the manager's running
  // task; cancelling that task cancels the result turn too.
  const child = running(owner, piWorker.id, { teamId: team.id }, "Background");
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,1)",
  ).run(lead.id, "call:0", child.id, "{}");
  transition(child, "completed");
  sweepAgentMail();
  const result = db
    .prepare("SELECT * FROM agent_mail WHERE owner_id=? AND kind='result'")
    .get(owner) as any;
  expect(result).toMatchObject({ delivery: "queued" });
  expect(runOf(result.run_id).state).toBe("queued");
  expect((await http(owner, `/runs/${lead.id}/cancel`, {})).status).toBe(200);
  expect(runOf(result.run_id).state).toBe("cancelled");
});
