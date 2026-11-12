import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
const { createAgent, Problem, ownedRun } = await import("../src/server/domain");
const { createTeam, deleteTeam, listTeams } =
  await import("../src/server/teams");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { sendMail, sweepAgentMail, agentMail, MAIL_LIMITS, resumeThread } =
  await import("../src/server/agent-mail");
const { readAgentThread } = await import("../src/server/agent-thread-feed");
const { feed } = await import("../src/server/mobile-return");
const { claim, transition } = await import("../src/server/queue");
const { core } = await import("../src/server/core-routes");
const { withTestAdapter } = await import("../src/server/providers");
const { storePublishedFile } = await import("../src/server/published-files");
const { readRunFile } = await import("../src/server/uploads");
const { captureMemory } = await import("../src/server/memory");
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
      // Synchronous fixture setup can outlast a pooled socket's keep-alive timeout.
      headers: {
        "content-type": "application/json",
        "x-owner": owner,
        connection: "close",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  return { status: response.status, data: await response.json() };
}

let agentSequence = 0;
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
    name: name + "-" + ++agentSequence,
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
  return ownedRun(run.id, owner);
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
const runOf = (runId: string) => {
  const row = db.prepare("SELECT owner_id FROM runs WHERE id=?").get(runId) as {
    owner_id: string;
  };
  return ownedRun(runId, row.owner_id);
};
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

it("tracks teammate-triggered work in delegated conversations", async () => {
  const owner = "mail-working-feed";
  const { manager, coder, team } = mixedTeam(owner);
  const lead = running(owner, manager.id, { teamId: team.id });
  const child = running(owner, coder.id, { teamId: team.id });
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,1)",
  ).run(lead.id, "feed-child", child.id, "{}");
  const sent = await message(lead, {
    to: coder.id,
    body: "Use the updated requirements",
    interrupt: true,
  });
  expect(sent).toMatchObject({ delivery: "steered" });
  const working = feed(owner, { filter: "working" });
  expect(working.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        conversation_id: child.conversation_id,
        run: expect.objectContaining({ id: child.id, state: "running" }),
      }),
    ]),
  );
  expect(working.summary.working).toBe(2);
  expect(feed(owner, { filter: "done" }).summary.working).toBe(2);
  expect(feed("other-owner", { filter: "working" }).items).toEqual([]);
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(child.id);
  // A queued message wakes the same worker conversation as a new turn.
  const followUp = await message(lead, {
    to: coder.id,
    body: "Check the final result",
    threadId: (sent as any).threadId,
  });
  expect(followUp).toMatchObject({ delivery: "new_turn" });
  const followUpRun = mail((followUp as any).messageId).run_id;
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture-worker' WHERE id=?",
  ).run(followUpRun);
  expect(feed(owner, { filter: "working" }).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        conversation_id: child.conversation_id,
        run: expect.objectContaining({ id: followUpRun }),
      }),
    ]),
  );
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(followUpRun);
  expect(feed(owner, { filter: "working" }).summary.working).toBe(1);
  expect(
    feed(owner, { filter: "done" }).items.some(
      (item) => item.conversation_id === child.conversation_id,
    ),
  ).toBe(true);
});

it.each(["refused", "cancelled", "failed", "interrupted"] as const)(
  "keeps %s mail out of later API context, memory and file access",
  async (outcome) => {
    const owner = "mail-context-" + outcome;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient"),
      other = agent(owner, "other");
    const team = createTeam(owner, {
      name: "Context",
      managerId: sender.id,
      members: [recipient.id],
    });
    const source = running(owner, sender.id, {
      conversationId: team.conversation_id!,
    });
    const file = storePublishedFile(source, "private-file", {
      name: "undelivered.txt",
      title: "Undelivered",
      mime: "text/plain",
      bytes: Buffer.from("Undelivered attachment"),
    });
    const receipt = sendMail(source, "private-mail", {
      to: recipient.id,
      body: "UNDELIVERED_MAIL_MARKER",
      fileIds: [file.artifactId],
    });
    const target = runOf(mail(receipt.messageId).run_id);
    if (outcome === "refused") {
      db.prepare("DELETE FROM team_members WHERE team_id=? AND agent_id=?").run(
        team.id,
        recipient.id,
      );
      expect(claim("refusal", (r) => r.id === target.id)).toBeUndefined();
      expect(mail(receipt.messageId).state).toBe("refused");
    } else if (outcome === "cancelled") transition(target, "cancelled");
    else {
      const claimed = claim(
        "stopped-before-dispatch",
        (r) => r.id === target.id,
      )!;
      expect(claimed.id).toBe(target.id);
      transition(claimed, outcome);
    }
    expect(runOf(target.id).state).toBe(
      outcome === "refused" ? "cancelled" : outcome,
    );
    expect(userMessage(target.id).content).toContain("UNDELIVERED_MAIL_MARKER");
    captureMemory();
    expect(
      db
        .prepare(
          "SELECT 1 FROM memory_sources WHERE source_id IN (SELECT id FROM messages WHERE run_id=?)",
        )
        .get(target.id),
    ).toBeUndefined();
    const follow = submit(owner, {
      agentId: recipient.id,
      conversationId: target.conversation_id!,
      input: "An unrelated user request",
      idempotencyKey: id(),
    }) as Run;
    const active = claim("follow-up", (r) => r.id === follow.id)!;
    expect(active?.id).toBe(follow.id);
    expect(() => readRunFile(active, file.artifactId, 0, 1000, "utf8")).toThrow(
      /not attached/,
    );
    expect(() =>
      sendMail(active, "forward", {
        to: other.id,
        fileIds: [file.artifactId],
        body: "Forward",
        scope: "direct",
      }),
    ).toThrow(/not one you published/);
    const contexts: string[] = [];
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_key, input) {
        contexts.push(JSON.stringify(input.messages));
        yield { text: "Handled the user request." };
      },
    });
    try {
      expect(await executeAgent(active)).toBe(true);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContain("An unrelated user request");
      expect(contexts[0]).not.toContain("UNDELIVERED_MAIL_MARKER");
      expect(contexts[0]).not.toContain(file.artifactId);
      transition(active, "completed");
    } finally {
      restore();
    }
  },
);

it("gives ordinary agents mail tools and keeps explicit team scope restricted", async () => {
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

  expect(
    await message(task, { to: outsider.id, body: "Hi", scope: "team" }),
  ).toEqual({
    error: expect.stringContaining("Message only members of this team"),
  });
  expect(await message(task, { to: coder.id, body: "Hi" })).toEqual({
    error: expect.stringContaining("can't message yourself"),
  });
  const solo = running(owner, outsider.id, {});
  expect(binding(solo, "loop_message")).toBeTruthy();
  expect(binding(solo, "loop_agents")).toBeTruthy();
  expect(binding(solo, "loop_handoff")).toBeTruthy();
  expect(() =>
    sendMail(solo, "call", { to: coder.id, body: "Hi", scope: "team" }),
  ).toThrow(/members of this team/);

  db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(
    now(),
    piWorker.id,
  );
  expect(binding(task, "loop_message")!.description).not.toContain(piWorker.id);
  expect(await message(task, { to: piWorker.id, body: "Hi" })).toEqual({
    error: expect.stringContaining("retired"),
  });
  deleteTeam(owner, team.id);
  expect(binding(task, "loop_message")).toBeTruthy();
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
  const direct = await message(child, {
    to: manager.id,
    body: "Direct question",
    scope: "direct",
    interrupt: true,
  });
  expect(direct).toMatchObject({ delivery: "queued" });
  expect(mail((direct as any).messageId)).toMatchObject({
    recipient_conversation_id: team.conversation_id,
    steering_id: null,
  });
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
  db.prepare("UPDATE run_steering SET state='sending' WHERE id=?").run(
    mail(lost.messageId).steering_id,
  );
  transition(busy, "completed");
  db.prepare("UPDATE run_steering SET error=? WHERE id=?").run(
    "This unread message can be continued in a new turn.",
    mail(steered.messageId).steering_id,
  );
  db.prepare("UPDATE run_steering SET error=? WHERE id=?").run(
    "The run ended before this message could be delivered. Send it again to continue.",
    mail(lost.messageId).steering_id,
  );
  const connection = (status: string) =>
    db
      .prepare(
        "UPDATE connections SET status=? WHERE id=(SELECT connection_id FROM agents WHERE id=?)",
      )
      .run(status, coder.id);
  connection("disconnected");
  const retryTime = now();
  sweepAgentMail(retryTime);
  expect(mail(steered.messageId).requeued_run_id).toBeNull();
  connection("connected");
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const {sweepAgentMail}=await import('./src/server/agent-mail.ts');sweepAgentMail(" +
        (retryTime + 1) +
        ");",
    ],
    { env: { ...process.env, LOOP_DATA_DIR: dir } },
  );
  expect(mail(steered.messageId).requeued_run_id).toBeNull();
  sweepAgentMail(retryTime + 15_000);
  sweepAgentMail(retryTime + 30_000);
  expect(
    db
      .prepare("SELECT key FROM agent_mail_retries WHERE owner_id=?")
      .all(owner),
  ).toEqual([]);
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
      .prepare("SELECT state,error,failure_reason FROM run_steering WHERE id=?")
      .get(requeued.steering_id),
  ).toEqual({
    state: "failed",
    error: expect.stringContaining("queued it"),
    failure_reason: null,
  });
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

