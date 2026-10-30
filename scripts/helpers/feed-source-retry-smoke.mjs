import { expect } from "@playwright/test";
import { temporaryPageRoute } from "./temporary-page-route.mjs";

/** A rate-limited source must recover without holding healthy Feed/Needs reads. */
export async function sourceRetryFeedSmoke(
  newPage,
  origin,
  remoteSource,
  closePage,
) {
  const page = await newPage();
  let stopFeedRoute = async () => {};
  let refusing = true,
    localVersion = 1,
    remoteWorkingAttempts = 0;
  const feedRoute = (url) =>
    url.pathname.endsWith("/feed") &&
    ["working", "needs"].includes(url.searchParams.get("filter"));
  const refresh = (sources) =>
    page.evaluate((sources) => {
      window.dispatchEvent(
        new CustomEvent("loop55-workspace-change", {
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
  const card = (surface, title) =>
    page.locator(`${surface} .inbox-card`).filter({ hasText: title });
  try {
    await page.goto(origin + "/?filter=working");
    await expect(card(".inbox-results", "Remote task")).toHaveCount(1);
    await expect(card(".needs-stack", "Remote approval task")).toHaveCount(1);
    await page.waitForTimeout(2500);
    stopFeedRoute = await temporaryPageRoute(page, feedRoute, async (route) => {
      const url = new URL(route.request().url());
      const remote = url.pathname.includes("/agent-sources/");
      const filter = url.searchParams.get("filter");
      if (remote && filter === "working") remoteWorkingAttempts++;
      if (remote && refusing)
        return route.fulfill({
          status: 429,
          headers: { "Retry-After": "2" },
          json: { error: "Fixture source cooling down" },
        });
      url.searchParams.delete("known");
      const response = await route.fetch({ url: url.href });
      const body = await response.json();
      body.items = body.items.map((item) =>
        remote
          ? {
              ...item,
              title:
                filter === "needs"
                  ? "Recovered remote Needs"
                  : "Recovered remote Feed",
            }
          : item.conversation_id ===
              (filter === "needs" ? "needs-thread" : "thread")
            ? {
                ...item,
                title: `Healthy local ${filter} ${localVersion}`,
                // Local awaiting approvals render in the separate approval slot.
                // Present a failed thread so this assertion observes Feed Needs.
                ...(filter === "needs"
                  ? {
                      run: { ...item.run, state: "failed" },
                      next_action: null,
                      pending_approvals: 0,
                    }
                  : {}),
              }
            : item,
      );
      await route.fulfill({ response, json: body });
    });
    await refresh(["", remoteSource]);
    await expect.poll(() => remoteWorkingAttempts).toBeGreaterThan(0);
    await expect(card(".inbox-results", "Healthy local working 1")).toHaveCount(
      1,
    );
    await expect(card(".needs-stack", "Healthy local needs 1")).toHaveCount(1);
    await expect(card(".needs-stack", "Remote approval task")).toHaveCount(1);
    await expect(
      page.getByText("Some environments could not refresh.", { exact: false }),
    ).toBeVisible();
    localVersion = 2;
    await refresh([""]);
    await expect(card(".inbox-results", "Healthy local working 2")).toHaveCount(
      1,
    );
    await expect(card(".needs-stack", "Healthy local needs 2")).toHaveCount(1);
    await expect.poll(() => remoteWorkingAttempts).toBeGreaterThan(1);
    // Recovery gets no new invalidation or database mutation.
    refusing = false;
    await expect(card(".inbox-results", "Recovered remote Feed")).toHaveCount(
      1,
    );
    await expect(card(".needs-stack", "Recovered remote Needs")).toHaveCount(1);
    await expect(
      page.getByText("Some environments could not refresh.", { exact: false }),
    ).toHaveCount(0);
  } finally {
    await stopFeedRoute();
    await closePage(page);
  }
}
