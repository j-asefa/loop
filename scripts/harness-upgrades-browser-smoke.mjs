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
    if (url.pathname.endsWith("/auth")) {
      reply({ providers: [] });
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
        effects++;
        polls = 0;
        upgrade = {
          commandId: body.commandId,
          name: "codex",
          state: "running",
          message: "Upgrading runtime…",
        };
        reply({ upgrade });
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
  const update = card.getByRole("button", {
    name: "Upgrade Codex",
    exact: true,
  });
  await expect(update).toBeEnabled();
  assert.equal(effects, 0, "opening provider settings only checks metadata");
  await update.click();
  await expect(
    card.getByRole("button", { name: "Upgrading Codex…", exact: true }),
  ).toBeDisabled();
  await expect(card).toContainText("Upgraded from 0.159.0 to 0.160.0.", {
    timeout: 10_000,
  });
  await expect(card).toContainText("No newer release found: 0.160.0");
  assert.equal(effects, 1);
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