it("tells a teammate in another environment that files aren't shared, and queues OpenCode", async () => {
  const owner = "places";
  const manager = agent(owner, "manager");
  const coder = agent(owner, "coder", harness("codex"));
  const remote = agent(owner, "remote", {
    authMode: "subscription",
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
  expect(wake.input).toContain("runs in a different environment");
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(wake.id);
  const urgent = await message(task, {
    to: remote.id,
    body: "Stop",
    interrupt: true,
  });
  expect(urgent).toMatchObject({ delivery: "steered" });
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
    expect(
      feed(owner, { filter: "working" }).items.map(
        (item) => item.conversation_id,
      ),
    ).toEqual(
      expect.arrayContaining([
        firstTask.conversation_id,
        secondTask.conversation_id,
      ]),
    );
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
    expect(
      feed(owner, { filter: "done" }).items.map((item) => item.conversation_id),
    ).toEqual(
      expect.arrayContaining([
        firstTask.conversation_id,
        secondTask.conversation_id,
      ]),
    );
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

it.each([
  ["retired", "before-dispatch"],
  ["removed", "before-dispatch"],
  ["retired", "queued"],
  ["removed", "queued"],
  ["retired", "deferred"],
  ["removed", "deferred"],
])(
  "delivers a finished %s worker's result through %s recovery",
  async (change, phase) => {
    const owner = `finished-result-${change}-${phase}`;
    const { manager, coder, team } = mixedTeam(owner);
    const parent = running(owner, manager.id, {
      conversationId: team.conversation_id!,
    });
    const child = running(
      owner,
      coder.id,
      { teamId: team.id },
      "Background task",
    );
    db.prepare(
      "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,1)",
    ).run(parent.id, "background:0", child.id, "{}");
    db.prepare(
      "UPDATE runs SET result='Finished work remains deliverable' WHERE id=?",
    ).run(child.id);
    transition(child, "completed");
    transition(parent, "completed");
    if (phase === "deferred")
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        manager.connection_id,
      );
    if (phase !== "before-dispatch") sweepAgentMail();
    if (change === "retired")
      db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(
        now(),
        coder.id,
      );
    else
      db.prepare("DELETE FROM team_members WHERE team_id=? AND agent_id=?").run(
        team.id,
        coder.id,
      );
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      manager.connection_id,
    );
    sweepAgentMail(now() + 600000);
    sweepAgentMail(now() + 1200000);
    const results = db
      .prepare("SELECT * FROM agent_mail WHERE owner_id=? AND kind='result'")
      .all(owner) as {
      state: string;
      run_id: string;
      recipient_conversation_id: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      state: "sent",
      recipient_conversation_id: parent.conversation_id,
    });
    const resultRun = claim(
      "result-worker",
      (r) => r.owner_id === owner && r.agent_id === manager.id,
    )!;
    expect(resultRun?.id).toBe(results[0].run_id);
    let received = false;
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_key, input) {
        received = JSON.stringify(input.messages).includes(
          "Finished work remains deliverable",
        );
        yield { text: "Received the completed work." };
      },
    });
    try {
      expect(await executeAgent(resultRun)).toBe(true);
      expect(received).toBe(true);
      transition(resultRun, "completed");
    } finally {
      restore();
    }
  },
);

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

it("retries a result the manager can't take yet, and holds it while the manager works elsewhere", async () => {
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
  const retryTime = now();
  sweepAgentMail(retryTime);
  expect(results()).toEqual([]);
  db.prepare(
    "UPDATE connections SET status='connected' WHERE id=(SELECT connection_id FROM agents WHERE id=?)",
  ).run(manager.id);
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const {sweepAgentMail}=await import('./src/server/agent-mail.ts');sweepAgentMail(" +
        (retryTime + 1) +
        ");",
    ],
    { env: { ...process.env, LOOP_DATA_DIR: dir } },
  );
  expect(results()).toEqual([]);
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
  expect(
    db
      .prepare("SELECT key FROM agent_mail_retries WHERE owner_id=?")
      .all(owner),
  ).toEqual([]);
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

it.each(["team", "direct"])(
  "hands work from Claude to Codex to Pi with context, files and durable identities in %s scope",
  async (scope) => {
    const owner = "handoff-" + scope;
    const claude = agent(owner, "planner", harness("claude"));
    const codex = agent(owner, "implementer", harness("codex"));
    const pi = agent(owner, "reviewer", harness("pi"));
    const team =
      scope === "team"
        ? createTeam(owner, {
            name: "Handoff",
            managerId: claude.id,
            members: [codex.id, pi.id],
          })
        : undefined;
    const source = running(owner, claude.id, {
      conversationId: team?.conversation_id ?? undefined,
    });
    const binding = nativeBindings(source).find(
      (b) => b.tool === "loop_handoff",
    )!;
    expect(binding).toBeDefined();
    const file = storePublishedFile(source, "handoff-design", {
      name: "design.md",
      title: "Design",
      mime: "text/markdown",
      bytes: Buffer.from("Streaming parser design"),
    });
    const input = {
      to: codex.id,
      fileIds: [file.artifactId],
      task: "Implement the parser",
      context:
        "The accepted design uses a streaming parser. Review edge cases next.",
      workspace:
        "repo acme/parser; branch parser-fix; commit abc123. No uncommitted edits remain.",
    };
    const sent = await invokeNative(source, binding, "handoff-1", input);
    const retry = await invokeNative(source, binding, "handoff-1", input);
    expect(retry).toEqual(sent);
    const row = db
      .prepare("SELECT * FROM agent_mail WHERE sender_run_id=?")
      .get(source.id) as any;
    expect(
      db
        .prepare("SELECT count(*) n FROM agent_mail WHERE sender_run_id=?")
        .get(source.id),
    ).toEqual({ n: 1 });
    const received = runOf(row.run_id);
    expect(received.input).toContain("Work handoff");
    expect(received.input).toContain("branch parser-fix");
    expect(received.input).toContain("grants no additional authority");
    expect(received.input).toContain(
      scope === "team" ? "from a teammate" : "from another agent",
    );
    expect(received.payload.connectionId).toBe(codex.connection_id);
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(received.id);
    expect(
      readRunFile(runOf(received.id), file.artifactId, 0, 1000, "utf8").content,
    ).toBe("Streaming parser design");
    const next = nativeBindings(received).find(
      (b) => b.tool === "loop_handoff",
    )!;
    await invokeNative(received, next, "handoff-2", {
      to: pi.id,
      task: "Review the parser",
      context: "Implementation completed, all parser tests pass.",
      ...(scope === "team" ? { threadId: row.thread_id } : {}),
      fileIds: [file.artifactId],
    });
    const final = db
      .prepare("SELECT run_id FROM agent_mail WHERE sender_run_id=?")
      .get(received.id) as any;
    expect(runOf(final.run_id).payload.connectionId).toBe(pi.connection_id);
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(final.run_id);
    expect(
      readRunFile(runOf(final.run_id), file.artifactId, 0, 1000, "utf8")
        .content,
    ).toBe("Streaming parser design");
    for (const fileOwner of [owner, "foreign-files-" + scope]) {
      const unrelated = agent(fileOwner, "unrelated");
      const task = running(fileOwner, unrelated.id, {});
      const privateFile = storePublishedFile(task, "private", {
        name: "private.md",
        title: "Private",
        mime: "text/markdown",
        bytes: Buffer.from("Not attached"),
      });
      expect(() =>
        sendMail(source, "unrelated-" + fileOwner, {
          to: codex.id,
          body: "Do not forward",
          fileIds: [privateFile.artifactId],
        }),
      ).toThrow(/not one you published/);
      expect(() =>
        readRunFile(
          runOf(final.run_id),
          privateFile.artifactId,
          0,
          1000,
          "utf8",
        ),
      ).toThrow();
    }
    // A crash between mail acceptance and saving the tool response must still
    // find the receipt after the original team disappears.
    db.prepare(
      "UPDATE native_calls SET result=NULL WHERE run_id=? AND call_id='handoff-1'",
    ).run(source.id);
    if (team) deleteTeam(owner, team.id);
    expect(await invokeNative(source, binding, "handoff-1", input)).toEqual(
      sent,
    );
  },
);

async function toolResult(
  run: Run,
  name: string,
  args: Record<string, unknown> = {},
) {
  const value = await invokeNative(run, binding(run, name)!, id(), args);
  return JSON.parse((value as any).result.content[0].text);
}

it.each([
  "queued",
  "paused",
  "cancelled",
  "refused",
  "failed",
  "interrupted",
  "completed",
] as const)(
  "keeps unread %s mail out of recipient status tools while retaining sender and owner history",
  async (state) => {
    const owner = "status-content-" + state,
      sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex")),
      source = running(owner, sender.id, {}),
      body = "Undelivered status content " + id();
    const receipt = sendMail(source, "status-content", {
      to: recipient.id,
      body,
    });
    const delivery = runOf(mail(receipt.messageId).run_id);
    if (state === "refused") {
      db.prepare(
        "UPDATE runs SET payload=json_set(payload,'$.reviewId','snapshot') WHERE conversation_id=?",
      ).run(delivery.conversation_id);
      expect(
        claim("refuse-status", (r) => r.id === delivery.id),
      ).toBeUndefined();
      expect(mail(receipt.messageId).state).toBe("refused");
    } else if (state === "cancelled" || state === "paused")
      transition(delivery, state);
    else if (["failed", "interrupted", "completed"].includes(state)) {
      const received = claim("read-status", (r) => r.id === delivery.id)!;
      expect(received.id).toBe(delivery.id);
      transition(received, state);
    }
    const later = running(owner, recipient.id, {});
    const list = await toolResult(later, "loop_message_status");
    const detail = await toolResult(later, "loop_message_status", {
      threadId: receipt.threadId,
    });
    expect(JSON.stringify([list, detail]).includes(body)).toBe(
      state === "completed",
    );
    expect(detail.messages[0]).toMatchObject({
      messageId: receipt.messageId,
      status:
        state === "refused"
          ? "not_delivered"
          : state === "completed"
            ? "handled"
            : state === "paused"
              ? "queued"
              : state,
      preview: state === "completed" ? body : null,
    });
    expect(
      JSON.stringify(await toolResult(source, "loop_message_status")),
    ).toContain(body);
    expect(
      JSON.stringify(
        await toolResult(source, "loop_message_status", {
          threadId: receipt.threadId,
        }),
      ),
    ).toContain(body);
    const history = await http(owner, `/agents/${recipient.id}/mail`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.data)).toContain(body);
  },
);

