import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function artifactReadAbortSmoke(page, fixture) {
  const artifact = fixture.db
    .prepare("SELECT id,title FROM artifacts WHERE id=?")
    .get(fixture.artifacts[0]);
  let failReply = true,
    hold = false,
    release;
  const handler = async (route) => {
    const response = await route.fetch();
    const send = () => route.fulfill({ response }).catch(() => {});
    if (hold) {
      hold = false;
      release = send;
    } else await send();
  };
  await page.route("**/api/artifacts/" + artifact.id, handler);
  try {
    const missing = randomUUID();
    let missingReads = 0;
    const observe = (request) => {
      if (new URL(request.url()).pathname === "/api/artifacts/" + missing)
        missingReads++;
    };
    page.on("request", observe);
    const missingResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/artifacts/" + missing &&
        response.status() === 404,
    );
    await page.goto(fixture.base + "/?artifact=" + missing);
    await missingResponse;
    const missingNotice = page.locator(".toast .collection-read-error");
    await expect(missingNotice).toBeVisible();
    const before = missingReads;
    await missingNotice
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(missingNotice).toHaveCount(0);
    assert.equal(
      missingReads,
      before,
      "dismissing a permanent open failure issues no request",
    );
    page.off("request", observe);
    await page.goto(fixture.base + "/?artifact=" + artifact.id);
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: artifact.title, exact: true }),
    ).toBeVisible();
    await page.route("**/api/v1/cards/**", async (route) => {
      if (failReply)
        return route.fulfill({
          status: 503,
          json: { error: "Reply detail unavailable" },
        });
      return route.continue();
    });
    const viewer = page.getByRole("dialog");
    await viewer.getByRole("button", { name: "Reply", exact: true }).click();
    const notice = viewer
      .locator(".collection-read-error")
      .filter({ hasText: "Reply detail unavailable" });
    await expect(notice).toBeVisible();
    failReply = false;
    await notice.getByRole("button", { name: "Retry connection" }).click();
    await expect(
      page
        .locator("dialog[open]")
        .last()
        .getByLabel("Reply to agent", { exact: true }),
    ).toBeVisible();
    await page.unroute("**/api/v1/cards/**");
    hold = true;
    await page.goto(fixture.base + "/?artifact=" + artifact.id);
    await expect.poll(() => Boolean(release)).toBe(true);
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (r) =>
        new URL(r.url()).pathname === "/api/artifacts/" + artifact.id,
      timeout: 8000,
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-auth-expired")),
    );
    await aborted;
    assert(release, "the initial artifact lookup remained pending at expiry");
    await release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    if (release) await release();
    await page.unroute("**/api/artifacts/" + artifact.id, handler);
    await page.unroute("**/api/v1/cards/**");
  }
}
