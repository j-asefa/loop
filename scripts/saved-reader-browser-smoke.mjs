import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-saved-reader-"));
let browser, server;
const held = [];
const heldWrites = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {Saved} from ${JSON.stringify(resolve("src/client/Workspace.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){const[version,setVersion]=useState(0),[folder,setFolder]=useState(''),[,render]=useState(0);
      window.revision=()=>flushSync(()=>setVersion(n=>n+1));
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      window.folder=value=>flushSync(()=>setFolder(value));
      return React.createElement(Saved,{folders:[],folder,version,onFolder:setFolder,onOpen:()=>{},onFile:()=>{},onCreate:()=>{},onEdit:()=>{}});
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let empty = false;
  let label = "",
    failure = 0,
    stuck = false,
    holdNext = false,
    pinFailure = false,
    pinned = 0;
  const requests = [],
    writes = [];
  const row = (id, title) => ({
    id,
    owner_id: "alice",
    agent_id: null,
    conversation_id: null,
    run_id: null,
    title,
    kind: "markdown",
    role: "answer",
    content: "Fixture",
    metadata: "{}",
    folder_id: null,
    pinned,
    archived: 0,
    version: 1,
    created_at: 1,
    updated_at: 1,
    cursor: 30,
    name: null,
    provider: null,
  });
  server = createServer(async (req, res) => {
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
    if (req.method !== "GET") {
      let body = "";
      for await (const chunk of req) body += chunk;
      writes.push({ path, body: JSON.parse(body) });
      if (pinFailure) send(500, { error: "Pin unavailable" });
      else {
        pinned = 1;
        send(200, row("one", label + "First"));
      }
      return;
    }
    if (path.endsWith("/artifacts")) {
      const before = url.searchParams.get("before");
      requests.push({
        path,
        before,
        pinned: url.searchParams.get("pinned"),
        folder: url.searchParams.get("folder"),
      });
      const code = failure || 200,
        body = failure
          ? { error: "Saved unavailable" }
          : empty
            ? { items: [], next: null }
            : before
              ? {
                  items: stuck
                    ? [row("bad", "Uncommitted row")]
                    : [
                        row("two", label + "Second"),
                        row("three", label + "Third"),
                      ],
                  next: stuck ? Number(before) : null,
                }
              : {
                  items: [
                    row("one", label + "First"),
                    row("two", label + "Second"),
                  ],
                  next: 20,
                };
      const reply = () => send(code, body);
      if (holdNext) {
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
  const scenarios = ["revision", "cursor", "scope", "errors", "command-scope"];
  const selected = process.argv[2];
  assert(
    !selected || scenarios.includes(selected),
    "Unknown Saved fixture scenario",
  );
  for (const scenario of selected ? [selected] : scenarios) {
    label = "";
    empty = false;
    failure = scenario === "errors" ? 400 : 0;
    stuck = scenario === "cursor";
    holdNext = false;
    pinFailure = false;
    pinned = 0;
    requests.length = 0;
    writes.length = 0;
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.clock.install();
      await page.goto("http://127.0.0.1:" + server.address().port);
      const rows = page.locator(".file-row"),
        notice = page.locator(".collection-read-error"),
        more = page.getByRole("button", { name: "Load more", exact: true });
      if (scenario === "command-scope") {
        const pinError = page.getByText("Pin unavailable", { exact: true });
        await expect(rows).toHaveCount(2);
        pinFailure = true;
        await page
          .getByRole("button", { name: "Pin", exact: true })
          .first()
          .click();
        await expect(pinError).toBeVisible();
        empty = true;
        await page.getByRole("button", { name: "Pinned", exact: true }).click();
        await expect(rows).toHaveCount(0);
        await expect(pinError).toHaveCount(0);
        await expect(
          page.getByText("Keep the good stuff close.", { exact: true }),
        ).toBeVisible();
        empty = false;
        await page.getByRole("button", { name: "Recent", exact: true }).click();
        await expect(rows).toHaveCount(2);
        await expect(pinError).toHaveCount(0);
        await page.route("**/api/**", async (route) => {
          if (route.request().method() === "GET") return route.continue();
          const response = await route.fetch();
          heldWrites.push(() => route.fulfill({ response }));
        });
        for (const [kind, value] of [
          ["folder", "other-folder"],
          ["source", "docker:other"],
          ["owner", "bob"],
          ["owner", "alice"],
        ]) {
          await page
            .getByRole("button", { name: "Pin", exact: true })
            .first()
            .click();
          await expect.poll(() => heldWrites.length).toBe(1);
          await page.evaluate(
            ([kind, value]) => window[kind](value),
            [kind, value],
          );
          await expect(rows).toHaveCount(2);
          if (kind === "folder") {
            await page.evaluate(() => window.folder(""));
            await expect(rows).toHaveCount(2);
          }
          await heldWrites.shift()();
          await page.clock.runFor(100);
          await expect(pinError).toHaveCount(0);
          if (kind === "source") {
            await page.evaluate(() => window.source(""));
            await expect(rows).toHaveCount(2);
          }
        }
        await page
          .getByRole("button", { name: "Pin", exact: true })
          .first()
          .click();
        await expect.poll(() => heldWrites.length).toBe(1);
        pinFailure = false;
        await page
          .getByRole("button", { name: "Pin", exact: true })
          .first()
          .click();
        await expect.poll(() => heldWrites.length).toBe(2);
        await heldWrites.pop()();
        await expect(
          page.getByRole("button", { name: "Unpin", exact: true }),
        ).toHaveCount(2);
        await heldWrites.shift()();
        await page.clock.runFor(100);
        await expect(pinError).toHaveCount(0);
      } else if (scenario === "errors") {
        await expect(notice).toContainText("Saved unavailable");
        failure = 0;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(rows).toHaveCount(2);
        pinFailure = true;
        await page
          .getByRole("button", { name: "Pin", exact: true })
          .first()
          .click();
        await expect(
          page.getByText("Pin unavailable", { exact: true }),
        ).toBeVisible();
        label = "Refreshed ";
        await page.evaluate(() => window.revision());
        await expect(rows.first()).toContainText("Refreshed First");
        await expect(
          page.getByText("Pin unavailable", { exact: true }),
        ).toBeVisible();
        assert.equal(writes.length, 1);
        pinFailure = false;
        await page
          .getByRole("button", { name: "Pin", exact: true })
          .first()
          .click();
        await expect(
          page.getByRole("button", { name: "Unpin", exact: true }),
        ).toHaveCount(2);
        await expect(
          page.getByText("Pin unavailable", { exact: true }),
        ).toHaveCount(0);
      } else {
        await expect(rows).toHaveCount(2);
        assert.equal(requests.length, 1, "initial mount must read once");
        if (scenario === "revision") {
          await more.click();
          await expect(rows).toHaveCount(3);
          label = "Revised ";
          holdNext = true;
          await page.evaluate(() => window.revision());
          await expect.poll(() => held.length).toBe(1);
          await expect(rows).toHaveCount(3);
          await expect(rows.first()).toContainText("First");
          held.shift()();
          await expect(rows).toHaveCount(2);
          await expect(rows.first()).toContainText("Revised First");
          await page
            .getByRole("button", { name: "Pinned", exact: true })
            .click();
          await expect.poll(() => requests.at(-1).pinned).toBe("1");
          await page
            .getByRole("button", { name: "Folders", exact: true })
            .click();
          await expect.poll(() => requests.at(-1).folder).toBe("unfiled");
        } else if (scenario === "cursor") {
          await more.click();
          await expect(notice).toContainText("Pagination did not advance");
          await expect(rows).toHaveCount(2);
          await expect(
            page.getByText("Uncommitted row", { exact: true }),
          ).toHaveCount(0);
          const before = requests.length;
          failure = 503;
          await page.getByRole("button", { name: "Retry connection" }).click();
          await expect(notice).toContainText("Saved unavailable");
          await page.clock.runFor(100);
          assert.equal(
            requests.length,
            before + 1,
            "explicit retry has one attempt",
          );
          assert.equal(requests.at(-1).before, "20");
          failure = 0;
          stuck = false;
          await page.getByRole("button", { name: "Retry connection" }).click();
          await expect(rows).toHaveCount(3);
          await expect(rows.last()).toContainText("Third");
          await expect(notice).toHaveCount(0);
        } else {
          for (const [kind, value] of [
            ["folder", "other-folder"],
            ["source", "docker:other"],
            ["owner", "bob"],
            ["owner", "alice"],
          ]) {
            label = "Old ";
            holdNext = true;
            await page.evaluate(() => window.revision());
            await expect.poll(() => held.length).toBe(1);
            label = "Current ";
            holdNext = true;
            await page.evaluate(
              ([kind, value]) => window[kind](value),
              [kind, value],
            );
            await expect.poll(() => held.length).toBe(2);
            await expect(rows).toHaveCount(0);
            held.pop()();
            await expect(rows.first()).toContainText("Current First");
            held.shift()();
            await page.clock.runFor(50);
            await expect(rows.first()).toContainText("Current First");
          }
        }
      }
      assert.deepEqual(errors, []);
      console.log(engine + " Saved reader passed: " + scenario);
    } finally {
      held.splice(0).forEach((send) => send());
      for (const send of heldWrites.splice(0)) await send().catch(() => {});
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
