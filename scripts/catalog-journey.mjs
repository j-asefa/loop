import { closeSheets } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function catalogJourney(page, api, base) {
  await page.goto(base);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  const catalog = page.getByRole("region", { name: "MCP catalog" });
  const catalogSize = (await api("/mcp/catalog")).entries.filter(
    (entry) =>
      !/\bdeprecated\b/i.test(`${entry.description} ${entry.note || ""}`),
  ).length;
  await expect(
    catalog.getByText(`${catalogSize} tools available`, { exact: true }),
  ).toBeVisible();
  await expect(catalog.getByRole("article")).toHaveCount(catalogSize);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(
      await page
        .locator("dialog[open]")
        .last()
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "Catalog fits viewport " + width,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await catalog
    .getByRole("combobox", { name: /^Category/ })
    .selectOption("Databases");
  await expect(
    catalog.getByRole("article", { name: "MongoDB", exact: true }),
  ).toBeVisible();
  await expect(
    catalog.getByRole("article", { name: "GitHub", exact: true }),
  ).toHaveCount(0);
  await catalog
    .getByRole("combobox", { name: /^Category/ })
    .selectOption("All");
  await catalog.getByLabel("No credentials listed", { exact: true }).check();
  assert.ok((await catalog.getByRole("article").count()) >= 5);
  await expect(
    catalog.getByRole("article", { name: "GitHub", exact: true }),
  ).toHaveCount(0);
  await catalog.getByLabel("No credentials listed", { exact: true }).uncheck();
  await catalog.getByLabel("Search tools").fill("no such integration");
  await expect(
    catalog.getByText("No matching tools. Try another search or category."),
  ).toBeVisible();
  await catalog.getByLabel("Search tools").fill("deepwiki");
  await catalog
    .getByRole("button", { name: "Install DeepWiki", exact: true })
    .click();
  await expect(
    catalog.getByRole("button", { name: "DeepWiki installed", exact: true }),
  ).toBeDisabled();
  const initial = (await api("/mcp")).filter(
    (c) => JSON.parse(c.metadata).catalogId === "deepwiki",
  );
  assert.equal(initial.length, 1);
  await catalog.getByLabel("Search tools").fill("github");
  await catalog
    .getByRole("button", { name: "Install GitHub", exact: true })
    .click();
  await catalog
    .getByLabel("Access token / API key")
    .fill("fixture-catalog-key");
  await catalog
    .getByRole("button", { name: "Install & connect", exact: true })
    .click();
  await expect(
    catalog.getByRole("button", { name: "GitHub installed", exact: true }),
  ).toBeDisabled();
  assert.ok(!JSON.stringify(await api("/mcp")).includes("fixture-catalog-key"));
  await page.getByRole("button", { name: /^Installed \(/ }).click();
  await page.getByLabel("Find connections").fill("deepwiki");
  const installed = page
    .locator(".connection-card")
    .filter({ has: page.getByRole("heading", { name: /DeepWiki/ }) });
  await installed.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    installed.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await catalog.getByLabel("Search tools").fill("deepwiki");
  await catalog
    .getByRole("button", { name: "Install DeepWiki", exact: true })
    .click();
  await expect(
    catalog.getByRole("button", { name: "DeepWiki installed", exact: true }),
  ).toBeDisabled();
  assert.equal(
    (await api("/mcp")).filter(
      (c) => JSON.parse(c.metadata).catalogId === "deepwiki",
    ).length,
    1,
  );
  await catalog.getByLabel("Search tools").fill("");
  await page
    .locator("dialog[open]")
    .last()
    .locator(".sheet-body")
    .evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({
    path: join(tmpdir(), "loop-mcp-catalog.png"),
    fullPage: false,
  });
  await closeSheets(page);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  await catalog.getByLabel("Search tools").fill("deepwiki");
  await expect(
    catalog.getByRole("button", { name: "DeepWiki installed", exact: true }),
  ).toBeDisabled();
  await closeSheets(page);
  console.log(
    `PASS: ${catalogSize}-tool catalog, category/search filters, 320/390/768px layouts, one-click install, secret form, re-enable without duplication and installed state after reload (fixture MCP).`,
  );
}
