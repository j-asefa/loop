import { expect } from "@playwright/test";
import assert from "node:assert/strict";

// Browser contract fixture. Runner authentication/ownership is exercised by
// runner-auth and managed-workspace tests; this sends no provider requests.
export async function nativeAuthBrowser({ browser, host }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  let enables = 0;
  const requests = [];
  try {
    await context.route("**/api/workspace/runtimes", (route) =>
      route.fulfill({
        json: {
          computer: "Fixture computer",
          online: true,
          setup: "ready",
          runtimes: [
            {
              name: "claude",
              backend: "hapi",
              environmentId: "auth-fixture",
              generation: 1,
              installed: true,
              available: true,
              enabled: false,
              authentication: "signed_in",
              billing: "subscription",
              help: "",
            },
          ],
        },
      }),
    );
    await context.route(
      "**/api/environments/auth-fixture/provider/claude/{status,providers}",
      (route) =>
        route.fulfill({
          json: {
            providers: [
              {
                id: "anthropic",
                name: "Claude",
                methods: [
                  { id: "oauth", label: "Claude account", type: "oauth" },
                ],
              },
            ],
          },
        }),
    );
    await context.route("**/api/workspace/runtimes/claude/enable", (route) => {
      enables++;
      return route.fulfill({
        status: 503,
        json: { error: "Could not load models. Try enabling again." },
      });
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await page.goto(host.pair().url);
    await page.getByRole("button", { name: "Pair and open Loop" }).click();
    await page
      .getByRole("button", { name: "Open settings", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: /Provider connections/ })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Provider connections",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "Manage Claude Code account", exact: true })
      .click();
    const login = page.getByRole("region", {
      name: "Claude Code account",
      exact: true,
    });
    await expect(login.getByRole("status")).toHaveText(
      /Signed in|Saved account/,
    );
    await expect(
      login.getByRole("button", { name: "Start sign-in", exact: true }),
    ).toHaveCount(0);
    await login
      .getByRole("button", { name: "Enable Claude Code", exact: true })
      .click();
    await expect(login.getByRole("alert")).toContainText(
      "Could not load models",
    );
    await expect(login.getByRole("status")).toHaveText(
      /Signed in|Saved account/,
    );
    await expect(
      login.getByRole("button", { name: "Enable Claude Code", exact: true }),
    ).toBeEnabled();
    assert.equal(enables, 1);
    assert(
      !requests.some((url) =>
        /\/api\/(?:environments\/[^/]+\/provider\/[^/]+|workspace\/harnesses\/[^/]+\/auth)\/(?:start|login|input|cancel)$/.test(url),
      ),
    );
    assert(
      requests.some((url) =>
        url.includes("/environments/auth-fixture/provider/claude/status"),
      ),
    );
  } finally {
    await context.close();
  }
}
