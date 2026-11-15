import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-run-evidence-"));
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
 import {VerificationSheet} from ${JSON.stringify(resolve("src/client/Verification.tsx"))};
 import {CheckoutSheet} from ${JSON.stringify(resolve("src/client/Checkout.tsx"))};
 import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
 import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
 ownerSession.change('alice');setShellSource('');
 function App(){const [kind,setKind]=useState('verification'),[run,setRun]=useState('first');
 window.kind=value=>flushSync(()=>setKind(value));window.run=value=>flushSync(()=>setRun(value));
 return kind==='none'?null:React.createElement(kind==='verification'?VerificationSheet:CheckoutSheet,{runId:run,onClose:()=>setKind('none')});}
 createRoot(document.getElementById('root')).render(React.createElement(App));
 `,
  );
  const { script } = await browserFixtureBundle(entry);
  let status = 200,
    holdNext = false,
    aborted = 0,
    checkoutReads = 0;
  const detail = {
    id: "checkout",
    run_id: "first",
    agent_id: "agent",
    conversation_id: "thread",
    directory: "/work",
    source: "/work",
    branch: "feature/evidence",
    base_ref: null,
    base_sha: null,
    start_head: "a".repeat(40),
    start_dirty: 0,
    start_untracked: 0,
    started_at: 1,
    state: "started",
    end_head: null,
    ahead: null,
    behind: null,
    files: [],
    committed: null,
    working: null,
    untracked: [],
    patch: null,
    patch_bytes: null,
    patch_truncated: false,
    remote: null,
    overlap: [],
    captured_late: false,
    summary: null,
    ended_at: null,
    error: null,
  };
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
    const checkout = path.endsWith("/checkout");
    if (checkout) checkoutReads++;
    const code = status,
      body = JSON.stringify(
        code === 200
          ? checkout
            ? detail
            : []
          : { error: "Evidence unavailable" },
      );
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(code, { "content-type": "application/json" });
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
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await expect(
    page.getByText("No test, type-check or lint command was observed."),
  ).toBeVisible();
  holdNext = true;
  await page.evaluate(() => window.run("held"));
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.run("current"));
  await expect.poll(() => aborted).toBe(1);
  held.shift()();
  await expect(
    page.getByText("No test, type-check or lint command was observed."),
  ).toBeVisible();
  await page.evaluate(() => window.kind("checkout"));
  await expect.poll(() => checkoutReads).toBe(1);
  status = 404;
  await expect.poll(() => checkoutReads, { timeout: 8000 }).toBe(2);
  await expect(
    page.getByText("Evidence unavailable", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => checkoutReads, { timeout: 13000 }).toBe(3);
  detail.state = "captured";
  status = 200;
  await expect.poll(() => checkoutReads, { timeout: 13000 }).toBe(4);
  await expect(
    page.getByText("Evidence unavailable", { exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(5500);
  assert.equal(checkoutReads, 4, "A completed observation stops polling");
  holdNext = true;
  await page.evaluate(() => window.run("unmount"));
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.kind("none"));
  await expect.poll(() => aborted).toBe(2);
  held.shift()();
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": verification selection abort; checkout started/error/repeated-error polling, recovery, completion and unmount abort passed",
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