it("discovers a bounded searchable owner-local directory without prompts or connection secrets", async () => {
  const owner = "directory";
  const a = agent(owner, "source");
  const b = agent(owner, "match-alpha", harness("codex"));
  const c = agent(owner, "match-beta");
  const hidden = agent("another-owner", "match-private");
  db.prepare(
    "UPDATE agents SET instructions='PRIVATE INSTRUCTIONS' WHERE id=?",
  ).run(b.id);
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    c.connection_id,
  );
  const run = running(owner, a.id, {});
  const page = await toolResult(run, "loop_agents", {
    query: "MATCH",
    limit: 1,
  });
  expect(page).toMatchObject({
    agents: [{ agentId: b.id, runtime: "Codex", availability: "available" }],
    nextOffset: 1,
  });
  const next = await toolResult(run, "loop_agents", {
    query: "match",
    limit: 1,
    offset: page.nextOffset,
  });
  expect(next).toMatchObject({
    agents: [{ agentId: c.id, availability: "disconnected" }],
    nextOffset: null,
  });
  expect(JSON.stringify([page, next])).not.toMatch(
    /PRIVATE INSTRUCTIONS|secret|metadata|connectionId/,
  );
  expect(JSON.stringify(page)).not.toContain(hidden.id);
  expect(await message(run, { to: hidden.id, body: "No" })).toEqual({
    error: expect.stringContaining("not found"),
  });
});

it("binds two direct participants across teams and keeps their original conversations", async () => {
  const owner = "direct-bindings";
  const a = agent(owner, "first"),
    b = agent(owner, "second"),
    third = agent(owner, "third");
  const firstTeam = createTeam(owner, {
    name: "First",
    managerId: a.id,
    members: [third.id],
  });
  const secondTeam = createTeam(owner, {
    name: "Second",
    managerId: b.id,
    members: [third.id],
  });
  const source = running(owner, a.id, {
    conversationId: firstTeam.conversation_id!,
  });
  const sent = sendMail(source, "new-direct", { to: b.id, body: "Question" });
  const row = mail(sent.messageId);
  expect(
    db
      .prepare("SELECT scope,team_id FROM agent_threads WHERE id=?")
      .get(sent.threadId),
  ).toEqual({ scope: "direct", team_id: null });
  expect(row.recipient_conversation_id).not.toBe(secondTeam.conversation_id);
  expect(
    db
      .prepare("SELECT team_id FROM conversations WHERE id=?")
      .get(row.recipient_conversation_id),
  ).toEqual({ team_id: null });
  const recipient = runOf(row.run_id);
  expect(recipient.payload).toMatchObject({
    connectionId: b.connection_id,
  });
  expect(recipient.payload.teamId).toBeUndefined();
  expect(recipient.input).not.toContain("on your team");
  const elsewhere = running(owner, a.id, { teamId: firstTeam.id });
  const replyRun = running(owner, b.id, {
    conversationId: row.recipient_conversation_id,
  });
  const reply = sendMail(replyRun, "reply", {
    to: a.id,
    body: "Answer",
    threadId: sent.threadId,
  });
  expect(mail(reply.messageId).recipient_conversation_id).toBe(
    source.conversation_id,
  );
  sendMail(elsewhere, "other-context", {
    to: b.id,
    body: "Follow-up",
    threadId: sent.threadId,
  });
  expect(
    db
      .prepare(
        "SELECT conversation_id FROM agent_thread_members WHERE thread_id=? AND agent_id=?",
      )
      .get(sent.threadId, a.id),
  ).toEqual({ conversation_id: source.conversation_id });
  expect(() =>
    sendMail(source, "third", {
      to: third.id,
      body: "No",
      threadId: sent.threadId,
    }),
  ).toThrow(/two fixed participants/);
  expect(() =>
    sendMail(source, "scope", {
      to: b.id,
      body: "No",
      threadId: sent.threadId,
      scope: "team",
    }),
  ).toThrow(/Scope conflicts/);
  expect(() =>
    sendMail(source, "conversation", {
      to: b.id,
      body: "No",
      threadId: sent.threadId,
      conversationId: secondTeam.conversation_id!,
    }),
  ).toThrow(/conflicts/);
  await invokeNative(
    source,
    binding(source, "loop_handoff")!,
    "cross-team-handoff",
    {
      to: b.id,
      task: "Check the result",
      context: "A handoff without shared team membership",
    },
  );
  const handoff = db
    .prepare("SELECT body FROM agent_mail WHERE idempotency_key=?")
    .get(`mail:${source.id}:cross-team-handoff`) as { body: string };
  expect(handoff.body).toContain("from another agent");
  deleteTeam(owner, firstTeam.id);
  deleteTeam(owner, secondTeam.id);
  expect(
    sendMail(replyRun, "after-delete", {
      to: a.id,
      body: "Still direct",
      threadId: sent.threadId,
    }).delivery,
  ).toBe("queued");
  expect(
    (await http(owner, `/agents/${a.id}/mail`)).data.threads[0].scope,
  ).toBe("direct");
  expect((await http("stranger", `/agents/${a.id}/mail`)).status).toBe(404);
  expect(
    (await http(owner, `/agents/${third.id}/mail/${sent.threadId}/resume`, {}))
      .status,
  ).toBe(404);
});

