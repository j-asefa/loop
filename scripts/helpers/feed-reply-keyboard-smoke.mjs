import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function feedReplyKeyboardSmoke(page, fixture, capture) {
  const diagnostics = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/ui/viewport-diagnostics"))
      diagnostics.push(r.status());
  });
  await page.goto(fixture.base + "/?viewportDebug=feed-reply", {
    waitUntil: "networkidle",
  });
  await page.getByRole("tab", { name: "Done", exact: true }).click();
  const card = page.locator(".inbox-card").first();
  await expect(card).toBeVisible();
  // This is the Feed card's Reply control, not a result on an agent profile
  // and not an already-open conversation. Let the app perform delayed focus.
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.locator("dialog.conversation-sheet[open]");
  const input = thread.getByRole("textbox", { name: "Reply to agent" });
  await expect(input).toBeFocused();
  for (const offsetTop of [0, 320]) {
    await page.evaluate((offsetTop) => {
      Object.defineProperty(visualViewport, "height", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(visualViewport, "offsetTop", {
        configurable: true,
        value: offsetTop,
      });
      visualViewport.dispatchEvent(new Event("resize"));
    }, offsetTop);
    await input.pressSequentially("My reply from the feed. ");
    await expect
      .poll(() =>
        thread.evaluate((el) => {
          const top = visualViewport.offsetTop,
            bottom = top + visualViewport.height;
          return [
            el,
            el.querySelector(".sheet-head"),
            el.querySelector("#composer"),
            el.querySelector(".composer-actions"),
          ].every((part) => {
            const r = part.getBoundingClientRect();
            return r.height > 0 && r.top >= top && r.bottom <= bottom + 1;
          });
        }),
      )
      .toBe(true);
    assert(
      await input.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          el ===
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        );
      }),
    );
    await capture("feed-reply-pan-" + offsetTop);
  }
  await expect.poll(() => diagnostics.length).toBeGreaterThan(0);
  assert(diagnostics.every((status) => status === 204));
  await input.blur();
  await page.evaluate(() => {
    delete visualViewport.height;
    delete visualViewport.offsetTop;
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await thread.getByRole("button", { name: "Close", exact: true }).click();
  await expect(thread).toHaveCount(0);
}
