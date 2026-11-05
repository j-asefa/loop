import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { htmlPreviewSmoke } from "./helpers/html-preview-smoke.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const fixture = await designFixture();
const evidence =
  process.env.LOOP_HTML_SCREENSHOT_DIR ||
  (process.env.CI ? join("test-results", "screenshots") : undefined);
if (evidence) mkdirSync(evidence, { recursive: true });
try {
  for (const engine of selectedEngines()) {
    const browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium
          ? process.env.CHROMIUM_PATH || undefined
          : undefined,
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        // Playwright's injected service-worker blocker throws inside opaque
        // frames. Use a fresh context with the browser's real sandbox instead.
        serviceWorkers: "allow",
      });
      await fixture.pair(context);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (error) => {
        if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
          errors.push(error.message);
      });
      await htmlPreviewSmoke(page, fixture, async (name) => {
        if (evidence)
          await page.screenshot({
            path: join(evidence, `${engine.name()}-${name}.png`),
          });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "HTML must stay within the preview",
        );
      });
      assert.deepEqual(errors, [], "Unexpected HTML preview browser errors");
      console.log(
        `${engine.name()}: HTML preview, interaction, isolation, navigation and download passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
