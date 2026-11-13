import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-results-reader-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    [
      "import React, {useEffect,useRef,useState} from " +
        JSON.stringify(resolve("node_modules/react/index.js")) +
        ";",
      "import {createRoot} from " +
        JSON.stringify(resolve("node_modules/react-dom/client.js")) +
        ";",
      "import {useResultsLoader} from " +
        JSON.stringify(resolve("src/client/app/Results.tsx")) +
        ";",
      "import {ownerSession} from " +
        JSON.stringify(resolve("src/client/ownerSession.ts")) +
        ";",
      "import {setShellSource} from " +
        JSON.stringify(resolve("src/client/sourceRouting.ts")) +
        ";",
      "import {resultTarget} from " +
        JSON.stringify(resolve("src/client/card-actions.ts")) +
        ";",
      "setShellSource(''); ownerSession.change('fixture-owner');",
      "function Probe(){",
      " const ownerRef=useRef('fixture-owner'); const [revision,setRevision]=useState(0);",
      " const result=useResultsLoader({ownerRef,profile:{id:'writer'},view:'all',teamKey:'',projectFilter:'',setRevision});",
      " window.readResults=notify=>result.loadResults(false,notify);",
      " useEffect(()=>{window.initial=result.loadResults(false,false);},[]);",
      " return React.createElement(React.Fragment,null,",
      "  React.createElement('output',{id:'state'},result.loading?'loading':result.error?'error':result.items.length?'rows':'empty'),",
      "  React.createElement('output',{id:'revision'},revision),",
      "  React.createElement('output',{id:'rows'},result.items.map(item=>resultTarget(item).title).join(',')),",
      "  React.createElement('output',{id:'error'},result.error));",
      "}",
      "createRoot(document.getElementById('root')).render(React.createElement(Probe));",
    ].join("\n"),
  );
  const { script, style } = await browserFixtureBundle(entry);
  let restarting = false,
    holdNext = false,
    updates = false,
    changes = 0;
  const item = (title) => ({
    card: {
      id: "a:result",
      type: "result",
      title,
      kind: "markdown",
      role: "answer",
      content: title,
      format: "markdown",
      created_at: 1,
      updated_at: null,
      author: {
        kind: "agent",
        id: "writer",
        name: "Writer",
        provider: "openai",
      },
      recipient: null,
      source: {
        artifact_id: "result",
        message_id: null,
        conversation_id: "thread",
        run_id: "run",
        agent_id: "writer",
      },
      context: {
        conversation_title: "Thread",
        folder_id: null,
        project_id: null,
        project_name: null,
        team_id: null,
      },
      attachments: [],
      saved: false,
      href: "/?artifact=result",
      version: 1,
      hidden: false,
      display: {
        model: null,
        tool: null,
        mime: null,
        filename: null,
        size: null,
        text: true,
        download: null,
        source: null,
        refreshable: false,
        app: false,
      },
    },
    order: [1, "a:result"],
    saved: null,
  });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
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
    if (path === "/api/v1/cards" || path === "/api/v1/cards/changes") {
      const changed = path.endsWith("/changes") && updates;
      const revision = "r" + (changed ? ++changes : changes);
      const body = restarting
        ? { error: "Restarting" }
        : path.endsWith("/changes")
          ? {
              revision,
              items: changed ? [item("Change " + changes)] : [],
              removed: [],
              more: false,
            }
          : { revision, next: null, items: [] };
      const status = restarting ? 503 : 200;
      const headers = {
        "content-type": "application/json",
        ...(restarting ? { "x-loop-unavailable": "restarting" } : {}),
      };
      const send = () => {
        res.writeHead(status, headers);
        res.end(JSON.stringify(body));
      };
      if (holdNext) {
        holdNext = false;
        held.push(send);
      } else send();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : ["restart", "notifications"]) {
    restarting = scenario === "restart";
    holdNext = false;
    updates = false;
    changes = 0;
    const context = await browser.newContext(),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto("http://127.0.0.1:" + server.address().port);
      await expect.poll(() => page.evaluate(() => !!window.initial)).toBe(true);
      await page.evaluate(() => window.initial);
      if (scenario === "restart") {
        restarting = false;
        holdNext = true;
        await page.evaluate(() => {
          window.pending = window.readResults(false);
        });
        await expect.poll(() => held.length).toBe(1);
        await expect(page.locator("#state")).toHaveText("loading");
        await expect(page.locator("#error")).toBeEmpty();
        held.shift()();
        await page.evaluate(() => window.pending);
        await expect(page.locator("#state")).toHaveText("empty");
      } else {
        updates = true;
        holdNext = true;
        await page.evaluate(() => {
          window.active = window.readResults(true);
        });
        await expect.poll(() => held.length).toBe(1);
        await page.evaluate(() => {
          window.quiet = window.readResults(false);
        });
        held.shift()();
        await page.evaluate(() => Promise.all([window.active, window.quiet]));
        await expect(page.locator("#rows")).toHaveText("Change 2");
        await expect(page.locator("#revision")).toHaveText("1");
        holdNext = true;
        await page.evaluate(() => {
          window.active = window.readResults(false);
        });
        await expect.poll(() => held.length).toBe(1);
        await page.evaluate(() => {
          window.notifying = window.readResults(true);
          window.quiet = window.readResults(false);
        });
        held.shift()();
        await page.evaluate(() =>
          Promise.all([window.active, window.notifying, window.quiet]),
        );
        await expect(page.locator("#rows")).toHaveText("Change 4");
        await expect(page.locator("#revision")).toHaveText("2");
      }
      assert.deepEqual(errors, []);
      console.log(engine + " Results reader passed: " + scenario);
    } finally {
      held.splice(0).forEach((send) => send());
      await context.close();
    }
  }
} finally {
  held.splice(0).forEach((send) => send());
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