it("validates explicit destinations, sender identity, scope and immutable call targeting", async () => {
  const owner = "direct-targets";
  const { manager, coder, team } = mixedTeam(owner);
  const source = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const target = running(owner, coder.id, { teamId: team.id });
  const input = {
    to: coder.id,
    body: "Direct",
    scope: "direct" as const,
    conversationId: target.conversation_id!,
  };
  const sent = sendMail(source, "fixed", input);
  expect(mail(sent.messageId).recipient_conversation_id).toBe(
    target.conversation_id,
  );
  expect(
    db.prepare("SELECT scope FROM agent_threads WHERE id=?").get(sent.threadId),
  ).toEqual({ scope: "direct" });
  for (const patch of [
    { body: "Different" },
    { scope: "team" },
    { to: manager.id },
    { conversationId: id() },
  ])
    expect(() =>
      sendMail(source, "fixed", { ...input, ...patch } as any),
    ).toThrow(/identity was reused/);
  expect(sendMail(source, "fixed", input)).toEqual(sent);
  expect(() =>
    sendMail(source, "wrong-conversation", {
      ...input,
      conversationId: source.conversation_id!,
    }),
  ).toThrow(/bound conversation is unavailable/);
  const foreign = agent("foreign-target", "foreign");
  const foreignRun = running("foreign-target", foreign.id, {});
  expect(() =>
    sendMail(source, "foreign-conversation", {
      ...input,
      conversationId: foreignRun.conversation_id!,
    }),
  ).toThrow(/bound conversation is unavailable/);
  const forged = await message(source, {
    to: coder.id,
    body: "Identity",
    scope: "direct",
    senderAgentId: foreign.id,
  });
  expect(mail((forged as any).messageId).sender_agent_id).toBe(manager.id);
  const review = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  db.prepare(
    "UPDATE runs SET payload=json_set(payload,'$.reviewId','snapshot') WHERE id=?",
  ).run(review.id);
  expect(nativeBindings(runOf(review.id)).map((t) => t.tool)).toEqual([
    "loop_review_read",
  ]);
  await expect(
    invokeNative(runOf(review.id), binding(source, "loop_message")!, "forged", {
      to: coder.id,
      body: "No",
    }),
  ).rejects.toThrow(/unavailable/);
  expect(() => sendMail(review, "bypass", input)).toThrow(/unavailable/);
});

it("retains disconnected mail through a fresh process sweep and does not release held mail", async () => {
  const owner = "durable-pending";
  const a = agent(owner, "sender"),
    b = agent(owner, "receiver");
  const run = running(owner, a.id, {});
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    b.connection_id,
  );
  const sent = sendMail(run, "durable", { to: b.id, body: "Keep this" });
  expect(sent.delivery).toBe("pending");
  expect(mail(sent.messageId)).toMatchObject({
    state: "pending",
    run_id: null,
    recipient_conversation_id: null,
  });
  db.prepare(
    "UPDATE agent_threads SET paused_at=?,paused_reason='User must resume' WHERE id=?",
  ).run(now(), sent.threadId);
  const held = sendMail(run, "held", {
    to: b.id,
    body: "Hold this",
    threadId: sent.threadId,
  });
  expect(held.delivery).toBe("held");
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    b.connection_id,
  );
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const {sweepAgentMail}=await import('./src/server/agent-mail.ts');sweepAgentMail(Date.now()+600000);sweepAgentMail(Date.now()+1200000);",
    ],
    { env: { ...process.env, LOOP_DATA_DIR: dir } },
  );
  expect(mail(sent.messageId).state).toBe("sent");
  expect(mail(held.messageId).state).toBe("held");
  expect(
    db
      .prepare("SELECT count(*) n FROM runs WHERE idempotency_key=?")
      .get(`mail:${run.id}:durable`),
  ).toEqual({ n: 1 });
  const resume = await http(
    owner,
    `/agents/${a.id}/mail/${sent.threadId}/resume`,
    {},
  );
  expect(resume.data).toEqual({ released: 1, refused: 0, held: 0 });
  expect(mail(held.messageId).recipient_conversation_id).toBe(
    mail(sent.messageId).recipient_conversation_id,
  );
});

it("holds mail at queue pressure and refuses obsolete targets on recovery without rerouting", () => {
  const owner = "queue-pressure";
  const a = agent(owner, "sender"),
    b = agent(owner, "target"),
    c = agent(owner, "other");
  const source = running(owner, a.id, {});
  const pending: Run[] = [];
  // Seed queue pressure in one commit; the delivery/recovery actions below
  // still run as separate production transactions.
  db.transaction(() => {
    for (let i = 0; i < 99; i++)
      pending.push(
        submit(owner, {
          agentId: c.id,
          input: "work",
          idempotencyKey: id(),
        }) as Run,
      );
  }).immediate();
  const accepted = sendMail(source, "full", { to: b.id, body: "Wait" });
  expect(accepted.delivery).toBe("pending");
  transition(pending[0], "cancelled");
  sweepAgentMail(now() + 600000);
  expect(mail(accepted.messageId).state).toBe("sent");
  const targetConversation = mail(accepted.messageId).recipient_conversation_id;
  db.prepare(
    "UPDATE runs SET payload=json_set(payload,'$.reviewId','snapshot') WHERE conversation_id=?",
  ).run(targetConversation);
  expect(() =>
    sendMail(source, "obsolete", {
      to: b.id,
      body: "No",
      threadId: accepted.threadId,
    }),
  ).toThrow(/bound conversation/);
  const fresh = sendMail(source, "new-contact", {
    to: b.id,
    body: "New thread",
  });
  expect(fresh.threadId).not.toBe(accepted.threadId);
  db.prepare("UPDATE agents SET retired_at=? WHERE id=?").run(now(), b.id);
  sweepAgentMail(now() + 1200000);
  expect(mail(fresh.messageId)).toMatchObject({
    state: "refused",
    error: expect.stringContaining("retired"),
  });
});

it("serializes mail across native conversations at atomic claims while preserving user concurrency", () => {
  const owner = "mail-claims";
  const a = agent(owner, "sender"),
    b = agent(owner, "native", harness("codex"));
  const source = running(owner, a.id, {});
  const first = submit(owner, {
    agentId: b.id,
    input: "User one",
    idempotencyKey: id(),
  }) as Run;
  const second = submit(owner, {
    agentId: b.id,
    input: "User two",
    idempotencyKey: id(),
  }) as Run;
  const claimOwn = (worker: string) =>
    claim(worker, (run) => run.owner_id === owner && run.agent_id === b.id);
  expect(claimOwn("one")?.id).toBe(first.id);
  expect(claimOwn("two")?.id).toBe(second.id);
  const mails = ["one", "two"].map((call) =>
    sendMail(source, call, { to: b.id, body: call }),
  );
  expect(mails.map((m) => m.delivery)).toEqual(["queued", "queued"]);
  expect(claimOwn("three")).toBeUndefined();
  transition(first, "completed");
  transition(second, "awaiting_approval");
  expect(claimOwn("after-approval")).toBeUndefined();
  transition(second, "completed");
  const delivered = claimOwn("new-worker")!;
  expect(delivered.id).toBe(mail(mails[0].messageId).run_id);
  expect(claimOwn("concurrent-worker")).toBeUndefined();
  transition(delivered, "completed");
  const next = claimOwn("next-worker")!;
  expect(next.id).toBe(mail(mails[1].messageId).run_id);
  transition(next, "cancelled");
  sweepAgentMail(now() + 600000);
  expect(runOf(next.id).state).toBe("cancelled");
  expect(claimOwn("after-cancel")).toBeUndefined();
});

