// Seeds stories straight into the feed store, so it drives Social's reading,
// saving, filtering, search and watches without reaching a feed.
import { mobileSmokeOptions } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { smokeScreenshotDirectory } from "./helpers/smoke-diagnostics.mjs";
import { join } from "node:path";
import { chromiumExecutable, selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { socialSmoke } from "./helpers/social-smoke.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const evidence = smokeScreenshotDirectory("LOOP_SOCIAL_SCREENSHOT_DIR");
for (const engine of selectedEngines()) {
  // Each engine gets its own workspace. The journey marks a story read, saves
  // a reminder and creates a watch; reseeding feeds would leave all of that
  // behind for the next engine, which then starts with nothing unread.
  const fixture = await designFixture();
  try {
    const browser = await engine.launch({
      headless: true,
      executablePath: chromiumExecutable(engine),
    });
    try {
      const context = await browser.newContext(mobileSmokeOptions);
      await fixture.pair(context);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (error) => {
        if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
          errors.push(error.message);
      });
      await socialSmoke(page, fixture, async (name) => {
        if (evidence)
          await page.screenshot({
            path: join(evidence, `${engine.name()}-${name}.png`),
          });
      });
      assert.deepEqual(errors, [], "Unexpected Social browser errors");
      console.log(
        `${engine.name()}: Social reading, saving, filtering, search, catalog and watches passed`,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
}
