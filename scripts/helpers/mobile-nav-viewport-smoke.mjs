import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Real Feed, reply sheet, navigation and composer. Desktop WebKit cannot open
// the iPhone keyboard; CSS models a fixed layer retaining its old origin while
// the visual viewport recovers, including recovery without a second event.
export async function mobileNavViewportSmoke(page, fixture, capture) {
  await page.goto(fixture.base);
  await page.getByRole("tab", { name: "Done", exact: true }).click();
  const nav = page.locator(".mobile-nav");
  const dock = page.locator(".main-column > .composer-dock");
  const bottom = () => nav.evaluate((el) => el.getBoundingClientRect().bottom);
  const aligned = async () => {
    await expect.poll(bottom).toBeCloseTo(844, 0);
    await expect(dock).toBeVisible();
    const bars = await page.evaluate(() => {
      const nav = document.querySelector(".mobile-nav").getBoundingClientRect();
      const dock = document.querySelector(".main-column > .composer-dock").getBoundingClientRect();
      return { nav: nav.top, dock: dock.bottom };
    });
    assert(Math.abs(bars.nav - bars.dock) < 2, "Composer stays directly above the tab bar");
    await expect(nav.getByRole("button", { name: "Projects", exact: true })).toBeInViewport({ ratio: 1 });
  };
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await aligned();
    await page.locator(".inbox-results .inbox-card").first()
      .getByRole("button", { name: "Reply", exact: true }).click();
    const sheet = page.locator("dialog.conversation-sheet[open]");
    await expect(sheet.getByRole("textbox", { name: "Reply to agent" })).toBeFocused();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, value: 494 });
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect(nav).toBeHidden();
    // Exercise touch input: a mouse press can blur the field and move Close
    // between down/up when this fixture changes the simulated keyboard state.
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(nav).toBeVisible();
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".mobile-nav, .main-column > .composer-dock"))
        el.style.marginBottom = "350px";
      // The focusout signal has happened, but both measurements still describe
      // the keyboard viewport until later in the transition.
      document.dispatchEvent(new Event("focusout"));
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => { delete visualViewport.height; }); // deliberately no resize
    await aligned();
    await capture("keyboard-dismissed-" + width);

    // Returning from another app can restore the probe before the bar itself.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".mobile-nav, .main-column > .composer-dock"))
        el.style.marginBottom = "240px";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await aligned();
    // A touch finishes before Safari's fixed layer settles. No further scroll
    // or viewport event follows that last layout movement.
    await page.evaluate(() => window.dispatchEvent(new Event("touchend")));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".mobile-nav, .main-column > .composer-dock"))
        el.style.marginBottom = "372px";
    });
    await aligned();
    await page.waitForTimeout(1600);
    await aligned(); // repeated measurements cannot accumulate a translation
    await capture("scroll-settled-" + width);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".mobile-nav, .main-column > .composer-dock"))
        el.style.removeProperty("margin-bottom");
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await aligned();
    await expect(dock).toBeVisible();
  }
  // The shell keeps an unsent draft while navigating through page views.
  await page.getByRole("button", { name: "Compose a message", exact: true }).click();
  const draft = page.locator(".main-column #composer");
  const unsent = "Keep this draft while I visit other pages.";
  await draft.fill(unsent);
  await draft.blur();
  await nav.getByRole("button", { name: "Projects", exact: true }).tap();
  await expect(nav.getByRole("button", { name: "Projects", exact: true })).toHaveClass(/current/);
  await expect(draft).toHaveValue(unsent);
  for (const name of ["Your profile", "Feed"]) {
    await nav.getByRole("button", { name, exact: true }).tap();
    await expect(nav.getByRole("button", { name, exact: true })).toHaveClass(/current/);
    await expect(draft).toHaveValue(unsent);
  }
  await page.getByRole("button", { name: "Compose a message", exact: true }).click();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(unsent);
  await capture("navigation-preserved-draft");
}