it.each(["paused", "awaiting_approval"] as const)(
  "lets unrelated native work pass mail waiting behind %s work",
  (state) => {
    const owner = "mail-lane-" + state;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex"));
    const source = running(owner, sender.id, {}),
      busy = running(owner, recipient.id, {});
    if (state === "paused") {
      transition(busy, "pausing");
      transition(busy, "paused");
    } else transition(busy, state);
    const receipt = sendMail(source, "waiting", {
      to: recipient.id,
      body: "Waiting for availability",
    });
    const queued = runOf(mail(receipt.messageId).run_id);
    const unrelated = submit(owner, {
      agentId: recipient.id,
      input: "Work in conversation C",
      idempotencyKey: id(),
    }) as Run;
    const own = (r: Run) => r.owner_id === owner && r.agent_id === recipient.id;
    expect(claim("unrelated", own)?.id).toBe(unrelated.id);
    expect(runOf(queued.id).state).toBe("queued");
    transition(unrelated, "completed");
    transition(busy, "completed");
    expect(claim("mail", own)?.id).toBe(queued.id);
    const later = submit(owner, {
      agentId: recipient.id,
      input: "Later user turn",
      idempotencyKey: id(),
    }) as Run;
    expect(claim("conflict", own)).toBeUndefined();
    transition(queued, "completed");
    expect(claim("after-mail", own)?.id).toBe(later.id);
    transition(later, "completed");
  },
);

it.each(["disconnected", "deleted"])(
  "refuses queued mail with a %s old provider after a connection switch without blocking new work",
  (state) => {
    const owner = "mail-provider-switch-" + state;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex"));
    const source = running(owner, sender.id, {});
    const receipt = sendMail(source, "old-provider", {
      to: recipient.id,
      body: "Keep the original provider identity",
    });
    const target = runOf(mail(receipt.messageId).run_id);
    const replacement = agent(owner, "replacement", harness("pi"));
    db.prepare("UPDATE agents SET connection_id=? WHERE id=?").run(
      replacement.connection_id,
      recipient.id,
    );
    if (state === "deleted")
      db.prepare("DELETE FROM connections WHERE id=?").run(
        recipient.connection_id,
      );
    else
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        recipient.connection_id,
      );
    const next = submit(owner, {
      agentId: recipient.id,
      input: "New provider request",
      idempotencyKey: id(),
    }) as Run;
    expect(claim("replacement", (r) => r.agent_id === recipient.id)?.id).toBe(
      next.id,
    );
    expect(runOf(target.id).state).toBe("cancelled");
    expect(mail(receipt.messageId)).toMatchObject({
      state: "refused",
      error: expect.stringContaining("provider selected"),
    });
    expect(runOf(target.id).payload.connectionId).toBe(recipient.connection_id);
    transition(next, "completed");
  },
);

it("rechecks queued team membership but preserves independent direct mail", () => {
  const owner = "revoked-queued";
  const { manager, coder, team } = mixedTeam(owner);
  const run = running(owner, manager.id, {
    conversationId: team.conversation_id!,
  });
  const teamMail = sendMail(run, "team", { to: coder.id, body: "Team" });
  const direct = sendMail(run, "direct", {
    to: coder.id,
    body: "Direct",
    scope: "direct",
  });
  db.prepare("DELETE FROM team_members WHERE team_id=? AND agent_id=?").run(
    team.id,
    coder.id,
  );
  const own = (r: Run) => r.owner_id === owner && r.agent_id === coder.id;
  const valid = claim("first", own);
  expect(mail(teamMail.messageId).state).toBe("refused");
  expect(valid?.id).toBe(mail(direct.messageId).run_id);
});

it.each(["codex", "claude", "pi", "opencode", "acp"])(
  "selects the running %s conversation for direct interrupts, using its connection's capability",
  (harnessName) => {
    const owner = "direct-steer-" + harnessName;
    const a = agent(owner, "sender"),
      b = agent(owner, "target", harness(harnessName));
    const source = running(owner, a.id, {}),
      target = running(owner, b.id, {});
    const preference = agent(
      owner,
      "new-preference",
      harness(
        harnessName === "opencode" || harnessName === "acp"
          ? "codex"
          : "opencode",
      ),
    );
    db.prepare("UPDATE agents SET connection_id=? WHERE id=?").run(
      preference.connection_id,
      b.id,
    );
    const sent = sendMail(source, "interrupt", {
      to: b.id,
      body: "Urgent",
      conversationId: target.conversation_id!,
      interrupt: true,
    });
    expect(sent.delivery).toBe(
      ["codex", "claude", "pi"].includes(harnessName) ? "steered" : "queued",
    );
    const automatic = sendMail(source, "other-thread", {
      to: b.id,
      body: "Other",
      interrupt: true,
    });
    expect(automatic.delivery).toBe(sent.delivery);
    expect(mail(automatic.messageId).recipient_conversation_id).toBe(
      target.conversation_id,
    );
  },
);

it("uses a new direct interrupt's destination as the thread's default, including team conversations", () => {
  const owner = "direct-interrupt-first-binding";
  const sender = agent(owner, "sender"),
    recipient = agent(owner, "recipient", harness("codex")),
    worker = agent(owner, "worker");
  const team = createTeam(owner, {
    name: "Recipient team",
    managerId: recipient.id,
    members: [worker.id],
  });
  const source = running(owner, sender.id, {}),
    target = running(owner, recipient.id, {
      conversationId: team.conversation_id!,
    });
  const urgent = sendMail(source, "interrupt", {
    to: recipient.id,
    body: "Current task",
    interrupt: true,
  });
  expect(urgent.delivery).toBe("steered");
  expect(
    db
      .prepare("SELECT scope,team_id FROM agent_threads WHERE id=?")
      .get(urgent.threadId),
  ).toEqual({ scope: "direct", team_id: null });
  expect(
    db
      .prepare(
        "SELECT conversation_id FROM agent_thread_members WHERE thread_id=? AND agent_id=?",
      )
      .get(urgent.threadId, recipient.id),
  ).toEqual({ conversation_id: target.conversation_id });
  const ordinary = sendMail(source, "ordinary", {
    to: recipient.id,
    body: "Later",
    threadId: urgent.threadId,
  });
  expect(mail(ordinary.messageId)).toMatchObject({
    recipient_conversation_id: target.conversation_id,
    steering_id: null,
  });
});

it("establishes an empty direct binding from the earlier ordinary message before releasing an interrupt", () => {
  const owner = "direct-interrupt-empty-binding";
  const sender = agent(owner, "sender"),
    recipient = agent(owner, "recipient", harness("codex"));
  const source = running(owner, sender.id, {}),
    target = running(owner, recipient.id, {});
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    recipient.connection_id,
  );
  const ordinary = sendMail(source, "ordinary", {
    to: recipient.id,
    body: "Later",
  });
  expect(ordinary.delivery).toBe("pending");
  expect(mail(ordinary.messageId).recipient_conversation_id).toBeNull();
  const urgent = sendMail(source, "interrupt", {
    to: recipient.id,
    body: "Now",
    threadId: ordinary.threadId,
    interrupt: true,
  });
  expect(urgent.delivery).toBe("pending");
  expect(mail(urgent.messageId).recipient_conversation_id).toBe(
    target.conversation_id,
  );
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    recipient.connection_id,
  );
  sweepAgentMail(now() + 600000);
  const bound = mail(ordinary.messageId).recipient_conversation_id;
  expect(bound).toEqual(expect.any(String));
  expect(bound).not.toBe(target.conversation_id);
  // Each sweep releases only the earliest pending message in a thread.
  expect(mail(urgent.messageId).state).toBe("pending");
  sweepAgentMail(now() + 1200000);
  expect(mail(urgent.messageId)).toMatchObject({
    delivery: "steered",
    run_id: target.id,
  });
  expect(
    db
      .prepare(
        "SELECT conversation_id FROM agent_thread_members WHERE thread_id=? AND agent_id=?",
      )
      .get(ordinary.threadId, recipient.id),
  ).toEqual({ conversation_id: bound });
});

it.each(["review"])(
  "refuses an automatically selected %s conversation instead of choosing another task",
  (backend) => {
    const owner = "direct-interrupt-ineligible-" + backend;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex"));
    const source = running(owner, sender.id, {});
    const eligible = running(owner, recipient.id, {});
    const target = running(owner, recipient.id, {});
    db.prepare(
      "UPDATE runs SET payload=json_set(payload,'$.reviewId','snapshot') WHERE id=?",
    ).run(target.id);
    expect(() =>
      sendMail(source, "interrupt", {
        to: recipient.id,
        body: "Now",
        interrupt: true,
      }),
    ).toThrow(/Send without interrupt or specify another conversationId/);
    expect(
      db
        .prepare("SELECT count(*) n FROM agent_mail WHERE owner_id=?")
        .get(owner),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT count(*) n FROM run_steering WHERE owner_id=?")
        .get(owner),
    ).toEqual({ n: 0 });
    expect(
      sendMail(source, "ordinary", { to: recipient.id, body: "Later" })
        .delivery,
    ).toBe("queued");
    const explicit = sendMail(source, "explicit", {
      to: recipient.id,
      body: "Eligible task",
      interrupt: true,
      conversationId: eligible.conversation_id!,
    });
    expect(explicit.delivery).toBe("steered");
    expect(mail(explicit.messageId).run_id).toBe(eligible.id);
  },
);

