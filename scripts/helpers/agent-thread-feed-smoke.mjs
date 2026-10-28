import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function agentThreadFeedSmoke(page, fixture, _engine, capture) {
  const { db, owner } = fixture;
  const sender = fixture.conversations.find(
    (item) => item.state === "completed",
  );
  const target = fixture.conversations.find((item) => item.state === "running");
  assert.ok(sender && target);
  const senderAgent = db
    .prepare("SELECT agent_id FROM conversations WHERE id=?")
    .get(sender.id).agent_id;
  const targetAgent = db
    .prepare("SELECT agent_id FROM conversations WHERE id=?")
    .get(target.id).agent_id;
  assert.notEqual(senderAgent, targetAgent);
  db.prepare(
    "UPDATE agents SET name='basil',normalized_name='basil' WHERE id=?",
  ).run(senderAgent);
  db.prepare(
    "UPDATE agents SET name='willow',normalized_name='willow' WHERE id=?",
  ).run(targetAgent);
  const first = randomUUID(),
    separate = randomUUID(),
    waiting = randomUUID(),
    hiddenTeam = randomUUID();
  const time = Date.now() + 1000;
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,hide_results_from_feed,created_at) VALUES(?,?,'Hidden exchange team',?,1,?)",
  ).run(hiddenTeam, owner, senderAgent, time);
  const thread = (id, title) =>
    db
      .prepare(
        "INSERT INTO agent_threads(id,owner_id,scope,subject,created_by,created_at,updated_at) VALUES(?,?,'direct',?,?,?,?)",
      )
      .run(id, owner, title, senderAgent, time, time);
  const message = (
    id,
    threadId,
    body,
    at,
    { reply = false, state = "sent" } = {},
  ) =>
    db
      .prepare(
        `
    INSERT INTO agent_mail(id,owner_id,thread_id,kind,sender_agent_id,sender_run_id,sender_conversation_id,recipient_agent_id,recipient_conversation_id,body,interrupt,idempotency_key,request,state,delivery,run_id,created_at)
    VALUES(?,?,?,'message',?,?,?,?,?,?,1,?,'{}',?,'steered',?,?)
  `,
      )
      .run(
        id,
        owner,
        threadId,
        reply ? targetAgent : senderAgent,
        reply ? target.run : sender.run,
        reply ? target.id : sender.id,
        reply ? senderAgent : targetAgent,
        reply ? sender.id : target.id,
        body,
        id,
        state,
        reply ? sender.run : target.run,
        at,
      );
  thread(first, "Navigation review");
  thread(separate, "Build question");
  thread(waiting, "Waiting exchange");
  const question = randomUUID(),
    answer = randomUUID();
  const full =
    "Can we keep the navigation review together?\n\n" +
    "Only the messages in this exchange belong here. ".repeat(80) +
    "\n\nEND OF QUESTION";
  message(question, first, full, time);
  message(
    answer,
    first,
    "Yes. The review can stay in one thread while my other work continues.",
    time + 1,
    { reply: true },
  );
  message(
    randomUUID(),
    separate,
    "A separate build question delivered into the same running task.",
    time + 2,
  );
  message(randomUUID(), waiting, "Waiting for availability", time + 3, {
    state: "pending",
  });
  const incoming = randomUUID();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user','Mail delivered into existing work',?,?)",
  ).run(
    incoming,
    owner,
    target.id,
    target.run,
    JSON.stringify({
      automation: {
        kind: "agent_message",
        mailId: question,
        threadId: first,
        fromName: "basil",
        fromAgentId: senderAgent,
      },
    }),
    time,
  );
  const unrelated = randomUUID();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','UNRELATED WORK BEFORE THE EXCHANGE',?)",
  ).run(unrelated, owner, target.id, target.run, time - 100);
  const mailCard = (id) => page.locator(`[data-agent-thread="${id}"]`);
  const reader = page.locator("dialog.agent-thread-sheet[open]");
  const close = async (sheet) => {
    await sheet
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(sheet).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  let sends = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(runs|agents\/[^/]+\/messages)$/.test(
        new URL(request.url()).pathname,
      )
    )
      sends++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await expect(mailCard(first)).toContainText("Agent thread · 2 messages");
  await expect(mailCard(separate)).toHaveCount(1);
  await expect(mailCard(waiting)).toHaveCount(0);
  await mailCard(first).scrollIntoViewIfNeeded();
  await capture("automatic-exchange-card");
  await mailCard(first)
    .getByRole("button", { name: "Open thread", exact: true })
    .click();
  await expect(reader.locator(".agent-thread-message")).toHaveCount(2);
  await expect(reader).toContainText("END OF QUESTION");
  await expect(reader).not.toContainText("UNRELATED WORK");
  await expect(reader).not.toContainText("A separate build question");
  await capture("automatic-exchange-reader");

  // A new mail record updates the open reader through workspace invalidation.
  const followUp = randomUUID();
  message(followUp, first, "The navigation review is now complete.", time + 10);
  await expect(reader.locator(".agent-thread-message")).toHaveCount(3);
  await expect(reader).toContainText("The navigation review is now complete.");
  const expectDelivery = async (label) => {
    await expect(mailCard(first).locator(".field-hint")).toContainText(label);
    await expect(
      reader.locator(`[data-mail-id="${followUp}"] > .field-hint`),
    ).toHaveText(label);
  };
  await expectDelivery("Being read");
  const mailRows = () =>
    db
      .prepare("SELECT * FROM agent_mail WHERE thread_id=? ORDER BY id")
      .all(first);
  const beforeRunChanges = mailRows();
  // Only run rows change: neither an additional mail event nor reopening the
  // reader is required to update the card and its individual message statuses.
  db.prepare("UPDATE runs SET state='queued',updated_at=? WHERE id=?").run(
    time + 11,
    target.run,
  );
  await expectDelivery("Queued");
  db.prepare("UPDATE runs SET state='running',updated_at=? WHERE id=?").run(
    time + 12,
    target.run,
  );
  await expectDelivery("Being read");
  assert.deepEqual(mailRows(), beforeRunChanges);

  const steering = randomUUID(),
    steeredMessage = randomUUID();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user','Follow-up delivered mid-task',?,?)",
  ).run(
    steeredMessage,
    owner,
    target.id,
    target.run,
    JSON.stringify({ automation: { mailId: followUp, threadId: first } }),
    time + 13,
  );
  db.prepare(
    "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,state,created_at) VALUES(?,?,?,?,?,'{}','sending',?)",
  ).run(steering, owner, target.run, steeredMessage, steering, time + 13);
  db.prepare("UPDATE agent_mail SET steering_id=? WHERE id=?").run(
    steering,
    followUp,
  );
  await expectDelivery("Waiting to be read mid-task");
  const beforeSteeringChanges = mailRows();
  db.prepare("UPDATE run_steering SET state='delivered' WHERE id=?").run(
    steering,
  );
  await expectDelivery("Read mid-task");
  db.prepare("UPDATE run_steering SET state='failed' WHERE id=?").run(steering);
  await expectDelivery("Delivery unconfirmed, not resent");
  assert.deepEqual(mailRows(), beforeSteeringChanges);
  db.prepare("UPDATE agent_mail SET steering_id=NULL WHERE id=?").run(followUp);
  await expectDelivery("Being read");
  // Completing the interrupted run must not attach its unrelated final result.
  db.prepare(
    "UPDATE runs SET state='completed',input='Unrelated task result',updated_at=? WHERE id=?",
  ).run(time + 20, target.run);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','UNRELATED FINAL ANSWER',?)",
  ).run(randomUUID(), owner, target.id, target.run, time + 20);
  await expectDelivery("Handled");
  await expect(reader.locator(".agent-thread-message")).toHaveCount(3);
  await expect(reader).not.toContainText("UNRELATED FINAL ANSWER");
  await close(reader);
  await expect(mailCard(first)).toContainText("3 messages");
  await expect(
    page.locator(".inbox-results .inbox-card").filter({
      has: page.getByRole("heading", {
        name: "Unrelated task result",
        exact: true,
      }),
    }),
  ).toHaveCount(1);

  // Failed reads preserve native cards and recover without submitting work.
  const fail = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unavailable" }),
    });
  await page.route("**/api/feed/agent-threads?**", fail);
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("button", { name: "Retry agent threads" }),
  ).toBeVisible({ timeout: 12000 });
  await page.getByRole("button", { name: "Retry agent threads" }).click();
  await page.unroute("**/api/feed/agent-threads?**", fail);
  await expect(mailCard(first)).toContainText("3 messages", { timeout: 12000 });

  const filters = page.getByRole("tablist", { name: "Show", exact: true });
  await filters.getByRole("tab", { name: "Threads", exact: true }).click();
  await expect(mailCard(first)).toHaveCount(1);
  await expect(mailCard(separate)).toHaveCount(1);
  await expect(mailCard(waiting)).toHaveCount(1);
  await mailCard(separate)
    .getByRole("button", { name: "Open thread", exact: true })
    .click();
  await expect(reader.locator(".agent-thread-message")).toHaveCount(1);
  await expect(reader).toContainText("A separate build question");
  await expect(reader).not.toContainText("END OF QUESTION");
  await close(reader);

  // Direct exchanges follow their conversation teams, including live changes
  // that emit feed events without touching mail. A public context keeps a mixed
  // exchange visible; toggling the team's preference is also reflected live.
  const contexts = db
    .prepare("SELECT id,team_id FROM conversations WHERE id IN (?,?)")
    .all(sender.id, target.id);
  db.prepare("UPDATE conversations SET team_id=? WHERE id IN (?,?)").run(
    hiddenTeam,
    sender.id,
    target.id,
  );
  await expect(page.locator("[data-agent-thread]")).toHaveCount(0);
  db.prepare("UPDATE teams SET hide_results_from_feed=0 WHERE id=?").run(
    hiddenTeam,
  );
  await expect(page.locator("[data-agent-thread]")).toHaveCount(3);
  db.prepare("UPDATE teams SET hide_results_from_feed=1 WHERE id=?").run(
    hiddenTeam,
  );
  await expect(page.locator("[data-agent-thread]")).toHaveCount(0);
  db.prepare("UPDATE conversations SET team_id=NULL WHERE id=?").run(target.id);
  await expect(page.locator("[data-agent-thread]")).toHaveCount(3);
  for (const context of contexts)
    db.prepare("UPDATE conversations SET team_id=? WHERE id=?").run(
      context.team_id,
      context.id,
    );

  // Both message and thread pagination retain exact identities, including ties.
  for (let index = 0; index < 42; index++) {
    message(randomUUID(), first, `Linked history ${index}`, time + 30 + index);
    const id = randomUUID();
    thread(id, `Earlier exchange ${index}`);
    message(
      randomUUID(),
      id,
      "Another independent exchange",
      time - 1000 - index,
    );
  }
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("[data-agent-thread]")).toHaveCount(40);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator("[data-agent-thread]")).toHaveCount(45);
  await expect(mailCard(first)).toHaveCount(1);
  await mailCard(first)
    .getByRole("button", { name: "Open thread", exact: true })
    .click();
  await expect(reader.locator(".agent-thread-message")).toHaveCount(40);
  await reader
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(reader.locator(".agent-thread-message")).toHaveCount(45);
  await expect(reader.locator(".agent-thread-message").first()).toContainText(
    "END OF QUESTION",
  );
  await expect(reader).not.toContainText("UNRELATED");
  const finalReply = randomUUID();
  message(finalReply, first, "Reply after loading history", time + 100);
  await expect(reader.locator(".agent-thread-message")).toHaveCount(46);
  await expect(reader.locator(".agent-thread-message").first()).toContainText(
    "END OF QUESTION",
  );
  await reader
    .locator(`[data-mail-id="${question}"]`)
    .getByRole("button", { name: "Open original conversation" })
    .click();
  await expect(page.locator("dialog.conversation-sheet[open]")).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("conversation"))
    .toBe(target.id);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("message"))
    .toBe(incoming);
  assert.equal(
    sends,
    0,
    "Reading and grouping mail never submits new agent work",
  );
}
