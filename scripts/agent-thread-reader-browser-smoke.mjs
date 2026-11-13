import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-agent-thread-reader-"));
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
    import {useAgentThreadFeed} from ${JSON.stringify(resolve("src/client/useAgentThreadFeed.ts"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const [agent,setAgent]=useState('first'),[enabled,setEnabled]=useState(true),[revision,setRevision]=useState(0);
      window.select=value=>flushSync(()=>setAgent(value));
      window.enable=value=>flushSync(()=>setEnabled(value));
      window.owner=value=>flushSync(()=>{ownerSession.change(value);setRevision(n=>n+1)});
      const data=useAgentThreadFeed(['','docker:other'],enabled,{view:'threads',agent});
      return React.createElement('section',null,
        React.createElement('output',{id:'rows'},data.items.map(item=>item.subject).join(',')),
        React.createElement('output',{id:'error'},data.error),
        React.createElement('output',{id:'loading'},String(data.loading)),
        React.createElement('button',{onClick:data.loadMore,disabled:!data.hasMore},'More'),
        React.createElement('button',{onClick:data.refresh},'Retry'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let epoch = "initial";
  let rows = [3, 2, 1],
    failure = false,
    stuck = false,
    holdNext = false;
  const requests = [];
  const row = (source, n, agent) => ({
    id: "thread-" + n,
    subject: agent + "-" + source + n + ":" + epoch,
    scope: "direct",
    updated_at: n,
    paused_at: null,
    paused_reason: null,
    participants: [],
    message_count: 1,
    latest: {
      id: "mail-" + n,
      kind: "message",
      status: "handled",
      from: "sender",
      to: "recipient",
      preview: "Message",
      created_at: n,
      error: null,
      files: 0,
      conversation_id: null,
    },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
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
    if (url.pathname.endsWith("/feed/agent-threads")) {
      const source = url.pathname.includes("/agent-sources/") ? "B" : "A",
        agent = url.searchParams.get("agent"),
        before = url.searchParams.get("before");
      requests.push({ source, agent, before });
      const selected = source === "A" ? rows : [1];
      const start = before === null ? 0 : selected.indexOf(Number(before)) + 1;
      const n = selected[start],
        next =
          stuck && before !== null
            ? before
            : start + 1 < selected.length
              ? String(n)
              : null;
      const body =
        failure && source === "A"
          ? { error: "Agent threads unavailable" }
          : { items: n === undefined ? [] : [row(source, n, agent)], next };
      const status = failure && source === "A" ? 503 : 200;
      const reply = () => send(status, body);
      if (holdNext && source === "A") {
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
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : ["window", "cursor", "queued-retry", "scope"]) {
    rows = [3, 2, 1];
    failure = false;
    stuck = false;
    holdNext = false;
    requests.length = 0;
    epoch = "initial";
    const context = await browser.newContext(),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const output = page.locator("#rows"),
      notice = page.locator("#error");
    const idle = () => expect(page.locator("#loading")).toHaveText("false");
    const more = () =>
      page.getByRole("button", { name: "More", exact: true }).click();
    try {
      await page.goto("http://127.0.0.1:" + server.address().port);
      await expect(output).toContainText("first-A3");
      await expect(output).toContainText("first-B1");
      await idle();
      if (scenario === "window") {
        await more();
        await expect(output).toContainText("first-A2");
        await idle();
        await more();
        await expect(output).toContainText("first-A1");
        await idle();
        assert.equal(
          requests.filter((r) => r.source === "B").length,
          1,
          "exhausted source does not append",
        );
        rows = [6, 5, 4, 3, 2, 1];
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(output).toContainText("first-A4", { timeout: 8000 });
        await idle();
        for (const n of rows) await expect(output).toContainText("first-A" + n);
        await page.evaluate(() => window.enable(false));
        await expect(output).toBeEmpty();
        await page.evaluate(() => window.enable(true));
        await expect(output).toContainText("first-A1");
      } else if (scenario === "cursor") {
        stuck = true;
        await more();
        await expect(notice).toContainText("Couldn’t load some agent threads");
        await idle();
        await expect(output).toContainText("first-A3");
        await expect(output).not.toContainText("first-A2");
        stuck = false;
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(notice).toBeEmpty();
      } else if (scenario === "queued-retry") {
        holdNext = true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => held.length).toBe(1);
        failure = true;
        const before = requests.filter((r) => r.source === "A").length;
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        for (let i = 0; i < 12; i++)
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        held.shift()();
        await expect(notice).toContainText("Couldn’t load some agent threads", {
          timeout: 12000,
        });
        await idle();
        assert.equal(
          requests.filter((r) => r.source === "A").length,
          before + 1,
          "queued manual retry is one request, not an automatic retry budget",
        );
        await expect(output).toContainText("first-B1");
        failure = false;
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(notice).toBeEmpty();
      } else {
        for (const [kind, value] of [
          ["select", "second"],
          ["owner", "bob"],
          ["owner", "alice"],
        ]) {
          holdNext = true;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect.poll(() => held.length).toBe(1);
          epoch = kind + "-" + value;
          holdNext = true;
          await page.evaluate(
            ([kind, value]) => window[kind](value),
            [kind, value],
          );
          await expect.poll(() => held.length).toBe(2);
          await expect(output).toBeEmpty();
          held.pop()();
          await expect(output).toContainText("second-A3");
          await expect(output).toContainText(epoch);
          held.shift()();
          await page.waitForTimeout(100);
          await expect(output).not.toContainText("first-A");
          await expect(output).toContainText(epoch);
          await expect(notice).toBeEmpty();
          await idle();
        }
        holdNext = true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => held.length).toBe(1);
        await page.evaluate(() => window.enable(false));
        held.shift()();
        await page.waitForTimeout(100);
        await expect(output).toBeEmpty();
      }
      assert.deepEqual(errors, []);
      console.log(engine + " agent-thread reader passed: " + scenario);
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
