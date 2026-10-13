import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { briefPaginationSmoke } from "./brief-pagination-smoke.mjs";

export async function briefHistorySmoke(
  page,
  fixture,
  capture,
  { project, root, ids },
) {
  const { db } = fixture;
  const sheet = page.locator("dialog.brief-sheet[open]");
  const close = () =>
    sheet.getByRole("button", { name: "Close", exact: true }).click();
  const record = page.getByRole("region", {
    name: "Project record",
    exact: true,
  });
  // Retired state is absent from the compact page; its evidence must come from the ledger.
  await record.getByRole("tab", { name: /^State/ }).click();
  await expect(record).toContainText("No current state recorded.");
  const full = () =>
    record
      .getByRole("button", { name: "View full state record", exact: true })
      .click();
  await full();
  await sheet.locator(".brief-item-open").first().click();
  await expect(sheet.locator(".brief-source a")).toHaveCount(2);
  await expect(sheet).toContainText("retired");
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith(root) && response.request().method() === "GET",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await refreshed;
  await page.evaluate(
    () => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    ),
  );
  await expect(sheet.locator(".brief-source a")).toHaveCount(2);
  await close();

  // Enough newer versions to put this item's changes beyond the first server page.
  const latest = db
    .prepare(
      "SELECT * FROM project_briefs WHERE project_id=? ORDER BY version DESC LIMIT 1",
    )
    .get(project);
  const fields = Object.keys(latest);
  const insert = db.prepare(
    `INSERT INTO project_briefs(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
  );
  for (let n = 1; n <= 55; n++) {
    const version = latest.version + n;
    const value = {
      ...latest,
      id: randomUUID(),
      version,
      idempotency_key: `history-fixture:${project}:${version}`,
      synth_at: Date.now(),
      view: JSON.stringify({
        ...JSON.parse(latest.view),
        changes: [
          {
            op: "removed",
            field: "decisions",
            id: "absent-from-compact",
            since_version: version,
            pinned: false,
          },
        ],
      }),
    };
    insert.run(...fields.map((field) => value[field]));
  }
  db.prepare("UPDATE brief_state SET current_version=? WHERE project_id=?").run(
    latest.version + 55,
    project,
  );
  await full();
  await sheet.locator(".brief-item-open").first().click();
  await sheet.getByRole("tab", { name: "History", exact: true }).click();
  await expect(sheet).toContainText(
    "No matching changes in these versions. Check older versions.",
  );
  await expect(
    sheet.getByRole("tab", { name: "History", exact: true }),
  ).toHaveText("History");
  let pages = 0;
  await page.route("**/brief/versions?before=*", (route) => {
    pages++;
    return route.fulfill({
      status: 503,
      json: { error: "Older history is temporarily unavailable" },
    });
  });
  await sheet
    .getByRole("button", { name: "Older versions", exact: true })
    .click();
  await expect(sheet.getByRole("alert")).toContainText(
    "Older history is temporarily unavailable",
  );
  await page.unroute("**/brief/versions?before=*");
  const count = (request) => {
    if (request.url().includes("/brief/versions?before=")) pages++;
  };
  page.on("request", count);
  await sheet
    .getByRole("button", { name: "Retry history", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(sheet.getByText("Version 2", { exact: true })).toBeVisible();
  assert.equal(
    pages,
    2,
    "A failed page and one retry; duplicate clicks cannot append twice",
  );
  page.off("request", count);
  const versions = await sheet
    .locator(".brief-history strong")
    .allTextContents();
  assert.equal(versions.length, new Set(versions).size);
  await capture("item-history-older");
  await close();
  await page.locator(".brief-changes").click();
  await expect(sheet.locator(".brief-history")).toContainText(
    "Removed · Decision",
  );
  await capture("full-history");
  const firstPage = await fixture.api(root + "/versions");
  const remainingPage = await fixture.api(
    root + "/versions?before=" + firstPage.before,
  );
  await briefPaginationSmoke(page, {
    pattern: "**/brief/versions?before=*",
    endpoint: root + "/versions",
    first: firstPage,
    remaining: remainingPage,
    more: sheet.getByRole("button", { name: "Older versions", exact: true }),
    rows: sheet.locator(".brief-history strong"),
    total: firstPage.items.length + remainingPage.items.length,
  });
  await close();

  // A closed item's late history cannot overwrite a freshly opened full history.
  let release,
    first = true;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/brief/versions", async (route) => {
    if (!first) return route.continue();
    first = false;
    await held;
    await route.fulfill({
      json: {
        items: [
          {
            version: 999999,
            at: 1,
            changes: [
              {
                op: "added",
                field: "state",
                id: ids.state[0],
                pinned: false,
                since_version: 1,
              },
            ],
          },
        ],
        before: null,
      },
    });
  });
  await full();
  await sheet.locator(".brief-item-open").first().click();
  await sheet.getByRole("tab", { name: "History", exact: true }).click();
  await expect(sheet.getByText("Loading history…")).toBeVisible();
  await close();
  await page.locator(".brief-changes").click();
  await expect(sheet.locator(".brief-history")).toContainText(
    "Removed · Decision",
  );
  const response = page.waitForResponse((r) =>
    r.url().endsWith(root + "/versions"),
  );
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(sheet).not.toContainText("999999");
  await page.unroute("**/brief/versions");
  await close();
}
