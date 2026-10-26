import { expect } from "@playwright/test";
import { openAgentProfile } from "./browser-ui.mjs";

export async function workspaceRecoverySmoke(page, fixture) {
  // Keep the outage observable until the assertion: a concurrent background
  // refresh can otherwise recover from a single aborted request before polling
  // sees the warning.
  let failBootstrap = true;
  const bootstrap = (route) =>
    failBootstrap ? route.abort("failed") : route.continue();
  const runsPattern = /\/api\/runs\?active=1(?:&|$)/;
  let failRuns = true;
  const runs = (route) => (failRuns ? route.abort("failed") : route.continue());
  try {
    await page.route("**/api/bootstrap", bootstrap);
    await page.goto(fixture.base);
    await expect(page.locator(".workspace-load-status")).toContainText(
      "Couldn’t refresh your agents and projects.",
    );
    await expect(page.locator(".toast.error")).toHaveCount(0);
    // No manual reload: retry the failed opening read and clear only its notice.
    failBootstrap = false;
    await expect(page.locator(".your-agents")).toBeVisible({ timeout: 12000 });
    await expect(page.locator(".workspace-load-status")).toHaveCount(0);
    await page.unroute("**/api/bootstrap", bootstrap);

    await page.route(runsPattern, runs);
    await page.reload();
    await expect(page.locator(".workspace-load-status")).toContainText(
      "Couldn’t refresh task status.",
    );
    await page.getByRole("button", { name: "Retry now", exact: true }).click();
    await expect(page.locator(".workspace-load-status")).toContainText(
      "Couldn’t refresh task status.",
    );
    // An unrelated failed action must survive recovery of background reads.
    const actionPattern = "**/api/results/*";
    const failedAction = (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            json: { error: "Fixture archive unavailable" },
          })
        : route.continue();
    await page.route(actionPattern, failedAction);
    // Result cards live on agent profiles; archive is in the card's
    // "More actions" menu.
    await openAgentProfile(page, fixture.agents[0].name);
    await page
      .locator(".feed-card:not(.inbox-card)")
      .first()
      .getByRole("button", { name: "More actions", exact: true })
      .click();
    await page
      .locator("dialog[open]")
      .last()
      .getByRole("menuitem", { name: /^Archive/ })
      .click();
    await expect(page.locator(".toast.error")).toContainText(
      "Fixture archive unavailable",
    );
    failRuns = false;
    await page.getByRole("button", { name: "Retry now", exact: true }).click();
    await expect(page.locator(".workspace-load-status")).toHaveCount(0);
    await expect(page.locator(".toast.error")).toContainText(
      "Fixture archive unavailable",
    );
    await page
      .locator(".toast.error")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await page.unroute(actionPattern, failedAction);
    console.log(
      "Opening network failures recover without stale warnings or lost action errors",
    );
  } finally {
    await page.unroute("**/api/bootstrap", bootstrap);
    await page.unroute(runsPattern, runs);
    await page.unroute("**/api/results/*");
  }
}
