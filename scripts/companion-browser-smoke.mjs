process.env.LOOP_PROFILE = "companion";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
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
    .filter({ hasText: "Connected to desktop" })
    .waitFor();
  assert(!page.url().includes("#"));
  const workspaceUrl = page.url();
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
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole("button", {
        name: i === 0 ? "Create your first agent" : "New agent",
        exact: true,
      })
      .first()
      .click();
    await page.getByLabel("Unique name").fill("browser-" + i);
    await page
      .getByText("Instructions & advanced options", { exact: true })
      .click();
    await page
      .getByLabel("Agent instructions", { exact: true })
      .fill("Keep this native instruction " + i);
    await page
      .getByRole("dialog")
      .getByLabel("Project", { exact: true })
      .selectOption({
        label: i === 2 ? "Second project" : basename(process.cwd()),
      });
    await page
      .getByLabel("Initial prompt", { exact: true })
      .fill(i === 0 ? "approve" : "wait");
    await page
      .getByRole("button", { name: "Create & start", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Meet your next agent" })
      .waitFor({ state: "hidden" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Running", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "decline", exact: true }).waitFor();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/mobile-workspace-running.png",
    fullPage: true,
  });
  assert.equal(
    db.prepare("SELECT count(*) n FROM companion_sessions").get().n,
    3,
  );
  await page.getByRole("button", { name: "decline", exact: true }).click();
  await page
    .getByRole("button", { name: "Native conversations", exact: true })
    .click();
  await page.getByRole("button").filter({ hasText: "approve" }).last().click();
  await page
    .getByLabel("Reply to agent")
    .fill("Follow-up keeps native context");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .getByRole("button", { name: "Native conversations", exact: true })
    .click();
  await page.getByRole("button").filter({ hasText: "approve" }).last().click();
  await page.getByLabel("Reply to agent").fill("Draft survives reconnect");
  await context.setOffline(true);
  await context.setOffline(false);
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: "Connected to desktop" })
    .waitFor();
  // A restored conversation loads after the desktop connection. Its composer
  // label can still be loading, so check the route before opening another sheet.
  if (!new URL(page.url()).searchParams.has("conversation")) {
    await page
      .getByRole("button", { name: "Native conversations", exact: true })
      .click();
    await page
      .getByRole("button")
      .filter({ hasText: "approve" })
      .last()
      .click();
  }
  await expect(page.getByLabel("Reply to agent")).toHaveValue(
    "Draft survives reconnect",
  );
  await page.screenshot({
    path: "test-results/mobile-workspace-conversation.png",
    fullPage: true,
  });
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
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
  db.close();
  await rm(dir, { recursive: true, force: true });
}
