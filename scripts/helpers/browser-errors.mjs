import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export const signalCollection = (page, collection) =>
  page.evaluate((id) => {
    window.dispatchEvent(
      new CustomEvent("loop-workspace-change", {
        detail: {
          sources: [""],
          changes: [
            {
              source: "",
              events: [
                { type: "invalidate", scope: { kind: "collection", id } },
              ],
            },
          ],
        },
      }),
    );
  }, collection);

// Exercise the mounted production view, including its automatic backoff and
// button. No synthetic successful response or replacement collection reader.
export async function collectionReadRecovery(
  page,
  {
    route: match,
    start,
    scope = page,
    recovered,
    change,
    errorText = "Collection recovery fixture",
    slowRefresh = false,
  },
) {
  let reads = 0;
  let blocked = true;
  let status = 503;
  let delay = 0;
  const handler = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    if (blocked)
      await route.fulfill({
        status,
        json: { error: "Collection recovery fixture" },
      });
    else {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await route.continue();
    }
  };
  // Let notifications from preceding fixture mutations settle first.
  await page.waitForTimeout(2500);
  await page.route(match, handler);
  try {
    await start();
    const marker = scope
      .locator(".collection-read-error")
      .filter({ hasText: errorText });
    // Exhaustion registers with the shared watcher, including when its event
    // response is empty. No wake event or manual click should be necessary.
    await expect.poll(() => reads, { timeout: 20_000 }).toBeGreaterThan(3);
    blocked = false;
    const recoveryReads = reads;
    await expect
      .poll(() => reads, { timeout: 10_000 })
      .toBeGreaterThan(recoveryReads);
    await expect(marker).toHaveCount(0);

    if (slowRefresh) {
      // A healthy slow read must finish despite unrelated recovery broadcasts.
      await page.waitForTimeout(500);
      delay = 4500;
      const beforeSlow = reads;
      const completed = page.waitForResponse(
        (response) => match(new URL(response.url())) && response.ok(),
      );
      void completed.catch(() => {});
      await start();
      await expect.poll(() => reads).toBe(beforeSlow + 1);
      for (let n = 0; n < 5; n++) {
        await signalCollection(page, "all");
        await page.waitForTimeout(500);
      }
      assert.equal(
        reads,
        beforeSlow + 1,
        "Invalidations let the in-flight read finish",
      );
      delay = 0;
      await completed;
      await expect.poll(() => reads).toBe(beforeSlow + 2);
      await page.waitForTimeout(500);
      assert.equal(
        reads,
        beforeSlow + 2,
        "Concurrent invalidations coalesce to one trailing read",
      );
    }

    // Permanent refusals remain visible and require an explicit retry.
    status = 403;
    blocked = true;
    const beforeRefusal = reads;
    await start();
    await expect(marker).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => reads).toBe(beforeRefusal + 1);
    await page.waitForTimeout(2100);
    assert.equal(
      reads,
      beforeRefusal + 1,
      "Permanent refusals do not recover automatically",
    );
    const retry = marker.getByRole("button", {
      name: "Retry connection",
      exact: true,
    });
    await retry.click();
    await expect.poll(() => reads).toBe(beforeRefusal + 2);
    await expect(retry).toBeEnabled();
    await page.waitForTimeout(6500);
    assert.equal(
      reads,
      beforeRefusal + 2,
      "The manual retry must not start another retry budget",
    );
    await expect(marker).toBeVisible();
    blocked = false;
    if (recovered) await recovered();
    else await retry.click();
    await expect(marker).toHaveCount(0);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(beforeRefusal + 3);
    if (change) {
      const before = reads;
      await change();
      await expect.poll(() => reads).toBe(before + 1);
      // The parent's coalesced revision follows the direct subscription.
      await page.waitForTimeout(750);
      assert.equal(reads, before + 1, "One change issues one healthy read");
    }
  } finally {
    await page.unroute(match, handler);
  }
}

// Playwright's WebKit error parser can shorten Error.message at the URL's
// colon. The first stack line retains the complete browser diagnostic.
export function isWebKitNavigationFetchError(engine, error, base) {
  if (engine !== "webkit") return false;
  const diagnostic = error.stack?.split("\n", 1)[0] || error.message;
  return (
    diagnostic.startsWith(`Fetch API cannot load ${base}/api/`) &&
    diagnostic.endsWith(" due to access control checks.")
  );
}
