import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { engineForRun } from "./helpers/engines.mjs";

const engine = await engineForRun(import.meta.url);
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
  let holdBefore;
  let failHeadOnly = false;
  let failHistoryOnly = false;
  let movingHead = false;
  let allowedHistoryCursor;
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
      if (movingHead && source === "A" && before === null)
        rows.unshift(rows[0] + 1);
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
        failure &&
        source === "A" &&
        (!failHeadOnly || before === null) &&
        (!failHistoryOnly || before !== null) &&
        before !== allowedHistoryCursor
          ? { error: "Agent threads unavailable" }
          : { items: n === undefined ? [] : [row(source, n, agent)], next };
      const status =
        failure &&
        source === "A" &&
        (!failHeadOnly || before === null) &&
        (!failHistoryOnly || before !== null) &&
        before !== allowedHistoryCursor
          ? 503
          : 200;
      const reply = () => send(status, body);
      if ((holdNext || before === holdBefore) && source === "A") {
        holdNext = false;
        holdBefore = undefined;
        held.push(reply);
      } else reply();
      return;
    }
    send(404, { error: "Unknown fixture route" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : [
        "window",
        "cursor",
        "queued-retry",
        "pull",
        "pull-append",
        "pull-append-exhausted",
        "gap-exhaustion",
        "pull-append-error",
        "pull-append-live",
        "pull-gap-replay",
        "history-error",
        "history-error-reopen",
        "history-error-exhausted",
        "history-error-exhausted-reopen",
        "notification-rescan",
        "scope",
      ]) {
    rows = [3, 2, 1];
    failure = false;
    failHeadOnly = false;
    failHistoryOnly = false;
    movingHead = false;
    allowedHistoryCursor = undefined;
    stuck = false;
    holdNext = false;
    holdBefore = undefined;
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
      } else if (scenario === "gap-exhaustion") {
        await more();
        await expect(output).toContainText("first-A2");
        await idle();
        await more();
        await expect(output).toContainText("first-A1");
        await idle();
        rows = [8, 7, 6, 5, 4, 3, 2, 1, 0];
        failure = failHistoryOnly = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(notice).toContainText("Couldn’t load some agent threads", {
          timeout: 20_000,
        });
        await idle();
        failure = false;
        for (const n of [7, 6, 5, 4, 3, 2, 1, 0]) {
          await more();
          await expect(output).toContainText("first-A" + n);
          await idle();
        }
        await expect(
          page.getByRole("button", { name: "More", exact: true }),
        ).toBeDisabled();
        await expect(notice).toContainText("Couldn’t load some agent threads", {
          timeout: 20_000,
        });
      } else if (scenario === "pull-append-exhausted") {
        holdNext = true;
        await more();
        await expect.poll(() => held.length).toBe(1);
        rows = [3];
        epoch = "exhausted";
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(output).toContainText("first-A3:exhausted");
        await idle();
        held.shift()();
        await page.waitForTimeout(100);
        await expect(output).not.toContainText("first-A2");
        await expect(
          page.getByRole("button", { name: "More", exact: true }),
        ).toBeDisabled();
      } else if (
        scenario === "pull-append" ||
        scenario === "pull-append-error" ||
        scenario === "pull-append-live"
      ) {
        holdNext = true;
        await more();
        await expect.poll(() => held.length).toBe(1);
        epoch = "after-pull";
        failure = failHeadOnly = scenario === "pull-append-error";
        rows = [8, 7, 6, 5, 4, 3, 2, 1];
        movingHead = scenario === "pull-append-live";
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(output).toContainText("first-A2:after-pull", {
          timeout: 12_000,
        });
        movingHead = false;
        allowedHistoryCursor = undefined;
        await idle();
        if (failHeadOnly) {
          await expect(notice).toContainText(
            "Couldn’t load some agent threads",
          );
          failure = false;
          await page.evaluate(() =>
            window.dispatchEvent(new Event("loop-refresh")),
          );
          await expect(notice).toBeEmpty();
          await expect(output).toContainText("first-A3:after-pull");
          await idle();
        }
        held.shift()();
        await page.waitForTimeout(100);
        await expect(output).not.toContainText(":initial");
        await expect(output).toContainText("first-A2:after-pull");
      } else if (
        scenario === "history-error" ||
        scenario === "history-error-reopen" ||
        scenario === "history-error-exhausted" ||
        scenario === "history-error-exhausted-reopen"
      ) {
        await more();
        await expect(output).toContainText("first-A2");
        await idle();
        if (scenario.includes("exhausted")) {
          await more();
          await expect(output).toContainText("first-A1");
          await idle();
        }
        rows = [8, 7, 6, 5, 4, 3, 2, 1];
        failure = failHistoryOnly = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(output).toContainText("first-A8", { timeout: 15_000 });
        await expect(notice).toContainText("Couldn’t load some agent threads");
        await idle();
        if (scenario.includes("reopen")) {
          await page.evaluate(() => window.enable(false));
          await expect(output).toBeEmpty();
          if (scenario.includes("exhausted")) {
            failHistoryOnly = false;
            failHeadOnly = true;
          }
          await page.evaluate(() => window.enable(true));
          await expect(notice).toContainText(
            "Couldn’t load some agent threads",
            { timeout: 15_000 },
          );
          await idle();
        }
        failure = false;
        await more();
        await expect(output).toContainText("first-A1");
        await idle();
        if (scenario.includes("exhausted")) {
          await expect(output).toContainText("first-A7");
          await expect(output).not.toContainText("first-A6");
        } else {
          await expect(output).not.toContainText("first-A7");
          await more();
          await expect(output).toContainText("first-A7");
        }
        await expect(notice).toContainText("Couldn’t load some agent threads");
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(output).toContainText("first-A7");
        await expect(notice).toBeEmpty();
        await idle();
        await expect(
          page.getByRole("button", { name: "More", exact: true }),
        ).toBeDisabled();
      } else if (scenario === "pull") {
        await more();
        await expect(output).toContainText("first-A2:initial");
        await idle();
        await more();
        await expect(output).toContainText("first-A1:initial");
        await idle();
        holdBefore = "2";
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => held.length).toBe(1);
        epoch = "after-pull";
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        // The held page must not block the pull, and its saved progress must
        // not skip page two after that page changed on the server.
        await expect(output).toContainText("first-A2:after-pull");
        await expect(output).toContainText("first-A1:after-pull");
        held.shift()();
        await page.waitForTimeout(100);
        await expect(output).not.toContainText(":initial");
        await idle();
      } else if (scenario === "pull-gap-replay") {
        await more();
        await expect(output).toContainText("first-A2");
        await idle();
        await more();
        await expect(output).toContainText("first-A1");
        await idle();
        rows = [8, 7, 6, 5, 4, 3, 2, 1];
        failure = failHistoryOnly = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(output).toContainText("first-A8", { timeout: 15_000 });
        await idle();
        failure = false;
        holdNext = true;
        await more();
        await expect.poll(() => held.length).toBe(1);
        rows = [12, 11, 10, 9, ...rows];
        epoch = "second-pull";
        failure = true;
        allowedHistoryCursor = "8";
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(output).toContainText("first-A7:second-pull", {
          timeout: 20_000,
        });
        await expect(output).not.toContainText("first-A11");
        await expect(notice).toContainText("Couldn’t load some agent threads");
        held.shift()();
        await page.waitForTimeout(100);
        await expect(output).toContainText("first-A7:second-pull");
      } else if (scenario === "notification-rescan") {
        await more();
        await expect(output).toContainText("first-A2");
        await idle();
        await more();
        await expect(output).toContainText("first-A1");
        await idle();
        rows = [8, 7, 6, 5, 4, 3, 2, 1];
        holdBefore = "4";
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect.poll(() => held.length, { timeout: 10_000 }).toBe(1);
        await expect(output).toContainText("first-A6");
        rows = rows.filter((n) => n !== 6);
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: [""] },
            }),
          ),
        );
        held.shift()();
        await expect(output).not.toContainText("first-A6", { timeout: 10_000 });
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
