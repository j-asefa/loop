import { expect } from "@playwright/test";
import { temporaryPageRoute } from "./temporary-page-route.mjs";

/** A held local response must not delay remote Feed/Needs updates. Another
 * local notification must survive that read without replacing the remote rows.
 * Only HTTP display responses are controlled; production scheduling runs. */
export async function pendingSourceRefreshSmoke(
  newPage,
  origin,
  remoteSource,
  closePage,
) {
  const page = await newPage();
  let stopFeedRoute = async () => {};
  let releaseLocal;
  const localGate = new Promise((resolve) => {
    releaseLocal = resolve;
  });
  let localReads = 0,
    localHeld = false;
  const feedRoute = (url) =>
    url.pathname.endsWith("/feed") &&
    ["working", "needs"].includes(url.searchParams.get("filter"));
  const startupReads = new Set();
  let lastFeedActivity = Date.now();
  page.on("request", (request) => {
    if (feedRoute(new URL(request.url()))) {
      startupReads.add(request);
      lastFeedActivity = Date.now();
    }
  });
  const finishRead = (request) => {
    if (startupReads.delete(request)) lastFeedActivity = Date.now();
  };
  page.on("requestfinished", finishRead);
  page.on("requestfailed", finishRead);
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
    await page.addInitScript(() => {
      window.__pendingFeedInitialSources = new Set();
      window.addEventListener("loop-workspace-change", (event) => {
        for (const change of event.detail?.changes ?? [])
          if (
            change.events.some(
              (event) =>
                event.type === "invalidate" &&
                event.scope?.kind === "collection" &&
                event.scope.id === "all",
            )
          )
            window.__pendingFeedInitialSources.add(change.source);
      });
    });
    await page.goto(origin + "/?filter=working");
    await expect(
      page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: "Remote task" }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".needs-stack .feed-item-card")
        .filter({ hasText: "Remote approval task" }),
    ).toHaveCount(1);
    // Both sources must publish their initial reset and finish its reads before
    // controlling the next notification. A fixed delay can end while the
    // remote source is still waiting for the broad coalescing deadline.
    await page.waitForFunction(
      (remote) =>
        ["", remote].every((source) =>
          window.__pendingFeedInitialSources.has(source),
        ),
      remoteSource,
      { timeout: 8000 },
    );
    await expect
      .poll(
        () => startupReads.size === 0 && Date.now() - lastFeedActivity >= 250,
      )
      .toBe(true);
    stopFeedRoute = await temporaryPageRoute(page, feedRoute, async (route) => {
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
    await refresh([""]);
    await expect.poll(() => localHeld).toBe(true);
    await refresh([remoteSource]);
    await expect(
      page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: "Remote pending Feed update" }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".needs-stack .feed-item-card")
        .filter({ hasText: "Remote pending approval update" }),
    ).toHaveCount(1);
    await refresh([""]);
    releaseLocal();
    await expect(
      page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: "Local read two" }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: "Remote pending Feed update" }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".needs-stack .feed-item-card")
        .filter({ hasText: "Remote pending approval update" }),
    ).toHaveCount(1);
  } finally {
    releaseLocal();
    await stopFeedRoute();
    await closePage(page);
  }
}
