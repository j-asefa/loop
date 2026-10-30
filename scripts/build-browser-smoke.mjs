import "../deployment/environment.mjs";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { buildFallbackSmoke } from "./helpers/build-fallback-smoke.mjs";

const identity = (id) => ({
  id,
  repository: "github.com/j-asefa/loop",
  commit: "a".repeat(40),
  clean: true,
  builtAt: 1,
  ancestors: [],
});
const scripts = new Map();
for (const version of ["old", "new"]) {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserBuildStatus} from './src/client/BuildStatus';
    createRoot(document.getElementById('root')).render(<><BrowserBuildStatus/><textarea aria-label="Draft"/></>);
  `,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: {
      __LOOP55_BUILD__: JSON.stringify(identity(version)),
      "process.env.NODE_ENV": '"production"',
    },
  });
  scripts.set(version, result.outputFiles[0].text);
}
const css = await readFile("src/client/style.css", "utf8");
let loaded = "old",
  fail = false;
const server = createServer((req, res) => {
  if (req.url === "/api/build") {
    res.writeHead(fail ? 503 : 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ serving: identity("new") }));
  } else if (req.url === "/app.js") {
    res.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    res.end(scripts.get(loaded));
  } else if (req.url === "/style.css") {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(css);
  } else {
    res.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div id="root" style="max-width:440px;padding:16px"></div><script type="module" src="/app.js"></script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  for (const [name, engine] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    if (process.env.LOOP55_BROWSER && process.env.LOOP55_BROWSER !== name)
      continue;
    loaded = "old";
    fail = false;
    const browser = await engine.launch({
      headless: true,
      ...(name === "chromium" && process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.clock.install();
      let buildRequests = 0,
        releaseBuild;
      const slowBuild = new Promise((resolve) => {
        releaseBuild = resolve;
      });
      await page.route("**/api/build", async (route) => {
        if (++buildRequests === 1) await slowBuild;
        await route.continue();
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await expect.poll(() => buildRequests).toBe(1);
      await page.clock.runFor(16000);
      expect(buildRequests).toBe(1);
      releaseBuild();
      await expect(
        page.getByText("This page and the running app use different builds."),
      ).toBeVisible();
      await page.getByLabel("Draft").fill("Keep my unsent draft");
      fail = true;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(
        page.getByText("This page and the running app use different builds."),
      ).toBeVisible();
      await expect(page.getByLabel("Draft")).toHaveValue(
        "Keep my unsent draft",
      );
      fail = false;
      loaded = "new";
      await page.getByRole("button", { name: "Reload to update" }).click();
      await expect(
        page.getByRole("button", { name: "Reload to update" }),
      ).toHaveCount(0);
      await buildFallbackSmoke(
        browser,
        `http://127.0.0.1:${server.address().port}`,
      );
      console.log(
        `${name}: slow build checks, cold stale page, failed refresh, explicit reload, unknown build identity fallback passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
