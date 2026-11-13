import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-search-status-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {SearchSettings} from ${JSON.stringify(resolve("src/client/Workspace.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {WorkspaceChangeQueue} from ${JSON.stringify(resolve("src/client/workspace-changes.ts"))};
    import {WorkspaceEvent} from ${JSON.stringify(resolve("src/shared/workspace-events.ts"))};
    ownerSession.change('alice');setShellSource('');
    const queue = new WorkspaceChangeQueue();
    window.signal=(source='',collection='search')=>{
      queue.add(source,[WorkspaceEvent.parse({type:'invalidate',scope:{kind:'collection',id:collection}})]);
      window.dispatchEvent(new CustomEvent('loop-workspace-change',{detail:queue.drain()}));
    };
    function Probe(){
      const [,render]=useState(0);
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      return React.createElement(SearchSettings,{connections:[],onClose:()=>{}});
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let snapshot,
    failure = false,
    holdNext = false,
    reads = 0;
  const status = (indexed, detail) => ({
    enabled: true,
    state: indexed === 20 ? "ready" : "indexing",
    total: 20,
    indexed,
    pending: 20 - indexed,
    detail,
  });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
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
    if (path.endsWith("/preferences")) {
      send(200, { embedding_enabled: 1, embedding_connection: null });
      return;
    }
    if (path.endsWith("/search/status")) {
      reads++;
      const code = failure ? 400 : 200,
        body = failure
          ? { error: "Index status unavailable" }
          : { ...snapshot };
      const reply = () => send(code, body);
      if (holdNext) {
        holdNext = false;
        held.push(reply);
      } else reply();
      return;
    }
    send(404, { error: "Unknown fixture route" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  for (const scenario of ["progress", "recovery", "scope"]) {
    reads = 0;
    failure = scenario === "recovery";
    holdNext = false;
    snapshot = status(1, "Initial index");
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.clock.install();
      await page.goto("http://127.0.0.1:" + server.address().port);
      const banner = page.locator(".search-index-status");
      if (scenario === "recovery") {
        await expect(page.getByRole("alert")).toContainText(
          "Index status unavailable",
        );
        assert.equal(reads, 1);
        failure = false;
        snapshot = status(20, "Recovered index");
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(banner).toContainText("Recovered index");
        await expect(page.getByRole("alert")).toHaveCount(0);
        assert.equal(reads, 2);
        failure = true;
        await page.evaluate(() => window.signal());
        await expect(page.getByRole("alert")).toContainText(
          "Index status unavailable",
        );
        await expect(banner).toContainText("Recovered index");
        failure = false;
        snapshot = status(10, "Content changed");
        await page.evaluate(() => window.signal("", "results"));
        await expect(banner).toContainText("Content changed");
        await expect(page.getByRole("alert")).toHaveCount(0);
      } else {
        await expect(banner).toContainText("Initial index");
        if (scenario === "progress") {
          await page.clock.fastForward(12000);
          assert.equal(reads, 1, "the view must not poll while idle");
          snapshot = status(16, "Batch indexed");
          await page.evaluate(() => window.signal("unrelated-source"));
          await page.clock.runFor(20);
          assert.equal(reads, 1, "foreign-source progress must not refresh");
          await page.evaluate(() => window.signal());
          await expect(banner).toContainText("Batch indexed");
          snapshot = status(20, "All indexed");
          await page.evaluate(() => window.signal());
          await expect(banner).toContainText("Semantic search ready");
          await expect(banner).toContainText("All indexed");
          const settled = reads;
          await page.clock.fastForward(12000);
          assert.equal(
            reads,
            settled,
            "completed indexing must not leave a timer",
          );
        } else {
          let source = "";
          for (const [kind, value] of [
            ["source", "docker:other"],
            ["owner", "bob"],
            ["owner", "alice"],
          ]) {
            snapshot = status(19, "Old held index");
            holdNext = true;
            await page.evaluate((source) => window.signal(source), source);
            await expect.poll(() => held.length).toBe(1);
            snapshot = status(2, "Current index");
            holdNext = true;
            await page.evaluate(
              ([kind, value]) => window[kind](value),
              [kind, value],
            );
            if (kind === "source") source = value;
            await expect.poll(() => held.length).toBe(2);
            await expect(banner).toHaveCount(0);
            held.pop()();
            await expect(banner).toContainText("Current index");
            held.shift()();
            await page.clock.runFor(50);
            await expect(banner).toContainText("Current index");
          }
        }
      }
      assert.deepEqual(errors, []);
      console.log(engine + " Search status passed: " + scenario);
    } finally {
      held.splice(0).forEach((send) => send());
      await context.close();
    }
  }
} finally {
  held.splice(0).forEach((send) => send());
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
