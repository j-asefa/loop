import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-search-reader-"));
let browser, server;
const held = [],
  details = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {SearchWorkspace} from ${JSON.stringify(resolve("src/client/Workspace.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){const[,render]=useState(0),[opened,setOpened]=useState(0);
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      return React.createElement(React.Fragment,null,React.createElement(SearchWorkspace,{agents:[],folders:[],userName:'You',onProfile:()=>{},onOpen:()=>setOpened(n=>n+1),onConversation:()=>setOpened(n=>n+1)}),React.createElement('output',{id:'opened'},opened));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let failure = 0,
    detailFailure = 0,
    holdNext = false,
    holdDetail = false,
    stuck = false,
    label = "";
  const requests = [],
    openRequests = [];
  const semantic = {
    enabled: false,
    state: "disabled",
    total: 0,
    indexed: 0,
    pending: 0,
    detail: null,
  };
  const item = (id, title) => ({
    id: "artifact:" + id,
    owner_id: "alice",
    kind: "markdown",
    title,
    agent_id: null,
    conversation_id: null,
    folder_id: null,
    created_at: 1,
    updated_at: 1,
    snippet: "A matching search excerpt.",
    score: 1,
    url: "/artifact/" + id,
    message_id: null,
  });
  const artifact = {
    id: "one",
    owner_id: "alice",
    agent_id: null,
    conversation_id: null,
    run_id: null,
    title: "Opened artifact",
    kind: "markdown",
    role: "answer",
    content: "Fixture",
    metadata: "{}",
    folder_id: null,
    pinned: 0,
    archived: 0,
    version: 1,
    created_at: 1,
    updated_at: 1,
  };
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid"),
      path = url.pathname;
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
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
    if (path.endsWith("/search")) {
      const q = url.searchParams.get("q"),
        before = url.searchParams.get("before");
      requests.push({ path, q, before, kind: url.searchParams.get("kind") });
      const code = failure || 200,
        body = failure
          ? { error: "Search unavailable" }
          : {
              mode: "keyword",
              detail: null,
              pending: 0,
              semantic,
              next: before ? (stuck ? Number(before) : null) : 10,
              items: before
                ? stuck
                  ? [item("bad", "Uncommitted match")]
                  : [
                      item("one", label + q + " First"),
                      item("two", label + q + " Second"),
                    ]
                : [item("one", label + q + " First")],
            };
      const reply = () => send(code, body);
      if (holdNext) {
        holdNext = false;
        held.push(reply);
      } else reply();
      return;
    }
    if (path.includes("/artifacts/")) {
      openRequests.push(path);
      const code = detailFailure || 200,
        body = detailFailure ? { error: "Artifact unavailable" } : artifact;
      const reply = () => send(code, body);
      if (holdDetail) {
        holdDetail = false;
        details.push(reply);
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
  const scenarios = [
      "intent",
      "retry",
      "clear",
      "scope",
      "detail",
      "detail-clear",
    ],
    selected = process.argv[2];
  assert(!selected || scenarios.includes(selected));
  for (const scenario of selected ? [selected] : scenarios) {
    failure = 0;
    detailFailure = 0;
    holdNext = false;
    holdDetail = false;
    stuck = false;
    label = "";
    requests.length = 0;
    openRequests.length = 0;
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.clock.install();
      await page.goto("http://127.0.0.1:" + server.address().port);
      const input = page.getByRole("searchbox", { name: "Search everything" }),
        rows = page.locator(".search-result"),
        notice = page.locator(".collection-read-error");
      const search = async (text) => {
        await input.fill(text);
        await input.press("Enter");
      };
      const clear = () =>
        page.getByRole("button", { name: "Clear search" }).click();
      await expect(input).toBeVisible();
      assert.equal(requests.length, 0);
      if (scenario === "intent") {
        await input.fill("Needle");
        await page.clock.fastForward(5000);
        assert.equal(requests.length, 0, "typing is not a submitted search");
        await input.press("Enter");
        await expect(rows.first()).toContainText("Needle First");
        assert.equal(requests.length, 1);
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: {
                sources: [""],
                changes: [
                  {
                    source: "",
                    events: [
                      {
                        type: "invalidate",
                        scope: { kind: "collection", id: "search" },
                      },
                    ],
                  },
                ],
              },
            }),
          ),
        );
        await page.clock.fastForward(12000);
        assert.equal(
          requests.length,
          1,
          "index progress must not dispatch another query",
        );
        await input.fill("Unsubmitted");
        await page.getByRole("button", { name: "More results" }).click();
        await expect(rows).toHaveCount(2);
        assert.equal(requests.at(-1).before, "10");
        assert.equal(
          requests.at(-1).q,
          "Needle",
          "pagination belongs to the completed query, not unsent edits",
        );
        await page.getByRole("tab", { name: "Results", exact: true }).click();
        await expect.poll(() => requests.at(-1).kind).toBe("markdown");
        await expect(rows).toHaveCount(1);
      } else if (scenario === "retry") {
        failure = 503;
        await search("Needle");
        await expect(notice).toContainText("Search unavailable");
        await page.clock.fastForward(10000);
        assert.equal(
          requests.length,
          1,
          "a failed query must not retry automatically",
        );
        failure = 0;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(rows).toHaveCount(1);
        stuck = true;
        await page.getByRole("button", { name: "More results" }).click();
        await expect(notice).toContainText("Search pagination did not advance");
        await expect(rows).toHaveCount(1);
        await expect(
          page.getByText("Uncommitted match", { exact: true }),
        ).toHaveCount(0);
        const before = requests.length;
        failure = 503;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(notice).toContainText("Search unavailable");
        await page.clock.fastForward(10000);
        assert.equal(requests.length, before + 1);
        assert.equal(requests.at(-1).before, "10");
        failure = 0;
        stuck = false;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(rows).toHaveCount(2);
        await expect(notice).toHaveCount(0);
      } else if (scenario === "clear") {
        holdNext = true;
        await search("Old");
        await expect.poll(() => held.length).toBe(1);
        holdNext = true;
        await search("New");
        await expect.poll(() => held.length).toBe(2);
        held.pop()();
        await expect(rows.first()).toContainText("New First");
        held.shift()();
        await page.clock.runFor(100);
        await expect(rows.first()).toContainText("New First");
        holdNext = true;
        await search("Cleared");
        await expect.poll(() => held.length).toBe(1);
        await clear();
        await expect(rows).toHaveCount(0);
        held.shift()();
        await page.clock.runFor(100);
        await expect(rows).toHaveCount(0);
        await expect(page.getByText("Finding…", { exact: true })).toHaveCount(
          0,
        );
        await search("After");
        await expect(rows.first()).toContainText("After First");
      } else if (scenario === "scope") {
        await search("Needle");
        await expect(rows).toHaveCount(1);
        label = "Old ";
        holdNext = true;
        await search("Needle");
        await expect.poll(() => held.length).toBe(1);
        label = "Current ";
        holdNext = true;
        await page.evaluate(() => window.source("docker:other"));
        await expect.poll(() => held.length).toBe(2);
        await expect(rows).toHaveCount(0);
        held.pop()();
        await expect(rows.first()).toContainText("Current Needle");
        held.shift()();
        await page.clock.runFor(100);
        await expect(rows.first()).toContainText("Current Needle");
        label = "Old ";
        holdNext = true;
        await search("Needle");
        await expect.poll(() => held.length).toBe(1);
        const before = requests.length;
        await page.evaluate(() => window.owner("bob"));
        await page.clock.runFor(100);
        await expect(rows).toHaveCount(0);
        assert.equal(
          requests.length,
          before,
          "an old owner query must not be dispatched for a different owner",
        );
        label = "Current ";
        holdNext = true;
        await page.evaluate(() => window.owner("alice"));
        await expect.poll(() => held.length).toBe(2);
        held.pop()();
        await expect(rows.first()).toContainText("Current Needle");
        held.shift()();
        await page.clock.runFor(100);
        await expect(rows.first()).toContainText("Current Needle");
      } else if (scenario === "detail-clear") {
        await search("Needle");
        await expect(rows).toHaveCount(1);
        holdDetail = true;
        await rows
          .first()
          .getByRole("button", { name: "Needle First", exact: true })
          .click();
        await expect.poll(() => details.length).toBe(1);
        const aborted = page.waitForEvent("requestfailed", {
          predicate: (request) => request.url().includes("/artifacts/"),
          timeout: 5000,
        });
        await clear();
        await aborted;
        details.shift()();
        await page.clock.runFor(100);
        await expect(page.locator("#opened")).toHaveText("0");
      } else {
        await search("Needle");
        await expect(rows).toHaveCount(1);
        detailFailure = 503;
        await rows
          .first()
          .getByRole("button", { name: "Needle First", exact: true })
          .click();
        await expect(notice).toContainText("Artifact unavailable");
        await page.clock.fastForward(10000);
        assert.equal(openRequests.length, 1);
        detailFailure = 0;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(page.locator("#opened")).toHaveText("1");
        holdDetail = true;
        await rows
          .first()
          .getByRole("button", { name: "Needle First", exact: true })
          .click();
        await expect.poll(() => details.length).toBe(1);
        holdDetail = true;
        await rows
          .first()
          .getByRole("button", { name: "Needle First", exact: true })
          .click();
        await expect.poll(() => details.length).toBe(2);
        details.pop()();
        await expect(page.locator("#opened")).toHaveText("2");
        details.shift()();
        await page.clock.runFor(100);
        await expect(page.locator("#opened")).toHaveText("2");
        holdDetail = true;
        await rows
          .first()
          .getByRole("button", { name: "Needle First", exact: true })
          .click();
        await expect.poll(() => details.length).toBe(1);
        await clear();
        details.shift()();
        await page.clock.runFor(100);
        await expect(page.locator("#opened")).toHaveText("2");
      }
      assert.deepEqual(errors, []);
      console.log(engine + " Search reader passed: " + scenario);
    } finally {
      held.splice(0).forEach((send) => send());
      details.splice(0).forEach((send) => send());
      await context.close();
    }
  }
} finally {
  held.splice(0).forEach((send) => send());
  details.splice(0).forEach((send) => send());
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
