import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function teamFeedVisibilitySmoke(page, fixture, engine, capture) {
  const team = (await fixture.api("/teams"))[0];
  const target = fixture.conversations[0];
  fixture.db
    .prepare("UPDATE conversations SET team_id=? WHERE id=?")
    .run(team.id, target.id);
  const row = page.locator(`.inbox-row[aria-label^="${target.title}"]`);
  const dialog = () => page.locator("dialog[open]").last();
  const toggle = () =>
    dialog().getByRole("checkbox", {
      name: /^Show results and threads in feed/,
    });
  const filters = page.getByRole("tablist", { name: "Show", exact: true });
  const close = async () => {
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loop55Sheet !== true);
  };
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Filter by team: All teams" }).click();
  await dialog()
    .getByRole("checkbox", { name: team.name, exact: true })
    .check();
  await expect(toggle()).toBeChecked();
  await toggle().click();
  await expect(toggle()).toBeEnabled();
  await expect(toggle()).not.toBeChecked();
  assert.equal(
    (await fixture.api("/teams")).find((t) => t.id === team.id)
      .hide_results_from_feed,
    1,
  );
  await expect(
    dialog().getByText(/Results and threads hidden from All teams/),
  ).toBeVisible();
  await capture("hidden-team-setting");
  await close();
  // Selecting the hidden team is an explicit way back to its results.
  await expect(row).toBeVisible();
  await filters.getByRole("tab", { name: "Threads", exact: true }).click();
  await expect(row).toBeVisible();
  await page
    .getByRole("button", { name: `Filter by team: ${team.name}` })
    .click();
  await dialog()
    .getByRole("button", { name: /^All teams/ })
    .click();
  await close();
  await expect(row).toHaveCount(0);
  await page.reload({ waitUntil: "networkidle" });
  await expect(row).toHaveCount(0);
  await filters.getByRole("tab", { name: "Done", exact: true }).click();
  await expect(row).toHaveCount(0);
  await filters.getByRole("tab", { name: "Threads", exact: true }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page
    .locator(".projects-view")
    .getByRole("button", { name: /^Agent teams/ })
    .click();
  const entry = dialog()
    .locator(".team-directory-item")
    .filter({ has: page.getByText(team.name, { exact: true }) });
  const directoryToggle = entry.getByRole("checkbox", {
    name: /^Show results and threads in feed/,
  });
  await expect(directoryToggle).not.toBeChecked();
  // A rejected save leaves the preference intact and can be retried.
  await page.route(`**/api/teams/${team.id}/feed-visibility`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Could not save visibility" }),
    }),
  );
  await directoryToggle.click();
  await expect(entry.getByRole("alert")).toHaveText(
    "Could not save visibility",
  );
  await expect(directoryToggle).not.toBeChecked();
  await page.unroute(`**/api/teams/${team.id}/feed-visibility`);
  await directoryToggle.click();
  await expect(directoryToggle).toBeEnabled();
  await expect(directoryToggle).toBeChecked();
  await expect(entry.getByRole("alert")).toHaveCount(0);
  await capture("team-directory-setting");
  await close();
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(row).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(row).toBeVisible();
  await filters.getByRole("tab", { name: "Done", exact: true }).click();
  await expect(row).toBeVisible();
}
