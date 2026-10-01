import { expect } from "@playwright/test";

export async function messageNavigationSmoke(page, fixture) {
  const agent = fixture.agents[0];
  const endpoint = `${fixture.base}/api/agents/${agent.id}/messages`;
  for (const navigation of ["back", "reload"]) {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page
      .locator(".agent-strip")
      .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) })
      .click();
    // Profiles restore their selected tab; start the controlled read from Results.
    await page.getByRole("tab", { name: "Results", exact: true }).click();
    await page.waitForLoadState("networkidle");
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let captured;
    const ready = new Promise((resolve) => (captured = resolve));
    let delivered;
    const finished = new Promise((resolve) => (delivered = resolve));
    const hold = async (route) => {
      const response = await route.fetch();
      captured();
      await held;
      try {
        await route.fulfill({ response });
      } finally {
        delivered();
      }
    };
    await page.route(endpoint, hold, { times: 1 });
    try {
      await page.evaluate((url) => {
        window.__messageReadCancelled = 0;
        const fetch = window.fetch;
        window.fetch = (input, options) => {
          if (new URL(String(input), location.href).href === url)
            options?.signal?.addEventListener("abort", () => {
              window.__messageReadCancelled++;
            });
          return fetch(input, options);
        };
      }, endpoint);
      await page.getByRole("tab", { name: "Messages", exact: true }).click();
      await ready;
      if (navigation === "back") {
        // The profile's Back button now always reads "Back" (to the Feed).
        await page.getByRole("button", { name: "Back", exact: true }).click();
        // The fetch signal is authoritative here. Playwright can leave a
        // routed request pending until its held response is released.
        await expect
          .poll(() => page.evaluate(() => window.__messageReadCancelled))
          .toBeGreaterThan(0);
      } else await page.goto(fixture.base);
      await expect(page.locator(".profile-head")).toHaveCount(0);
      await expect(page.locator(".your-agents")).toBeVisible();
    } finally {
      release();
      await finished;
      await page.unroute(endpoint, hold);
    }
    await page.waitForLoadState("networkidle");
  }
  console.log("Leaving a profile cancels pending message reads cleanly");
}
