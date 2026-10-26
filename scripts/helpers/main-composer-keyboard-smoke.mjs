import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openAgentProfile } from "./browser-ui.mjs";

export async function mainComposerKeyboardSmoke(page, fixture, capture) {
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await openAgentProfile(page, fixture.agents[0].name);
  await page
    .locator(".profile-actions")
    .getByRole("button", { name: "Message", exact: true })
    .click();
  const dock = page.locator(".composer-dock:not(.thread-mode)");
  const input = dock.getByLabel("Message your agent", { exact: true });
  await input.fill("Keep my attached draft visible.");
  await dock.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "mobile-screenshot.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("fixture attachment"),
  });
  const files = dock.getByRole("list", { name: "Attached files" });
  await expect(files).toContainText("mobile-screenshot.txt");
  await dock
    .getByRole("button", { name: "Clear message", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(files).toContainText("mobile-screenshot.txt");
  await expect(
    dock.getByRole("button", { name: "Clear message", exact: true }),
  ).toHaveCount(0);
  await input.fill("Keep my attached draft visible.");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await input.focus();
    // The keyboard reduces the visible area, while Safari retains a taller
    // layout viewport and moves the fixed element's origin independently.
    await page.evaluate(() => {
      window.__composerScroll = Object.getOwnPropertyDescriptor(
        window,
        "scrollY",
      );
      Object.defineProperty(window, "scrollY", {
        configurable: true,
        value: 337,
      });
      Object.defineProperty(document.documentElement, "clientHeight", {
        configurable: true,
        value: 844,
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
      document.querySelector(".composer-dock").style.marginTop = "-337px";
    });
    await page.setViewportSize({ width, height: 362 });
    await page.evaluate(() =>
      visualViewport.dispatchEvent(new Event("resize")),
    );
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
    await expect
      .poll(() =>
        dock.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const actions = el
            .querySelector(".composer-actions")
            .getBoundingClientRect();
          return (
            r.top >= 7 &&
            r.top <= 9 &&
            r.bottom <= 362 &&
            actions.top >= r.top &&
            actions.bottom <= 362
          );
        }),
      )
      .toBe(true);
    await input.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    const field = await input.boundingBox(),
      footer = await dock.locator(".composer-actions").boundingBox();
    assert(
      field.y >= 8 && field.y + field.height <= footer.y + 1,
      "The focused field fits above the fixed action row",
    );
    await expect(input).toHaveValue("Keep my attached draft visible.");
    await expect(files).toContainText("mobile-screenshot.txt");
    const send = dock.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    await expect(send).toBeInViewport();
    await capture("main-composer-keyboard-" + width);
    await dock.locator(".composer-body").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(dock.getByLabel("Agent recipient")).toBeInViewport();
    await page.evaluate(() => {
      Object.defineProperty(window, "scrollY", window.__composerScroll);
      delete window.__composerScroll;
      delete document.documentElement.clientHeight;
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      delete visualViewport.pageTop;
      document
        .querySelector(".composer-dock")
        .style.removeProperty("margin-top");
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await input.blur();
    await page.evaluate(() =>
      visualViewport.dispatchEvent(new Event("resize")),
    );
  }
  await dock
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
}
