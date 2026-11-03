import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { selectedEngines } from "./helpers/engines.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const screenshots =
  process.env.LOOP_APP_CONTRACT_SCREENSHOTS ||
  "/tmp/loop-app-contracts-screenshots";
mkdirSync(screenshots, { recursive: true });
for (const engine of selectedEngines()) {
  const name = engine.name();
  const browser = await engine.launch({
    headless: true,
    ...(name === "chromium" && process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  const fixture = await cardsFixture("multi-user", true, {
    nodeEnv: "production",
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      if (!isWebKitNavigationFetchError(name, error, fixture.origin))
        errors.push(error.message);
    });
    await page.goto(fixture.origin);
    await page.getByLabel("Email", { exact: true }).fill("cards@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("fixture-cards-owner-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Open settings", exact: true }),
    ).toBeVisible();
    // A real Better Auth session omits mode. The shell still opens using the
    // credential-free display projection returned by the production app.
    const session = await (
      await page.request.get(fixture.origin + "/api/auth/get-session")
    ).json();
    assert.deepEqual(session, {
      user: { id: fixture.owner, name: "Card owner" },
    });

    for (const field of [
      "cardTokens",
      "personalDecisions",
      "continuationStart",
    ]) {
      let omitted = false;
      const capability = async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        assert.equal(typeof value[field], "boolean");
        delete value[field];
        omitted = true;
        await route.fulfill({ response, json: value });
      };
      await page.route("**/api/capabilities", capability);
      await page.reload();
      await page
        .getByRole("button", { name: "Open settings", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Settings", exact: true }),
      ).toBeVisible();
      if (field === "cardTokens")
        await expect(
          page.getByRole("button", { name: "Card API tokens", exact: true }),
        ).toHaveCount(0);
      assert(
        omitted,
        "The actual discovery response was changed before the shell loaded",
      );
      await page.screenshot({
        path: join(screenshots, name + "-missing-" + field + ".png"),
      });
      await page.unroute("**/api/capabilities", capability);
    }
    let omittedObserver = false;
    await page.route("**/api/build", async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      assert.equal(typeof value.eventLoop.observing, "boolean");
      delete value.eventLoop;
      value.serving.id += "-contract-fixture-change";
      omittedObserver = true;
      await route.fulfill({ response, json: value });
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Reload to update", exact: true }),
    ).toBeVisible();
    assert(
      omittedObserver,
      "A valid legacy build response still produces the reload notice",
    );
    await page.screenshot({
      path: join(screenshots, name + "-missing-event-loop.png"),
    });
    await page
      .getByRole("button", { name: "Open settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    assert.equal(
      await (
        await page.request.get(fixture.origin + "/api/auth/get-session")
      ).json(),
      null,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS " +
        name +
        ": account sign-in/out, credential-free session and omitted capability/build fields; screenshots " +
        screenshots,
    );
  } finally {
    await fixture.close();
    await browser.close();
  }
}
