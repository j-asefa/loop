import { build } from "esbuild";
import { expect } from "@playwright/test";

export async function buildFallbackSmoke(browser, base) {
  const identity = (id) => ({
    id,
    repository: null,
    commit: null,
    clean: false,
    builtAt: 0,
    ancestors: [],
  });
  for (const { loaded, legacy, initialMismatch } of [
    { loaded: "development" },
    { loaded: "compiled" },
    { loaded: "compiled", legacy: "missing" },
    { loaded: "compiled", legacy: "malformed" },
    { loaded: "compiled", legacy: "missing", initialMismatch: true },
  ]) {
    const page = await browser.newPage();
    let socket,
      reads = 0,
      serving = loaded;
    try {
      await page.clock.install();
      await page.route("**/build-fallback-fixture", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<main id="root"></main>',
        }),
      );
      await page.route("**/api/build", (route) => {
        reads++;
        if (serving === null) return route.fulfill({ status: 404, json: {} });
        return route.fulfill({ json: { serving: identity(serving) } });
      });
      await page.routeWebSocket("**/ws?*", (route) => {
        socket = route;
      });
      await page.goto(base + "/build-fallback-fixture");
      const bundle = await build({
        stdin: {
          resolveDir: process.cwd(),
          loader: "tsx",
          contents: `
            import React from 'react'; import {createRoot} from 'react-dom/client';
            import {BrowserBuildStatus} from './src/client/BuildStatus';
            import {WorkspaceConnection} from './src/client/NativeControls';
            createRoot(document.getElementById('root')).render(<><BrowserBuildStatus/><WorkspaceConnection/></>);
          `,
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        loader: { ".css": "empty" },
        define: {
          __LOOP_BUILD__: JSON.stringify(identity(loaded)),
          "process.env.NODE_ENV": '"production"',
        },
      });
      const initialRead = page.waitForResponse("**/api/build");
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await (await initialRead).finished();
      await expect.poll(() => Boolean(socket)).toBe(true);
      const reset = (asset, id) =>
        socket.send(
          JSON.stringify({
            v: 2,
            type: "reset",
            cursor: 0,
            epoch: "fixture",
            build: asset,
            buildIdentity: typeof id === "string" ? identity(id) : id,
          }),
        );
      await page.clock.runFor(1000);
      const reload = page.getByRole("button", { name: "Reload to update" });
      if (initialMismatch) {
        reset("mismatching-assets", "replacement");
        await expect(reload).toBeVisible();
      }
      reset("original-assets", loaded);
      await expect(reload).toHaveCount(0);
      if (legacy) {
        // Roll back to a server without a usable identity or build endpoint.
        // Its first changed asset hash must still use the original baseline.
        serving = null;
        reset(
          initialMismatch ? "mismatching-assets" : "legacy-assets",
          legacy === "missing" ? undefined : {},
        );
        await expect(reload).toBeVisible();
        const absentRead = page.waitForResponse("**/api/build");
        await page.clock.runFor(15000);
        expect((await absentRead).status()).toBe(404);
        await page.clock.runFor(1000);
        await expect(reload).toBeVisible();
        continue;
      }
      // Source pages detect changed assets by hash; compiled pages can use a
      // known different identity. Neither notice may be erased by uncertainty.
      reset("new-assets", loaded === "development" ? loaded : "replacement");
      await expect(reload).toBeVisible();
      serving = "development";
      const unknownRead = page.waitForResponse("**/api/build");
      await page.clock.runFor(15000);
      await (await unknownRead).finished();
      await page.clock.runFor(1000);
      expect(reads).toBeGreaterThan(1);
      await expect(reload).toBeVisible();
      reset("new-assets", "development");
      await page.clock.runFor(1000);
      await expect(reload).toBeVisible();
      if (loaded !== "development") {
        serving = loaded;
        const matchingRead = page.waitForResponse("**/api/build");
        await page.clock.runFor(15000);
        await (await matchingRead).finished();
        await expect(reload).toHaveCount(0);
      }
    } finally {
      await page.close();
    }
  }
}
