import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

// Production provider cards and typed transport; all releases/installers are
// deterministic HTTP fixtures, with no provider, registry or device traffic.
const dir = await mkdtemp(join(tmpdir(), "loop-harness-upgrades-browser-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
let browser, server;
let upgrade = null,
  installed = "0.159.0",
  polls = 0,
  effects = 0,
  checks = 0;
let outcome = "complete";
let loseStartReply = true;
const commandIds = [];
const enableIds = [];
let enableOutcome = "unknown";
let authUnavailable = false;
let holdCheck = false,
  checkEntered = false,
  releaseCheck;
const requests = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {RuntimeSetup} from ${JSON.stringify(resolve("src/client/RuntimeSetup.tsx"))};
    import {setViewOwner} from  ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    setViewOwner("fixture-owner");
    import {HarnessUpgrade} from ${JSON.stringify(resolve("src/client/HarnessUpgrade.tsx"))};
    import ${JSON.stringify(resolve("src/client/style.css"))};
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement(RuntimeSetup, {onEnabled: async () => {}}));
    window.renderUpgrade = disabled => root.render(React.createElement(HarnessUpgrade, {runtime: "codex", label: "Codex", disabled}));
  `,
  );
  const bundle = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    requests.push([req.method, url.pathname, url.search]);
    const reply = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client.css"><main id="root"></main><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (url.pathname === "/client.mjs") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.script);
      return;
    }
    if (url.pathname === "/client.css") {
      res.setHeader("content-type", "text/css");
      res.end(bundle.style);
      return;
    }
    if (url.pathname === "/api/workspace/runtimes") {
      reply({
        computer: "Fixture laptop",
        online: true,
        setup: "ready",
        runtimes: [
          {
            name: "codex",
            backend: "direct",
            installed: true,
            available: true,
            enabled: true,
            authentication: "previously_verified",
            version: installed,
            help: "",
            project: "/fixture",
          },
          {
            name: "muse",
            backend: "direct",
            installed: true,
            available: true,
            enabled: true,
            authentication: "previously_verified",
            version: "1.4.12",
            help: "",
            project: "/fixture",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/workspace") {
      reply({
        harnesses: [],
        nativeProcesses: 0,
        concurrency: 1,
        hostLifetime: "foreground",
        tunnelOrigin: "",
        projectPaths: [{ folder_id: "fixture-project", path: "/fixture" }],
      });
      return;
    }
    if (url.pathname === "/api/workspace/runtimes/codex/enable") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      enableIds.push(body.commandId);
      if (enableOutcome === "unknown")
        reply(
          {
            error: "Fixture enable outcome is unknown",
            executionOutcome: "unknown",
          },
          409,
        );
      else if (enableOutcome === "refused")
        reply(
          {
            error: "Fixture project access refused",
            executionOutcome: "refused",
          },
          403,
        );
      else
        reply({
          name: "codex",
          billing: { mode: body.billing, description: "Fixture billing" },
          models: [],
          capabilities: {},
        });
      return;
    }
    if (url.pathname.endsWith("/auth")) {
      reply(
        authUnavailable
          ? { providers: "unavailable" }
          : {
              providers: [],
              attempt: {
                id: "attempt-a",
                commandId: "auth-a",
                provider: "codex",
                method: "login",
                state: "complete",
                expiresAt: Date.now() + 60000,
                url: "https://fixture.invalid",
                instructions: "Fixture auth status loaded",
              },
            },
      );
      return;
    }
    if (url.pathname === "/api/workspace/runtimes/muse/upgrade") {
      reply({
        upgrade: null,
        canUpgrade: false,
        upgradeHelp:
          "Muse Code updates itself. Run muse on the computer to check for an update now.",
      });
      return;
    }
    if (url.pathname === "/api/workspace/runtimes/codex/upgrade") {
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.match(body.commandId, /^[0-9a-f-]{36}$/);
        commandIds.push(body.commandId);
        effects++;
        polls = 0;
        upgrade = {
          commandId: body.commandId,
          name: "codex",
          state: "running",
          message: "Upgrading runtime…",
        };
        if (loseStartReply) {
          loseStartReply = false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"');
        } else reply({ upgrade });
        return;
      }
      if (req.method === "DELETE") {
        upgrade = null;
        reply({ upgrade });
        return;
      }
      if (upgrade?.state === "running" && ++polls >= 2) {
        installed = "0.160.0";
        upgrade = {
          ...upgrade,
          state: outcome,
          version: installed,
          message:
            outcome === "restart-required"
              ? "Restart the workspace before running Codex again. Queued prompts will wait."
              : "Upgraded from 0.159.0 to 0.160.0.",
        };
      }
      if (url.searchParams.has("check")) {
        checks++;
        if (holdCheck) {
          checkEntered = true;
          await new Promise((done) => {
            releaseCheck = done;
          });
        }
      }
      reply({
        upgrade,
        canUpgrade: true,
        ...(url.searchParams.has("check")
          ? {
              installedVersion: installed,
              latestVersion: "0.160.0",
              updateAvailable: installed !== "0.160.0",
              checkedAt: Date.now(),
            }
          : {}),
      });
      return;
    }
    reply({ error: `Unexpected fixture route: ${url.pathname}` }, 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card = page
    .locator(".native-runtime")
    .filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
  await expect(card).toContainText("Update available: 0.159.0 → 0.160.0");
  await expect(card).toContainText("Fixture laptop · Version 0.159.0");
  assert.equal(
    await page.locator(".settings-sheet").count(),
    0,
    "updates are on the provider card",
  );
  const openAccount = () =>
    card
      .getByRole("button", { name: "Manage Codex account", exact: true })
      .click();
  await openAccount();
  const account = page.getByRole("dialog", { name: "Codex", exact: true });
  const refreshRuntime = account.getByRole("button", {
    name: "Refresh Codex",
    exact: true,
  });
  await expect(account).toContainText("Fixture auth status loaded");
  await refreshRuntime.click();
  await expect(account).toContainText("Fixture enable outcome is unknown");
  const pendingEnable = enableIds.at(-1);
  authUnavailable = true;
  await page.reload();
  await openAccount();
  await expect(refreshRuntime).toBeEnabled();
  await refreshRuntime.click();
  await expect(account).toContainText("Fixture enable outcome is unknown");
  assert.deepEqual(
    enableIds,
    [pendingEnable, pendingEnable],
    "reload must recover the same enable command",
  );
  enableOutcome = "refused";
  await refreshRuntime.click();
  await expect(account).toContainText("Fixture project access refused");
  enableOutcome = "unknown";
  await refreshRuntime.click();
  await expect(account).toContainText("Fixture enable outcome is unknown");
  assert.deepEqual(
    enableIds,
    Array(4).fill(pendingEnable),
    "a recovery refusal must retain the original unknown command",
  );
  await account
    .getByRole("button", { name: "Check runtime status", exact: true })
    .click();
  const newVerification = account.getByRole("button", {
    name: "Start new verification",
    exact: true,
  });
  await expect(newVerification).toBeEnabled();
  assert.equal(enableIds.length, 4, "inspection does not dispatch");
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    window.blockArchive = true;
    Storage.prototype.setItem = function (key, value) {
      if (window.blockArchive && key.startsWith("loop-effect-history:"))
        throw new Error("Fixture archive unavailable");
      return set.call(this, key, value);
    };
  });
  await newVerification.click();
  await expect(account).toContainText("Fixture archive unavailable");
  assert.equal(enableIds.length, 4, "failed supersession cannot dispatch");
  await page.evaluate(() => {
    window.blockArchive = false;
  });
  await account
    .getByRole("button", { name: "Check runtime status", exact: true })
    .click();
  await expect(newVerification).toBeEnabled();
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    window.blockRemoval = true;
    Storage.prototype.removeItem = function (key) {
      if (window.blockRemoval && key.startsWith("loop-effect:"))
        throw new Error("Fixture removal unavailable");
      return remove.call(this, key);
    };
  });
  await newVerification.click();
  await expect(account).toContainText("Fixture removal unavailable");
  assert.equal(
    enableIds.length,
    4,
    "failed active-slot removal cannot dispatch",
  );
  await page.evaluate(() => {
    window.blockRemoval = false;
  });
  await account
    .getByRole("button", { name: "Check runtime status", exact: true })
    .click();
  await expect(newVerification).toBeEnabled();
  enableOutcome = "success";
  await newVerification.click();
  await expect(refreshRuntime).toBeEnabled();
  await expect(
    account.getByText("Connection not verified", { exact: true }),
  ).toHaveCount(0);
  assert.notEqual(enableIds.at(-1), pendingEnable);
  assert.equal(enableIds.length, 5);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    window.blockEnable = true;
    Storage.prototype.setItem = function (key, value) {
      if (window.blockEnable && key.startsWith("loop-effect:"))
        throw new Error("Fixture storage unavailable");
      return set.call(this, key, value);
    };
  });
  await refreshRuntime.click();
  await expect(account).toContainText("nothing was sent");
  assert.equal(
    enableIds.length,
    5,
    "storage failure prevents runtime verification",
  );
  await page.evaluate(() => {
    window.blockEnable = false;
  });
  await account.getByRole("button", { name: "Close", exact: true }).click();
  await expect(account).toHaveCount(0);
  const update = card.getByRole("button", {
    name: "Upgrade Codex",
    exact: true,
  });
  await expect(update).toBeEnabled();
  assert.equal(effects, 0, "opening provider settings only checks metadata");
  await page.evaluate(() => {
    window.blockIdentity = true;
    window.blockedWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        window.blockIdentity &&
        (key.startsWith("loop-effect:") || key.startsWith("loop-upgrade-cmd:"))
      ) {
        window.blockedWrites++;
        throw new Error("Fixture storage unavailable");
      }
      return set.call(this, key, value);
    };
  });
  await update.click();
  await expect.poll(() => page.evaluate(() => window.blockedWrites)).toBe(1);
  await expect(update).toBeEnabled();
  assert.equal(effects, 0, "storage refusal must prevent an upgrade start");
  await page.evaluate(() => {
    window.blockIdentity = false;
  });
  await update.click();
  await expect(
    card.getByRole("button", { name: "Upgrading Codex…", exact: true }),
  ).toBeDisabled();
  await expect(card).toContainText("Upgraded from 0.159.0 to 0.160.0.", {
    timeout: 10_000,
  });
  await expect(card).toContainText("No newer release found: 0.160.0");
  assert.equal(effects, 1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith("loop-effect:"),
          ).length,
      ),
    )
    .toBe(0);
  await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  const before = checks;
  await card
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect.poll(() => checks).toBeGreaterThan(before);
  assert.equal(effects, 1, "checking does not reinstall");
  outcome = "restart-required";
  await update.click();
  await expect(card).toContainText(
    "Restart the workspace before running Codex again.",
    { timeout: 10_000 },
  );
  await expect(update).toBeDisabled();
  assert.notEqual(
    commandIds[1],
    commandIds[0],
    "status recovery settles the lost start reply before a later upgrade",
  );
  await page.reload();
  await expect(card).toContainText(
    "Restart the workspace before running Codex again.",
  );
  await expect(update).toBeDisabled();
  assert.equal(effects, 2, "reload never replays an upgrade");
  const muse = page.locator(".native-runtime").filter({
    has: page.getByRole("heading", { name: "Muse Code", exact: true }),
  });
  await expect(muse).toContainText("Muse Code updates itself");
  await expect(
    muse.getByRole("button", { name: "Upgrade Muse Code", exact: true }),
  ).toBeDisabled();
  assert(
    !requests.some(
      ([method, path]) => method === "POST" && path.includes("muse"),
    ),
  );
  // The provider page disables all upgrade controls while another account is
  // being enabled/inspected. Abort an initial release lookup at that boundary,
  // then re-enable the same component without remounting it.
  upgrade = null;
  installed = "0.159.0";
  holdCheck = true;
  const beforeCancellation = checks;
  await page.evaluate(() => window.renderUpgrade(false));
  await expect.poll(() => checkEntered).toBe(true);
  await page.evaluate(() => window.renderUpgrade(true));
  await expect(
    page.getByRole("button", { name: "Upgrade Codex", exact: true }),
  ).toBeDisabled();
  holdCheck = false;
  releaseCheck();
  await page.evaluate(() => window.renderUpgrade(false));
  await expect(page.getByRole("status")).toContainText(
    "Update available: 0.159.0 → 0.160.0",
  );
  assert.equal(
    checks,
    beforeCancellation + 2,
    "cancellation must retry release lookup automatically",
  );
  assert.equal(effects, 2, "retrying a release check never upgrades");
  assert.deepEqual(failures, []);
  console.log(
    `harness-upgrades-browser (${engine.name()}): provider cards, read-only checks, progress, refresh, restart hold, reload and cancelled-check recovery passed`,
  );
} finally {
  releaseCheck?.();
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
