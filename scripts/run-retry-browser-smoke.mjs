import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";
import { selectedEngines } from "./helpers/engines.mjs";

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  let browser;
  try {
    const conversation = fixture.conversations.find(
      (item) => item.state === "failed",
    );
    assert(conversation);
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await fixture.pair(context);
    const ids = [];
    let refused = false;
    await context.route(
      `**/api/runs/${conversation.run}/retry`,
      async (route) => {
        ids.push(route.request().postDataJSON().idempotencyKey);
        await route.fulfill({
          status: refused ? 422 : 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: refused
              ? "Retry fixture refused"
              : "Retry fixture uncertain",
            executionOutcome: refused ? "refused" : "unknown",
          }),
        });
      },
    );
    const page = await context.newPage();
    const open = async () => {
      await page.goto(`${fixture.base}/?conversation=${conversation.id}`);
      await expect(
        page.getByRole("button", { name: "Retry as a new run", exact: true }),
      ).toBeVisible();
    };
    const retry = async (message) => {
      await page
        .getByRole("button", { name: "Retry as a new run", exact: true })
        .click();
      await expect(page.getByText(message, { exact: true })).toBeVisible();
    };
    await open();
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("loop-effect:"))
          throw new Error("Fixture storage unavailable");
        return set.call(this, key, value);
      };
    });
    await retry("Cannot save this change's identity; nothing was sent.");
    assert.equal(
      ids.length,
      0,
      "storage failure must prevent run retry dispatch",
    );
    await open();
    await retry("Retry fixture uncertain");
    const first = ids[0];
    assert(first);
    await open();
    await retry("Retry fixture uncertain");
    assert.equal(
      ids[1],
      first,
      "reload must retain the uncertain retry identity",
    );
    refused = true;
    await retry("Retry fixture refused");
    assert.equal(ids[2], first);
    refused = false;
    await retry("Retry fixture uncertain");
    assert.notEqual(
      ids[3],
      first,
      "a proven refusal permits a new explicit retry identity",
    );
    console.log(
      `PASS ${engine.name()} run retry storage refusal, reload recovery and explicit settlement`,
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
