import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { engineForRun } from "./helpers/engines.mjs";

const engine = await engineForRun(import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loop-approval-reader-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
 import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
 import {Approvals} from ${JSON.stringify(resolve("src/client/Approvals.tsx"))};import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
 ownerSession.change('alice');setShellSource('');function App(){const [shown,setShown]=useState(true),[run,setRun]=useState('first'),[,render]=useState(0);
 window.shown=value=>flushSync(()=>setShown(value));window.run=value=>flushSync(()=>setRun(value));window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});window.refresh=()=>window.dispatchEvent(new Event('loop-workspace-change'));
 return shown?React.createElement(Approvals,{revision:0,runId:run,onChange:()=>{},onConversation:()=>{}}):null;}createRoot(document.getElementById('root')).render(React.createElement(App));
 `,
  );
  const { script } = await browserFixtureBundle(entry);
  let status = 200,
    holdNext = false,
    aborted = 0;
  const requests = [];
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (path === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
      return;
    }
    if (!path.endsWith("/approvals")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    requests.push(path);
    const code = status,
      body = JSON.stringify(
        code === 200 ? [] : { error: "Approval read unavailable" },
      );
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(code, {
        "content-type": "application/json",
        ...(code === 429 ? { "retry-after": "2" } : {}),
      });
      res.end(body);
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
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await expect.poll(() => requests.length).toBe(1);
  await page.waitForTimeout(100);
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  const before = requests.length;
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => {
    window.refresh();
    window.refresh();
    window.refresh();
  });
  await page.waitForTimeout(100);
  assert.equal(
    requests.length,
    before + 1,
    "Notifications must not cancel and restart a slow approval read",
  );
  assert.equal(aborted, 0);
  const loading = page.getByText("Loading approval updates…");
  await page.clock.runFor(1999);
  await expect(loading).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(loading).toBeVisible();
  await page.clock.resume();
  held.shift()();
  await expect.poll(() => requests.length).toBe(before + 2);
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  const stalledReads = requests.length;
  const beforeRetryAbort = aborted;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect.poll(() => aborted).toBe(beforeRetryAbort + 1);
  await expect.poll(() => requests.length).toBe(stalledReads + 1);
  held.shift()();
  await expect(
    page.getByRole("button", { name: "Retry connection", exact: true }),
  ).toHaveCount(0);
  status = 503;
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Approval read unavailable",
  );
  const manualFailureReads = requests.length;
  await page.waitForTimeout(2500);
  assert.equal(
    requests.length,
    manualFailureReads,
    "Manual retry must not schedule automatic 503 retries",
  );
  held.shift()();
  status = 200;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  status = 503;
  await page.evaluate(() => window.refresh());
  await expect(page.getByRole("alert")).toContainText(
    "Approval read unavailable",
  );
  status = 200;
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 5000 });
  status = 429;
  await page.evaluate(() => window.refresh());
  await expect(page.getByRole("status")).toContainText(
    "Approval updates are paused briefly",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  status = 200;
  await expect(
    page.getByText("Approval updates are paused briefly.", { exact: false }),
  ).toHaveCount(0, { timeout: 5000 });
  for (const transition of ["run", "source", "owner"]) {
    holdNext = true;
    await page.evaluate(() => window.refresh());
    await expect.poll(() => held.length).toBe(1);
    const old = aborted;
    await page.evaluate(
      (kind) =>
        window[kind](
          kind === "source"
            ? "peer:other"
            : kind === "owner"
              ? "bob"
              : "second",
        ),
      transition,
    );
    await expect.poll(() => aborted).toBe(old + 1);
    held.shift()();
  }
  assert(
    requests.some((path) =>
      path.includes("agent-sources/peer%3Aother/approvals"),
    ),
  );
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  const beforeClose = aborted;
  await page.evaluate(() => window.shown(false));
  await expect.poll(() => aborted).toBe(beforeClose + 1);
  held.shift()();
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": approvals coalesce slow reads, recover transient errors, expose quiet cooldown and abort stale run/source/owner/unmount reads: passed",
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
