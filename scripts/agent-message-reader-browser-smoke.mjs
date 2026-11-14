import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-agent-message-pager-"));
const sourceA = "docker:messages-a",
  sourceB = "docker:messages-b";
const requests = [],
  aborted = [],
  held = [];
let browser,
  server,
  hold = false,
  head = 2,
  stuck = false,
  actor = "alice";
const item = (source, id) => ({
  id: "message-" + id,
  content: actor + " " + source + " message " + id,
  created_at: id,
  conversation_id: "thread-a",
  run_id: "run-a",
  final: 1,
  model: null,
});
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {AgentMessages} from ${JSON.stringify(resolve("src/client/AgentMessages.tsx"))};
    import {SourceProvider} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {workspaceCapabilities} from ${JSON.stringify(resolve("src/shared/capabilities.ts"))};
    import {setViewOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    setShellSource("docker:ambient");
    const root=createRoot(document.getElementById("root"));
    window.replies=[];window.opened=[];
    window.showMessages=(source=${JSON.stringify(sourceA)}, owner="alice", revision=0, shown=true)=>flushSync(()=>{
      setViewOwner(owner);
      root.render(shown ? React.createElement(SourceProvider,{sourceId:source,capabilities:workspaceCapabilities()},React.createElement(AgentMessages,{agent:{id:"fixture-agent",name:"Fixture agent"},revision,onReply:value=>window.replies.push(value),onConversation:value=>window.opened.push(value)})):null);
    });
    window.showMessages();
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (req.url === "/client.mjs" || req.url === "/client.css") {
      res.writeHead(200, {
        "content-type": req.url.endsWith("mjs")
          ? "text/javascript"
          : "text/css",
      });
      res.end(req.url.endsWith("mjs") ? script : style);
      return;
    }
    const url = new URL(req.url, "http://fixture.invalid");
    const match =
      /^\/api\/agent-sources\/([^/]+)\/agents\/fixture-agent\/messages$/.exec(
        url.pathname,
      );
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const source = decodeURIComponent(match[1]),
      before = Number(url.searchParams.get("before"));
    const record = { source, before };
    requests.push(record);
    res.on("close", () => {
      if (!res.writableEnded) aborted.push(record);
    });
    const body = JSON.stringify({
      items: before
        ? [
            item(source, before - 1),
            ...(before > 2 ? [item(source, before - 2)] : []),
          ]
        : [item(source, head)],
      next: before
        ? stuck
          ? String(before)
          : before <= 3
            ? null
            : String(before - 2)
        : String(head),
    });
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(body);
    };
    if (hold) held.push(send);
    else send();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const cards = page.locator(".feed-card"),
    earlier = page.getByRole("button", {
      name: "Earlier messages",
      exact: true,
    });
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("alice " + sourceA + " message 2");
  hold = true;
  const closedBeforeHide = aborted.length;
  await earlier.click();
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => aborted.length).toBe(closedBeforeHide + 1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  hold = false;
  held.splice(0).forEach((send) => send());
  const beforeShow = requests.length;
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect.poll(() => requests.length).toBe(beforeShow + 1);
  await expect(earlier).toBeEnabled();
  hold = true;
  await page.evaluate(
    (source) => window.showMessages(source, "alice", 10),
    sourceA,
  );
  await expect.poll(() => held.length).toBe(1);
  const beforeRapidHide = aborted.length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect.poll(() => aborted.length).toBe(beforeRapidHide + 1);
  await expect.poll(() => held.length).toBe(2);
  const resumedRequests = requests.length;
  await earlier.click();
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  assert.equal(
    requests.length,
    resumedRequests,
    "Earlier messages queues behind the resumed head read",
  );
  hold = false;
  held.splice(0).forEach((send) => send());
  await expect(cards).toHaveCount(2);
  await expect(earlier).toHaveCount(0);
  head = 5;
  await page.evaluate(
    (source) => window.showMessages(source, "alice", 1),
    sourceA,
  );
  await expect(cards).toHaveCount(3);
  await earlier.click();
  await expect(cards).toHaveCount(5);
  await earlier.click();
  await expect(earlier).toHaveCount(0);
  await expect(cards).toHaveCount(5);
  head = 7;
  await page.evaluate(
    (source) => window.showMessages(source, "alice", 2),
    sourceA,
  );
  await expect(cards).toHaveCount(6);
  stuck = true;
  await earlier.click();
  await expect(page.getByRole("alert")).toContainText(
    "Pagination did not advance",
  );
  await expect(cards).toHaveCount(6);
  stuck = false;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(cards).toHaveCount(7);
  hold = true;
  await earlier.click();
  await expect.poll(() => held.length).toBe(1);
  head = 2;
  hold = false;
  const beforeSourceAbort = aborted.length;
  const sourceFrame = await page.evaluate((source) => {
    window.showMessages(source, "alice");
    return document.querySelectorAll(".feed-card").length;
  }, sourceB);
  assert.equal(
    sourceFrame,
    0,
    "source identity hides old rows in its first render",
  );
  await expect.poll(() => aborted.length).toBe(beforeSourceAbort + 1);
  await expect(cards).toContainText("alice " + sourceB + " message 2");
  held.splice(0).forEach((send) => send());
  await expect(cards).toHaveCount(1);
  hold = true;
  await earlier.click();
  await expect.poll(() => held.length).toBe(1);
  actor = "bob";
  hold = false;
  const beforeOwnerAbort = aborted.length;
  const ownerFrame = await page.evaluate((source) => {
    window.showMessages(source, "bob");
    return document.querySelectorAll(".feed-card").length;
  }, sourceB);
  assert.equal(
    ownerFrame,
    0,
    "owner identity hides old rows in its first render",
  );
  await expect.poll(() => aborted.length).toBe(beforeOwnerAbort + 1);
  await expect(cards).toContainText("bob " + sourceB + " message 2");
  held.splice(0).forEach((send) => send());
  await expect(cards).toHaveCount(1);
  await expect(cards).not.toContainText("alice");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.replies[0].messageId),
    "message-2",
  );
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.opened[0]), "thread-a");
  hold = true;
  await earlier.click();
  await expect.poll(() => held.length).toBe(1);
  const beforeUnmount = aborted.length;
  await page.evaluate(
    (source) => window.showMessages(source, "bob", 0, false),
    sourceB,
  );
  await expect.poll(() => aborted.length).toBe(beforeUnmount + 1);
  held.splice(0).forEach((send) => send());
  await expect(cards).toHaveCount(0);
  assert(requests.some((request) => request.source === sourceB));
  assert(!requests.some((request) => request.source === "docker:ambient"));
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: pagehide abort/pageshow resume, retained gaps, stalled-cursor retry, source/owner/unmount fencing and message actions passed (isolated HTTP fixture)`,
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