it.each(["pending", "held"])(
  "refuses %s interrupts when the selected destination becomes unusable",
  (state) => {
    const owner = "direct-interrupt-obsolete-" + state;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex"));
    const source = running(owner, sender.id, {}),
      target = running(owner, recipient.id, {});
    const ordinary = sendMail(source, "ordinary", {
      to: recipient.id,
      body: "Later",
    });
    if (state === "held")
      db.prepare("UPDATE agent_threads SET paused_at=? WHERE id=?").run(
        now(),
        ordinary.threadId,
      );
    else
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        recipient.connection_id,
      );
    const urgent = sendMail(source, "interrupt", {
      to: recipient.id,
      body: "Now",
      threadId: ordinary.threadId,
      interrupt: true,
    });
    expect(urgent.delivery).toBe(state);
    db.prepare(
      "UPDATE runs SET payload=json_set(payload,'$.reviewId','snapshot') WHERE conversation_id=?",
    ).run(target.conversation_id);
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      recipient.connection_id,
    );
    if (state === "held")
      expect(resumeThread(owner, null, urgent.threadId)).toEqual({
        released: 0,
        refused: 1,
        held: 0,
      });
    else sweepAgentMail(now() + 600000);
    expect(mail(urgent.messageId)).toMatchObject({
      state: "refused",
      run_id: null,
      steering_id: null,
      recipient_conversation_id: target.conversation_id,
    });
    const normal = sendMail(source, "normal-reply", {
      to: recipient.id,
      body: "Original destination",
      threadId: ordinary.threadId,
    });
    expect(mail(normal.messageId).recipient_conversation_id).toBe(
      mail(ordinary.messageId).recipient_conversation_id,
    );
  },
);

it("interrupts the current conversation from an existing direct thread without moving ordinary replies", async () => {
  const owner = "direct-interrupt-reply";
  const sender = agent(owner, "sender"),
    recipient = agent(owner, "recipient", harness("codex"));
  const source = running(owner, sender.id, {}),
    target = running(owner, recipient.id, {});
  const first = sendMail(source, "queued", {
    to: recipient.id,
    body: "Hold merges",
  });
  const original = mail(first.messageId).recipient_conversation_id;
  expect(first.delivery).toBe("queued");
  expect(original).not.toBe(target.conversation_id);

  const input = {
    to: recipient.id,
    body: "Hold merges now",
    threadId: first.threadId,
    interrupt: true,
  };
  const call = id();
  const urgent = await message(source, input, call);
  if ("error" in urgent) throw new Error(urgent.error);
  expect(urgent).toMatchObject({
    threadId: first.threadId,
    delivery: "steered",
  });
  expect(mail(urgent.messageId)).toMatchObject({
    run_id: target.id,
    recipient_conversation_id: target.conversation_id,
    steering_id: expect.any(String),
  });
  const followUp = sendMail(source, "ordinary", {
    to: recipient.id,
    body: "When you are done",
    threadId: first.threadId,
  });
  expect(mail(followUp.messageId).recipient_conversation_id).toBe(original);
  const exchange = readAgentThread(owner, first.threadId, { limit: 40 });
  expect(
    exchange.messages.map((message) => [message.id, message.content]),
  ).toEqual([
    [first.messageId, "Hold merges"],
    [urgent.messageId, "Hold merges now"],
    [followUp.messageId, "When you are done"],
  ]);
  expect(exchange.messages[1].message_id).toBe(
    (
      db
        .prepare("SELECT message_id FROM run_steering WHERE id=?")
        .get(mail(urgent.messageId).steering_id) as { message_id: string }
    ).message_id,
  );
  expect(
    db
      .prepare(
        "SELECT conversation_id FROM agent_thread_members WHERE thread_id=? AND agent_id=?",
      )
      .get(first.threadId, recipient.id),
  ).toEqual({ conversation_id: original });

  transition(target, "completed");
  running(owner, recipient.id, {});
  // A retried tool call keeps its original delivery even after the active task changes.
  expect(await message(source, input, call)).toEqual(urgent);
  expect(
    db
      .prepare("SELECT count(*) n FROM run_steering WHERE owner_id=?")
      .get(owner),
  ).toEqual({ n: 1 });
});

it("selects the newest running conversation, ignores queued work, and honors explicit interrupt destinations", () => {
  const owner = "direct-interrupt-selection";
  const sender = agent(owner, "sender"),
    recipient = agent(owner, "recipient", harness("codex"));
  const source = running(owner, sender.id, {});
  const older = running(owner, recipient.id, {}),
    newer = running(owner, recipient.id, {});
  // Equal timestamps still select the last-created running task deterministically.
  db.prepare("UPDATE runs SET created_at=? WHERE id IN (?,?)").run(
    now(),
    older.id,
    newer.id,
  );
  const queued = submit(owner, {
    agentId: recipient.id,
    input: "Later",
    idempotencyKey: id(),
  });
  const automatic = sendMail(source, "automatic", {
    to: recipient.id,
    body: "Current task",
    interrupt: true,
  });
  expect(mail(automatic.messageId)).toMatchObject({
    run_id: newer.id,
    steering_id: expect.any(String),
  });
  const explicit = sendMail(source, "explicit", {
    to: recipient.id,
    body: "This task",
    interrupt: true,
    threadId: automatic.threadId,
    conversationId: older.conversation_id!,
  });
  expect(mail(explicit.messageId)).toMatchObject({
    run_id: older.id,
    steering_id: expect.any(String),
  });
  const explicitQueue = sendMail(source, "explicit-queue", {
    to: recipient.id,
    body: "This queued task",
    interrupt: true,
    conversationId: queued.conversation_id!,
  });
  expect(explicitQueue.delivery).toBe("queued");
  expect(mail(explicitQueue.messageId)).toMatchObject({
    recipient_conversation_id: queued.conversation_id,
    steering_id: null,
  });
  const foreign = agent("other-interrupt-owner", "foreign", harness("codex"));
  const foreignRun = running("other-interrupt-owner", foreign.id, {});
  for (const conversationId of [
    source.conversation_id,
    foreignRun.conversation_id,
  ])
    expect(() =>
      sendMail(source, "invalid-" + conversationId, {
        to: recipient.id,
        body: "Wrong destination",
        interrupt: true,
        threadId: automatic.threadId,
        conversationId: conversationId!,
      }),
    ).toThrow(/bound conversation is unavailable/);
});

it.each(["completed", "paused", "awaiting_approval"] as const)(
  "uses normal routing for direct interrupts when the recipient's only task is %s",
  (state) => {
    const owner = "direct-interrupt-inactive-" + state;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex"));
    const source = running(owner, sender.id, {}),
      target = running(owner, recipient.id, {});
    if (state === "paused") transition(target, "pausing");
    transition(runOf(target.id), state);
    const sent = sendMail(source, "interrupt", {
      to: recipient.id,
      body: "Next task",
      interrupt: true,
    });
    expect(sent.delivery).toBe(state === "completed" ? "new_turn" : "queued");
    expect(mail(sent.messageId).steering_id).toBeNull();
    expect(mail(sent.messageId).recipient_conversation_id).not.toBe(
      target.conversation_id,
    );
    const reply = sendMail(source, "interrupt-reply", {
      to: recipient.id,
      body: "Same destination",
      interrupt: true,
      threadId: sent.threadId,
    });
    expect(mail(reply.messageId).recipient_conversation_id).toBe(
      mail(sent.messageId).recipient_conversation_id,
    );
  },
);

