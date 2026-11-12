import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-token-command-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
let browser, server;
const posts = [];
const tokens = [];
let mode = "refuse";
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React, {useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {CardTokens} from ${JSON.stringify(resolve("src/client/CardTokens.tsx"))};
    import {setViewOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import {SourceProvider} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {workspaceCapabilities} from ${JSON.stringify(resolve("src/shared/capabilities.ts"))};
    const h = React.createElement;
    setViewOwner('alice');
    function Fixture() {
      const [open, setOpen] = useState(true);
      return h(SourceProvider, {sourceId:'', capabilities:workspaceCapabilities()},
        h('button', {onClick:()=>setOpen(!open)}, open ? 'Close settings' : 'Open settings'),
        open && h(CardTokens,{owner:'alice',sourceId:''}));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  `,
  );
  const bundle = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const reply = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (path === "/client.mjs") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.script);
    } else if (path === "/session") reply({ csrf: "fixture" });
    else if (path === "/api/card-tokens" && req.method === "GET") reply(tokens);
    else if (path === "/api/card-tokens" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      posts.push(request);
      if (mode === "refuse") return reply({ error: "Creation refused" }, 403);
      if (mode === "commit")
        tokens.push({
          id: request.request_id,
          name: request.name,
          scopes: request.scopes,
          created_at: 100,
          revoked_at: null,
          last_used_at: null,
        });
      reply({ error: "Response withheld by fixture" }, 503);
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
  await page.route("**/api/card-tokens", async (route) => {
    if (route.request().method() !== "POST" || mode === "refuse")
      return route.continue();
    // Dropping a TCP connection can trigger a browser transport retry. Abort
    // delivery after the fixture handles it to test one lost application reply.
    await route.fetch();
    await route.abort("failed");
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  const name = page.getByLabel("Token name", { exact: true });
  await name.fill("Refused token");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Creation refused");
  await expect(name).toBeEnabled();
  mode = "drop";
  await name.fill("Pending token");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry token creation", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(name).toHaveValue("Pending token");
  await expect(name).toBeDisabled();
  assert.equal(posts.length, 2, "reopening must not dispatch");
  mode = "commit";
  await page
    .getByRole("button", { name: "Retry token creation", exact: true })
    .click();
  await expect(page.locator(".settings-command pre")).toHaveText(
    posts[1].secret,
  );
  assert.deepEqual(
    posts[2],
    posts[1],
    "retry keeps the exact secret and request identity",
  );
  assert.notEqual(
    posts[1].request_id,
    posts[0].request_id,
    "refusal releases the earlier request",
  );
  assert.equal(tokens.length, 1);
  const persisted = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    }),
  );
  for (const post of posts) assert(!persisted.includes(post.secret));
  console.log(
    `${engine.name()}: token creation refusal, uncertainty, reopen, reconciliation and secret isolation passed`,
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
