import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function replyKeyboardSmoke(page, fixture, capture) {
  const sheet = () => page.locator("dialog[open]").last();
  const composer = () => page.locator(".composer");
  const close = () =>
    composer()
      .getByRole("button", { name: "Collapse composer", exact: true })
      .click();
  const resetViewport = () =>
    page.evaluate(() => {
      delete window.visualViewport.height;
      delete window.visualViewport.offsetTop;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
  try {
    for (const kind of ["result", "message"]) {
      await page.setViewportSize({ width: 390, height: 844 });
      if (kind === "message") {
        await page.goto(
          fixture.base + "/?conversation=" + fixture.conversations[0].id,
          { waitUntil: "networkidle" },
        );
        await sheet().locator(".conversation-agent").click();
        await page
          .getByRole("button", { name: "Messages", exact: true })
          .click();
        await page
          .locator(".agent-message-actions")
          .first()
          .getByRole("button", { name: "Reply", exact: true })
          .click();
      } else {
        await page.goto(fixture.base, { waitUntil: "networkidle" });
        await page
          .locator(".feed-card")
          .first()
          .getByRole("button", { name: "Reply", exact: true })
          .click();
      }
      const input = composer().getByRole("textbox", { name: "Reply to agent" });
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await input.fill("Everything runs locally. Can you clarify this part?");
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const offsetTop of [0, 370]) {
          // iOS keeps the layout viewport tall while the keyboard shrinks and
          // pans the visual viewport. Resizing the browser alone misses this.
          await page.evaluate((offsetTop) => {
            Object.defineProperty(window.visualViewport, "height", {
              configurable: true,
              value: 430,
            });
            Object.defineProperty(window.visualViewport, "offsetTop", {
              configurable: true,
              value: offsetTop,
            });
            window.visualViewport.dispatchEvent(new Event("resize"));
            window.visualViewport.dispatchEvent(new Event("scroll"));
          }, offsetTop);
          await input.press("End");
          await input.press("!");
          await expect
            .poll(() =>
              composer().evaluate((dialog) => {
                const v = window.visualViewport;
                const top = v.offsetTop;
                const bottom = top + v.height;
                const content = dialog.querySelector(".composer-quote");
                const within = (element) => {
                  const r = element.getBoundingClientRect();
                  return r.top >= top && r.bottom <= bottom && r.height > 0;
                };
                const original = content.querySelector(
                  ".markdown > :first-child",
                );
                return (
                  within(dialog.querySelector(".composer-heading")) &&
                  within(dialog.querySelector(".composer-main")) &&
                  within(content) &&
                  content.clientHeight >= 60 &&
                  within(original) &&
                  original.getBoundingClientRect().bottom <=
                    content.getBoundingClientRect().bottom
                );
              }),
            )
            .toBe(true);
          await expect(input).toBeFocused();
          await capture(`reply-${kind}-keyboard-${width}-${offsetTop}`);
        }
      }
      // The whole original message remains independently scrollable while the
      // keyboard is open; scrolling it must not move the author or composer.
      const headerBefore = await composer()
        .locator(".composer-heading")
        .boundingBox();
      const replyBefore = await input.boundingBox();
      await composer()
        .locator(".composer-quote")
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      assert(
        await composer()
          .locator(".composer-quote")
          .evaluate((el) => el.scrollTop > 0),
        "The complete original message can be read while replying",
      );
      assert.equal(
        (await composer().locator(".composer-heading").boundingBox()).y,
        headerBefore.y,
      );
      assert.equal((await input.boundingBox()).y, replyBefore.y);
      const draft = await input.inputValue();
      await input.blur();
      await expect(page.locator(".mobile-nav")).toBeVisible();
      await resetViewport();
      await expect(input).toHaveValue(draft);
      await input.fill("");
      await composer()
        .getByRole("button", { name: "Clear reply context" })
        .click();
      await close();
    }
  } finally {
    await resetViewport();
    await page.setViewportSize({ width: 390, height: 844 });
  }
}
