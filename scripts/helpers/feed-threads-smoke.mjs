import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function feedThreadsSmoke(page, fixture, capture) {
  const target = fixture.conversations.find(
    (item) => item.state === "completed",
  );
  const latestRun = randomUUID();
  const latestTitle = "Review the follow-up changes";
  const latestAnswer =
    "Latest findings.\n\n" +
    "More detail.\n\n".repeat(150) +
    "End of the latest answer.";
  const at = Date.now();
  fixture.db
    .prepare(
      `
    INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
    SELECT ?,owner_id,agent_id,conversation_id,?,'completed',?,payload,?,?
    FROM runs WHERE id=?
  `,
    )
    .run(latestRun, latestTitle, latestRun, at, at, target.run);
  const insertMessage = fixture.db.prepare(`
    INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at)
    VALUES(?,?,?,?,?,?,?)
  `);
  insertMessage.run(
    randomUUID(),
    fixture.owner,
    target.id,
    latestRun,
    "user",
    latestTitle,
    at,
  );
  insertMessage.run(
    randomUUID(),
    fixture.owner,
    target.id,
    latestRun,
    "assistant",
    latestAnswer,
    at + 1,
  );

  const filters = page.getByRole("tablist", { name: "Show", exact: true });
  const threads = filters.getByRole("tab", { name: "Threads", exact: true });
  const cards = page.locator(".feed-results .feed-item-card");
  const titles = cards.locator(".feed-row > h2");
  const reader = page.locator("dialog.feed-reading-sheet[open]");
  const thread = page.locator("dialog.conversation-sheet[open]");
  const close = async (sheet) => {
    await sheet
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await expect(
    filters.getByRole("tab", { name: "Done", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(titles).toContainText([latestTitle, target.title]);
  await threads.click();
  await expect(threads).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("filter"))
    .toBe("threads");
  await expect(cards).toHaveCount(fixture.conversations.length);
  await expect(titles.first()).toHaveText(latestTitle);
  await expect(titles).not.toContainText([target.title]);
  for (const item of fixture.conversations.filter(
    (item) => item.id !== target.id,
  ))
    await expect(titles.filter({ hasText: item.title })).toHaveCount(1);

  // The full row fits even with Working and Queued counters on a narrow phone.
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await filters.evaluate((el) => el.scrollWidth <= el.clientWidth),
      `Feed tabs fit a ${width}px viewport`,
    );
    await capture(`threads-${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await expect(threads).toHaveAttribute("aria-selected", "true");
  await expect(cards).toHaveCount(fixture.conversations.length);

  // Card reading and Reply keep the selected thread and filter.
  await cards.first().locator(".feed-row").focus();
  await page.keyboard.press("Enter");
  await expect(reader).toBeVisible();
  await expect(reader.locator(".artifact-body")).toContainText(
    "End of the latest answer.",
  );
  await reader.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("conversation"))
    .toBe(target.id);
  await expect(
    thread.getByRole("textbox", { name: "Reply to agent" }),
  ).toBeFocused();
  await close(thread);
  await expect(threads).toHaveAttribute("aria-selected", "true");

  // A run that stops before answering still shows your prompt as yours.
  // Open its conversation instead of presenting it as an agent result.
  const stopped = fixture.conversations.find((item) => item.state === "failed");
  fixture.db
    .prepare("DELETE FROM messages WHERE run_id=? AND role='assistant'")
    .run(stopped.run);
  for (const state of ["failed", "interrupted"]) {
    fixture.db
      .prepare("UPDATE runs SET state=? WHERE id=?")
      .run(state, stopped.run);
    await page.reload({ waitUntil: "networkidle" });
    const stoppedCard = cards.filter({
      has: page.getByRole("heading", { name: stopped.title, exact: true }),
    });
    await expect(stoppedCard.locator(".feed-you")).toHaveText("You");
    await stoppedCard
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader).toHaveCount(0);
    await expect(thread).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(stopped.id);
    await expect(thread.locator(".message.user")).toContainText(stopped.title);
    await close(thread);
    await expect(threads).toHaveAttribute("aria-selected", "true");
  }

  // Dismissing a historical result in Done does not remove its thread.
  await fixture.api(
    `/feed/${target.id}`,
    { hidden: true, cardKey: "run:" + latestRun },
    "PATCH",
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-source-refresh")),
  );
  await expect(titles.first()).toHaveText(latestTitle);

  // Load older threads through the real paginated API. A changed thread moves
  // to the front once, while loaded history and the reading position survive.
  const history = Array.from({ length: 90 }, (_, index) => ({
    id: randomUUID(),
    title: `Older thread ${String(index).padStart(2, "0")}`,
  }));
  const insertConversation = fixture.db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)",
  );
  fixture.db.transaction(() => {
    for (const [index, item] of history.entries()) {
      const created = at - (100 + index) * 3_600_000;
      insertConversation.run(item.id, fixture.owner, item.title, created);
      insertMessage.run(
        randomUUID(),
        fixture.owner,
        item.id,
        null,
        "assistant",
        `Result for ${item.title}`,
        created,
      );
    }
  })();
  await page.reload({ waitUntil: "networkidle" });
  await expect(cards).toHaveCount(40);
  const more = page.getByRole("button", { name: "Load more", exact: true });
  await more.click();
  await expect(cards).toHaveCount(80);
  const retainedTitle = await titles.last().innerText();
  await cards.nth(65).scrollIntoViewIfNeeded();
  const position = await page.evaluate(() => scrollY);
  const changed = history[50];
  insertMessage.run(
    randomUUID(),
    fixture.owner,
    changed.id,
    null,
    "assistant",
    "A fresh answer in an older thread",
    Date.now(),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-source-refresh")),
  );
  await expect(titles.first()).toHaveText(changed.title);
  await expect(cards.first().locator(".preview")).toContainText(
    "A fresh answer in an older thread",
  );
  await expect(cards).toHaveCount(80);
  await expect(titles.last()).toHaveText(retainedTitle);
  await expect(titles.filter({ hasText: changed.title })).toHaveCount(1);
  // Scroll anchoring may adjust for the reordered card; it must stay in history.
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(position / 2);
  await more.click();
  await expect(cards).toHaveCount(
    history.length + fixture.conversations.length,
  );
  await expect(more).toHaveCount(0);
  expect(new Set(await titles.allTextContents()).size).toBe(
    history.length + fixture.conversations.length,
  );
  await cards.last().locator(".feed-row").click();
  await expect(reader).toBeVisible();
  await close(reader);
  await expect(cards).toHaveCount(
    history.length + fixture.conversations.length,
  );

  // Bounded refreshes reconcile snoozed/deleted rows in deeper loaded pages.
  const removed = history[85],
    snoozed = history[86];
  fixture.db.prepare("DELETE FROM conversations WHERE id=?").run(removed.id);
  await fixture.api("/later", {
    kind: "conversation",
    targetId: snoozed.id,
    condition: "time",
    dueAt: Date.now() + 3_600_000,
  });
  await expect
    .poll(
      async () => {
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-source-refresh")),
        );
        return cards.count();
      },
      { intervals: [300, 500], timeout: 8000 },
    )
    .toBe(history.length + fixture.conversations.length - 2);
  await expect(titles.filter({ hasText: removed.title })).toHaveCount(0);
  await expect(titles.filter({ hasText: snoozed.title })).toHaveCount(0);
}
