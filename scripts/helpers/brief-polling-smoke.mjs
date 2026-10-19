import assert from "node:assert/strict";
import { build } from "esbuild";
import { expect } from "@playwright/test";

export async function briefPollingSmoke(browser, base) {
  const page = await browser.newPage();
  const pending = [];
  const brief = (title) => ({
    format: "loop.brief/v1",
    project: "polling-fixture",
    version: 1,
    acknowledged_version: 1,
    basis: { since: 0, through: 0, pending: 0, synth_at: 1, window: "Fixture" },
    status: "active",
    headline: { text: title, cite: [] },
    state: [],
    decisions: [],
    open_questions: [],
    unfinished: [],
    needs_you: [],
    artifacts: [],
    changes: [],
    overflow: { state: 0, decisions: 0, open_questions: 0, unfinished: 0 },
    pins: [],
    settings: { enabled: true, connectionId: "fixture", model: "fixture" },
    sources: {},
    attention: {},
    coverage: { results: 0, threads: 0, model: "fixture" },
  });
  try {
    await page.clock.install();
    await page.route("**/brief-polling-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<main id="brief-fixture"></main>',
      }),
    );
    await page.route("**/api/**", async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/brief"))
        return route.fulfill({ json: { items: [] } });
      const response = await new Promise((resolve) => pending.push(resolve));
      await route.fulfill(response);
    });
    await page.goto(base + "/brief-polling-fixture");
    const bundle = await build({
      entryPoints: ["test/fixtures/brief-client.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"development"' },
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(
      (initial) =>
        window.renderBrief({ owner: "polling-owner", workspace: "", initial }),
      brief("Initial brief"),
    );
    for (let index = 0; index < 2; index++) {
      await expect.poll(() => pending.length).toBe(index + 1);
      await page.clock.runFor(16000);
      assert.equal(
        pending.length,
        index + 1,
        "Polling must retain a pending read",
      );
      const title = `Slow response ${index + 1}`;
      pending[index]({ json: brief(title) });
      await expect(page.locator(".brief-headline h2")).toHaveText(title);
      await page.clock.runFor(15000);
    }
    await expect.poll(() => pending.length).toBe(3);
    pending[2]({ status: 503, json: { error: "Temporary read failure" } });
    await expect(page.getByRole("alert")).toContainText(
      "Temporary read failure",
    );
    await page.clock.runFor(15000);
    await expect.poll(() => pending.length).toBe(4);
    pending[3]({ json: brief("Polling recovered") });
    await expect(page.locator(".brief-headline h2")).toHaveText(
      "Polling recovered",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    // A connection that never settles must release the pending read so a
    // manual retry and subsequent polling can recover.
    await page.clock.runFor(15000);
    await expect.poll(() => pending.length).toBe(5);
    await page.clock.runFor(31000);
    await expect(page.getByRole("alert")).toContainText(
      "Brief refresh timed out",
    );
    await page
      .getByRole("button", { name: "Retry brief", exact: true })
      .click();
    await expect.poll(() => pending.length).toBe(6);
    pending[5]({ json: brief("Hanging read recovered") });
    await expect(page.locator(".brief-headline h2")).toHaveText(
      "Hanging read recovered",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    for (const resolve of pending) resolve({ status: 503, json: {} });
    await page.close();
  }
}
