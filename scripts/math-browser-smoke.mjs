import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { trackSmokeCleanup } from "./helpers/smoke-lifecycle.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const mathAsset = /\/assets\/mathPlugins-[^/]+\.(?:js|css)$/;
const wide = String.raw`\underbrace{${Array(30).fill("a+b").join("+")}}_{n}`;
const content =
  String.raw`**The Claim:** Fixed-width $k$-CNF in time
($\sim 2^{n \cdot (\log \log n)^2 / \sqrt{\log n}}$), instead of $2^{\Omega(n)}$; the bound is $T$.

$$
${wide}
$$

~~~math
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
~~~

Prices are $5 and $10. Code: ` +
  "`$x$`.\n\n" +
  String.raw`Long inline math: $${wide}$.

[Original source](https://example.com/math)`;

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  try {
    const browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium ? process.env.CHROMIUM_PATH : undefined,
    });
    const closeBrowser = trackSmokeCleanup(() => browser.close());
    try {
      const done = fixture.conversations.find(
        (item) => item.state === "completed",
      );
      const working = fixture.conversations.find(
        (item) => item.state === "running",
      );
      const update = (item, text) => {
        fixture.db
          .prepare(
            "UPDATE messages SET content=? WHERE run_id=? AND role='assistant'",
          )
          .run(text, item.run);
        fixture.db
          .prepare("UPDATE artifacts SET content=? WHERE run_id=?")
          .run(text, item.run);
      };
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      await fixture.pair(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => {
        if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
          errors.push(error.message);
      });
      const requests = [];
      const fontResponses = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("response", (response) => {
        if (/KaTeX_.*\.woff2$/.test(response.url()))
          fontResponses.push(response.status());
      });
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      await expect(
        page.locator(".inbox-results .inbox-row").first(),
      ).toBeVisible();
      assert(
        !requests.some((url) => mathAsset.test(new URL(url).pathname)),
        "Plain messages loaded the math chunk",
      );

      let releaseMath;
      const held = new Promise((resolve) => {
        releaseMath = resolve;
      });
      const hold = async (route) => {
        await held;
        await route.continue();
      };
      await page.route(mathAsset, hold);
      // No dollars: whitespace before the fence language must itself trigger
      // the initial lazy load, including in a compact Feed preview.
      update(done, "~~~ \tmath\n\\frac{1}{2}\n~~~");
      const requestedMath = page.waitForRequest((request) =>
        mathAsset.test(new URL(request.url()).pathname),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await requestedMath;
      const card = page
        .locator(".inbox-results .inbox-card")
        .filter({ hasText: done.title });
      await expect(card.locator(".preview")).toContainText("\\frac{1}{2}");
      await expect(card.locator(".katex")).toHaveCount(0);
      releaseMath();
      await expect(card.locator(".katex-display")).toHaveCount(1);
      await page.unroute(mathAsset, hold);
      update(done, content);
      await page.evaluate(() =>
        window.dispatchEvent(new Event("loop-source-refresh")),
      );
      await expect(card.locator(".katex")).toHaveCount(7);
      await card.locator(".inbox-row").click();
      const reader = page.locator("dialog.feed-reading-sheet[open]");
      await expect(reader.locator(".katex")).toHaveCount(7);
      await expect(reader.locator(".katex-error")).toHaveCount(0);
      await expect(reader.locator("code")).toHaveText("$x$");
      await expect(reader).toContainText("Prices are $5 and $10.");
      await expect(
        reader.getByRole("link", { name: "Original source" }),
      ).toHaveAttribute("href", "https://example.com/math");
      await page.evaluate(() => document.fonts.ready);
      assert(
        fontResponses.length > 0 &&
          fontResponses.every((status) => status === 200),
        "Local math fonts did not load",
      );
      assert(
        requests.every((url) => new URL(url).origin === fixture.base),
        "Math made an external request",
      );
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "Page overflows at phone width",
        );
        assert(
          await reader.evaluate((el) => el.scrollWidth <= el.clientWidth),
          "Reader overflows at phone width",
        );
        const display = reader.locator(".katex-display").first();
        assert(
          await display.evaluate((el) => el.scrollWidth > el.clientWidth),
          "Wide display math was not scrollable",
        );
        await display.evaluate((el) => {
          el.scrollLeft = 100;
        });
        assert(await display.evaluate((el) => el.scrollLeft > 0));
        const inline = reader
          .locator("p")
          .filter({ hasText: "Long inline math:" })
          .locator(".katex");
        assert(
          await inline.evaluate((el) => el.scrollWidth > el.clientWidth),
          "Wide inline math was not scrollable",
        );
        await expect(
          reader.getByRole("button", { name: "Reply", exact: true }),
        ).toBeInViewport();
      }
      await page.screenshot({
        path: join(tmpdir(), `loop-math-${engine.name()}.png`),
      });
      await reader.getByRole("button", { name: "Reply", exact: true }).click();
      const thread = page.locator("dialog.conversation-sheet[open]");
      await expect(thread.locator(".message .katex")).toHaveCount(7);

      // The mounted Working reader replaces a partial equation with the complete
      // message, and recovers again after an invalid but closed expression.
      update(working, String.raw`Streaming $\frac{1}{`);
      await page.goto(`${fixture.base}/?filter=working`);
      await page
        .locator(".inbox-row")
        .filter({ hasText: working.title })
        .click();
      await expect(reader).toContainText(String.raw`Streaming $\frac{1}{`);
      for (const [text, selector] of [
        [String.raw`Streaming $\frac{1}{$ tail`, ".katex-error"],
        [String.raw`Streaming $\frac{1}{2}$ tail`, ".katex"],
      ]) {
        update(working, text);
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-source-refresh")),
        );
        await expect(reader.locator(selector)).toHaveCount(1);
        await expect(reader).toContainText("tail");
      }
      await expect(reader.locator(".katex-error")).toHaveCount(0);
      assert.deepEqual(errors, []);
      await context.close();

      // A fresh page with a failed chunk download retains the message and Reply.
      const offline = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      await fixture.pair(offline);
      await offline.route(mathAsset, (route) => route.abort());
      const fallback = await offline.newPage();
      const failed = fallback.waitForEvent("requestfailed", {
        predicate: (request) => mathAsset.test(new URL(request.url()).pathname),
      });
      await fallback.goto(fixture.base);
      await failed;
      await fallback
        .locator(".inbox-row")
        .filter({ hasText: done.title })
        .click();
      const fallbackReader = fallback.locator(
        "dialog.feed-reading-sheet[open]",
      );
      await expect(fallbackReader).toContainText("$k$-CNF");
      await expect(fallbackReader.locator(".katex")).toHaveCount(0);
      await expect(
        fallbackReader.getByRole("button", { name: "Reply", exact: true }),
      ).toBeVisible();
      await offline.close();
      console.log(
        `${engine.name()}: math rendering, lazy assets, 320/390px overflow, streaming and failed-download fallback passed`,
      );
    } finally {
      await closeBrowser();
    }
  } finally {
    await fixture.close();
  }
}
