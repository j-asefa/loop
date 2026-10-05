import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { designFixture } from "./design-fixture.mjs";

// Exercise the production thread with content wider than a phone and with
// failed searches. Page overflow alone misses clipping inside modal sheets.
export async function threadLayoutSmoke(page, capture) {
  const fixture = await designFixture();
  try {
    const id = fixture.conversations[0].id;
    const first = fixture.db
      .prepare(
        "SELECT id FROM messages WHERE conversation_id=? ORDER BY created_at LIMIT 1",
      )
      .get(id).id;
    const position = fixture.db.prepare(
      "INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,conversation_id) DO UPDATE SET position_message_id=excluded.position_message_id",
    );
    const outline = page.locator("dialog.outline-sheet[open]");
    const status = outline.locator(".outline-status");
    const search = outline.getByLabel("Search this thread");
    const longQuery = "averylongquery".repeat(10);
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      for (const [width, height] of [
        [320, 568],
        [390, 844],
        [768, 600],
      ]) {
        await page.setViewportSize({ width, height });
        position.run(fixture.owner, id, first, Date.now());
        await page.goto(`${fixture.base}/?conversation=${id}`);
        const pill = page.getByRole("group", { name: "Thread position" });
        await expect(
          pill.getByText("Resumed where you left off"),
        ).toBeVisible();
        const bounds = await pill.evaluate((element) => {
          const outer = element.getBoundingClientRect();
          return [...element.children].every((child) => {
            const box = child.getBoundingClientRect();
            return (
              box.left >= outer.left &&
              box.right <= outer.right &&
              box.top >= outer.top &&
              box.bottom <= outer.bottom
            );
          });
        });
        assert(bounds, `Reading controls escape their pill at ${width}px`);
        await capture(`thread-resumed-${colorScheme}-${width}`);
        await pill
          .getByRole("button", { name: "Jump to latest messages" })
          .click();
        await page
          .getByRole("button", { name: "Jump to…", exact: true })
          .click();
        await search.fill(longQuery);
        await expect(status).toHaveText(`0 matches for “${longQuery}”`);
        const body = outline.locator(".sheet-body");
        assert(
          await body.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
          `Long search text widens the sheet at ${width}px`,
        );
        await capture(`thread-search-${colorScheme}-${width}`);
        await search.fill("Review");
        await expect(status).toHaveText("2 matches for “Review”");
        await expect(outline.locator(".outline-list li")).toHaveCount(2);

        if (width === 320 && colorScheme === "light") {
          await page.route(
            `**/api/conversations/${id}/outline?q=unavailable`,
            (route) =>
              route.fulfill({
                status: 503,
                json: { error: "Search temporarily unavailable" },
              }),
            { times: 1 },
          );
          await search.fill("unavailable");
          await expect(outline.getByRole("alert")).toHaveText(
            "Search temporarily unavailable",
          );
          await expect(status).toHaveText("Search unavailable");
          await expect(outline.locator(".outline-list li")).toHaveCount(0);
          await expect(
            outline.getByRole("group", { name: "Show" }),
          ).toHaveCount(0);
          await outline.getByRole("button", { name: "Try again" }).click();
          await expect(status).toHaveText("0 matches for “unavailable”");
          await expect(outline.getByRole("alert")).toHaveCount(0);
          await search.fill("x".repeat(240));
          await expect(search).toHaveValue("x".repeat(200));
          await expect(status).toHaveText(`0 matches for “${"x".repeat(200)}”`);
          await expect(outline.getByRole("alert")).toHaveCount(0);
          await search.fill("");
          await expect(status).toHaveText("Showing everything · 2");
        }
      }
    }
    console.log(
      "Thread search bounds, failure recovery, plural counts and reading controls passed in both themes at 320/390/768px",
    );
  } finally {
    await page.goto("about:blank");
    await page.emulateMedia({ colorScheme: "light" });
    await fixture.close();
  }
}
