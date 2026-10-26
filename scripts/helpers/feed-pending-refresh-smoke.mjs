import { expect } from "@playwright/test";

/** Hold the trailing-read window open so a second source-scoped read lands
 * inside it deterministically. Only timer delivery and display responses are
 * controlled; the real Feed listeners, requests and rendering run unchanged. */
export async function pendingSourceRefreshSmoke(context, origin, remoteSource) {
  const page = await context.newPage();
  let releaseLocal;
  const localGate = new Promise((resolve) => {
    releaseLocal = resolve;
  });
  let localReads = 0,
    localHeld = false;
  const feedRoute = (url) =>
    url.pathname.endsWith("/feed") &&
    ["working", "needs"].includes(url.searchParams.get("filter"));
  const refresh = (sources) =>
    page.evaluate((sources) => {
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: {
            sources,
            changes: sources.map((source) => ({
              source,
              events: [
                {
                  type: "invalidate",
                  scope: { kind: "collection", id: "feed" },
                },
              ],
            })),
          },
        }),
      );
    }, sources);
  try {
    await page.goto(origin + "/?filter=working");
    await expect(
      page
        .locator(".inbox-results .inbox-card")
        .filter({ hasText: "Remote task" }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".needs-stack .inbox-card")
        .filter({ hasText: "Remote approval task" }),
    ).toHaveCount(1);
    // Finish the fixture's initial socket reset/coalescing before controlling
    // the single notification under test. No database mutation follows it.
    await page.waitForTimeout(2500);
    await page.route(feedRoute, async (route) => {
      const url = new URL(route.request().url());
      const remote = url.pathname.includes("/agent-sources/");
      const filter = url.searchParams.get("filter");
      url.searchParams.delete("known"); // Ask the real route for a full display page.
      const response = await route.fetch({ url: url.href });
      const body = await response.json();
      if (remote) {
        body.items = body.items.map((item) => ({
          ...item,
          title:
            filter === "needs"
              ? "Remote pending approval update"
              : "Remote pending Feed update",
        }));
      } else if (filter === "working") {
        const count = ++localReads;
        body.items = body.items.map((item) =>
          item.conversation_id === "thread"
            ? {
                ...item,
                title: count === 1 ? "Local read one" : "Local read two",
              }
            : item,
        );
        if (count === 1) {
          localHeld = true;
          await localGate;
        }
      }
      await route.fulfill({ response, json: body });
    });
    await page.evaluate(() => {
      const set = window.setTimeout.bind(window),
        clear = window.clearTimeout.bind(window);
      const pending = new Map();
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 100 || typeof callback !== "function")
          return set(callback, delay, ...args);
        // The production catch-up remains scheduled until production clears it.
        const id = set(() => {
          pending.delete(id);
          callback(...args);
        }, 60_000);
        pending.set(id, () => callback(...args));
        return id;
      };
      window.clearTimeout = (id) => {
        pending.delete(id);
        clear(id);
      };
      window.__pendingFeedTimers = pending;
      window.__releaseFeedTimers = () => {
        window.setTimeout = set;
        window.clearTimeout = clear;
        for (const [id, callback] of pending) {
          clear(id);
          set(callback, 0);
        }
        pending.clear();
      };
    });
    await refresh([""]);
    await expect.poll(() => localHeld).toBe(true);
    await refresh([remoteSource]);
    releaseLocal();
    await expect
      .poll(() => page.evaluate(() => window.__pendingFeedTimers.size))
      .toBeGreaterThan(0);
    await refresh([""]);
    await expect(
      page
        .locator(".inbox-results .inbox-card")
        .filter({ hasText: "Local read two" }),
    ).toHaveCount(1);
    await page.evaluate(() => window.__releaseFeedTimers());
    await expect(
      page
        .locator(".inbox-results .inbox-card")
        .filter({ hasText: "Remote pending Feed update" }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".needs-stack .inbox-card")
        .filter({ hasText: "Remote pending approval update" }),
    ).toHaveCount(1);
  } finally {
    releaseLocal();
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
}
