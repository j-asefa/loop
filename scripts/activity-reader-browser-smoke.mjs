import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { reduceActivity } from "../src/shared/agent-activities.ts";

const dir = await mkdtemp(join(tmpdir(), "loop-activity-reader-"));
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
    import {useConversationActivities} from ${JSON.stringify(resolve("src/client/activityView.ts"))};
    import {CollectionReadNotice} from ${JSON.stringify(resolve("src/client/CollectionRead.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const [shown,setShown]=useState(true),[thread,setThread]=useState('first'),[,render]=useState(0);
      window.shown=value=>flushSync(()=>setShown(value));
      window.thread=value=>flushSync(()=>setThread(value));
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      return shown?React.createElement(Reader,{thread}):null;
    }
    function Reader({thread}){
      const read=useConversationActivities(thread,['run']);
      window.earlier=read.loadEarlier;
      window.refresh=()=>window.dispatchEvent(new CustomEvent('loop-workspace-change'));
      return React.createElement('section',null,
        React.createElement('output',null,read.items.map(item=>item.key).join(',')),
        React.createElement('span',{id:'loading'},String(read.loading)),
        React.createElement(CollectionReadNotice,{error:read.error,busy:read.loading,retry:read.retry}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let failEarlier = false,
    holdNext = false,
    cooldown = false,
    label = "initial";
  const requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (url.pathname === "/client.mjs" || url.pathname === "/client.css") {
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".mjs")
          ? "text/javascript"
          : "text/css",
      });
      res.end(url.pathname.endsWith(".mjs") ? script : style);
      return;
    }
    requests.push({
      path: url.pathname,
      view: url.searchParams.get("view"),
      before: url.searchParams.get("before"),
    });
    const key = label,
      earlier = url.searchParams.has("before"),
      failed = earlier && failEarlier;
    const record = reduceActivity(undefined, {
      v: 1,
      kind: "tool",
      id: key,
      source: { transport: "api", origin: "test" },
      patch: { title: key },
    }).record;
    const body = failed
      ? { error: "Earlier unavailable" }
      : {
          version: 1,
          items: [{ key, sequence: 100, kind: "tool", run: "run", record }],
          cursor: 100,
          more: false,
          earlier: earlier ? null : 50,
        };
    const retry = cooldown;
    cooldown = false;
    const reply = () => {
      res.writeHead(retry ? 429 : failed ? 404 : 200, {
        "content-type": "application/json",
        ...(retry ? { "retry-after": "2" } : {}),
      });
      res.end(JSON.stringify(retry ? { error: "Cooldown" } : body));
    };
    if (holdNext) {
      holdNext = false;
      held.push(reply);
    } else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  await expect(page.locator("output")).toHaveText("initial");
  await expect(page.locator("#loading")).toHaveText("false");
  failEarlier = true;
  await page.evaluate(() => window.earlier());
  await expect(page.getByRole("alert")).toContainText("Earlier unavailable");
  label = "live";
  await page.evaluate(() => window.refresh());
  await expect(page.locator("output")).toContainText("live");
  await expect(page.getByRole("alert")).toContainText("Earlier unavailable");
  failEarlier = false;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.equal(requests.at(-1).before, "50");
  console.log(
    engine + " activity-reader independent earlier error/retry cursor: passed",
  );
  for (const transition of ["thread", "source", "owner"]) {
    label = "obsolete-" + transition;
    holdNext = true;
    await page.evaluate(() => window.refresh());
    await expect.poll(() => held.length).toBe(1);
    label = "current-" + transition;
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
    await expect(page.locator("output")).toHaveText(label);
    held.splice(0).forEach((reply) => reply());
    await page.waitForTimeout(50);
    await expect(page.locator("output")).toHaveText(label);
  }
  console.log(engine + " activity-reader thread/source/owner lifetime: passed");
  cooldown = true;
  const before = requests.length;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => requests.length).toBe(before + 1);
  await page.evaluate(() => window.shown(false));
  await page.waitForTimeout(2300);
  assert.equal(
    requests.length,
    before + 1,
    "unmount aborts the Retry-After continuation",
  );
  console.log(
    engine + " activity-reader unmount cancels cooldown retry: passed",
  );
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
