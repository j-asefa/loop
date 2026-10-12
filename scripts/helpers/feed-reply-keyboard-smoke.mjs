import assert from "node:assert/strict";
import { mockViewportCoordinates } from "./mock-viewport.mjs";
import { expect } from "@playwright/test";

export async function feedReplyKeyboardSmoke(page, fixture, capture) {
  await mockViewportCoordinates(page);
  const diagnostics = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/ui/viewport-diagnostics"))
      diagnostics.push(r.status());
  });
  await page.goto(fixture.base + "/?viewportDebug=feed-reply", {
    waitUntil: "networkidle",
  });
  await page.getByRole("tab", { name: "Done", exact: true }).click();
  // Done cards are separate from the collapsed Needs-you stack above them.
  const card = page.locator(".inbox-results .inbox-card").first();
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
  // Captured from physical Safari after Feed -> Reply: pageTop and scrollY
  // are both 337, but offsetTop incorrectly repeats 337. The visible browser
  // is only 362px tall. Model the modal origin shift with real CSS geometry.
  await page.setViewportSize({ width: 390, height: 362 });
  await page.evaluate(() => {
    window.__savedScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 337,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 699,
    });
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: 362,
    });
    Object.defineProperty(visualViewport, "offsetTop", {
      configurable: true,
      value: 337,
    });
    Object.defineProperty(visualViewport, "pageTop", {
      configurable: true,
      value: 337,
    });
    document.querySelector("dialog.conversation-sheet").style.marginTop =
      "-337px";
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(
      () =>
        thread.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const input = el.querySelector("#composer"),
            field = input.getBoundingClientRect();
          return (
            r.top >= 7 &&
            r.top <= 9 &&
            r.bottom <= 362 &&
            field.top >= r.top &&
            field.bottom <= 362 &&
            document.elementFromPoint(
              field.x + field.width / 2,
              field.y + field.height / 2,
            ) === input
          );
        }),
      {
        message:
          "The physical Safari capture must keep Feed Reply inside the actual 362px screen",
      },
    )
    .toBe(true);
  await capture("feed-reply-physical-safari");
  await page.evaluate(() => {
    Object.defineProperty(window, "scrollY", window.__savedScrollY);
    delete window.__savedScrollY;
    delete document.documentElement.clientHeight;
    delete visualViewport.pageTop;
    document
      .querySelector("dialog.conversation-sheet")
      .style.removeProperty("margin-top");
  });
  await input.blur();
  await page.evaluate(() => {
    delete visualViewport.height;
    delete visualViewport.offsetTop;
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await thread.getByRole("button", { name: "Close", exact: true }).click();
  await expect(thread).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
}
