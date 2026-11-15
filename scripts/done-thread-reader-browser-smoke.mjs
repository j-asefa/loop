import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-done-thread-reader-"));
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
    import {useDoneThreads,DoneThreadReader} from ${JSON.stringify(resolve("src/client/DoneThreads.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const [agent,setAgent]=useState('first'),[source,setSource]=useState(''),[fanout,setFanout]=useState(false),[enabled,setEnabled]=useState(true),[detail,setDetail]=useState(false),[mounted,setMounted]=useState(true),[revision,setRevision]=useState(0);
      window.select=value=>flushSync(()=>setAgent(value));
      window.source=value=>flushSync(()=>setSource(value));
      window.fanout=value=>flushSync(()=>setFanout(value));
      window.enable=value=>flushSync(()=>setEnabled(value));
      window.detail=value=>flushSync(()=>{setDetail(value);setEnabled(!value)});
      window.mount=value=>flushSync(()=>setMounted(value));
      window.owner=value=>flushSync(()=>{ownerSession.change(value);setRevision(n=>n+1)});
      const data=useDoneThreads(fanout?['','docker:other']:[source],enabled,{agent});
      window.retry=()=>data.retry();
      window.refresh=()=>data.refresh();
      return React.createElement('section',null,
        React.createElement('output',{id:'rows'},data.threads.map(item=>item.title).join(',')),
        React.createElement('output',{id:'error'},data.error),
        React.createElement('output',{id:'supported'},JSON.stringify(data.supported)),
        mounted&&detail?React.createElement(DoneThreadReader,{thread:{id:agent,title:agent,source,createdAt:1,cardIds:[],preview:null},onClose:()=>window.closedCount=(window.closedCount||0)+1,onChanged:()=>window.changedCount=(window.changedCount||0)+1,onOpen:()=>{}}):null);
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let failNext = false,
    holdRemote = false;
  let holdNext = false,
    status = 200,
    aborted = 0,
    epoch = "initial";
  const requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (
      url.pathname === "/" ||
      url.pathname === "/client.mjs" ||
      url.pathname === "/client.css"
    ) {
      res.writeHead(200, {
        "content-type":
          url.pathname === "/"
            ? "text/html"
            : url.pathname.endsWith(".css")
              ? "text/css"
              : "text/javascript",
      });
      res.end(
        url.pathname === "/"
          ? '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>'
          : url.pathname.endsWith(".css")
            ? style
            : script,
      );
      return;
    }
    const detail = /\/feed\/threads\/[^/]+\/page$/.test(url.pathname);
    if (!detail && !url.pathname.endsWith("/feed/threads/page")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown fixture route" }));
      return;
    }
    const id = detail
      ? url.pathname.split("/").at(-2)
      : url.searchParams.get("agent");
    const source = url.pathname.includes("/agent-sources/")
      ? "remote"
      : "local";
    requests.push({
      path: url.pathname,
      id,
      detail,
      source,
      method: req.method,
    });
    const code = failNext ? 503 : status,
      thread = {
        id,
        title: id + ":" + source + ":" + epoch,
        createdAt: 1,
        cardIds: [],
      };
    const body =
      code === 200
        ? detail
          ? { thread, cards: [], next: null }
          : { threads: [{ ...thread, preview: null }], next: null }
        : { error: "Threads unavailable" };
    failNext = false;
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    res.on("close", () => {
      if (!res.writableEnded) aborted++;
    });
    if (holdNext && (!holdRemote || source === "remote")) {
      holdNext = false;
      held.push(send);
    } else send();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : [
        "list-coalescing",
        "list-scope",
        "detail-coalescing",
        "detail-scope",
        "missing",
        "partial",
        "independent-sources",
        "mutation-refresh",
        "list-retry",
        "detail-retry",
      ]) {
    holdRemote = false;
    status = 200;
    holdNext = false;
    aborted = 0;
    epoch = "initial";
    requests.length = 0;
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator("#rows")).toHaveText("first:local:initial");
    const detail = scenario.startsWith("detail");
    if (detail) {
      await page.evaluate(() => window.detail(true));
      await expect(page.getByText("Loading thread…")).toHaveCount(0);
    }
    const count = () =>
      requests.filter((request) => request.detail === detail).length;
    const refresh = () =>
      page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("loop-workspace-change", {
            detail: { sources: [""] },
          }),
        ),
      );
    if (scenario.endsWith("coalescing")) {
      holdNext = true;
      epoch = "held";
      await refresh();
      await expect.poll(() => held.length).toBe(1);
      const before = count();
      await page.evaluate(() => {
        for (let n = 0; n < 8; n++)
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: [""] },
            }),
          );
      });
      await page.waitForTimeout(550);
      assert.equal(
        count(),
        before,
        "Notifications must not replace an in-flight Done-thread read",
      );
      assert.equal(
        aborted,
        0,
        "A healthy slow read must finish before its trailing refresh",
      );
      epoch = "trailing";
      held.shift()();
      await expect.poll(count).toBe(before + 1);
      if (!detail)
        await expect(page.locator("#rows")).toHaveText("first:local:trailing");
    } else if (scenario.endsWith("scope")) {
      for (const change of ["selection", "source", "owner", "unmount"]) {
        holdNext = true;
        await refresh();
        await expect.poll(() => held.length).toBe(1);
        const before = aborted;
        await page.evaluate((change) => {
          if (change === "selection") window.select("second");
          else if (change === "source") window.source("docker:other");
          else if (change === "owner") window.owner("bob");
          else if (window.detail && change === "unmount") {
            window.enable(false);
            window.mount(false);
          }
        }, change);
        await expect.poll(() => aborted).toBeGreaterThan(before);
        held.shift()();
        if (!detail && change !== "unmount")
          await expect(page.locator("#rows")).not.toHaveText("");
        if (change === "source") await page.evaluate(() => window.source(""));
      }
    } else if (scenario === "mutation-refresh") {
      const before = count();
      failNext = true;
      epoch = "after-mutation";
      await page.evaluate(() => window.refresh());
      await expect(page.locator("#rows")).toHaveText(
        "first:local:after-mutation",
      );
      assert.equal(
        count(),
        before + 2,
        "Mutation refresh must automatically retry a transient 503",
      );
      await expect(page.locator("#error")).toHaveText("");
    } else if (scenario === "independent-sources") {
      holdNext = true;
      holdRemote = true;
      await page.evaluate(() => window.fanout(true));
      await expect.poll(() => held.length).toBe(1);
      await expect(page.locator("#rows")).toContainText("first:local:initial");
      epoch = "healthy-change";
      await refresh();
      await expect(page.locator("#rows")).toContainText(
        "first:local:healthy-change",
      );
      assert.equal(
        held.length,
        1,
        "The remote read must remain held while local data refreshes",
      );
      assert.equal(
        requests.filter((request) => request.source === "remote").length,
        1,
      );
      held.shift()();
    } else if (scenario === "partial") {
      holdNext = true;
      await page.evaluate(() => window.fanout(true));
      await expect.poll(() => held.length).toBe(1);
      await expect(page.locator("#rows")).toContainText("first:remote:initial");
      held.shift()();
      await expect(page.locator("#rows")).toContainText("first:local:initial");
      await expect(page.locator("#supported")).toContainText("docker:other");
    } else if (scenario.endsWith("retry")) {
      status = 400;
      await refresh();
      if (detail)
        await expect(page.getByRole("alert")).toContainText(
          "Threads unavailable",
        );
      else
        await expect(page.locator("#error")).toContainText(
          "Couldn’t load card threads",
        );
      const before = count();
      status = 503;
      if (detail)
        await page.getByRole("button", { name: "Retry", exact: true }).click();
      else await page.evaluate(() => window.retry());
      await expect.poll(count).toBe(before + 1);
      await page.waitForTimeout(2100);
      assert.equal(
        count(),
        before + 1,
        "Explicit retry must issue one attempt without automatic retry backoff",
      );
      status = 200;
      if (detail)
        await page.getByRole("button", { name: "Retry", exact: true }).click();
      else await page.evaluate(() => window.retry());
      if (detail) await expect(page.getByRole("alert")).toHaveCount(0);
      else await expect(page.locator("#error")).toHaveText("");
    } else if (scenario === "missing") {
      status = 404;
      await page.evaluate(() => window.retry());
      await expect(page.locator("#supported")).toHaveText("[]");
      await expect(page.locator("#error")).toHaveText("");
      await page.evaluate(() => window.detail(true));
      await expect
        .poll(() => page.evaluate(() => window.closedCount || 0))
        .toBe(1);
      assert.equal(await page.evaluate(() => window.changedCount), 1);
    }
    assert(
      requests.every((request) => request.method === "GET"),
      "Reader fixture must never dispatch a command",
    );
    assert.deepEqual(errors, []);
    await context.close();
    held.splice(0).forEach((send) => send());
    console.log(`${engine} ${scenario} passed`);
  }
} finally {
  held.splice(0).forEach((send) => send());
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
