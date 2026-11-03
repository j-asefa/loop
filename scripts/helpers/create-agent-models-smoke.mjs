import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  chooseAgentConnection,
  chooseAgentModel,
  openAgentModelOptions,
} from "./agent-model-options.mjs";

// Production creation UI and persistence, with controlled catalog responses.
// No real harness, provider credentials, or inference.
export async function createAgentModelsSmoke(page, fixture, _engine, capture) {
  const codex = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='codex'")
    .get();
  const claude = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='anthropic'")
    .get();
  const saved = [
    { id: "native-default", name: "Default", resolvedModel: "GPT-6 Sol" },
    {
      id: "careful",
      name: "Careful model",
      effortLevels: [
        { value: "high", description: "Spend more time reasoning." },
      ],
    },
    ...Array.from({ length: 70 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
    })),
  ];
  fixture.db
    .prepare(
      "UPDATE connections SET models=?,metadata=json_set(metadata,'$.loopHarness','codex') WHERE id=?",
    )
    .run(JSON.stringify(saved), codex.id);
  const sheet = page.getByRole("dialog", { name: "New chat", exact: true });
  const start = sheet.getByRole("button", {
    name: "Start chatting",
    exact: true,
  });
  const open = async () => {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page
      .getByRole("region", { name: "Your agents", exact: true })
      .getByRole("button", { name: "New agent", exact: true })
      .click();
  };
  let creationRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/agents"))
      creationRequests++;
  });
  let requests = 0;
  const read = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const hold = async (route) => {
    requests++;
    read.resolve();
    await gate.promise;
    await route.fulfill({
      json: { models: [{ id: "late", name: "Late Codex model" }] },
    });
  };
  await page.route(`**/api/connections/${codex.id}/models`, hold);
  await open();
  await expect(start).toBeEnabled();
  assert.equal(
    requests,
    0,
    "A saved native catalog needs no discovery request",
  );
  await expect(sheet.locator(".create-agent-selection")).toContainText(
    "Default",
  );
  await sheet
    .getByLabel("Opening message", { exact: true })
    .fill("Keep this draft while I choose a model.");
  await sheet.getByText("Customize", { exact: true }).click();
  await sheet
    .getByLabel("Project", { exact: true })
    .selectOption(fixture.projects[0].id);
  await chooseAgentModel(sheet, "careful");
  await expect(
    sheet
      .getByRole("radiogroup", { name: "Model", exact: true })
      .getByRole("radio"),
  ).toHaveCount(50);
  await sheet.getByLabel("Effort", { exact: true }).selectOption("high");
  await sheet.getByLabel("Search models", { exact: true }).fill("model-7");
  await expect(
    sheet
      .getByRole("radiogroup", { name: "Model", exact: true })
      .getByRole("radio"),
  ).toHaveCount(1);
  await expect(
    sheet.getByRole("radio", { name: "Model 7", exact: true }),
  ).toBeVisible();
  await sheet.getByLabel("Search models", { exact: true }).press("Enter");
  await expect(sheet).toBeVisible();
  assert.equal(
    creationRequests,
    0,
    "Searching never submits the creation form",
  );
  await sheet.getByLabel("Search models", { exact: true }).fill("not-a-model");
  await expect(
    sheet.getByText("No models match your search.", { exact: true }),
  ).toBeVisible();
  await expect(sheet.locator(".create-agent-selection")).toContainText(
    "Careful model",
  );
  // A metadata update can shrink the catalog while a search is active. The
  // query must stay visible and clearable even below the usual search threshold.
  fixture.db
    .prepare("UPDATE connections SET models=?,label=? WHERE id=?")
    .run(
      JSON.stringify(saved.slice(0, 2)),
      "Smaller catalog account",
      codex.id,
    );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(
    sheet.getByText("Smaller catalog account", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByLabel("Search models", { exact: true }),
  ).toBeVisible();
  await sheet.getByLabel("Search models", { exact: true }).fill("");
  await expect(
    sheet
      .getByRole("radiogroup", { name: "Model", exact: true })
      .getByRole("radio"),
  ).toHaveCount(2);
  fixture.db
    .prepare("UPDATE connections SET models=?,label=? WHERE id=?")
    .run(JSON.stringify(saved), codex.label, codex.id);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(
    sheet.getByText("Smaller catalog account", { exact: true }),
  ).toHaveCount(0);
  await sheet.getByRole("button", { name: /Show more models/ }).click();
  await expect(
    sheet
      .getByRole("radiogroup", { name: "Model", exact: true })
      .getByRole("radio"),
  ).toHaveCount(72);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await sheet
      .getByLabel("Model and connection", { exact: true })
      .scrollIntoViewIfNeeded();
    await capture("model-choices-" + width);
    await sheet.locator(".create-agent-models").scrollIntoViewIfNeeded();
    await capture("model-list-" + width);
    if (width === 390) {
      const theme = await page.evaluate(
        () => document.documentElement.dataset.theme,
      );
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await capture("model-list-dark");
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
    }
    assert(
      await sheet
        .locator(".sheet-body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
  }
  // Native radio keyboard navigation must update the actual selection.
  const careful = sheet.getByRole("radio", {
    name: "Careful model",
    exact: true,
  });
  await careful.focus();
  await careful.press("ArrowDown");
  await expect(
    sheet.getByRole("radio", { name: "Model 0", exact: true }),
  ).toBeChecked();
  await expect(sheet.getByLabel("Effort", { exact: true })).toHaveCount(0);
  await sheet
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await read.promise;
  await expect(start).toBeDisabled();
  await chooseAgentConnection(sheet, { id: claude.id });
  await expect(start).toBeEnabled();
  await expect(sheet.getByLabel("Project", { exact: true })).toHaveValue(
    fixture.projects[0].id,
  );
  await expect(
    sheet.getByLabel("Opening message", { exact: true }),
  ).toHaveValue("Keep this draft while I choose a model.");
  const lateResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/connections/${codex.id}/models`),
  );
  gate.resolve();
  await lateResponse;
  await expect(sheet.locator(".create-agent-selection")).toContainText(
    "Claude Sonnet",
  );
  await expect(
    sheet.getByRole("radio", { name: "Late Codex model", exact: true }),
  ).toHaveCount(0);
  await expect(start).toBeEnabled();
  await page.unroute(`**/api/connections/${codex.id}/models`, hold);

  // Refresh removes an explicitly selected model. Do not silently select and
  // submit a different model, even when the response offers a valid default.
  await chooseAgentConnection(sheet, { id: codex.id });
  await chooseAgentModel(sheet, "careful");
  const current = [{ id: "native-default", name: "Default" }];
  let refreshRequests = 0;
  const refreshed = (route) => {
    refreshRequests++;
    fixture.db
      .prepare("UPDATE connections SET models=? WHERE id=?")
      .run(JSON.stringify(current), codex.id);
    return route.fulfill({ json: { models: current } });
  };
  await page.route(`**/api/connections/${codex.id}/models`, refreshed);
  await sheet
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await expect(sheet.getByRole("alert")).toContainText(
    "selected model is no longer available",
  );
  await expect(start).toBeDisabled();
  await chooseAgentModel(sheet, "native-default");
  await expect(start).toBeEnabled();

  // Once refresh finishes, subsequent workspace catalogs replace its result.
  // The removed selection must not survive and discovery must not repeat.
  const newer = [{ id: "newer", name: "Newly available model" }];
  fixture.db
    .prepare("UPDATE connections SET models=?,label=? WHERE id=?")
    .run(JSON.stringify(newer), "Updated after refresh", codex.id);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(
    sheet.getByText("Updated after refresh", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("radio", { name: "Newly available model", exact: true }),
  ).toBeVisible();
  await expect(
    sheet
      .getByRole("radiogroup", { name: "Model", exact: true })
      .locator('input[value="native-default"]'),
  ).toHaveCount(0);
  await expect(start).toBeDisabled();
  await chooseAgentModel(sheet, "newer");
  await expect(start).toBeEnabled();
  fixture.db
    .prepare("UPDATE connections SET models='[]',label=? WHERE id=?")
    .run("Empty refreshed catalog", codex.id);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(
    sheet.getByText("Empty refreshed catalog", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Refresh models", exact: true }),
  ).toBeEnabled();
  await expect(start).toBeDisabled();
  assert.equal(refreshRequests, 1, "Later catalogs do not repeat discovery");
  await page.unroute(`**/api/connections/${codex.id}/models`, refreshed);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();

  // With no saved catalog, creation must wait for discovery and show a retry
  // on failure. An explicit retry is the only second request.
  fixture.db
    .prepare("UPDATE connections SET models='[]' WHERE id=?")
    .run(codex.id);
  const emptyGate = Promise.withResolvers();
  let emptyRequests = 0;
  const empty = async (route) => {
    emptyRequests++;
    if (emptyRequests === 1) {
      await emptyGate.promise;
      return route.fulfill({
        status: 503,
        json: { error: "Fixture discovery unavailable" },
      });
    }
    fixture.db
      .prepare("UPDATE connections SET models=? WHERE id=?")
      .run(JSON.stringify(saved), codex.id);
    return route.fulfill({ json: { models: saved } });
  };
  await page.route(`**/api/connections/${codex.id}/models`, empty);
  await open();
  await expect.poll(() => emptyRequests).toBe(1);
  await expect(start).toBeDisabled();
  await sheet
    .getByLabel("Opening message", { exact: true })
    .fill("The form stays usable during discovery.");
  emptyGate.resolve();
  await expect(sheet.getByRole("alert")).toContainText(
    "Couldn’t refresh models",
  );
  await expect(start).toBeDisabled();
  assert.equal(emptyRequests, 1);
  await sheet.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(start).toBeEnabled();
  assert.equal(emptyRequests, 2);
  await expect(
    sheet.getByLabel("Opening message", { exact: true }),
  ).toHaveValue("The form stays usable during discovery.");
  await openAgentModelOptions(sheet);
  await capture("recovered-models");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page.unrouteAll({ behavior: "wait" });

  // Native discovery publishes updated connection metadata before its HTTP
  // response arrives. Reconciliation must not cancel or repeat that request.
  fixture.db
    .prepare("UPDATE connections SET models='[]' WHERE id=?")
    .run(codex.id);
  const discoveryGate = Promise.withResolvers();
  let discoveryRequests = 0;
  await page.route(`**/api/connections/${codex.id}/models`, async (route) => {
    discoveryRequests++;
    await discoveryGate.promise;
    await route.fulfill({ json: { models: saved } });
  });
  await open();
  await expect.poll(() => discoveryRequests).toBe(1);
  await openAgentModelOptions(sheet);
  fixture.db
    .prepare("UPDATE connections SET models=?,label=? WHERE id=?")
    .run(JSON.stringify(saved), "Updated during discovery", codex.id);
  try {
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect(
      sheet.getByRole("radiogroup", { name: "Connection", exact: true }),
    ).toContainText("Updated during discovery");
  } finally {
    discoveryGate.resolve();
  }
  await expect(start).toBeEnabled();
  assert.equal(
    discoveryRequests,
    1,
    "Metadata updates do not repeat discovery",
  );
  // Connection loss requires a deliberate choice rather than switching the
  // account or destination. Restoring that same account can use saved models.
  await sheet
    .getByLabel("Opening message", { exact: true })
    .fill("Keep my account and draft.");
  fixture.db
    .prepare("UPDATE connections SET status='needs_reconnect' WHERE id=?")
    .run(codex.id);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(
    sheet.getByText("Choose a connected account to start chatting.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    sheet
      .getByRole("radiogroup", { name: "Connection", exact: true })
      .locator("input:checked"),
  ).toHaveCount(0);
  await expect(start).toBeDisabled();
  fixture.db
    .prepare("UPDATE connections SET status='connected' WHERE id=?")
    .run(codex.id);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(start).toBeEnabled();
  await expect(
    sheet.getByLabel("Opening message", { exact: true }),
  ).toHaveValue("Keep my account and draft.");
  assert.equal(discoveryRequests, 1, "Restored saved models need no discovery");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page.unrouteAll({ behavior: "wait" });
}
