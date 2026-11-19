import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { engineForRun } from "./helpers/engines.mjs";

const engine = await engineForRun(import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loop-outline-query-"));
let browser, server;
const held = [],
  requests = [],
  aborted = [];
let hold = false,
  fail = false;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {OutlineSheet} from ${JSON.stringify(resolve("src/client/ThreadTools.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {SourceProvider} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {workspaceCapabilities} from ${JSON.stringify(resolve("src/shared/capabilities.ts"))};
    setShellSource("");
    const root = createRoot(document.getElementById("root"));
    window.show = (id="thread-a", owner="alice") => flushSync(() => {
      ownerSession.change(owner);
      root.render(id ? React.createElement(SourceProvider,{sourceId:"",capabilities:workspaceCapabilities()},React.createElement(OutlineSheet,{conversationId:id,onClose:()=>{},onJump:id=>window.jumped=id})):null);
    });
    window.show();
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
    }
    if (url.pathname.startsWith("/client.")) {
      res.setHeader(
        "content-type",
        url.pathname.endsWith("mjs") ? "text/javascript" : "text/css",
      );
      return res.end(url.pathname.endsWith("mjs") ? script : style);
    }
    if (url.pathname.endsWith("/outline")) {
      const text = url.searchParams.get("q");
      requests.push({ path: url.pathname, text });
      const body = fail
        ? { error: "Outline unavailable" }
        : text
          ? {
              items: [],
              matches: [
                {
                  message_id: "message-1",
                  kind: "prompt",
                  saved: false,
                  preview: text,
                  created_at: 1,
                },
              ],
            }
          : {
              items: [
                {
                  message_id: "message-1",
                  kind: "prompt",
                  preview: url.pathname,
                  created_at: 1,
                  run_id: null,
                },
              ],
            };
      const status = fail ? 503 : 200;
      res.on("close", () => {
        if (!res.writableEnded) aborted.push(text);
      });
      const send = () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (hold && text !== "new query") held.push(send);
      else send();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const rows = page.locator(".outline-list li");
  await expect(rows).toHaveCount(1);
  const input = page.getByRole("searchbox");
  hold = true;
  await input.fill("old query");
  await expect.poll(() => held.length).toBe(1);
  await input.fill("new query");
  await expect.poll(() => aborted.includes("old query")).toBe(true);
  hold = false;
  await expect(rows).toContainText(["new query"]);
  held.splice(0).forEach((send) => send());
  await expect(rows).toContainText(["new query"]);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const beforeRetype = requests.length;
  await input.fill("");
  await input.fill("new query");
  await page.clock.runFor(249);
  assert.equal(requests.length, beforeRetype);
  await page.clock.runFor(1);
  await expect.poll(() => requests.length).toBe(beforeRetype + 1);
  await expect(rows).toContainText(["new query"]);
  await page.clock.resume();
  await rows.getByRole("button").click();
  assert.equal(await page.evaluate(() => window.jumped), "message-1");
  fail = true;
  const before = requests.length;
  await input.fill("failed query");
  await expect(page.getByRole("alert")).toContainText("Outline unavailable");
  assert.equal(requests.length, before + 1);
  fail = false;
  hold = true;
  const retry = page.getByRole("button", { name: "Try again" });
  await retry.click();
  await expect.poll(() => held.length).toBe(1);
  await expect(page.locator(".outline-status")).toHaveText("Searching…");
  await expect(retry).toBeDisabled();
  await page.locator(".outline-search").evaluate((form) => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  hold = false;
  held.splice(0).forEach((send) => send());
  await expect(rows).toContainText(["failed query"]);
  assert.equal(requests.length, before + 2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  hold = true;
  await input.fill("departing query");
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.show("thread-b", "bob"));
  await expect.poll(() => aborted.includes("departing query")).toBe(true);
  hold = false;
  held.splice(0).forEach((send) => send());
  await expect(rows).toContainText(["departing query"]);
  await input.fill("");
  await expect(rows).toContainText(["thread-b"]);
  hold = true;
  await input.fill("unmount query");
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.show(null));
  await expect.poll(() => aborted.includes("unmount query")).toBe(true);
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: outline/search cancellation, latest query, owner/conversation change, once-mode error/retry and jump passed (HTTP fixture)`,
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
