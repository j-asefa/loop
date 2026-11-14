import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function personalProfileReaderSmoke(page, fixture) {
  let submitted = false,
    failed = true,
    hold = false,
    reads = 0,
    release;
  const handler = async (route) => {
    if (route.request().method() !== "GET") {
      submitted = true;
      return route.continue();
    }
    reads++;
    if (failed)
      return route.fulfill({
        status: 400,
        json: { error: "Profile temporarily unavailable" },
      });
    const response = await route.fetch();
    const body = {
      ...(await response.json()),
      ...(submitted ? {} : { display_name: "Original profile" }),
    };
    const send = () => route.fulfill({ response, json: body }).catch(() => {});
    if (hold) {
      hold = false;
      release = send;
    } else await send();
  };
  await page.route("**/api/me/profile", handler);
  try {
    await page.goto(fixture.base + "/?page=profile");
    const profile = page.getByRole("region", { name: "Your profile" });
    const notice = profile
      .locator(".collection-read-error")
      .filter({ hasText: "Profile temporarily unavailable" });
    await expect(notice).toBeVisible();
    await expect(
      profile.getByRole("button", { name: "Edit profile", exact: true }),
    ).toBeDisabled();
    const before = reads;
    await notice.getByRole("button", { name: "Retry connection" }).click();
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(
      notice.getByRole("button", { name: "Retry connection" }),
    ).toBeEnabled();
    failed = false;
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("loop-workspace-change")),
    );
    await expect(profile.locator("h1")).toHaveText("Original profile");
    await expect(notice).toHaveCount(0);
    hold = true;
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("loop-workspace-change")),
    );
    await expect.poll(() => Boolean(release)).toBe(true);
    await profile
      .getByRole("button", { name: "Edit profile", exact: true })
      .click();
    const sheet = page.getByRole("dialog", { name: "Edit profile" });
    await sheet.getByLabel("Name", { exact: true }).fill("Saved profile");
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (r) =>
        new URL(r.url()).pathname === "/api/me/profile" && r.method() === "GET",
    });
    await sheet
      .getByRole("button", { name: "Save profile", exact: true })
      .click();
    await aborted;
    await expect(profile.locator("h1")).toHaveText("Saved profile");
    assert(release, "the old response was held across the successful PUT");
    await release();
    await expect(profile.locator("h1")).toHaveText("Saved profile");
  } finally {
    if (release) await release();
    await page.unroute("**/api/me/profile", handler);
  }
}
