import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-feed-badge-"));
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
    import {useFeedBadge} from ${JSON.stringify(resolve("src/client/useFeedBadge.ts"))};
    import {CollectionReadNotice} from ${JSON.stringify(resolve("src/client/CollectionRead.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const [sources,setSources]=useState(['','peer:other']),[enabled,setEnabled]=useState(true),[,render]=useState(0);
      const read=useFeedBadge(enabled,sources);
      window.sources=value=>flushSync(()=>setSources(value));
      window.enabled=value=>flushSync(()=>setEnabled(value));
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      window.refresh=()=>window.dispatchEvent(new Event('loop-source-refresh'));
      window.savedRetry=read.retry;
      return React.createElement('section',null,React.createElement('output',null,typeof read==='number'?read:read.count),React.createElement(CollectionReadNotice,read));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  const counts = { local: 3, peer: 5 },
    failures = new Set(),
    holds = new Set(),
    requests = [];
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
    const source = path === "/api/feed" ? "local" : "peer";
    requests.push(source);
    const fail = failures.has(source),
      count = counts[source];
    const reply = () => {
      res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          fail
            ? { error: "Fixture unavailable" }
            : {
                items: [],
                next: null,
                summary: {
                  needs: count,
                  working: count,
                  queued: 0,
                  later_due: 0,
                },
              },
        ),
      );
    };
    if (holds.delete(source)) held.push(reply);
    else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  await expect(page.locator("output")).toHaveText("8");
  failures.add("peer");
  counts.local = 4;
  await page.evaluate(() => window.refresh());
  await expect(page.getByRole("alert")).toContainText("Fixture unavailable", {
    timeout: 15000,
  });
  await expect(page.locator("output")).toHaveText("9");
  const before = requests.length;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toBeEnabled();
  assert.deepEqual(
    requests.slice(before),
    ["peer"],
    "manual retry dispatches once, only for failed source",
  );
  failures.clear();
  counts.peer = 7;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.locator("output")).toHaveText("11");
  await expect(page.getByRole("alert")).toHaveCount(0);
  console.log(engine + " feed-badge failure isolation/manual recovery: passed");
  holds.add("peer");
  counts.peer = 50;
  const old = requests.length;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => requests.length).toBeGreaterThan(old);
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.sources([""]));
  await expect(page.locator("output")).toHaveText("4");
  held.splice(0).forEach((reply) => reply());
  await page.waitForTimeout(50);
  await expect(page.locator("output")).toHaveText("4");
  holds.add("local");
  counts.local = 90;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  counts.local = 2;
  await page.evaluate(() => window.owner("bob"));
  await expect(page.locator("output")).toHaveText("2");
  held.splice(0).forEach((reply) => reply());
  await page.waitForTimeout(50);
  await expect(page.locator("output")).toHaveText("2");
  await page.evaluate(() => window.enabled(false));
  await expect(page.locator("output")).toHaveText("0");
  const disabled = requests.length;
  await page.evaluate(() => window.refresh());
  await page.waitForTimeout(50);
  assert.equal(requests.length, disabled);
  console.log(engine + " feed-badge source/owner/disabled lifetimes: passed");
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
