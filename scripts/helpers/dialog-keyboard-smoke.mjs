import assert from "node:assert/strict";
import { mockViewportCoordinates } from "./mock-viewport.mjs";
import { expect } from "@playwright/test";
import { openSettings } from "./browser-ui.mjs";

// Exercise the production Sheet + PwaStatus boundary. Desktop browser runners
// cannot open an iPhone keyboard, so simulate its visual and fixed viewports.
export async function dialogKeyboardSmoke(page, fixture, capture) {
  await mockViewportCoordinates(page);
  const draft = '{ "mcpServers": {} }';
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await openSettings(page);
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  const sheet = page.getByRole("dialog", {
    name: "Tools & integrations",
    exact: true,
  });
  await sheet.getByRole("button", { name: "Custom", exact: true }).click();
  await sheet
    .getByText("Paste MCP JSON configuration", { exact: true })
    .click();
  const input = sheet.getByLabel("MCP configuration", { exact: true });
  await input.fill(draft);
  try {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      // Account for a fixed containing block ending earlier than innerHeight.
      // Shift bottom-anchored dialogs independently from the page probe.
      // Top-anchored dialogs must not depend on either bottom measurement.
      const style = await page.addStyleTag({
        content: `
        @media (max-width: 700px) {
           .sheet:not(.side-panel) {
            margin-bottom: var(--test-layout-shift, 0px);
          }
        }
      `,
      });
      await page.evaluate(() => {
        const probe = [...document.body.children].find(
          (el) =>
            el.getAttribute("aria-hidden") === "true" &&
            el.style.position === "fixed" &&
            el.style.height === "0px",
        );
        if (!probe) throw new Error("Fixed viewport probe missing");
        window.__sheetProbe = probe;
        probe.getBoundingClientRect = () => ({
          top: window.__sheetLayoutBottom,
          height: 0,
        });
      });
      for (const layoutBottom of [844, 430]) {
        for (const dialogBottom of [844, 430]) {
          for (const offsetTop of [0, 370]) {
            await input.focus();
            await page.evaluate(
              ({ layoutBottom, dialogBottom, offsetTop }) => {
                window.__sheetLayoutBottom = layoutBottom;
                document.documentElement.style.setProperty(
                  "--test-layout-shift",
                  innerHeight - dialogBottom + "px",
                );
                Object.defineProperty(window.visualViewport, "height", {
                  configurable: true,
                  value: 430,
                });
                Object.defineProperty(window.visualViewport, "offsetTop", {
                  configurable: true,
                  value: offsetTop,
                });
                window.visualViewport.dispatchEvent(new Event("resize"));
              },
              { layoutBottom, dialogBottom, offsetTop },
            );
            await expect(page.locator("html")).toHaveAttribute(
              "data-keyboard",
              "open",
            );
            await expect
              .poll(
                () =>
                  sheet.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    const v = window.visualViewport;
                    const header = el
                      .querySelector(".sheet-head")
                      .getBoundingClientRect();
                    return (
                      r.top >= v.offsetTop &&
                      r.bottom <= v.offsetTop + v.height + 1 &&
                      r.height > 100 &&
                      header.top >= v.offsetTop &&
                      header.bottom <= v.offsetTop + v.height
                    );
                  }),
                {
                  message: `Dialog and its close control stay visible: ${width}px, page bottom ${layoutBottom}, modal bottom ${dialogBottom}, pan ${offsetTop}`,
                },
              )
              .toBe(true);
            await input.evaluate((el) =>
              el.scrollIntoView({ block: "center" }),
            );
            await expect(input).toBeFocused();
            await expect(input).toHaveValue(draft);
            const bounds = await input.boundingBox();
            assert(
              bounds.y >= offsetTop &&
                bounds.y + bounds.height <= offsetTop + 430,
              "The focused form field remains above the keyboard",
            );
            assert.equal(
              await sheet.evaluate((el) => el.scrollWidth > el.clientWidth),
              false,
            );
            await capture(
              `dialog-keyboard-${width}-${layoutBottom}-${dialogBottom}-${offsetTop}`,
            );
          }
        }
      }
      await page.evaluate(() => {
        delete window.__sheetProbe.getBoundingClientRect;
        delete window.__sheetProbe;
        delete window.__sheetLayoutBottom;
        document.documentElement.style.removeProperty("--test-layout-shift");
      });
      await style.evaluate((el) => el.remove());
    }
    await input.blur();
    await expect(page.locator("html")).toHaveAttribute(
      "data-keyboard",
      "closed",
    );
    await expect(input).toHaveValue(draft);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await page.evaluate(() => {
      if (window.__sheetProbe) delete window.__sheetProbe.getBoundingClientRect;
      document.documentElement.style.removeProperty("--test-layout-shift");
      delete window.visualViewport.height;
      delete window.visualViewport.offsetTop;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.setViewportSize({ width: 390, height: 844 });
  }
}
