import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-done-thread-identity-"));
let browser, server;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {OrganizeCards} from ${JSON.stringify(resolve("src/client/DoneThreads.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change(new URLSearchParams(location.search).get('owner')||'alice');setShellSource('');
    createRoot(document.getElementById('root')).render(React.createElement(OrganizeCards,{selection:{source:'',title:'Results',cardIds:new URLSearchParams(location.search).has('reverse')?['d:run:second','d:run:first']:['d:run:first','d:run:second'],previews:[]},threads:[],onClose:()=>window.completed=true,onDone:()=>{}}));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  const payloads = [];
  const deleted = new Set();
  const ids = [],
    records = new Map();
  let loseReply = true;
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (path === "/" || path === "/client.mjs" || path === "/client.css") {
      res.writeHead(200, {
        "content-type":
          path === "/"
            ? "text/html"
            : path.endsWith(".css")
              ? "text/css"
              : "text/javascript",
      });
      res.end(
        path === "/"
          ? '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>'
          : path.endsWith(".css")
            ? style
            : script,
      );
      return;
    }
    assert.equal(req.method, "POST");
    assert.equal(path, "/api/feed/threads");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    ids.push(body.id);
    payloads.push(body);
    if (deleted.has(body.id)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Thread not found" }));
      return;
    }
    if (!records.has(body.id)) records.set(body.id, { ...body, createdAt: 1 });
    res.writeHead(loseReply ? 500 : 200, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        loseReply
          ? { error: "Fixture reply lost after creation" }
          : records.get(body.id),
      ),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  const submit = () =>
    page.getByRole("menuitem", { name: "Combine into a new thread" }).click();
  await page.goto(url);
  await submit();
  await expect(page.getByRole("alert")).toContainText("Fixture reply lost");
  assert.equal(records.size, 1);
  await page.getByLabel("New thread name").fill("Edited while uncertain");
  await submit();
  await expect(page.getByRole("alert")).toContainText("Fixture reply lost");
  assert.equal(
    ids[1],
    ids[0],
    "Editing an uncertain title must retain its identity",
  );
  assert.equal(
    payloads[1].title,
    "Results",
    "Recovery must retain its original creation context",
  );
  ids.splice(1);
  payloads.splice(1);
  await page.goto(url + "/?reverse=1");
  loseReply = false;
  await submit();
  await expect.poll(() => page.evaluate(() => window.completed)).toBe(true);
  assert.equal(ids[1], ids[0], "Reload recovery must retain the creation ID");
  assert.equal(
    records.size,
    1,
    "Recovering a lost reply must not create another grouping",
  );
  await page.reload();
  loseReply = true;
  await submit();
  await expect(page.getByRole("alert")).toContainText("Fixture reply lost");
  assert.notEqual(
    ids[2],
    ids[0],
    "A settled creation must release its pending identity",
  );
  await page.goto(url + "/?owner=bob");
  await submit();
  await expect(page.getByRole("alert")).toContainText("Fixture reply lost");
  const old = ids[3];
  deleted.add(old);
  records.delete(old);
  loseReply = false;
  await submit();
  await expect(page.getByRole("alert")).toContainText("Thread not found");
  await page
    .getByRole("button", { name: "Start a separate thread", exact: true })
    .click();
  await submit();
  await expect.poll(() => page.evaluate(() => window.completed)).toBe(true);
  assert.notEqual(
    ids.at(-1),
    old,
    "Explicit separate creation must release the deleted receipt slot",
  );
  const history = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("loop-effect-history:"))
      .map((key) => JSON.parse(localStorage.getItem(key))),
  );
  assert(
    history.some((record) => record.commandId === old),
    "The superseded uncertain identity must remain in history",
  );
  assert.notEqual(
    ids[3],
    ids[2],
    "Another owner must not reuse Alice pending identity",
  );
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: Done-thread creation reload recovery, settlement and owner isolation passed`,
  );
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
