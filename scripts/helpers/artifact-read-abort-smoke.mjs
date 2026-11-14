import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function artifactReadAbortSmoke(page, fixture) {
  const artifact = fixture.db
    .prepare("SELECT id,title FROM artifacts WHERE id=?")
    .get(fixture.artifacts[0]);
  let hold = false,
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
    await page.goto(fixture.base + "/?artifact=" + artifact.id);
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: artifact.title, exact: true }),
    ).toBeVisible();
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
  }
}
