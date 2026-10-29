import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Keep real dialog geometry. Only keyboard viewport measurements are synthetic:
// desktop WebKit does not display the iOS keyboard or perform its focus pan.
export async function safariSheetKeyboardSmoke(page, fixture, capture) {
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "body { min-height: 2400px; }" });
  await page.evaluate(() => window.scrollTo(0, 500));
  const scroll = await page.evaluate(() => scrollY);
  assert(scroll > 0);
  // A fixed app control can open a sheet while the feed is scrolled. Avoid
  // Playwright scrolling the trigger back into view before invoking it.
  await page
    .getByRole("button", { name: "New agent", exact: true })
    .evaluate((el) => el.click());
  const sheet = page.getByRole("dialog", { name: "New chat" });
  await expect(sheet).toBeVisible();
  const field = sheet.getByLabel("Opening message", { exact: true });
  await field.fill("Preserve this Safari draft.");
  await page.evaluate(() => {
    // Some keyboard states shrink innerHeight as well as visualViewport.
    // Comparing only those two values then incorrectly reports no keyboard.
    window.__innerHeightDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: 400,
    });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
  await expect
    .poll(() =>
      sheet.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top <= 10 && r.bottom <= 401;
      }),
    )
    .toBe(true);
  await field.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const before = await page.locator("body").boundingBox();
  await page.evaluate(() => window.scrollTo(0, 900));
  assert.equal(
    (await page.locator("body").boundingBox()).y,
    before.y,
    "Focusing a modal field must not pan the background page",
  );
  await expect(field).toHaveValue("Preserve this Safari draft.");
  await capture("keyboard-resized-layout");
  await field.blur();
  await page.evaluate(() => {
    Object.defineProperty(
      window,
      "innerHeight",
      window.__innerHeightDescriptor,
    );
    delete window.__innerHeightDescriptor;
    delete document.documentElement.clientHeight;
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(scroll);
  await expect
    .poll(() => page.evaluate(() => history.scrollRestoration))
    .toBe("auto");

  // A nested sheet closing must not unlock its parent's background.
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .evaluate((el) => el.click());
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  const tools = page.getByRole("dialog", {
    name: "Tools & integrations",
    exact: true,
  });
  await expect(tools).toBeVisible();
  await tools.getByRole("button", { name: "Close", exact: true }).click();
  await expect(tools).toHaveCount(0);
  const locked = await page.locator("body").boundingBox();
  await page.evaluate(() => scrollTo(0, 900));
  assert.equal((await page.locator("body").boundingBox()).y, locked.y);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(scroll);
  await expect
    .poll(() => page.evaluate(() => history.scrollRestoration))
    .toBe("auto");
}
