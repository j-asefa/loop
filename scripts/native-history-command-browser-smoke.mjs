import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-history-command-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
const posts = [];
let browser, server;
let mode = "uncertain";
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {NativeHistory} from ${JSON.stringify(resolve("src/client/NativeHistory.tsx"))};
    import {SourceProvider} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {workspaceCapabilities} from ${JSON.stringify(resolve("src/shared/capabilities.ts"))};
    import {setViewOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    const root = createRoot(document.getElementById('root'));
    window.mountHistory = (owner, sourceId='') => {
      setViewOwner(owner);
      root.render(React.createElement(SourceProvider,
        {key:JSON.stringify([owner,sourceId]),sourceId,capabilities:workspaceCapabilities()}, React.createElement(NativeHistory,
        {onClose:()=>{},onOpen:id=>{window.opened=id}})));
    };
    window.mountHistory('alice');
  `,
  );
  const bundle = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname.replace(
      "/api/agent-sources/fixture%3Asecond/",
      "/api/",
    );
    const reply = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/client.mjs") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.script);
    } else if (path === "/session") reply({ csrf: "fixture" });
    else if (path === "/api/native/history")
      reply({
        managed: [],
        external: [
          {
            id: "fixture-history",
            harness: "codex",
            title: "Fixture history",
            project: "/fixture",
          },
        ],
        next: null,
      });
    else if (path === "/api/native/history/fixture-history")
      reply({ items: [], activities: [], note: "Fixture history details" });
    else if (
      path === "/api/native/history/fixture-history/fork" &&
      req.method === "POST"
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      posts.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (mode === "uncertain")
        reply(
          { error: "Fixture uncertain fork", executionOutcome: "unknown" },
          503,
        );
      else reply({ id: "forked-conversation" });
    } else if (path === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<main id="root"></main><script type="module" src="/client.mjs"></script>',
      );
    } else reply({ error: "Unexpected fixture route" }, 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const selectHistory = async () => {
    await page
      .getByRole("button", { name: "Other Codex", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Fixture history", exact: false })
      .click();
    await expect(
      page.getByText("Fixture history details", { exact: true }),
    ).toBeVisible();
  };
  await selectHistory();
  const fork = page.getByRole("button", {
    name: "Fork into a new Loop conversation",
    exact: true,
  });
  await fork.click();
  await expect(page.getByRole("alert")).toContainText("Fixture uncertain fork");
  assert.equal(posts.length, 1);
  const retained = await page.evaluate(() =>
    sessionStorage.getItem(
      'loop-effect:["alice","","native-history-fork","fixture-history"]',
    ),
  );
  assert.equal(
    retained,
    posts[0].commandId,
    "receipt stores the raw command ID before dispatch",
  );
  await page.reload();
  await selectHistory();
  assert.equal(posts.length, 1, "reload does not dispatch a fork");
  await page.evaluate(() => window.mountHistory("bob"));
  await selectHistory();
  await fork.click();
  await expect(page.getByRole("alert")).toContainText("Fixture uncertain fork");
  assert.equal(posts.length, 2);
  assert.notEqual(
    posts[1].commandId,
    posts[0].commandId,
    "owners have separate pending forks",
  );
  await page.evaluate(() => window.mountHistory("alice", "fixture:second"));
  await selectHistory();
  await fork.click();
  await expect(page.getByRole("alert")).toContainText("Fixture uncertain fork");
  assert.equal(posts.length, 3);
  assert.notEqual(
    posts[2].commandId,
    posts[0].commandId,
    "sources have separate pending forks",
  );
  await page.evaluate(() => window.mountHistory("alice"));
  await selectHistory();
  mode = "success";
  await fork.click();
  await expect
    .poll(() => page.evaluate(() => window.opened))
    .toBe("forked-conversation");
  assert.equal(posts.length, 4);
  assert.deepEqual(
    posts[3],
    posts[0],
    "uncertain fork keeps its identity after reload",
  );
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem(
        'loop-effect:["alice","","native-history-fork","fixture-history"]',
      ),
    ),
    null,
  );
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem(
        'loop-effect:["bob","","native-history-fork","fixture-history"]',
      ),
    ),
    posts[1].commandId,
    "settling Alice leaves Bob's uncertain receipt",
  );
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem(
        'loop-effect:["alice","fixture:second","native-history-fork","fixture-history"]',
      ),
    ),
    posts[2].commandId,
    "settling local leaves the other source receipt",
  );
  assert.deepEqual(failures, []);
  console.log(
    `${engine.name()}: native-history fork retains raw identity through uncertainty/reload and removes it after success; isolated fixture`,
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
