import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { engineForRun } from "./helpers/engines.mjs";

const engine = await engineForRun(import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loop-run-files-reader-"));
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
    import {RunFiles} from ${JSON.stringify(resolve("src/client/PublishedFiles.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function App(){
      const [shown,setShown]=useState(true),[run,setRun]=useState('first'),[active,setActive]=useState(false),[,render]=useState(0);
      window.shown=value=>flushSync(()=>setShown(value));
      window.run=value=>flushSync(()=>setRun(value));
      window.active=value=>flushSync(()=>setActive(value));
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      window.refresh=()=>window.dispatchEvent(new Event('loop-workspace-change'));
      return shown?React.createElement(RunFiles,{runId:run,active,previewImages:false}):null;
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let status = 200,
    label = "Initial",
    holdNext = false;
  const requests = [];
  let aborted = 0;
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
    requests.push(path);
    const code = status;
    const body =
      code === 200
        ? [
            {
              id: "file",
              title: label,
              metadata: JSON.stringify({
                name: label + ".txt",
                mime: "text/plain",
                size: 12,
              }),
            },
          ]
        : { error: "Files unavailable" };
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(code, {
        "content-type": "application/json",
        ...(code === 429 ? { "retry-after": "2" } : {}),
      });
      res.end(JSON.stringify(body));
    };
    res.on("close", () => {
      if (!res.writableEnded) aborted++;
    });
    if (holdNext) {
      holdNext = false;
      held.push(send);
    } else send();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const file = page.getByRole("button", { name: /^Preview / });
  await expect(file).toHaveAccessibleName("Preview Initial.txt");

  status = 503;
  await page.evaluate(() => window.refresh());
  await expect(page.getByRole("alert")).toContainText("Files unavailable");
  await expect(file).toHaveAccessibleName("Preview Initial.txt");
  const retry = page.getByRole("button", { name: "Retry files", exact: true });
  await expect(retry).toBeEnabled();
  status = 200;
  label = "Retried";
  holdNext = true;
  const beforeRetry = requests.length;
  await retry.click();
  await expect
    .poll(() => requests.length, { timeout: 1500 })
    .toBe(beforeRetry + 1);
  await expect(file).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  held.shift()();
  await expect(file).toHaveAccessibleName("Preview Retried.txt");

  const beforeLimit = requests.length;
  status = 429;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => requests.length).toBe(beforeLimit + 1);
  await page.waitForTimeout(100);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(file).toHaveAccessibleName("Preview Retried.txt");
  status = 200;
  label = "After cooldown";
  await expect(file).toHaveAccessibleName("Preview After cooldown.txt", {
    timeout: 5000,
  });
  assert.equal(requests.length, beforeLimit + 2);

  for (const transition of ["run", "source", "owner", "active"]) {
    holdNext = true;
    await page.evaluate(() => window.refresh());
    await expect.poll(() => held.length).toBe(1);
    const beforeAbort = aborted;
    label = "Current " + transition;
    await page.evaluate(
      (kind) =>
        window[kind](
          kind === "active"
            ? true
            : kind === "owner"
              ? "bob"
              : kind === "source"
                ? "peer:other"
                : "second",
        ),
      transition,
    );
    await expect(file).toHaveAccessibleName("Preview " + label + ".txt");
    await expect.poll(() => aborted).toBe(beforeAbort + 1);
    held.shift()();
    await expect(file).toHaveAccessibleName("Preview " + label + ".txt");
  }
  assert(
    requests.some((path) =>
      path.includes("agent-sources/peer%3Aother/runs/second/files"),
    ),
  );
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  const beforeUnmount = aborted;
  await page.evaluate(() => window.shown(false));
  await expect.poll(() => aborted).toBe(beforeUnmount + 1);
  held.shift()();
  await expect(file).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": run files retain refresh rows, interrupt retry, quiet cooldown and abort run/source/owner/active/unmount reads: passed",
  );
} finally {
  held.splice(0).forEach((send) => send());
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(dir, { recursive: true, force: true });
}