it.each(["pending", "held"])(
  "keeps an interrupt's selected destination when %s mail is released",
  (state) => {
    const owner = "direct-interrupt-" + state;
    const sender = agent(owner, "sender"),
      recipient = agent(owner, "recipient", harness("codex"));
    const source = running(owner, sender.id, {}),
      target = running(owner, recipient.id, {});
    const first = sendMail(source, "ordinary", {
      to: recipient.id,
      body: "When free",
    });
    if (state === "held")
      db.prepare("UPDATE agent_threads SET paused_at=? WHERE id=?").run(
        now(),
        first.threadId,
      );
    else
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        recipient.connection_id,
      );
    const input = {
      to: recipient.id,
      body: "For the current task",
      interrupt: true,
      threadId: first.threadId,
    };
    const accepted = sendMail(source, "interrupt", input);
    expect(accepted.delivery).toBe(state);
    expect(mail(accepted.messageId).recipient_conversation_id).toBe(
      target.conversation_id,
    );
    transition(target, "completed");
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      recipient.connection_id,
    );
    const next = running(owner, recipient.id, {});
    if (state === "held") resumeThread(owner, null, accepted.threadId);
    else sweepAgentMail(now() + 600000);
    const delivered = mail(accepted.messageId);
    expect(delivered).toMatchObject({
      state: "sent",
      delivery: "queued",
      steering_id: null,
      recipient_conversation_id: target.conversation_id,
    });
    expect(delivered.run_id).not.toBe(next.id);
    expect(sendMail(source, "interrupt", input).messageId).toBe(
      accepted.messageId,
    );
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM runs WHERE owner_id=? AND idempotency_key=?",
        )
        .get(owner, `mail:${source.id}:interrupt`),
    ).toEqual({ n: 1 });
  },
);

it("counts pair traffic across direct and team scopes, including pending messages", () => {
  const owner = "mixed-limits";
  const { manager, coder, team } = mixedTeam(owner);
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    coder.connection_id,
  );
  const sources = [0, 1, 2].map(() =>
    running(owner, manager.id, { conversationId: team.conversation_id! }),
  );
  const receipts = Array.from({ length: MAIL_LIMITS.perPairHour + 1 }, (_, i) =>
    sendMail(sources[Math.floor(i / 8)], `mixed-${i}`, {
      to: coder.id,
      body: String(i),
      scope: i % 2 ? "direct" : "team",
    }),
  );
  expect(receipts.slice(0, -1).every((r) => r.delivery === "pending")).toBe(
    true,
  );
  expect(receipts.at(-1)?.delivery).toBe("held");
});

it("preserves pending-before-held order when Resume races a reconnect", () => {
  const owner = "resume-pending";
  const a = agent(owner, "sender"),
    b = agent(owner, "recipient");
  const source = running(owner, a.id, {});
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    b.connection_id,
  );
  const first = sendMail(source, "first", { to: b.id, body: "First" });
  db.prepare(
    "UPDATE agent_threads SET paused_at=?,paused_reason='Paused' WHERE id=?",
  ).run(now(), first.threadId);
  const second = sendMail(source, "second", {
    to: b.id,
    body: "Second",
    threadId: first.threadId,
  });
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    b.connection_id,
  );
  expect(resumeThread(owner, null, first.threadId)).toEqual({
    released: 0,
    refused: 0,
    held: 1,
  });
  expect(mail(second.messageId).state).toBe("held");
  sweepAgentMail(now() + 600000);
  expect(mail(first.messageId).state).toBe("sent");
  expect(mail(second.messageId).state).toBe("held");
  expect(resumeThread(owner, null, first.threadId)).toEqual({
    released: 1,
    refused: 0,
    held: 0,
  });
  const firstRun = mail(first.messageId).run_id;
  const secondRun = mail(second.messageId).run_id;
  const claimant = (r: Run) => r.owner_id === owner && r.agent_id === b.id;
  expect(claim("after-resume", claimant)?.id).toBe(firstRun);
  transition(runOf(firstRun), "completed");
  expect(claim("after-first", claimant)?.id).toBe(secondRun);
});

it("counts sends at Resume's exact timestamp and bounds held mail and long-lived threads", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const owner = "precise-limits";
    const a = agent(owner, "sender"),
      b = agent(owner, "recipient");
    let source = running(owner, a.id, {});
    let threadId: string | undefined;
    // Advance slowly enough that the hourly pair limit does not hide the thread limit.
    for (let i = 0; i <= MAIL_LIMITS.perThread; i++) {
      if (i % MAIL_LIMITS.perRun === 0) source = running(owner, a.id, {});
      clock.mockReturnValue(now() + 240000);
      const receipt = sendMail(source, `long-${i}`, {
        to: b.id,
        body: String(i),
        threadId,
      });
      threadId = receipt.threadId;
      expect(receipt.delivery === "held").toBe(i === MAIL_LIMITS.perThread);
    }
    expect(resumeThread(owner, null, threadId!)).toEqual({
      released: 1,
      refused: 0,
      held: 0,
    });
    // Every following send and the Resume above have exactly the same timestamp.
    for (let i = 0; i < MAIL_LIMITS.perPairHour + MAIL_LIMITS.held; i++) {
      if (i % MAIL_LIMITS.perRun === 0) source = running(owner, a.id, {});
      const receipt = sendMail(source, `same-time-${i}`, {
        to: b.id,
        body: String(i),
        threadId,
      });
      expect(receipt.delivery === "held").toBe(i >= MAIL_LIMITS.perPairHour);
    }
    source = running(owner, a.id, {});
    expect(() =>
      sendMail(source, "over-held", { to: b.id, body: "Too many", threadId }),
    ).toThrow(/already holds 30/);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM agent_mail WHERE thread_id=? AND state='held'",
        )
        .get(threadId),
    ).toEqual({ n: 30 });
  } finally {
    clock.mockRestore();
  }
});

it("bounds accepted pending mail without creating orphan threads on refusal", () => {
  const owner = "pending-capacity";
  const a = agent(owner, "sender");
  const recipients = Array.from({ length: 6 }, () => agent(owner, "recipient"));
  for (const b of recipients)
    db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
      b.connection_id,
    );
  let source = running(owner, a.id, {});
  for (let i = 0; i < MAIL_LIMITS.pending; i++) {
    if (i % MAIL_LIMITS.perRun === 0) source = running(owner, a.id, {});
    const receipt = sendMail(source, `capacity-${i}`, {
      to: recipients[Math.floor(i / 20)].id,
      body: String(i),
    });
    expect(receipt.delivery).toBe("pending");
  }
  expect(() =>
    sendMail(source, "overflow", { to: recipients[5].id, body: "Too many" }),
  ).toThrow(/too much pending/);
  expect(
    db
      .prepare("SELECT count(*) n FROM agent_threads WHERE owner_id=?")
      .get(owner),
  ).toEqual({ n: 100 });
});

it.each(["pending", "stranded"])(
  "isolates malformed %s mail during the worker sweep",
  async (phase) => {
    const owner = `malformed-sweep-${phase}`;
    const pending = (owner: string) => {
      const sender = agent(owner, "sender"),
        recipient = agent(owner, "recipient");
      db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
        recipient.connection_id,
      );
      const receipt = sendMail(running(owner, sender.id, {}), "pending", {
        to: recipient.id,
        body: "Deliver after recovery",
      });
      expect(receipt.delivery).toBe("pending");
      return { receipt, recipient, sender };
    };
    let damaged: string;
    if (phase === "stranded") {
      const { manager, coder, team } = mixedTeam(owner);
      const lead = running(owner, manager.id, {
        conversationId: team.conversation_id!,
      });
      const busy = running(owner, coder.id, { teamId: team.id });
      const receipt = sendMail(lead, "unread", {
        to: coder.id,
        body: "Unread steering",
        interrupt: true,
      });
      expect(mail(receipt.messageId).steering_id).toEqual(expect.any(String));
      transition(busy, "completed");
      damaged = receipt.messageId;
    } else damaged = pending(owner).receipt.messageId;
    db.prepare("UPDATE agent_mail SET attempts='bad' WHERE id=?").run(damaged);
    const healthy = pending(owner + "-healthy");
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      healthy.recipient.connection_id,
    );
    sweepAgentMail(now() + 600000);
    expect(mail(damaged)).toMatchObject({
      state: "refused",
      attempts: "bad",
      requeued_run_id: null,
    });
    expect(mail(healthy.receipt.messageId)).toMatchObject({
      state: "sent",
      owner_id: owner + "-healthy",
      run_id: expect.any(String),
    });
    const delivered = mail(healthy.receipt.messageId).run_id;
    sweepAgentMail(now() + 1200000);
    expect(mail(healthy.receipt.messageId).run_id).toBe(delivered);
    expect(
      db
        .prepare("SELECT count(*) n FROM runs WHERE agent_id=?")
        .get(healthy.recipient.id),
    ).toEqual({ n: 1 });
    const row = mail(damaged);
    const readable = readAgentThread(owner, row.thread_id, { limit: 40 });
    expect(readable.messages.some((message) => message.id === damaged)).toBe(
      true,
    );
    const statusRun = runOf(row.sender_run_id);
    const status = await toolResult(statusRun, "loop_message_status", {
      threadId: row.thread_id,
    });
    expect(
      status.messages.some(
        (message: { messageId: string }) => message.messageId === damaged,
      ),
    ).toBe(true);
  },
);

