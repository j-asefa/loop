import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-import-status-"));
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
    import {ImportSheet} from ${JSON.stringify(resolve("src/client/Workspace.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {WorkspaceChangeQueue} from ${JSON.stringify(resolve("src/client/workspace-changes.ts"))};
    import {WorkspaceEvent} from ${JSON.stringify(resolve("src/shared/workspace-events.ts"))};
    ownerSession.change('alice');setShellSource('');
    const queue=new WorkspaceChangeQueue();
    window.signal=(source='')=>{
      queue.add(source,[WorkspaceEvent.parse({type:'invalidate',scope:{kind:'collection',id:'imports'}})]);
      window.dispatchEvent(new CustomEvent('loop-workspace-change',{detail:queue.drain()}));
    };
    function Probe(){const [,render]=useState(0);
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      return React.createElement(ImportSheet,{onClose:()=>{},onChange:()=>{}});
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let job,
    failure = false,
    holdNext = false,
    reads = 0,
    writes = 0;
  const row = (completed, status = "running") => ({
    id: "fixture-import",
    owner_id: "alice",
    provider: "openai",
    digest: "fixture-digest",
    status,
    created_at: 1,
    summary: JSON.stringify({ completed, conversations: 20 }),
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
    if (path.endsWith("/imports/preview")) {
      writes++;
      send(500, { error: "Upload rejected" });
      return;
    }
    if (path.endsWith("/imports")) {
      reads++;
      const code = failure ? 400 : 200,
        body = failure ? { error: "History unavailable" } : [{ ...job }];
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
    job = row(0, "queued");
    failure = scenario === "recovery";
    holdNext = false;
    reads = 0;
    writes = 0;
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.clock.install();
      await page.goto("http://127.0.0.1:" + server.address().port);
      const history = page.locator(".settings-import-job"),
        notice = page.locator(".collection-read-error");
      if (scenario === "recovery") {
        await expect(notice).toContainText("History unavailable");
        assert.equal(reads, 1);
        failure = false;
        job = row(2);
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(history).toContainText("2 of 20");
        await expect(notice).toHaveCount(0);
        failure = true;
        await page.evaluate(() => window.signal());
        await expect(notice).toContainText("History unavailable");
        await expect(history).toContainText("2 of 20");
        await page
          .locator("input[type=file]")
          .setInputFiles({
            name: "conversations.json",
            mimeType: "application/json",
            buffer: Buffer.from("[]"),
          });
        await page
          .getByRole("button", { name: "Preview import", exact: true })
          .click();
        await expect(page.getByRole("alert")).toHaveCount(2);
        await expect(
          page.getByRole("alert").filter({ hasText: "Upload rejected" }),
        ).toBeVisible();
        assert.equal(writes, 1);
        failure = false;
        job = row(20, "completed");
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(history).toContainText("Done");
        await expect(notice).toHaveCount(0);
        await expect(page.getByRole("alert")).toContainText("Upload rejected");
        assert.equal(
          writes,
          1,
          "retrying a history read must not repeat the upload",
        );
      } else {
        await expect(history).toContainText("Queued");
        if (scenario === "progress") {
          await page.clock.fastForward(12000);
          assert.equal(reads, 1, "history must not poll while idle");
          job = row(16);
          await page.evaluate(() => window.signal("unrelated-source"));
          await page.clock.runFor(20);
          assert.equal(reads, 1);
          await page.evaluate(() => window.signal());
          await expect(history).toContainText("16 of 20");
          job = row(20, "completed");
          await page.evaluate(() => window.signal());
          await expect(history).toContainText("Done");
          const settled = reads;
          await page.clock.fastForward(12000);
          assert.equal(reads, settled);
        } else {
          let source = "";
          for (const [kind, value] of [
            ["source", "docker:other"],
            ["owner", "bob"],
            ["owner", "alice"],
          ]) {
            job = row(19);
            holdNext = true;
            await page.evaluate((source) => window.signal(source), source);
            await expect.poll(() => held.length).toBe(1);
            job = row(2);
            holdNext = true;
            await page.evaluate(
              ([kind, value]) => window[kind](value),
              [kind, value],
            );
            if (kind === "source") source = value;
            await expect.poll(() => held.length).toBe(2);
            await expect(history).toHaveCount(0);
            held.pop()();
            await expect(history).toContainText("2 of 20");
            held.shift()();
            await page.clock.runFor(50);
            await expect(history).toContainText("2 of 20");
          }
        }
      }
      assert.deepEqual(errors, []);
      console.log(engine + " Import status passed: " + scenario);
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
