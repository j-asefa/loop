import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function cardRemindersSmoke(page, fixture, _engine, capture) {
  const { db, owner } = fixture;
  const target = fixture.conversations.find(
    (item) => item.state === "completed",
  );
  const firstTitle = "Review the first result";
  const firstBody = "Keep this exact result for later.";
  const secondTitle = "Review the follow-up result";
  const secondBody = "This follow-up has its own reminder.";
  const firstMessage = db
    .prepare(
      "SELECT id FROM messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(target.run).id;
  db.prepare("UPDATE runs SET input=? WHERE id=?").run(firstTitle, target.run);
  db.prepare("UPDATE messages SET content=? WHERE id=?").run(
    firstBody,
    firstMessage,
  );

  const dialog = () => page.locator("dialog[open]").last();
  const card = (title) =>
    page.locator(".feed-results .feed-item-card").filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
  const settled = async () => {
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const dismissToast = async () => {
    const toast = page.locator(".action-toast");
    if (await toast.count())
      await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
  };
  const setReminder = async (title, menu = false) => {
    if (menu) {
      await card(title)
        .getByRole("button", { name: "Thread actions", exact: true })
        .click();
      await dialog()
        .getByRole("menuitem", { name: "Remind me", exact: true })
        .click();
    } else {
      await card(title)
        .getByRole("button", { name: "Remind me", exact: true })
        .click();
    }
    await expect(dialog()).toHaveAttribute("aria-label", "Remind me");
    await dialog()
      .getByRole("button", { name: /^In an hour/ })
      .click();
    await expect(page.locator(".action-toast")).toContainText("Reminder set:");
    await dismissToast();
    await settled();
  };
  await page.goto(fixture.base + "/?filter=done", { waitUntil: "networkidle" });
  await setReminder(firstTitle);
  const first = (await fixture.api("/later")).upcoming.find(
    (item) => item.target_id === firstMessage,
  );
  assert(first, "The Feed reminder targets its selected message");
  assert.equal(first.kind, "message");

  // The thread gets another result and a new title after the first reminder.
  const secondRun = randomUUID(),
    secondMessage = randomUUID(),
    at = Date.now();
  db.prepare(
    `
    INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
    SELECT ?,owner_id,agent_id,conversation_id,?,'completed',?,payload,?,? FROM runs WHERE id=?
  `,
  ).run(secondRun, secondTitle, secondRun, at, at, target.run);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,?)",
  ).run(secondMessage, owner, target.id, secondRun, secondBody, at + 1);
  db.prepare("UPDATE conversations SET title=? WHERE id=?").run(
    "The thread has moved on",
    target.id,
  );
  await page.reload({ waitUntil: "networkidle" });
  await expect(card(firstTitle)).toContainText(firstBody);
  await setReminder(secondTitle, true);
  const reminders = (await fixture.api("/later")).upcoming.filter(
    (item) => item.conversation_id === target.id,
  );
  assert.equal(
    reminders.length,
    2,
    "Cards in one thread keep independent reminders",
  );
  assert.deepEqual(
    reminders.map((item) => item.target_id).sort(),
    [firstMessage, secondMessage].sort(),
  );
  assert.equal(
    reminders.find((item) => item.target_id === firstMessage).id,
    first.id,
  );

  await page.goto(fixture.base + "/?page=profile&profileTab=reminders", {
    waitUntil: "networkidle",
  });
  const reminder = (title) =>
    page.locator(".later-card").filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
  await expect(reminder(firstTitle)).toContainText(firstBody);
  await expect(reminder(firstTitle)).not.toContainText(secondBody);
  await expect(reminder(secondTitle)).toContainText(secondBody);
  await capture("card-reminders");
  await reminder(firstTitle)
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`message=${firstMessage}`));
  await expect(page.locator(`#message-${firstMessage}`)).toBeFocused();
  await dialog()
    .locator(":scope > .sheet-inner > .sheet-head")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await settled();
  await reminder(firstTitle)
    .getByRole("button", {
      name: `Cancel reminder for ${firstTitle}`,
      exact: true,
    })
    .click();
  await expect(reminder(firstTitle)).toHaveCount(0);
  await expect(reminder(secondTitle)).toHaveCount(1);
  await page
    .locator(".action-toast")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect(reminder(firstTitle)).toHaveCount(1);
  const restored = (await fixture.api("/later")).upcoming.find(
    (item) => item.id === first.id,
  );
  assert.equal(restored.target_id, firstMessage);

  // This change targets finished cards; active work keeps thread reminders.
  const working = fixture.conversations.find(
    (item) => item.state === "running",
  );
  await page.goto(fixture.base + "/?filter=working", {
    waitUntil: "networkidle",
  });
  await setReminder(working.title);
  const activeReminder = (await fixture.api("/later")).upcoming.find(
    (item) => item.conversation_id === working.id,
  );
  assert.equal(activeReminder.kind, "conversation");
  assert.equal(activeReminder.target_id, working.id);
}
