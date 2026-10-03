import { expect } from "@playwright/test";
import assert from "node:assert/strict";

// Browser fixture for explicit runner checks; no provider account is contacted.
export async function environmentRuntimeBrowser({ browser, host }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    const environments = [
      { id: "fixture-native", name: "Laptop", state: "online" },
      { id: "fixture-docker", name: "Docker", state: "offline" },
    ];
    let checks = 0;
    await context.route("**/api/environments", (route) =>
      route.fulfill({ json: environments }),
    );
    await context.route("**/api/environments/*/runtimes", (route) => {
      assert(route.request().url().endsWith("/fixture-native/runtimes"));
      assert.equal(route.request().method(), "GET");
      if (++checks === 1)
        return route.fulfill({
          status: 503,
          json: { error: "private runner diagnostic" },
        });
      return route.fulfill({
        json: {
          runtimes: [
            {
              flavor: "codex",
              installed: true,
              authentication: "unknown",
              billing: "subscription",
              checkedAt: Date.now(),
            },
            {
              flavor: "claude",
              installed: false,
              authentication: "signed_out",
              billing: "subscription",
              checkedAt: Date.now(),
            },
          ],
        },
      });
    });
    const page = await context.newPage();
    await page.goto(host.pair().url);
    await page.getByRole("button", { name: "Pair and open Loop" }).click();
    await page
      .getByRole("button", { name: "New agent", exact: true })
      .first()
      .click();
    const sheet = page.getByRole("dialog", { name: "Meet your next agent" });
    // Runtime setup is collapsed under one disclosure once a runtime is
    // connected; managed environments are nested inside it.
    await sheet
      .getByText("Runtimes and execution environments", { exact: true })
      .click();
    await sheet
      .getByText("Managed execution environments", { exact: true })
      .click();
    const laptop = sheet.getByRole("region", { name: "Laptop runtimes" });
    const docker = sheet.getByRole("region", { name: "Docker runtimes" });
    await expect(
      laptop.getByText("Installation and sign-in have not been checked."),
    ).toBeVisible();
    await expect(
      docker.getByRole("button", { name: "Check installation and sign-in" }),
    ).toBeDisabled();
    assert.equal(checks, 0);
    await laptop
      .getByRole("button", { name: "Check installation and sign-in" })
      .click();
    await expect(laptop.getByRole("status")).toHaveText(
      "Runtime check unavailable. Installation and sign-in are unknown.",
    );
    await expect(sheet.getByText("private runner diagnostic")).toHaveCount(0);
    await laptop
      .getByRole("button", { name: "Check installation and sign-in" })
      .click();
    await expect(
      laptop.getByText("Executable available · Sign-in unknown"),
    ).toBeVisible();
    await expect(
      laptop.getByText("Executable unavailable · Sign-in required"),
    ).toBeVisible();
    await expect(laptop.getByRole("status")).toHaveCount(0);
    assert.equal(checks, 2);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "New agent", exact: true })
      .first()
      .click();
    // Runtime setup is collapsed under one disclosure once a runtime is
    // connected; managed environments are nested inside it.
    await sheet
      .getByText("Runtimes and execution environments", { exact: true })
      .click();
    await sheet
      .getByText("Managed execution environments", { exact: true })
      .click();
    await expect(
      laptop.getByText("Installation and sign-in have not been checked."),
    ).toBeVisible();
    assert.equal(checks, 2);
  } finally {
    await context.close();
  }
}
