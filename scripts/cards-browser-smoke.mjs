import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  for (const mode of ["server", "companion"]) {
    const fixture = await cardsFixture(mode, true);
    try {
      for (const width of [390, 1280]) {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          serviceWorkers: "block",
          permissions: ["clipboard-read", "clipboard-write"],
        });
        if (fixture.browser.cookie) {
          const [name, value] = fixture.browser.cookie.split("=");
          await context.addCookies([
            {
              name,
              value,
              url: fixture.origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
        }
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(fixture.origin);
        await page
          .getByRole("button", { name: "Open settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Integration tokens", exact: true })
          .click();
        const title = mode + " " + width;
        await page.getByLabel("Token name", { exact: true }).fill(title);
        await page
          .getByLabel("Read access", { exact: true })
          .selectOption("read");
        await expect(
          page.getByText(
            "Read agents, conversations, results, files and pending decisions across your projects.",
            { exact: false },
          ),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Create read-only token", exact: true })
          .click();
        const secretBox = page.locator(".settings-command pre");
        await expect(secretBox).toBeVisible();
        const secret = await secretBox.textContent();
        assert.match(secret, /^loop_token_[\w-]{43}$/);
        await page
          .getByRole("button", { name: "Copy token", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Copied", exact: true }),
        ).toBeVisible();
        assert.equal(
          await page.evaluate(() => navigator.clipboard.readText()),
          secret,
        );
        const response = await fixture.request("/api/v1/cards?view=sent", {
          headers: { authorization: "Bearer " + secret },
        });
        assert.equal(response.status, 200);
        const storage = await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            url: location.href,
          }),
        );
        assert(!storage.includes(secret));
        await page
          .getByRole("button", { name: "Hide token", exact: true })
          .click();
        await expect(secretBox).toHaveCount(0);
        await page.reload();
        await page
          .getByRole("button", { name: "Open settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Integration tokens", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Revoke " + title, exact: true }),
        ).toBeVisible();
        await expect(secretBox).toHaveCount(0);
        await page
          .getByRole("button", { name: "Revoke " + title, exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Revoke " + title, exact: true }),
        ).toHaveCount(0);
        assert.equal(
          (
            await fixture.request("/api/v1/cards", {
              headers: { authorization: "Bearer " + secret },
            })
          ).status,
          401,
        );
        // A definite refusal settles the receipt and allows corrected input.
        await page.route("**/api/card-tokens", (route) =>
          route.request().method() === "POST"
            ? route.fulfill({
                status: 403,
                json: { error: "Creation refused" },
              })
            : route.continue(),
        );
        await page
          .getByLabel("Token name", { exact: true })
          .fill("Refused " + title);
        await page
          .getByRole("button", { name: "Create read-only token", exact: true })
          .click();
        await expect(page.getByRole("alert")).toContainText("Creation refused");
        await expect(
          page.getByLabel("Token name", { exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByLabel("Read access", { exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole("button", {
            name: "Retry token creation",
            exact: true,
          }),
        ).toHaveCount(0);
        await page.unroute("**/api/card-tokens");
        // A committed creation with a lost response is reconciled by ID.
        let lostRequest;
        await page.route("**/api/card-tokens", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          lostRequest = route.request().postDataJSON();
          await route.fetch();
          await route.abort("failed");
        });
        await page
          .getByLabel("Token name", { exact: true })
          .fill("Lost " + title);
        await page
          .getByRole("button", { name: "Create read-only token", exact: true })
          .click();
        await expect(secretBox).toBeVisible();
        assert.equal(await secretBox.textContent(), lostRequest.secret);
        assert.equal(
          fixture.db
            .prepare("SELECT count(*) n FROM card_tokens WHERE id=?")
            .get(lostRequest.request_id).n,
          1,
        );
        await page
          .getByRole("button", { name: "Hide token", exact: true })
          .click();
        await page.unroute("**/api/card-tokens");
        // Closing Settings before a committed response arrives keeps a pending
        // receipt for this owner/source, without another POST on reopening.
        let release, committed;
        const reached = new Promise((resolve) => {
          committed = resolve;
        });
        const held = new Promise((resolve) => {
          release = resolve;
        });
        let delivered;
        const delivery = new Promise((resolve) => {
          delivered = resolve;
        });
        let pendingRequest,
          posts = 0;
        await page.route("**/api/card-tokens", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          posts++;
          pendingRequest = route.request().postDataJSON();
          const response = await route.fetch();
          committed();
          await held;
          await route.fulfill({ response });
          delivered();
        });
        await page
          .getByLabel("Token name", { exact: true })
          .fill("Pending " + title);
        await page
          .getByRole("button", { name: "Create read-only token", exact: true })
          .click();
        await reached;
        await page
          .getByRole("dialog", { name: "Integration tokens", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Integration tokens", exact: true })
          .click();
        await expect(secretBox).toBeVisible();
        assert.equal(await secretBox.textContent(), pendingRequest.secret);
        release();
        await delivery;
        assert.equal(posts, 1);
        await page.unroute("**/api/card-tokens");
        const noSecrets = await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            url: location.href,
          }),
        );
        assert(
          !noSecrets.includes(lostRequest.secret) &&
            !noSecrets.includes(pendingRequest.secret),
        );
        // A linked source can return a transient 404 while reconnecting.
        await page
          .getByRole("dialog", { name: "Integration tokens", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        let unavailableStatus = 404;
        await page.route("**/api/card-tokens", (route) =>
          route.fulfill({
            status: unavailableStatus,
            json: {
              error:
                unavailableStatus === 404
                  ? "This Docker workspace is unavailable"
                  : "Token list failure " + unavailableStatus,
            },
          }),
        );
        await page
          .getByRole("button", { name: "Integration tokens", exact: true })
          .click();
        await expect(
          page.getByText("Integration tokens are unavailable", {
            exact: false,
          }),
        ).toBeVisible();
        for (const status of [500, 404, 403]) {
          unavailableStatus = status;
          await page
            .getByRole("button", { name: "Retry list", exact: true })
            .click();
          if (status === 404) {
            await expect(
              page.getByText("Integration tokens are unavailable", {
                exact: false,
              }),
            ).toBeVisible();
          } else {
            await expect(page.getByRole("alert")).toContainText(
              "Token list failure " + status,
            );
            await expect(
              page.getByText("Integration tokens are unavailable", {
                exact: false,
              }),
            ).toHaveCount(0);
          }
        }
        await page.unroute("**/api/card-tokens");
        await page
          .getByRole("button", { name: "Retry list", exact: true })
          .click();
        await expect(
          page.getByLabel("Token name", { exact: true }),
        ).toBeVisible();
        // Older sources omit the capability; previews explicitly disable it.
        for (const advertised of [undefined, false]) {
          await page.route("**/api/capabilities", async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            if (advertised === undefined) delete body.cardTokens;
            else body.cardTokens = advertised;
            await route.fulfill({ response, json: body });
          });
          await page.reload();
          await page
            .getByRole("button", { name: "Open settings", exact: true })
            .click();
          await expect(
            page.getByRole("button", {
              name: "Integration tokens",
              exact: true,
            }),
          ).toHaveCount(0);
          await page.unroute("**/api/capabilities");
        }
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.deepEqual(errors, []);
        await context.close();
      }
      console.log(
        `Card token Settings journey passed: ${mode}, phone and desktop`,
      );
    } finally {
      await fixture.close();
    }
  }
} finally {
  await browser.close();
}
