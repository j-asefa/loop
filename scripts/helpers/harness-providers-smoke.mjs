import { expect } from "@playwright/test";
import { openSettings } from "./browser-ui.mjs";

// Browser fixtures only: no credentials, real provider or inference calls.
export async function harnessProvidersSmoke(page, fixture, _engine, capture) {
  let view = {
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        configured: true,
        source: "stored",
        credentialType: "api",
        removable: true,
        methods: [{ id: "key", label: "API key", type: "api" }],
      },
    ],
    models: [
      { id: "native-default", name: "Runtime default" },
      ...Array.from({ length: 355 }, (_, i) => ({
        id: `openrouter/fixture-${i}`,
        name: `Fixture model ${i}`,
      })),
    ],
    agents: [],
    billing: "existing",
    enabled: false,
    updatedAt: Date.now(),
  };
  let releaseRefresh;
  let refreshResult = "success";
  const refreshCommands = [];
  await page.route("**/api/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), nativeHarnesses: true },
    });
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        harnesses: [],
        nativeProcesses: 0,
        concurrency: 1,
        hostLifetime: "foreground",
        tunnelOrigin: "",
        projectPaths: [{ folder_id: "first", path: "/projects/first" }],
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
            name: "pi",
            backend: "direct",
            installed: true,
            available: true,
            enabled: view.enabled,
            version: "0.80.0",
            help: "",
            authentication: "previously_verified",
            project: "/projects/first",
            billing: "existing",
          },
        ],
      },
    }),
  );
  await page.route("**/api/workspace/runtimes/pi/upgrade", (route) =>
    route.fulfill({
      json: {
        upgrade: null,
        canUpgrade: false,
        upgradeHelp: "Fixture harness",
      },
    }),
  );
  await page.route("**/api/workspace/runtimes/pi/providers?*", (route) =>
    route.fulfill({ json: view }),
  );
  await page.route(
    "**/api/workspace/runtimes/pi/providers/refresh",
    async (route) => {
      refreshCommands.push(route.request().postDataJSON());
      await new Promise((resolve) => {
        releaseRefresh = resolve;
      });
      if (refreshResult === "http-error")
        return route.fulfill({
          status: 503,
          json: { error: "Could not reach Pi." },
        });
      view = {
        ...view,
        enabled: refreshResult === "success",
        updatedAt: Date.now(),
        syncError:
          refreshResult === "sync-error"
            ? "Pi could not refresh its models."
            : undefined,
      };
      await route.fulfill({ json: view });
    },
  );
  await page.goto(fixture.base);
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await page
    .getByRole("button", { name: "Manage Pi providers", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Pi", exact: true });
  const status = sheet.locator(".harness-connection-status");
  const notice = sheet.locator(".harness-refresh-confirmation");
  await expect(status).toContainText("Pi is not enabled in Loop55");
  await expect(status).not.toHaveClass(/connected/);
  await expect(status).toContainText("355 models found.");
  const enable = sheet.getByRole("button", { name: "Enable Pi", exact: true });
  await enable.click();
  await expect(
    sheet.getByRole("button", { name: "Refreshing…", exact: true }),
  ).toBeDisabled();
  await expect.poll(() => refreshCommands.length).toBe(1);
  releaseRefresh();
  await expect(notice).toHaveText("Pi refreshed successfully.");
  await expect(status).toContainText("Pi is enabled in Loop55");
  await expect(status).toHaveClass(/connected/);
  await expect(status).toContainText("355 models found.");
  await expect(status).toContainText(
    "You can choose Pi when creating an agent.",
  );
  await expect(
    sheet.getByRole("button", { name: "Refresh Pi", exact: true }),
  ).toBeEnabled();
  expect(refreshCommands[0]).toMatchObject({
    projectId: "first",
    useProviderBilling: false,
  });
  await status.scrollIntoViewIfNeeded();
  await capture("pi-enabled");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await capture("pi-enabled-dark");
  await page.setViewportSize({ width: 320, height: 640 });
  expect(
    await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await capture("pi-enabled-320");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

  // A failed refresh must clear the previous success, even with an HTTP 200.
  refreshResult = "sync-error";
  await sheet.getByRole("button", { name: "Refresh Pi", exact: true }).click();
  await expect.poll(() => refreshCommands.length).toBe(2);
  await expect(notice).toBeEmpty();
  releaseRefresh();
  await expect(sheet.getByRole("alert")).toContainText(
    "Pi could not refresh its models.",
  );
  await expect(status).not.toHaveClass(/connected/);
  await expect(status).toContainText("Pi is not enabled in Loop55");
  await expect(notice).toBeEmpty();
  await expect(enable).toBeEnabled();

  refreshResult = "http-error";
  await enable.click();
  await expect.poll(() => refreshCommands.length).toBe(3);
  releaseRefresh();
  await expect(
    sheet.getByRole("alert").filter({ hasText: "Could not reach Pi." }),
  ).toBeVisible();
  await expect(notice).toBeEmpty();
  await expect(enable).toBeEnabled();

  refreshResult = "success";
  await enable.click();
  await expect.poll(() => refreshCommands.length).toBe(4);
  releaseRefresh();
  await expect(notice).toHaveText("Pi refreshed successfully.");
  await expect(sheet.getByRole("alert")).toHaveCount(0);
  expect(new Set(refreshCommands.map((c) => c.commandId)).size).toBe(4);
  await status.scrollIntoViewIfNeeded();
  await capture("pi-recovered");
}
