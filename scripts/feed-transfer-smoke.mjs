import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { trackSmokeCleanup } from "./helpers/smoke-lifecycle.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

// Real Feed and HTTP server, isolated data, no provider calls or route mocks.
// Routing interception disables the browser cache this regression exercises.
for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  try {
    const insert = fixture.db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',1)",
    );
    for (const file of readdirSync("public/avatars/robots")) {
      if (!file.endsWith(".webp")) continue;
      const name = file.slice(0, -5);
      insert.run(`transfer-${name}`, fixture.owner, name, name);
    }
    const browser = await engine.launch({
      executablePath:
        engine === chromium ? process.env.CHROMIUM_PATH : undefined,
    });
    const closeBrowser = trackSmokeCleanup(() => browser.close());
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      const errors = [];
      page.on("pageerror", (error) => {
        if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
          errors.push(error.message);
      });
      const requested = new Set();
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/avatars/")) requested.add(path);
      });
      const assets = new Map();
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (/^\/assets\/.*\.(js|css)$/.test(path)) assets.set(path, response);
      });
      const timings = () =>
        page.evaluate(() =>
          performance.getEntriesByType("resource").map((r) => ({
            path: new URL(r.name).pathname,
            transferred: r.transferSize,
            encoded: r.encodedBodySize,
            decoded: r.decodedBodySize,
          })),
        );
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      const portraits = page.locator(".agent-strip .avatar img");
      await expect(portraits).toHaveCount(111);
      await expect
        .poll(() => portraits.first().evaluate((img) => img.naturalWidth))
        .toBeGreaterThan(0);
      assert(
        requested.size > 0 && requested.size < 20,
        `Initial Feed fetched ${requested.size} avatars`,
      );
      assert.equal(
        await portraits.last().getAttribute("src"),
        null,
        "Far-offscreen avatar has no request URL",
      );
      const coldAvatars = requested.size;
      const cold = await timings();
      assert(assets.size >= 2, "Production JavaScript and CSS were served");
      for (const [path, response] of assets) {
        assert.equal(
          response.headers()["cache-control"],
          "public, max-age=31536000, immutable",
          path,
        );
        assert.match(response.headers()["content-encoding"], /^(gzip|br)$/);
      }
      await page.reload({ waitUntil: "networkidle" });
      await expect
        .poll(() => portraits.first().evaluate((img) => img.naturalWidth))
        .toBeGreaterThan(0);
      const warm = await timings();
      if (engine === chromium) {
        const code = cold.filter((r) => assets.has(r.path));
        assert(
          code.reduce((n, r) => n + r.encoded, 0) <
            code.reduce((n, r) => n + r.decoded, 0) / 2,
        );
        for (const r of warm.filter((r) => assets.has(r.path)))
          assert.equal(
            r.transferred,
            0,
            `Reload transferred cached asset ${r.path}`,
          );
        for (const r of warm.filter((r) => r.path.startsWith("/avatars/")))
          assert(
            r.transferred < 1024,
            `Avatar body transferred again: ${r.path}`,
          );
      }
      // Scroll the actual clipped rail: new portraits load as they become visible.
      await portraits.last().scrollIntoViewIfNeeded();
      await expect
        .poll(() => portraits.last().evaluate((img) => img.naturalWidth))
        .toBeGreaterThan(0);
      assert(
        requested.size > coldAvatars,
        "Scrolling fetched newly visible avatars",
      );
      await expect(portraits.first()).toHaveJSProperty("naturalWidth", 384);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          engine: engine.name(),
          initialAvatars: coldAvatars,
          afterScrollAvatars: requested.size,
          coldCodeBytes: cold
            .filter((r) => assets.has(r.path))
            .reduce((n, r) => n + r.transferred, 0),
          reloadCodeBytes: warm
            .filter((r) => assets.has(r.path))
            .reduce((n, r) => n + r.transferred, 0),
        }),
      );
    } finally {
      await closeBrowser();
    }
  } finally {
    await fixture.close();
  }
}
