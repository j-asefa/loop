import { expect } from "@playwright/test";

export async function feedReadingSmoke(page, fixture, capture) {
  const done = fixture.conversations.find((item) => item.state === "completed");
  const fullMessage = "A detailed result.\n\n" + "Further findings. ".repeat(350) + "\n\nEnd of the full result.";
  fixture.db.prepare("UPDATE messages SET content=? WHERE run_id=? AND role='assistant'")
    .run(fullMessage, done.run);
  const reader = page.locator("dialog.feed-reading-sheet[open]");
  const thread = page.locator("dialog.conversation-sheet[open]");
  const close = async (sheet) => {
    await sheet.locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  for (const [filter, state] of [["done", "completed"], ["working", "running"], ["queued", "queued"]]) {
    await page.setViewportSize({ width: filter === "queued" ? 320 : 390, height: 844 });
    const item = fixture.conversations.find((value) => value.state === state);
    await page.goto(`${fixture.base}/?filter=${filter}`, { waitUntil: "networkidle" });
    const card = page.locator(".inbox-results .inbox-card").filter({ hasText: item.title });
    await card.locator(".inbox-row").click();
    await expect(reader).toBeVisible();
    await expect(thread).toHaveCount(0);
    await expect(reader.locator(".result-identity")).toBeVisible();
    await expect(reader.locator(".result-title")).toHaveText(item.title);
    await expect.poll(() => reader.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (filter === "done")
      await expect(reader.locator(".artifact-body")).toContainText("End of the full result.");
    await reader.locator(".result-content").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(reader.getByRole("button", { name: "Reply", exact: true })).toBeInViewport();
    await capture(`feed-reading-${filter}`);
    await reader.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(reader).toHaveCount(0);
    await expect(thread).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("conversation")).toBe(item.id);
    await expect(thread.getByRole("textbox", { name: "Reply to agent" })).toBeFocused();
    await close(thread);
    // Keyboard opening and closing returns to the same feed filter.
    await card.locator(".inbox-row").focus();
    await page.keyboard.press("Enter");
    await expect(reader).toBeVisible();
    await close(reader);
    await expect(card).toBeVisible();
  }
  await page.goto(`${fixture.base}/?filter=done`, { waitUntil: "networkidle" });
  await page.route("**/api/messages/*", (route) =>
    route.fulfill({ status: 503, json: { error: "Fixture message unavailable" } }),
  );
  await page.locator(".inbox-results .inbox-row").filter({ hasText: done.title }).click();
  await expect(reader.getByRole("alert")).toContainText("Couldn’t load the full message");
  await reader.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(thread).toBeVisible();
  await expect(reader).toHaveCount(0);
}
