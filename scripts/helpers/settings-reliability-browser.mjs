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
  let failed = true,
    preferenceReads = 0;
  const preferences = async (route) => {
    preferenceReads++;
    if (!failed) return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Permission check interrupted" }),
    });
  };
  const origin = new URL(base).origin;
  const headers = { origin };
  if (companion) {
    const session = await page.request.get(origin + "/session");
    assert.equal(session.status(), 200);
    headers["x-loop-csrf"] = (await session.json()).csrf;
  }
  const created = await page.request.post(origin + "/api/mcp", {
    headers,
    data: {
      name: "Fixture tools",
      url: "https://example.test/mcp",
      auth: { type: "none" },
    },
  });
  assert.equal(created.status(), 201);
  const connection = await created.json();
  const connections = (route) => route.fulfill({ json: [connection] });
  const catalogResponse = await page.request.get(origin + "/api/mcp/catalog");
  assert.equal(catalogResponse.status(), 200);
  const catalog = await catalogResponse.json();
  // Start with production responses, then remove optional display fields.
  for (const entry of catalog.entries) {
    delete entry.note;
    delete entry.serverUrl;
  }
  const catalogWithoutOptionalFields = (route) =>
    route.fulfill({ json: catalog });
  await page.route("**/api/mcp/preferences", preferences);
  await page.route("**/api/mcp", connections);
  await page.route("**/api/mcp/catalog", catalogWithoutOptionalFields);
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
    if (companion) {
      await expect(
        drawer.getByRole("button", { name: "Add machine", exact: true }),
      ).toHaveCount(0);
      await drawer
        .getByRole("button", { name: "Runtime machines", exact: true })
        .click();
      const machines = page.getByRole("dialog", {
        name: "Runtime machines",
        exact: true,
      });
      await expect(
        machines.getByRole("button", {
          name: /This computer & paired devices/,
        }),
      ).toBeVisible();
      assert.equal(
        hostReads,
        0,
        "Companion machine settings do not request runtime hosts",
      );
      await machines
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    await capture("settings-home");
    // Exercise memory contracts through the real app and database. No response
    // fixture substitutes for the note, its revision or the policy writes.
    await drawer.getByRole("button", { name: /Shared memory/ }).click();
    const memory = page.getByRole("dialog", {
      name: "Shared memory",
      exact: true,
    });
    const recall = memory.getByRole("checkbox", {
      name: /Enable shared recall/,
    });
    await expect(recall).toBeChecked();
    await recall.click();
    await expect(recall).not.toBeChecked();
    await recall.click();
    await expect(recall).toBeChecked();
    await memory
      .getByRole("button", { name: "Pin a note", exact: true })
      .click();
    const title = "Contract memory " + Date.now();
    await memory.getByLabel("Title", { exact: true }).fill(title);
    await memory
      .getByLabel("Note", { exact: true })
      .fill("Historical contract evidence");
    await memory.getByRole("button", { name: "Pin note", exact: true }).click();
    const source = memory.getByRole("button", { name: title, exact: true });
    await expect(source).toContainText("Revision 1");
    await source.click();
    await expect(
      memory.getByLabel("Note content", { exact: true }),
    ).toHaveValue("Historical contract evidence");
    await memory
      .getByLabel("Note content", { exact: true })
      .fill("Revised historical evidence");
    await memory
      .getByRole("button", { name: "Save note revision", exact: true })
      .click();
    await expect(source).toContainText("Revision 2");
    await source.click();
    await expect(
      memory.getByLabel("Note content", { exact: true }),
    ).toHaveValue("Revised historical evidence");
    await memory
      .getByRole("button", { name: "Close source", exact: true })
      .click();
    await capture("settings-memory-revision");
    const row = memory.locator(".memory-source", { hasText: title });
    await row
      .getByRole("button", { name: "Remove from shared memory", exact: true })
      .click();
    await expect(source).toBeDisabled();
    await expect(row).toContainText("Removed");
    await expect(memory.getByRole("alert")).toHaveCount(0);
    await closeSheets(page);
    await openSettings(page);
    await drawer.getByRole("button", { name: /Tools & integrations/ }).click();
    const sheet = page.getByRole("dialog", {
      name: "Tools & integrations",
      exact: true,
    });
    const catalogRegion = sheet.getByRole("region", { name: "MCP catalog" });
    await expect(catalogRegion.getByRole("article").first()).toBeVisible();
    for (const transport of ["http", "stdio"]) {
      const entry = catalog.entries.find(
        (entry) => entry.transport === transport,
      );
      await expect(
        catalogRegion.getByRole("article", { name: entry.name, exact: true }),
      ).toBeVisible();
    }
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
    // Typed projection reads allow two transient retries (2s, then 4s) before
    // exposing the existing manual recovery control.
    await expect(sheet.getByText("Permission check interrupted")).toBeVisible({
      timeout: 10_000,
    });
    assert.equal(preferenceReads, 3, "Permission recovery is bounded");
    failed = false;
    await sheet
      .getByRole("button", { name: "Retry permissions", exact: true })
      .click();
    await expect(
      sheet.getByLabel("Agent tool calls", { exact: true }),
    ).toBeEnabled();
    assert.equal(preferenceReads, 4, "Manual retry recovers the failed read");
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
  } finally {
    page.off("request", requests);
    await page.unroute("**/api/mcp/preferences", preferences);
    await page.unroute("**/api/mcp", connections);
    await page.unroute("**/api/mcp/catalog", catalogWithoutOptionalFields);
    await page.setViewportSize({ width: 390, height: 844 });
    const disconnected = await page.request.patch(
      origin + "/api/mcp/" + connection.id,
      { headers, data: { action: "disconnect" } },
    );
    assert.equal(disconnected.status(), 200);
  }
}
