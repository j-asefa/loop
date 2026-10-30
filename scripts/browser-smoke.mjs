import "../deployment/environment.mjs";
import { chooseAgentModel } from "./helpers/agent-model-options.mjs";
import { architectureSettingsJourney } from "./architecture-settings-journey.mjs";
import {
  closeSheets,
  isolatedBrowserEnv,
  openSettings,
  openTab,
} from "./helpers/browser-ui.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { createServer as reservePort } from "node:net";
async function freePort() {
  const server = reservePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const port = await freePort(),
  base = "http://localhost:" + port;
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "loop55-browser-"));
import { spawn } from "node:child_process";
import { chromium, webkit, expect } from "@playwright/test";
import assert from "node:assert/strict";
const fixtureEnv = await isolatedBrowserEnv();
const server = spawn(
  process.execPath,
  ["--import", "tsx", "src/server/serve.ts"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...fixtureEnv,
      LOOP55_DATA_DIR: dir,
      PORT: String(port),
      LOOP55_URL: base,
      LOOP55_AUTH_MODE: "single-user",
    },
  },
);
const worker = spawn(
  process.execPath,
  ["--import", "tsx", "src/server/worker.ts"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...fixtureEnv,
      LOOP55_DATA_DIR: dir,
      PORT: String(port),
      LOOP55_URL: base,
    },
  },
);
let browser, page;
let logs = "";
server.stderr.on("data", (b) => (logs += b));
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser =
    process.env.LOOP55_BROWSER === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({
          executablePath: process.env.CHROMIUM_PATH || undefined,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
          headless: true,
        });
  page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => {
    if (!isWebKitNavigationFetchError(process.env.LOOP55_BROWSER, e, base))
      errors.push(e.message);
  });
  await page.goto(base);
  await page.getByRole("heading", { name: "Feed", exact: true }).waitFor();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  assert.equal(
    (await page.context().cookies()).length,
    0,
    "Personal workspace needs no login cookie",
  );
  await page.screenshot({ path: join(dir, "mobile-empty.png") });
  await openSettings(page);
  await page.getByRole("button", { name: /Import conversations/ }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles("test/fixtures/chatgpt-export.zip");
  await page.getByRole("button", { name: "Preview import" }).click();
  await page
    .getByRole("button", { name: "Import these conversations" })
    .click();
  // Import jobs show progress and state separately instead of "1 / 1 · status".
  const job = page.locator(".settings-import-job").first();
  await job.getByText("1 of 1 conversations").waitFor({ timeout: 15000 });
  await job.getByText("Done", { exact: true }).waitFor({ timeout: 15000 });
  await closeSheets(page);
  // Result cards live on the agent's profile; the imported thread's byline
  // on the Feed opens it.
  await page
    .locator(".inbox-card")
    .filter({ hasText: "Market research" })
    .locator(".card-byline .identity")
    .click();
  await page.locator(".profile-head h1").waitFor();
  await page.getByRole("tab", { name: "Results", exact: true }).click();
  await page
    .getByRole("heading", { name: "Market research", exact: true })
    .waitFor();
  await page.screenshot({ path: join(dir, "mobile-feed.png") });
  const imported = page.locator(".feed-card").filter({
    has: page.getByRole("heading", { name: "Market research", exact: true }),
  });
  await imported.getByRole("button", { name: "Save", exact: true }).click();
  // Saved results and messages share the Saved tab on your profile.
  await openTab(page, "Your profile");
  await page
    .getByRole("region", { name: "Your profile", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Saved", exact: true }).click();
  await expect(imported).toBeVisible();
  await expect(
    imported.getByRole("button", { name: "Remove from Saved", exact: true }),
  ).toBeVisible();
  // The profile's counts go to what they count.
  const yourProfile = page.getByRole("region", {
    name: "Your profile",
    exact: true,
  });
  await yourProfile.getByRole("button", { name: /Agents$/ }).click();
  const directory = page.getByRole("dialog", { name: "Your agents" });
  await expect(directory).toBeVisible();
  await closeSheets(page);
  await expect(yourProfile).toBeVisible();
  await yourProfile.getByRole("button", { name: /Messages$/ }).click();
  await expect(
    page.getByRole("tab", { name: "Messages", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await yourProfile.getByRole("button", { name: /Projects$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await openTab(page, "Search");
  // The submit button is gone; Enter submits the search field.
  const searchField = page.getByRole("searchbox", {
    name: "Search everything",
  });
  await searchField.fill("bids");
  await searchField.press("Enter");
  // Search may still be loading when the optional keyword notice is absent.
  // Wait for the result itself before inspecting or opening it.
  await expect(page.locator(".search-result").first()).toBeVisible({
    timeout: 15000,
  });
  await page
    .locator(".search-result")
    .first()
    .locator(".search-hit, h3 button")
    .first()
    .click();
  await page.locator("dialog[open]").last().waitFor();
  await closeSheets(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await closeSheets(page);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: join(dir, "mobile-dark.png") });
  await page.reload();
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");

  for (const width of [320, 390, 430, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "horizontal overflow at " + width,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const identity = await page.evaluate(async () => {
    const r = await fetch("/api/auth/get-session");
    return r.json();
  });
  const fixtureDb = new Database(join(dir, "loop55.db"));
  const connection = crypto.randomUUID();
  fixtureDb
    .prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Browser fixture account','','connected',?,?)",
    )
    .run(
      connection,
      identity.user.id,
      JSON.stringify([
        { id: "browser-fixture-model", name: "Browser fixture model" },
      ]),
      Date.now(),
    );
  fixtureDb.close();
  const before = await page.evaluate(async () => {
    const r = await fetch("/api/runs");
    return (await r.json()).length;
  });
  await page.goto(
    base +
      "/share?url=" +
      encodeURIComponent("https://github.com/example/fixture") +
      "&question=" +
      encodeURIComponent("What could this become?"),
  );
  await page.getByRole("heading", { name: "Bring it into Loop55" }).waitFor();
  assert.equal(
    await page.getByLabel("Source URL", { exact: true }).inputValue(),
    "https://github.com/example/fixture",
  );
  await page
    .getByRole("button", { name: "Preview route", exact: true })
    .click();
  await page.getByRole("button", { name: "Choose provider & model" }).click();
  await page.getByText("Customize", { exact: true }).click();
  await chooseAgentModel(page, "browser-fixture-model");
  const newName = "browser-" + crypto.randomUUID().slice(0, 8);
  await page.getByLabel("Unique name").fill(newName);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  await page.getByRole("heading", { name: "Bring it into Loop55" }).waitFor();
  assert.equal(
    await page.getByLabel("Your question").inputValue(),
    "What could this become?",
  );
  await page.getByRole("button", { name: "Preview route" }).click();
  await page.getByRole("button", { name: "Send after review" }).waitFor();
  await page.getByLabel("Your question").fill("@unknown-agent review this");
  await page.getByRole("button", { name: "Preview route" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "unknown or unavailable" })
    .waitFor();
  await page.getByLabel("Your question").fill("@" + newName + " review this");
  await page.getByRole("button", { name: "Preview route" }).click();
  await page
    .getByText("Current work will continue.", { exact: false })
    .waitFor();
  const after = await page.evaluate(async () => {
    const r = await fetch("/api/runs");
    return (await r.json()).length;
  });
  assert.equal(after, before, "deep link and route preview must not send work");
  await page.screenshot({ path: join(dir, "mobile-share.png") });
  await page.goBack();
  await page.locator("dialog[open]").last().waitFor({ state: "hidden" });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByRole("heading", { name: "Bring it into Loop55" }).waitFor();
  await closeSheets(page);
  const cached = await page.evaluate(async () => {
    const all = [];
    for (const key of await caches.keys())
      for (const r of await (await caches.open(key)).keys()) all.push(r.url);
    return all;
  });
  assert.ok(cached.length >= 5);
  assert.equal(
    cached.some((u) => u.includes("/api/")),
    false,
  );
  await page.context().setOffline(true);
  await page.getByRole("status").filter({ hasText: "offline" }).waitFor();
  // Playwright WebKit aborts an offline reload before navigation. Chromium
  // exercises the cached fallback; both browsers check the notice and reconnect.
  if (process.env.LOOP55_BROWSER !== "webkit") {
    await page.reload();
    await page
      .getByRole("heading", { name: "Your work is still in Loop55." })
      .waitFor();
  }
  await page.context().setOffline(false);
  await page.goto(base);
  await page.getByRole("heading", { name: "Feed", exact: true }).waitFor();
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "landscape overflow",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toHaveCount(0);
  await closeSheets(page);
  await page.context().clearCookies();
  await page.reload();
  await page.getByRole("heading", { name: "Feed", exact: true }).waitFor();
  const reopened = await page.evaluate(async () =>
    (await fetch("/api/auth/get-session")).json(),
  );
  assert.equal(reopened.mode, "single-user");
  assert.equal(reopened.user.id, identity.user.id);
  await architectureSettingsJourney(page);
  assert.deepEqual(errors, []);

  console.log(
    "PASS: personal workspace without registration or cookies, preserved identity after reload, no redundant sign-out, worker import, profile results, later/saved results, folders, exact search, responsive layouts, themes, share routing, no auto-send, back, offline notice/reconnect (cached fallback in Chromium), public-only caches, no page errors",
  );
} catch (e) {
  console.log("PAGE", await page?.locator("body").innerText());
  console.log("SERVER", logs.slice(-2000));
  throw e;
} finally {
  await browser?.close();
  server.kill();
  worker.kill();
  rmSync(dir, { recursive: true, force: true });
}
