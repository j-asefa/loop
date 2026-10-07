import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openSettings, closeSheets } from "./browser-ui.mjs";

export async function settingsReliabilityBrowser(
  page,
  base,
  capture = async () => {},
  { companion = false } = {},
) {
  let hostReads = 0;
  const requests = (request) => {
    if (new URL(request.url()).pathname === "/api/runtime-hosts") hostReads++;
  };
  page.on("request", requests);
  let failed = true;
  const preferences = async (route) => {
    if (!failed) return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Permission check interrupted" }),
    });
  };
  const connections = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "settings-fixture",
          name: "Fixture tools",
          status: "connected",
          url: "https://example.test/mcp",
          metadata: "{}",
          tools: "[]",
          authType: "none",
        },
      ]),
    });
  const machines = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "settings-machine",
          name: "Workshop MacBook Pro",
          kind: "native-host",
          url: "ws://127.0.0.1:4500",
        },
      ]),
    });
  await page.route("**/api/mcp/preferences", preferences);
  await page.route("**/api/mcp", connections);
  await page.route("**/api/runtime-hosts", machines);
  try {
    await page.goto(base);
    await openSettings(page);
    const drawer = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(
      drawer.getByRole("button", { name: /Shared memory/ }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: /Search preferences/ }),
    ).toBeVisible();
    if (companion)
      await expect(
        drawer.getByRole("button", { name: /Runtime machines/ }),
      ).toHaveCount(0);
    await capture("settings-home");
    await drawer.getByRole("button", { name: /Tools & integrations/ }).click();
    const sheet = page.getByRole("dialog", {
      name: "Tools & integrations",
      exact: true,
    });
    await sheet.getByRole("button", { name: /Installed \(1\)/ }).click();
    await expect(
      sheet.getByRole("heading", { name: /Fixture tools/ }),
    ).toBeVisible();
    await expect(sheet.getByText("Permission check interrupted")).toHaveCount(
      0,
    );
    await sheet
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    await expect(
      sheet.getByLabel("Agent tool calls", { exact: true }),
    ).toBeDisabled();
    await expect(sheet.getByText("Permission check interrupted")).toBeVisible();
    failed = false;
    await sheet
      .getByRole("button", { name: "Retry permissions", exact: true })
      .click();
    await expect(
      sheet.getByLabel("Agent tool calls", { exact: true }),
    ).toBeEnabled();
    await expect(sheet.getByText("Permission check interrupted")).toHaveCount(
      0,
    );
    if (companion)
      assert.equal(
        hostReads,
        0,
        "Companion must not request unsupported runtime-host endpoints",
      );
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const tabs = sheet.getByRole("group", { name: "Tools view" });
        await tabs
          .getByRole("button", { name: "Permissions", exact: true })
          .scrollIntoViewIfNeeded();
        assert(
          await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          "Settings sheet must not overflow horizontally",
        );
        for (const button of await tabs.getByRole("button").all()) {
          assert(
            (await button.boundingBox()).height >= 44,
            "Tabs retain touch targets",
          );
          assert.equal(
            await button.evaluate((el) => getComputedStyle(el).whiteSpace),
            "nowrap",
            "Tab labels stay on one line",
          );
        }
        await capture(`settings-permissions-${width}-${theme}`);
      }
    }
    await closeSheets(page);
    // A connected machine's row has no chevron and keeps its action in the
    // state column. On the narrowest phones that column must still fit the
    // button, which is the one row where a squeezed column clips a label.
    if (!companion) {
      await openSettings(page);
      await drawer.getByRole("button", { name: /Runtime machines/ }).click();
      const machineSheet = page.getByRole("dialog", {
        name: "Runtime machines",
        exact: true,
      });
      const row = machineSheet.locator(".settings-row", {
        hasText: "Workshop MacBook Pro",
      });
      const remove = row.getByRole("button", { name: "Remove machine" });
      await expect(remove).toBeVisible();
      for (const width of [320, 375, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(row).toHaveClass(/no-chevron/);
        const box = await remove.boundingBox();
        const label = await remove.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect().width;
        });
        assert(
          box.width >= label - 1,
          `Remove machine is clipped at ${width}px (${box.width}px for a ${label}px label)`,
        );
        assert(
          await machineSheet.evaluate(
            (el) => el.scrollWidth <= el.clientWidth + 1,
          ),
          `Runtime machines overflow at ${width}px`,
        );
        await capture(`settings-machines-${width}`);
      }
      await closeSheets(page);
    }
  } finally {
    page.off("request", requests);
    await page.unroute("**/api/mcp/preferences", preferences);
    await page.unroute("**/api/mcp", connections);
    await page.unroute("**/api/runtime-hosts", machines);
    await page.setViewportSize({ width: 390, height: 844 });
  }
}
