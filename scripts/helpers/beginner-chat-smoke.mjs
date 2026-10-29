import assert from "node:assert/strict";
import {
  chooseAgentModel,
  openAgentModelOptions,
} from "./agent-model-options.mjs";
import { expect } from "@playwright/test";
import { closeSheets, openSettings } from "./browser-ui.mjs";

// Real creation routes and persisted agents; no worker or live provider calls.
export async function beginnerChatSmoke(page, fixture, _engine, capture) {
  const strip = page.getByRole("region", { name: "Your agents", exact: true });
  const sheet = page.getByRole("dialog", { name: "New chat", exact: true });
  const composer = page.locator(".composer");
  const input = page.getByLabel("Message your agent", { exact: true });
  const count = () =>
    fixture.db.prepare("SELECT count(*) AS n FROM agents").get().n;
  const before = count();
  const connection = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='codex'")
    .get();
  fixture.db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    JSON.stringify([
      {
        id: "specific",
        name: "Specific model",
        effortLevels: [{ value: "high" }],
      },
      { id: "default", name: "Default" },
    ]),
    connection.id,
  );
  let requests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/agents"))
      requests++;
  });
  const bootstrapGate = Promise.withResolvers();
  const bootstrapRead = Promise.withResolvers();
  const holdBootstrap = async (route) => {
    bootstrapRead.resolve();
    await bootstrapGate.promise;
    await route.continue();
  };
  await page.route("**/api/bootstrap", holdBootstrap);
  await page.goto(fixture.base, { waitUntil: "domcontentloaded" });
  await bootstrapRead.promise;
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".composer-launch")).toHaveCount(0);
  bootstrapGate.resolve();
  await page.waitForLoadState("networkidle");
  await page.unroute("**/api/bootstrap", holdBootstrap);
  let releaseName;
  const nameGate = new Promise((resolve) => {
    releaseName = resolve;
  });
  await page.route(
    "**/api/agents/suggest-name",
    async (route) => {
      await nameGate;
      await route.continue();
    },
    { times: 1 },
  );
  await strip.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(
    sheet.getByText("Choosing a name…", { exact: true }),
  ).toBeVisible();
  for (const label of ["Unique name", "Project", "Agent instructions"])
    await expect(sheet.getByLabel(label, { exact: true })).toBeHidden();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await capture("simple-creation-" + width);
    assert(
      await sheet
        .locator(".sheet-body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
  }
  releaseName();
  const start = sheet.getByRole("button", {
    name: "Start chatting",
    exact: true,
  });
  await expect(start).toBeEnabled();
  assert.equal(requests, 0, "Opening the screen does not create an agent");
  assert.equal(count(), before);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("new-chat");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents"),
  );
  await start.click();
  const created = await (await createdResponse).json();
  await expect(sheet).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(page.getByLabel("Agent recipient")).toHaveValue(created.id);
  assert.equal(count(), before + 1);
  assert.equal(requests, 1, "One click creates exactly one agent");
  assert.equal(
    created.model,
    "default",
    "Use the connection's default before a specific model",
  );
  assert.equal(created.connection_id, connection.id);
  assert.equal(created.instructions, "");
  assert.match(created.name, /^[a-z]{3,32}$/);
  const details = await fixture.api(`/agents/${created.id}`);
  assert.equal(details.runs.length, 0, "Opening a chat never sends a message");
  await expect(
    composer.getByRole("button", { name: "Select model and effort" }),
  ).toBeHidden();
  await expect(
    composer.getByRole("button", { name: "Send later", exact: true }),
  ).toBeHidden();
  await expect(input).toHaveAttribute("placeholder", "Ask anything…");
  await capture("ready-to-chat");
  await composer
    .getByRole("button", { name: "Chat options", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "Select model and effort" }),
  ).toBeVisible();
  await composer
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
  await capture("new-chat-button");
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await expect(input).toBeFocused();
  await expect(
    composer.getByRole("button", { name: "Chat options", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  assert.equal(count(), before + 1, "The + composer reuses the existing agent");
  // Shortcuts still open their dialog while technical buttons are hidden.
  await expect(
    composer.getByRole("button", { name: "Commands & skills", exact: true }),
  ).toHaveCount(0);
  await input.fill("/");
  const commands = page.getByRole("dialog", {
    name: "Commands & skills",
    exact: true,
  });
  await expect(commands).toBeVisible();
  await commands.getByRole("button", { name: "Close", exact: true }).click();
  await expect(input).toBeFocused();
  await input.fill("");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await capture("simple-composer-" + width);
    assert(
      await composer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
  }
  await composer
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();

  // Creating from Settings must also close the drawer and focus the chat.
  await openSettings(page);
  await page.getByRole("button", { name: /Manage agents/ }).click();
  await page
    .getByRole("dialog", { name: "Your agents", exact: true })
    .getByRole("button", { name: "New agent", exact: true })
    .click();
  await sheet.getByText("Customize", { exact: true }).click();
  await openAgentModelOptions(sheet);
  await expect(
    sheet.getByRole("radiogroup", { name: "Connection", exact: true }),
  ).toBeVisible();
  await sheet.getByLabel("Unique name").fill("beginner-custom");
  await sheet
    .getByLabel("Agent instructions", { exact: true })
    .fill("Explain things simply.");
  await sheet
    .getByLabel("Project", { exact: true })
    .selectOption(fixture.projects[0].id);
  await chooseAgentModel(sheet, "specific");
  await sheet.getByText("Customize", { exact: true }).click();
  await sheet
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  const custom = fixture.db
    .prepare("SELECT * FROM agents WHERE name='beginner-custom'")
    .get();
  assert.equal(custom.instructions, "Explain things simply.");
  assert.equal(custom.folder_id, fixture.projects[0].id);
  assert.equal(custom.model, "specific");
  await composer
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();

  // A lost response does not trigger an automatic retry. The explicit retry
  // reuses the same receipt without requiring any customization.
  let lost;
  await page.route(
    "**/api/agents",
    async (route) => {
      const response = await route.fetch();
      lost = await response.json();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await strip.getByRole("button", { name: "New agent", exact: true }).click();
  await start.click();
  await expect(sheet.getByRole("alert")).toBeVisible();
  assert.equal(requests, 3);
  assert.equal(count(), before + 3);
  const retry = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents"),
  );
  await sheet
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  assert.equal((await (await retry).json()).id, lost.id);
  await expect(input).toBeFocused();
  assert.equal(count(), before + 3);
  assert.equal(requests, 4);

  // Saved native models are ready without re-running discovery. An explicit
  // refresh failure blocks creation and never silently uses the old catalog.
  fixture.db
    .prepare(
      "UPDATE connections SET metadata=json_set(metadata,'$.loopHarness','codex') WHERE id=?",
    )
    .run(connection.id);
  let catalogRequests = 0;
  await page.route(`**/api/connections/${connection.id}/models`, (route) => {
    catalogRequests++;
    return route.fulfill({
      status: 503,
      json: { error: "Unavailable fixture" },
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await strip.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(start).toBeEnabled();
  await expect(sheet.locator(".create-agent-selection")).toContainText(
    "Default",
  );
  assert.equal(
    catalogRequests,
    0,
    "Opening with saved models does not discover the harness",
  );
  await openAgentModelOptions(sheet);
  await sheet
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await expect(sheet.getByRole("alert")).toContainText(
    "Couldn’t refresh models",
  );
  assert.equal(catalogRequests, 1);
  await sheet.getByLabel("Model and connection", { exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Start chatting", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("radiogroup", { name: "Model", exact: true }),
  ).toBeHidden();
  assert.equal(requests, 4);
  await capture("connection-recovery");
  await closeSheets(page);

  fixture.db.prepare("UPDATE connections SET status='disconnected'").run();
  await page.reload({ waitUntil: "networkidle" });
  await strip.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Connect an account", exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Start chatting", exact: true }),
  ).toBeDisabled();
  await expect(
    sheet.getByRole("radiogroup", { name: "Connection", exact: true }),
  ).toBeHidden();
  assert.equal(requests, 4);
  await capture("first-time-setup");
  await closeSheets(page);

  // In an empty workspace, the + button opens the same simple creation screen.
  fixture.db
    .prepare("UPDATE connections SET status='connected',metadata=? WHERE id=?")
    .run(connection.metadata, connection.id);
  let empty = true;
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: empty ? { ...data, agents: [] } : data,
    });
  });
  await page.route(
    "**/api/agents",
    async (route) => {
      const response = await route.fetch();
      empty = false;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".composer-launch").click();
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("radiogroup", { name: "Connection", exact: true }),
  ).toBeHidden();
  assert.equal(requests, 4);
  await start.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  assert.equal(requests, 5);
  assert.equal(count(), before + 4);
  await page.unrouteAll({ behavior: "wait" });

  // After creating on another source, the destination opens a composer rather
  // than the profile. Ordinary agent links still open that agent's profile.
  const agentId = await page.getByLabel("Agent recipient").inputValue();
  await page.goto(`${fixture.base}/?agent=${agentId}&compose=1`);
  await expect(input).toBeFocused();
  await expect(page.getByLabel("Agent recipient")).toHaveValue(agentId);
  assert.equal(new URL(page.url()).searchParams.has("compose"), false);
  assert.equal(requests, 5);
  await page.goto(`${fixture.base}/?agent=${agentId}`);
  await expect(page.locator(".profile-head")).toBeVisible();
  await expect(input).toBeHidden();
}
