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
  },
) {
  let reads = 0;
  let blocked = true;
  const handler = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    if (blocked)
      await route.fulfill({
        status: 503,
        json: { error: "Collection recovery fixture" },
      });
    else await route.continue();
  };
  // Let notifications from preceding fixture mutations settle first.
  await page.waitForTimeout(2500);
  await page.route(match, handler);
  try {
    await start();
    const marker = scope
      .locator(".collection-read-error")
      .filter({ hasText: errorText });
    await expect(marker).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => reads, { timeout: 10_000 }).toBe(3);
    assert.equal(reads, 3, "One initial GET and the two existing retries");
    await page.waitForTimeout(2100);
    assert.equal(reads, 3, "Exhaustion stops background recovery");
    const retry = marker.getByRole("button", {
      name: "Retry connection",
      exact: true,
    });
    await retry.click();
    await expect.poll(() => reads).toBe(4);
    await expect(retry).toBeEnabled();
    await page.waitForTimeout(6500);
    assert.equal(
      reads,
      4,
      "The manual retry must not start another retry budget",
    );
    await expect(marker).toBeVisible();
    blocked = false;
    if (recovered) await recovered();
    else await retry.click();
    await expect(marker).toHaveCount(0);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(5);
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

// Legacy sources retain their existing fallback timers. A tick must neither
// interrupt an active read nor hide its exhausted notice before recovery.
export async function legacyFallbackRecovery(browser, fixture) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  await fixture.pair(page.context());
  let legacyFrames = 0;
  try {
    // The companion's sources share one multiplexed socket; downgrade the
    // capabilities each source frame announces.
    await page.routeWebSocket("**/api/events/multiplex/ws", (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        const envelope = JSON.parse(message.toString());
        const frame = envelope.frame ?? {};
        if (frame.v === 3 && frame.capabilities) {
          frame.capabilities = {
            invalidations: "partial",
            deadlines: false,
            transcript: "snapshot",
            feed: "snapshot",
            results: "snapshot",
          };
          legacyFrames++;
        }
        route.send(JSON.stringify(envelope));
      });
    });
    // Saved exercises useCards' separate legacy timer. Seed through the real
    // save endpoint, then hold an unchanged successful delta after exhaustion.
    const saved = fixture.db
      .prepare("SELECT id FROM messages WHERE role='assistant' LIMIT 1")
      .get();
    await fixture.api(`/messages/${saved.id}/saved`, {});
    await page.goto(fixture.base);
    await expect.poll(() => legacyFrames).toBeGreaterThan(0);
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    const profile = page.getByRole("region", {
      name: "Your profile",
      exact: true,
    });
    await profile.getByRole("tab", { name: "Saved", exact: true }).click();
    const rows = profile.locator(".saved-item");
    await expect(rows).not.toHaveCount(0);
    await page.waitForTimeout(2500);
    const count = await rows.count();
    const finishCards = Promise.withResolvers();
    let cardReads = 0,
      cardsRecovered = false;
    const cardsMatch = (url) =>
      url.pathname === "/api/v1/cards/changes" &&
      url.searchParams.get("view") === "saved";
    const cardsHandler = async (route) => {
      if (cardsRecovered) return route.continue();
      cardReads++;
      if (cardReads <= 3)
        return route.fulfill({
          status: 503,
          json: { error: "Saved fallback outage" },
        });
      await finishCards.promise;
      return route.continue();
    };
    await page.route(cardsMatch, cardsHandler);
    try {
      const notice = profile.locator(".collection-read-error");
      await expect(notice).toContainText("Saved fallback outage", {
        timeout: 12_000,
      });
      await expect.poll(() => cardReads).toBe(4);
      await expect(notice).toBeVisible();
      await expect(
        notice.getByRole("button", { name: "Retry connection", exact: true }),
      ).toBeDisabled();
      await page.waitForTimeout(4100);
      expect(cardReads).toBe(4);
      await expect(rows).toHaveCount(count);
      cardsRecovered = true;
      finishCards.resolve();
      await expect(notice).toHaveCount(0);
      await expect(rows).toHaveCount(count);
    } finally {
      finishCards.resolve();
      await page.unroute(cardsMatch, cardsHandler);
    }

    // These views also receive the parent's 15 s legacy revision tick. Hold
    // their initial real response past that tick; it must still reach the UI.
    for (const [tab, path] of [
      ["Reminders", "/api/later"],
      ["Scheduled", "/api/scheduled-sends"],
    ]) {
      const pending = Promise.withResolvers();
      let requests = 0,
        initial;
      const match = (url) => url.pathname === path;
      const handler = async (route) => {
        requests++;
        initial ??= route.request();
        await pending.promise;
        await route.continue();
      };
      await page.route(match, handler);
      const later = page.getByRole("region", { name: "Later", exact: true });
      try {
        await profile.getByRole("tab", { name: new RegExp("^" + tab) }).click();
        await expect.poll(() => requests).toBe(1);
        await expect(
          later.getByText("Loading…", { exact: true }),
        ).toBeVisible();
        await page.waitForTimeout(17_000);
        expect(requests).toBe(1);
        pending.resolve();
        const response = await initial.response();
        expect(response?.status()).toBe(200);
        await response.finished();
        await expect(later.getByText("Loading…", { exact: true })).toHaveCount(
          0,
        );
      } finally {
        pending.resolve();
        await page.unroute(match, handler);
      }
    }
  } finally {
    await page.close();
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
