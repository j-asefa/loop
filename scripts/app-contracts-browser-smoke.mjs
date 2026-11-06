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
  const fixture = await cardsFixture("companion", true, {
    nodeEnv: "production",
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const [cookieName, cookieValue] = fixture.browser.cookie.split("=");
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        url: fixture.origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      if (!isWebKitNavigationFetchError(name, error, fixture.origin))
        errors.push(error.message);
    });
    await page.goto(fixture.origin);
    await expect(
      page.getByRole("button", { name: "Open settings", exact: true }),
    ).toBeVisible();
    // The shell opens using the credential-free display projection.
    const session = await (
      await page.request.get(fixture.origin + "/api/auth/get-session")
    ).json();
    assert.deepEqual(session, {
      user: { id: fixture.owner, name: "Your workspace" },
      mode: "paired",
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
    // Both transports describe the same simulated new build. A companion's
    // reset frame can arrive after the HTTP read and replace its build notice.
    const changedBuildId = "app-contract-fixture-new-build";
    let changedBuildFrames = 0;
    await page.routeWebSocket(
      (url) =>
        ["/ws", "/api/events/ws", "/api/events/multiplex/ws"].includes(
          url.pathname,
        ),
      (route) => {
        const server = route.connectToServer();
        server.onMessage((message) => {
          const envelope = JSON.parse(message.toString());
          const frame = envelope.type === "frame" ? envelope.frame : envelope;
          if (frame.type === "reset" && frame.buildIdentity) {
            frame.buildIdentity.id = changedBuildId;
            changedBuildFrames++;
          }
          route.send(JSON.stringify(envelope));
        });
      },
    );
    let omittedObserver = false;
    await page.route("**/api/build", async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      assert.equal(typeof value.eventLoop.observing, "boolean");
      delete value.eventLoop;
      value.serving.id = changedBuildId;
      omittedObserver = true;
      await route.fulfill({ response, json: value });
    });
    await page.reload();
    await expect.poll(() => omittedObserver).toBe(true);
    await expect.poll(() => changedBuildFrames).toBeGreaterThan(0);
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
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS " +
        name +
        ": paired session, credential-free session and omitted capability/build fields; screenshots " +
        screenshots,
    );
  } finally {
    await fixture.close();
    await browser.close();
  }
}
