import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { workspaceCapabilities } from "../src/shared/capabilities.ts";

const dir = await mkdtemp(join(tmpdir(), "loop-owner-session-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
let browser, server;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React, {Suspense, startTransition, useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {useAppController} from ${JSON.stringify(resolve("src/client/app/AppController.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {cacheView, cachedView, viewOwner, viewGeneration} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import {saveThreadDraft, threadDraft} from ${JSON.stringify(resolve("src/client/drafts.ts"))};
    import {loadCapabilities} from ${JSON.stringify(resolve("src/client/capabilities.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    setShellSource("");
    await loadCapabilities();
    let blocked = false;
    const pending = new Promise(() => {});
    function Probe() {
      const [, render] = useState(0);
      window.rerender = () => render(value => value + 1);
      const model = useAppController();
      window.model = model;
      if (blocked) { window.suspended = true; throw pending; }
      return React.createElement("output", {id:"owner"}, model.session?.user.id || "anonymous");
    }
    window.inspect = () => ({owner:viewOwner(), generation:viewGeneration(), sessionOwner:ownerSession.current.session?.user.id, cached:cachedView("fixture"), draft:threadDraft("fixture").text});
    window.save = text => { cacheView("fixture", text, viewOwner()); saveThreadDraft("fixture", text, []); };
    window.changeOwner = id => window.model.setSession({user:{id,name:id},mode:"paired"});
    window.suspend = () => { blocked = true; startTransition(() => window.rerender()); };
    window.resume = () => { blocked = false; window.rerender(); };
    createRoot(document.getElementById("root")).render(React.createElement(Suspense, {fallback:React.createElement("p",{id:"fallback"},"Waiting")}, React.createElement(Probe)));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (path === "/client.mjs" || path === "/client.css") {
      res.writeHead(200, {
        "content-type": path.endsWith(".mjs") ? "text/javascript" : "text/css",
      });
      res.end(path.endsWith(".mjs") ? script : style);
      return;
    }
    const replies = {
      "/api/capabilities": workspaceCapabilities(),
      "/api/auth/get-session": {
        user: { id: "alice", name: "Alice" },
        mode: "paired",
      },
      "/api/bootstrap": { agents: [], connections: [], folders: [], teams: [] },
      "/api/agent-sources": [],
      "/api/runs": [],
      "/api/events": [],
      "/api/feed": {
        items: [],
        next: null,
        summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
      },
    };
    const known = Object.hasOwn(replies, path);
    res.writeHead(known ? 200 : 404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify(
        known ? replies[path] : { error: "Fixture route unavailable" },
      ),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await engine.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator("#owner")).toHaveText("alice");
  await page.evaluate(() => window.save("Alice draft"));
  const first = await page.evaluate(() => window.inspect());
  assert.equal(first.owner, "alice");
  assert.equal(first.sessionOwner, "alice");
  await page.evaluate(() => window.suspend());
  await expect.poll(() => page.evaluate(() => window.suspended)).toBe(true);
  await expect(page.locator("#owner")).toHaveText("alice");
  assert.deepEqual(await page.evaluate(() => window.inspect()), first);

  await page.evaluate(() => window.changeOwner("bob"));
  await expect(page.locator("#fallback")).toBeVisible();
  await expect(page.locator("#owner")).not.toBeVisible();
  const changed = await page.evaluate(() => window.inspect());
  assert.equal(changed.owner, "bob");
  assert.equal(changed.sessionOwner, "bob");
  assert.equal(changed.generation, first.generation + 1);
  assert.equal(changed.cached, undefined);
  assert.equal(changed.draft, "");
  await page.evaluate(() => window.resume());
  await expect(page.locator("#owner")).toHaveText("bob");
  assert.deepEqual(await page.evaluate(() => window.inspect()), changed);
  await page.evaluate(() => window.save("Bob draft"));
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-auth-expired")),
  );
  await expect(page.locator("#owner")).toHaveText("anonymous");
  assert.equal((await page.evaluate(() => window.inspect())).owner, undefined);
  await page.evaluate(() => window.changeOwner("alice"));
  await expect(page.locator("#owner")).toHaveText("alice");
  const returned = await page.evaluate(() => window.inspect());
  assert.equal(returned.generation, first.generation + 3);
  assert.equal(returned.draft, "Alice draft");
  assert.equal(returned.cached, undefined);
  for (const transition of ["owner", "expiry"]) {
    let release;
    let arrived;
    const reached = new Promise((resolve) => {
      arrived = resolve;
    });
    const handler = async (route) => {
      await new Promise((resolve) => {
        release = resolve;
        arrived();
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "alice", name: "Stale Alice" },
          mode: "paired",
        }),
      });
    };
    await page.route("**/api/auth/get-session", handler);
    try {
      await page.evaluate(() => {
        window.checkDone = false;
        void window.model.check().finally(() => {
          window.checkDone = true;
        });
      });
      await reached;
      if (transition === "owner")
        await page.evaluate(() => window.changeOwner("bob"));
      else
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-auth-expired")),
        );
      const expected = transition === "owner" ? "bob" : "anonymous";
      await expect(page.locator("#owner")).toHaveText(expected);
      const current = await page.evaluate(() => window.inspect());
      release();
      await expect.poll(() => page.evaluate(() => window.checkDone)).toBe(true);
      await expect(page.locator("#owner")).toHaveText(expected);
      assert.deepEqual(await page.evaluate(() => window.inspect()), current);
    } finally {
      release?.();
      await page.unroute("**/api/auth/get-session", handler);
    }
  }
  await page.goto(
    `http://127.0.0.1:${server.address().port}/?connect=1&page=projects`,
  );
  await expect(page.locator("#owner")).toHaveText("alice");
  assert.deepEqual(
    await page.evaluate(() => ({
      tab: window.model.tab,
      sheet: window.model.sheet,
      returnTo: window.model.returnTo,
      connect: new URL(location.href).searchParams.has("connect"),
    })),
    {
      tab: "projects",
      sheet: "connections",
      returnTo: "create",
      connect: false,
    },
  );
  await page.evaluate(() => {
    window.model.setSheet("memory");
    window.changeOwner("alice");
  });
  await expect
    .poll(() => page.evaluate(() => window.model.sheet))
    .toBe("memory");
  assert.equal(await page.evaluate(() => window.model.returnTo), "create");
  await page.goto(
    `http://127.0.0.1:${server.address().port}/?share=1&text=https%3A%2F%2Fexample.com%2Farticle&title=Article&folder=project`,
  );
  await expect(page.locator("#owner")).toHaveText("alice");
  assert.deepEqual(
    await page.evaluate(() => ({
      sheet: window.model.sheet,
      folder: window.model.folderChoice,
      draft: window.model.sharedDraft,
    })),
    {
      sheet: "share",
      folder: "project",
      draft: {
        url: "https://example.com/article",
        title: "Article",
        excerpt: "https://example.com/article",
        question: "",
        folderId: "project",
      },
    },
  );
  assert.deepEqual(errors, []);
  console.log(
    "Session snapshot and navigation: suspended render, owner replacement, expiry, delayed auth responses, draft isolation and deep-link initialization passed",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
