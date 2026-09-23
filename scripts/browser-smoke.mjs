import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "loop-browser-"));
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const server = spawn(
  process.execPath,
  ["--env-file=.env", "--import", "tsx", "src/server/index.ts"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOOP_DATA_DIR: dir },
  },
);
const worker = spawn(
  process.execPath,
  ["--env-file=.env", "--import", "tsx", "src/server/worker.ts"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOOP_DATA_DIR: dir },
  },
);
let browser, page;
let logs = "";
server.stderr.on("data", (b) => (logs += b));
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch("http://localhost:3000/api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:3000");
  await page.getByText("New here? Create an account").click();
  await page.getByLabel("Your name").fill("Workspace tester");
  await page
    .getByLabel("Email", { exact: true })
    .fill(`browser-${crypto.randomUUID()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill(crypto.randomUUID() + "Ab1!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("heading", { name: "Your loop." }).waitFor();
  await page.screenshot({ path: "docs/loop-v0/evidence/mobile-empty.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Import conversations/ }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles("tests/fixtures/chatgpt-export.zip");
  await page.getByRole("button", { name: "Preview import" }).click();
  await page
    .getByRole("button", { name: "Import these conversations" })
    .click();
  await page
    .getByText("1 / 1 conversations · completed")
    .waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("heading", { name: "Market research", exact: true })
    .waitFor();
  await page.screenshot({ path: "docs/loop-v0/evidence/mobile-feed.png" });
  await page
    .getByRole("navigation")
    .last()
    .getByRole("button", { name: "Saved", exact: true })
    .click();
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Research Radar");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Research Radar project" }).waitFor();
  await page
    .getByRole("navigation")
    .last()
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Search everything" }).fill("bids");
  await page
    .locator("form.search-box")
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await page
    .getByText("Keyword search")
    .first()
    .waitFor({ timeout: 1500 })
    .catch(() => {});
  assert.ok((await page.locator(".search-result").count()) >= 1);
  await page.locator(".search-result").first().click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "dark", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: "docs/loop-v0/evidence/mobile-dark.png" });
  await page.reload();
  await page.getByRole("heading", { name: "Your loop." }).waitFor();
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
  const fixtureDb = new Database(join(dir, "loop.db"));
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
    "http://localhost:3000/share?url=" +
      encodeURIComponent("https://github.com/example/fixture") +
      "&question=" +
      encodeURIComponent("What could this become?"),
  );
  await page.getByRole("heading", { name: "Bring it into Loop" }).waitFor();
  assert.equal(
    await page.getByLabel("Source URL", { exact: true }).inputValue(),
    "https://github.com/example/fixture",
  );
  await page
    .getByRole("button", { name: "Preview route", exact: true })
    .click();
  await page.getByRole("button", { name: "Choose provider & model" }).click();
  await page
    .getByRole("combobox", { name: /^Model/ })
    .selectOption("browser-fixture-model");
  const newName = "browser-" + crypto.randomUUID().slice(0, 8);
  await page.getByLabel("Unique name").fill(newName);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("heading", { name: "Bring it into Loop" }).waitFor();
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
  await page.screenshot({ path: "docs/loop-v0/evidence/mobile-share.png" });
  await page.goBack();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByRole("heading", { name: "Bring it into Loop" }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
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
  await page.reload();
  await page
    .getByRole("heading", { name: "Your work is still in Loop." })
    .waitFor();
  await page.context().setOffline(false);
  await page.goto("http://localhost:3000");
  await page.getByRole("heading", { name: "Your loop." }).waitFor();
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "landscape overflow",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "light", exact: true }).click();
  await page.getByRole("button", { name: "system", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "Pick up where you left off." })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      Object.values(sessionStorage).some((v) =>
        v.includes("What could this become?"),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);

  console.log(
    "PASS: signup, worker import, feed, folders, exact search, 320/390/430/1024 layouts, dark/system themes, share routing + agent creation + unknown handle, no auto-send, back, offline fallback, public-only caches, logout, no page errors",
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
