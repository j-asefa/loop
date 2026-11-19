import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { engineForRun } from "./helpers/engines.mjs";

const engine = await engineForRun(import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loop-conversation-pulls-"));
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
 import {ConversationPulls} from ${JSON.stringify(resolve("src/client/ConversationPulls.tsx"))};
 import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
 import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
 ownerSession.change('alice');setShellSource('');
 function App(){const [shown,setShown]=useState(true),[thread,setThread]=useState('first'),[key,setKey]=useState(''),[,render]=useState(0);
 window.shown=value=>flushSync(()=>setShown(value));window.thread=value=>flushSync(()=>setThread(value));window.key=value=>flushSync(()=>setKey(value));
 window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
 window.refresh=()=>window.dispatchEvent(new Event('loop-workspace-change'));
 return shown?React.createElement(ConversationPulls,{conversationId:thread,refreshKey:key}):null;}
 createRoot(document.getElementById('root')).render(React.createElement(App));
 `,
  );
  const { script } = await browserFixtureBundle(entry);
  let label = "Initial",
    status = 200,
    holdNext = false,
    aborted = 0;
  const requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (url.pathname === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
      return;
    }
    requests.push(url);
    const code = status,
      body = JSON.stringify(
        code === 200
          ? {
              connected: true,
              pulls: [
                {
                  owner: "acme",
                  repo: "api",
                  number: 1,
                  title: label,
                  state: "open",
                },
              ],
              hasMore: false,
            }
          : { error: "Unavailable" },
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
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const section = page.locator(".conversation-pulls");
  await expect(section).toContainText("Initial");
  await section.locator("summary").click();
  label = "Forced";
  await section.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(section).toContainText(label);
  assert.equal(requests.at(-1).searchParams.get("refresh"), "1");
  const before = requests.length;
  holdNext = true;
  await page.evaluate(() => {
    window.refresh();
    window.refresh();
    window.refresh();
  });
  await expect.poll(() => held.length).toBe(1);
  await page.waitForTimeout(100);
  assert.equal(requests.length, before + 1);
  held.shift()();
  await expect.poll(() => requests.length).toBe(before + 2);
  await expect(
    section.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  assert.equal(requests.at(-1).searchParams.has("refresh"), false);
  status = 404;
  await page.evaluate(() => window.refresh());
  await expect(section).toContainText("Could not refresh pull requests");
  await expect(section).toContainText(label);
  status = 200;
  await page.evaluate(() => window.refresh());
  await expect(section).not.toContainText("Could not refresh pull requests");
  for (const transition of ["key", "thread", "source", "owner"]) {
    holdNext = true;
    await page.evaluate(() => window.refresh());
    await expect.poll(() => held.length).toBe(1);
    const old = aborted;
    label = "Current " + transition;
    await page.evaluate(
      (kind) =>
        window[kind](
          kind === "owner"
            ? "bob"
            : kind === "source"
              ? "peer:other"
              : "second",
        ),
      transition,
    );
    await expect(section).toContainText(label);
    await expect.poll(() => aborted).toBe(old + 1);
    held.shift()();
    await expect(section).toContainText(label);
    assert.equal(requests.at(-1).searchParams.has("refresh"), false);
  }
  const beforeHidden = requests.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    window.dispatchEvent(new Event("focus"));
    window.refresh();
  });
  await page.waitForTimeout(100);
  assert.equal(requests.length, beforeHidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requests.length).toBe(beforeHidden + 1);
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
      ": conversation pulls forced/cache reads, coalescing, retained failure recovery, scope/key/unmount abort and hidden-tab policy passed",
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
