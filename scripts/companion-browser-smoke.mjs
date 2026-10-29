import { chooseAgentModel, openAgentModelOptions } from "./helpers/agent-model-options.mjs";
process.env.LOOP_PROFILE = "companion";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { nativeAuthBrowser, prepareNativeAuthBrowser } from "./helpers/native-auth-browser.mjs";
import { companionContractsBrowser } from "./helpers/companion-contracts-browser.mjs";
import { subscriptionContractsBrowser } from "./helpers/subscription-contracts-browser.mjs";
import { nativeSettingsBrowser } from "./helpers/native-settings-browser.mjs";
import { settingsReliabilityBrowser } from "./helpers/settings-reliability-browser.mjs";
import { agentSourcesBrowser } from "./helpers/agent-sources-browser.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-browser-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_TEST_HARNESS = "codex";
const { WorkspaceHost } = await import("../dist/workspace-host.js");
const { db } = await import("../dist/server/db.js");
const { control } = await import("../dist/host-control.js");
await chmod(resolve("test/harness.mjs"), 0o755);
const options = {
  harness: "codex",
  version: "fixture",
  project: process.cwd(),
  executable: resolve("test/harness.mjs"),
  billing: "existing",
};
const host = new WorkspaceHost(dir, options);
let browser;
// localhost and 127.0.0.1 are different sites, unlike two ports on one host.
const provider = createServer((req, res) => {
  if (req.url === "/authorize") {
    res.writeHead(302, {
      Location:
        host.gateway.origin +
        "/api/mcp/oauth/callback?state=invalid-state&code=fixture",
    });
    res.end();
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end('<a href="/authorize">Authorize fixture</a>');
  }
});
const restoreAuthPath = await prepareNativeAuthBrowser(dir);
process.env.LOOP_TEST_SETTING_AUDIT = join(dir, "setting-recovery-audit");
try {
  await host.start(options);
  const launch = {
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args:
      process.env.LOOP_BROWSER === "webkit"
        ? []
        : process.env.CHROMIUM_ARGS
          ? JSON.parse(process.env.CHROMIUM_ARGS)
          : ["--no-sandbox"],
  };
  browser = await (
    process.env.LOOP_BROWSER === "webkit" ? webkit : chromium
  ).launch(launch);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 2,
    hasTouch: true,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    // Reloading or revoking the device can interrupt an in-flight API fetch.
    // Keep the same narrow WebKit diagnostic filter as the other browser checks.
    if (
      !isWebKitNavigationFetchError(
        process.env.LOOP_BROWSER,
        error,
        host.gateway.origin,
      )
    )
      errors.push(error.message);
  });
  await page.goto(host.pair().url);
  await page.getByRole("button", { name: "Pair and open Loop" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Connected to workspace" })
    .waitFor();
  assert(!page.url().includes("#"));
  const workspaceUrl = page.url();
  await agentSourcesBrowser(page, workspaceUrl);
  await settingsReliabilityBrowser(page, workspaceUrl, undefined, {
    companion: true,
  });
  // The rest of this fixture starts with no linked agents. A developer's
  // running Docker Loop must not change its first-agent assertions.
  await page.route("**/api/agent-sources", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  );
  await page.goto(workspaceUrl);
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await page.goto(`http://localhost:${provider.address().port}/`);
  const callbackResponse = page.waitForResponse((response) =>
    response.url().includes("/api/mcp/oauth/callback"),
  );
  await page.getByRole("link", { name: "Authorize fixture" }).click();
  const callback = await callbackResponse;
  // A paired cross-site return reaches OAuth state validation, not the 401 pairing guard.
  assert.equal(callback.status(), 403);
  assert.match(
    await callback.text(),
    /OAuth state expired or belongs to another session/,
  );
  const unpaired = await browser.newContext();
  assert.equal((await unpaired.request.get(callback.url())).status(), 401);
  const oldDockerLink = await unpaired.newPage();
  await oldDockerLink.goto(
    host.gateway.origin + "/?workspace=docker:" + "a".repeat(64),
  );
  await oldDockerLink
    .getByRole("heading", { name: "Pair this device" })
    .waitFor();
  await unpaired.close();
  await page.goto(workspaceUrl);
  const otherProject = join(dir, "second-project");
  await mkdir(otherProject);
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .last()
    .click();
  await page
    .getByRole("button", { name: "New project", exact: true })
    .last()
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Second project");
  await page
    .getByLabel("Desktop directory", { exact: true })
    .fill(otherProject);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.locator("dialog[open]").last().waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Feed", exact: true }).last().click();
  // The native catalog has the same display names and effort metadata as its
  // runner. Network failure must not silently use the old generic aliases.
  const models = [
    { id: "default", name: "Use native default" },
    {
      id: "opus",
      name: "Claude Opus 5 (1M)",
      resolvedModel: "claude-opus-5[1m]",
      effortLevels: [{ value: "low" }, { value: "high" }, { value: "max" }],
      defaultEffort: "high",
    },
    {
      id: "sonnet",
      name: "Claude Sonnet fixture",
      effortLevels: [{ value: "low" }, { value: "high" }],
    },
  ];
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('fixture-claude','local-workspace','anthropic','Claude native','','connected',?,?,0)",
  ).run(
    JSON.stringify(models),
    JSON.stringify({
      loopHarness: "claude",
      authMode: "subscription",
      billing: {
        mode: "subscription",
        description: "Native subscription sign-in; no API fallback.",
      },
    }),
  );
  let requests = 0;
  await page.route("**/api/connections/fixture-claude/models", (route) =>
    ++requests === 1
      ? route.fulfill({
          status: 503,
          json: { error: "Fixture model refresh failed" },
        })
      : route.fulfill({ json: { models } }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: /^(New agent|Start chatting)$/ })
    .click();
  await page
    .getByRole("dialog", { name: "New chat", exact: true })
    .getByText("Customize", { exact: true })
    .click();
  const creation = page.getByRole("dialog", { name: "New chat" });
  await expect(creation.getByLabel("Unique name")).toHaveAttribute(
    "placeholder",
    "Choose a name",
  );
  await creation.getByLabel("Unique name").fill("native-model-picker");
  await openAgentModelOptions(creation);
  await creation.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(creation.getByRole("alert")).toContainText("Couldn’t refresh models");
  await expect(
    creation.getByRole("button", { name: "Start chatting", exact: true }),
  ).toBeDisabled();
  await creation
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(creation.getByRole("radiogroup", { name: "Model", exact: true }).locator('input[value="default"]')).toBeEnabled();
  await expect(creation.getByRole("radiogroup", { name: "Model", exact: true })).toContainText(
    "Claude Opus 5 (1M)",
  );
  await expect(creation.getByRole("radiogroup", { name: "Model", exact: true }).locator('input[value="default"]')).toBeChecked();
  await chooseAgentModel(creation, "opus");
  await expect(creation.getByLabel("Effort", { exact: true })).toBeEnabled();
  await chooseAgentModel(creation, "default");
  await expect(creation.getByLabel("Effort", { exact: true })).toHaveCount(0);
  await chooseAgentModel(creation, "opus");
  await expect(creation.getByLabel("Effort", { exact: true })).toBeEnabled();
  await creation.getByLabel("Effort", { exact: true }).selectOption("max");
  await expect(creation).toContainText(
    "Native subscription sign-in; no API fallback.",
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/mobile-native-models.png",
    fullPage: true,
  });
  await creation
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  await creation.waitFor({ state: "hidden" });
  // Closing the sheet schedules history.back(). Let that navigation settle
  // before the explicit workspace reload, which it can otherwise abort.
  await expect
    .poll(() => page.evaluate(() => history.state?.loopSheet === true))
    .toBe(false);
  assert.deepEqual(
    db
      .prepare("SELECT model,effort FROM agents WHERE name='native-model-picker'")
      .get(),
    { model: "opus", effort: "max" },
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM companion_sessions").get().n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM native_dispatch").get().n, 0);
  await page.goto(workspaceUrl);
  await nativeAuthBrowser({ browser, host, dir, db });
  await nativeSettingsBrowser({ page, host, dir, db });
  await companionContractsBrowser({ browser, host, db });
  await subscriptionContractsBrowser({ browser });
  const devices = await control(dir, "devices");
  await control(dir, "revoke", { id: devices[0].id });
  await page.getByRole("heading", { name: "Pair this device" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Original Loop mobile UI fixture journey passed:",
    process.env.LOOP_BROWSER || "chromium",
  );
} catch (e) {
  await mkdir("test-results", { recursive: true });
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({
      path: "test-results/browser-failure.png",
      fullPage: true,
    });
    console.error((await page?.locator("body").innerText())?.slice(-6000));
  }
  throw e;
} finally {
  await browser?.close();
  await new Promise((resolve) => provider.close(resolve));
  await host.close();
  restoreAuthPath();
  db.close();
  await rm(dir, { recursive: true, force: true });
}
