import { expect } from "@playwright/test";
import { openSettings } from "./browser-ui.mjs";

// Browser-only discovery fixtures; the paired-host test covers actual dispatch.
export async function geminiSmoke(page, fixture, _engine, capture) {
  let enabled = false;
  let enableRequest;
  let authRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/runtimes/gemini/auth")) authRequests++;
  });
  await page.route("**/api/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), nativeHarnesses: true },
    });
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        projectPaths: [
          { folder_id: "first", path: "/projects/first" },
          { folder_id: "second", path: "/projects/second" },
        ],
      },
    }),
  );
  await page.route("**/api/workspace/runtimes?*", (route) =>
    route.fulfill({
      json: {
        computer: "Fixture computer",
        online: true,
        setup: "ready",
        runtimes: [
          {
            name: "gemini",
            installed: true,
            available: true,
            enabled,
            version: "0.64.0",
            help: "",
            authentication: "unknown",
            ...(enabled
              ? { project: "/projects/second", billing: "existing" }
              : {}),
          },
        ],
      },
    }),
  );
  await page.route("**/api/workspace/runtimes/gemini/upgrade", (route) =>
    route.fulfill({
      json: { canUpgrade: false, upgradeHelp: "Fixture installation" },
    }),
  );
  await page.route("**/api/workspace/runtimes/gemini/enable", (route) => {
    enableRequest = route.request().postDataJSON();
    enabled = true;
    return route.fulfill({ json: { name: "gemini" } });
  });
  await page.goto(fixture.base);
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await page
    .getByRole("button", { name: "Sign in to Gemini CLI", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Gemini CLI", exact: true });
  await expect(
    sheet.getByText("Sign in with Google", { exact: true }),
  ).toBeVisible();
  await sheet
    .getByLabel("Project directory for new runtimes")
    .selectOption("second");
  await expect(sheet.getByLabel("Billing policy for new runtimes")).toHaveCount(
    0,
  );
  await capture("gemini-cli-setup");
  await sheet
    .getByRole("button", { name: "Enable Gemini CLI", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Refresh Gemini CLI", exact: true }),
  ).toBeEnabled();
  expect(enableRequest).toEqual({ projectId: "second", billing: "existing" });
  expect(authRequests).toBe(0);
}