it("does not let blocked followers starve retryable thread heads across owners", () => {
  const heads: string[] = [];
  for (let group = 0; group < 12; group++) {
    const owner = `fair-pending-${group}`;
    const a = agent(owner, "sender"),
      b = agent(owner, "recipient");
    db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
      b.connection_id,
    );
    let source = running(owner, a.id, {});
    let threadId: string | undefined;
    for (let i = 0; i < 20; i++) {
      if (i % MAIL_LIMITS.perRun === 0) source = running(owner, a.id, {});
      const receipt = sendMail(source, `waiting-${i}`, {
        to: b.id,
        body: String(i),
        threadId,
      });
      threadId = receipt.threadId;
      if (i === 0) heads.push(receipt.messageId);
    }
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      b.connection_id,
    );
  }
  // More than a sweep page of followers are due before their earlier mail.
  // They must not crowd those heads out of every later sweep.
  for (const head of heads)
    db.prepare("UPDATE agent_mail SET retry_at=? WHERE id=?").run(
      now() + 300000,
      head,
    );
  sweepAgentMail(now() + 600000);
  expect(heads.map((head) => mail(head).state)).toEqual(Array(12).fill("sent"));
});

// Three sequential races each start two real workers. Bound each child below,
// and leave room for all three races in the outer test deadline.
it("arbitrates mail claims between independent worker processes and never replays an uncertain native turn", async () => {
  const owner = "concurrent-claimers";
  const a = agent(owner, "sender"),
    b = agent(owner, "native", harness("codex"));
  const source = running(owner, a.id, {});
  const receipts = ["first", "second"].map((call) =>
    sendMail(source, call, { to: b.id, body: call }),
  );
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const race = () =>
    Promise.all(
      ["one", "two"].map(async (worker) => {
        const script = `const {claim}=await import('./src/server/queue.ts');console.log(JSON.stringify(claim(${JSON.stringify(worker)}, r=>r.owner_id===${JSON.stringify(owner)}&&r.agent_id===${JSON.stringify(b.id)})?.id??null));`;
        const { stdout } = await exec(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          {
            timeout: 5000,
            env: {
              ...process.env,
              LOOP_DATA_DIR: dir,
            },
          },
        );
        return JSON.parse(stdout.trim());
      }),
    );
  const firstRun = mail(receipts[0].messageId).run_id;
  const secondRun = mail(receipts[1].messageId).run_id;
  expect((await race()).filter(Boolean)).toEqual([firstRun]);
  transition(runOf(firstRun), "completed");
  expect((await race()).filter(Boolean)).toEqual([secondRun]);
  db.prepare(
    "INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES(?,'generation','digest','unknown',?)",
  ).run(secondRun, now());
  transition(runOf(secondRun), "interrupted");
  sweepAgentMail(now() + 600000);
  sweepAgentMail(now() + 1200000);
  expect((await race()).filter(Boolean)).toEqual([]);
  const statuses = await toolResult(source, "loop_message_status", {
    threadId: receipts[1].threadId,
  });
  expect(statuses.messages[0].status).toBe("unconfirmed");
  expect(mail(receipts[1].messageId).requeued_run_id).toBeNull();
}, 20000);

it.each(["models", "secret", "metadata"] as const)(
  "isolates damaged teammate %s from healthy turns and directory discovery",
  async (column) => {
    const owner = id(),
      { manager, coder, piWorker, team } = mixedTeam(owner);
    const lead = running(owner, manager.id, {
      conversationId: team.conversation_id!,
    });
    const bad =
      column === "models"
        ? '[{"id":"fixture","name":42}]'
        : column === "secret"
          ? "bad-envelope"
          : '{"loopHarness":false}';
    db.prepare(`UPDATE connections SET ${column}=? WHERE id=?`).run(
      bad,
      coder.connection_id,
    );
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream() {
        yield { text: "Healthy teammate still works." };
      },
    });
    try {
      expect(await executeAgent(lead)).toBe(true);
      const page = await toolResult(lead, "loop_agents", {});
      expect(page.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentId: coder.id,
            runtime: "unavailable",
            availability: "unavailable",
            reason: expect.stringContaining(coder.connection_id!),
          }),
          expect.objectContaining({
            agentId: piWorker.id,
            availability: "available",
          }),
        ]),
      );
      expect(
        await message(lead, { to: coder.id, body: "Unavailable" }),
      ).toEqual({ error: expect.stringContaining(coder.connection_id!) });
      expect(
        db
          .prepare("SELECT count(*) n FROM runs WHERE agent_id=?")
          .get(coder.id),
      ).toEqual({ n: 0 });
    } finally {
      restore();
    }
  },
);

it.each([
  ["reviewId", null],
  ["connectionId", false],
  ["maxSeconds", 0],
])(
  "delivers exactly one failure notice for a rejected background child with invalid %s",
  (field, value) => {
    const owner = id(),
      { manager, coder, team } = mixedTeam(owner);
    const lead = running(owner, manager.id, {
      conversationId: team.conversation_id!,
    });
    const child = submit(owner, {
      agentId: coder.id,
      teamId: team.id,
      input: "Background work",
      idempotencyKey: id(),
    });
    db.prepare(
      "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,'{}',1)",
    ).run(lead.id, id(), child.id);
    const payload = JSON.stringify({
      ...child.payload,
      [String(field)]: value,
    });
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(payload, child.id);
    expect(claim("reject-invalid", (r) => r.id === child.id)).toBeUndefined();
    expect(
      db
        .prepare("SELECT state,worker_id,error FROM runs WHERE id=?")
        .get(child.id),
    ).toEqual({
      state: "failed",
      worker_id: null,
      error: expect.stringContaining(child.id),
    });
    transition(lead, "completed");
    sweepAgentMail();
    sweepAgentMail(now() + 600000);
    const notices = db
      .prepare(
        "SELECT state,run_id FROM agent_mail WHERE owner_id=? AND kind='result'",
      )
      .all(owner) as { state: string; run_id: string }[];
    expect(notices).toHaveLength(1);
    expect(notices[0].state).toBe("sent");
    const notice = runOf(notices[0].run_id);
    expect(notice.conversation_id).toBe(lead.conversation_id);
    expect(notice.input).toContain(child.id);
    expect(notice.input).toContain("ended: failed");
    expect(
      db.prepare("SELECT payload FROM runs WHERE id=?").get(child.id),
    ).toEqual({ payload });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(child.id),
    ).toBeUndefined();
  },
);

it.each(["direct", "mail"])(
  "rejects malformed scalar run data in the %s queue without blocking healthy work",
  (kind) => {
    const owner = id();
    const sender = agent(owner, "sender");
    const recipient = agent(owner, "recipient");
    const healthyAgent = agent(owner, "healthy");
    const source = running(owner, sender.id, {});
    const badId =
      kind === "mail"
        ? mail(
            sendMail(source, id(), { to: recipient.id, body: "Queued mail" })
              .messageId,
          ).run_id!
        : submit(owner, {
            agentId: recipient.id,
            input: "Queued work",
            idempotencyKey: id(),
          }).id;
    const healthy = submit(owner, {
      agentId: healthyAgent.id,
      input: "Healthy work",
      idempotencyKey: id(),
    });
    db.prepare("UPDATE runs SET active_ms='invalid' WHERE id=?").run(badId);
    expect(claim("scalar-fixture", (run) => run.id === healthy.id)?.id).toBe(
      healthy.id,
    );
    expect(
      db
        .prepare("SELECT state,worker_id,error,active_ms FROM runs WHERE id=?")
        .get(badId),
    ).toEqual({
      state: "failed",
      worker_id: null,
      error: expect.stringContaining(badId),
      active_ms: 0,
    });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(badId),
    ).toBeUndefined();
  },
);
