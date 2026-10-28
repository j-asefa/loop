import { expect } from "@playwright/test";
import { openSettings } from "./browser-ui.mjs";

// Browser fixtures only. start-runtimes.node.test.ts exercises real dispatch.
export async function antigravitySmoke(page, fixture, _engine, capture) {
  let enabled = false;
  let enableRequest;
  const signIns = [];
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
            name: "antigravity",
            backend: "direct",
            installed: true,
            available: true,
            enabled,
            version: "1.4.9",
            help: "",
            authentication: enabled ? "previously_verified" : "unknown",
            ...(enabled
              ? { project: "/projects/second", billing: "existing" }
              : {}),
          },
        ],
      },
    }),
  );
  await page.route("**/api/workspace/runtimes/antigravity/auth**", (route) => {
    signIns.push(route.request().url());
    return route.fulfill({
      status: 404,
      json: { error: "No browser sign-in" },
    });
  });
  await page.route("**/api/workspace/runtimes/antigravity/upgrade", (route) =>
    route.fulfill({
      json: {
        upgrade: null,
        canUpgrade: false,
        upgradeHelp:
          "Antigravity updates itself. Run agy update on the computer.",
      },
    }),
  );
  await page.route("**/api/workspace/runtimes/antigravity/enable", (route) => {
    enableRequest = route.request().postDataJSON();
    enabled = true;
    return route.fulfill({
      json: {
        name: "antigravity",
        billing: {
          mode: "existing",
          description: "Native Antigravity configuration",
        },
        models: [],
        capabilities: {
          approvals: false,
          questions: false,
          workspaceTools: false,
        },
      },
    });
  });
  await page.goto(fixture.base);
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await page
    .getByRole("button", { name: "Antigravity setup details", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Antigravity", exact: true });
  await expect(sheet.getByText(/Run agy on Fixture computer/)).toBeVisible();
  await expect(
    sheet.getByText(/Headless runs cannot ask for approvals in Loop/),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Start sign-in", exact: true }),
  ).toHaveCount(0);
  await expect(sheet.getByLabel("Billing policy for new runtimes")).toHaveCount(
    0,
  );
  await sheet
    .getByLabel("Project directory for new runtimes")
    .selectOption("second");
  await capture("antigravity-setup");
  await sheet
    .getByRole("button", { name: "Enable Antigravity", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Refresh Antigravity", exact: true }),
  ).toBeEnabled();
  expect(enableRequest).toMatchObject({
    projectId: "second",
    billing: "existing",
  });
  expect(enableRequest.commandId).toMatch(/^[a-f0-9-]{36}$/);
  expect(signIns).toEqual([]);
  await capture("antigravity-enabled");
}
