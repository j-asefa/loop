import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-pull-watch-reader-"));
let server, browser;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {PullRequestCards} from ${JSON.stringify(resolve("src/client/PullRequestCard.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    const card={type:'github_pull_requests',tool:'fixture',fetchedAt:1,pulls:[{owner:'acme',repo:'api',number:1,title:'Fixture pull',url:'https://github.com/acme/api/pull/1',state:'open'}]};
    function App(){
      const [conversation,setConversation]=useState('thread-a'),[,render]=useState(0);
      window.select=value=>flushSync(()=>setConversation(value));
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.refresh=()=>window.dispatchEvent(new CustomEvent('loop-workspace-change'));
      return React.createElement(PullRequestCards,{card,artifactId:'artifact',conversationId:conversation});
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let fail = true,
    hold = false,
    cooldown = false,
    label = "First";
  const reads = [],
    aborted = [];
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
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
    if (url.pathname === "/favicon.ico") {
      res.writeHead(404);
      res.end();
      return;
    }
    assert(url.pathname.endsWith("/pr-watches"));
    const conversation = url.searchParams.get("conversation");
    reads.push({ path: url.pathname, conversation });
    res.on("close", () => {
      if (!res.writableEnded) aborted.push(conversation);
    });
    const status = cooldown ? 429 : fail ? 400 : 200;
    cooldown = false;
    const body =
      status !== 200
        ? { error: "Watch list unavailable" }
        : {
            watches: [
              {
                id: "watch",
                conversation_id: conversation,
                agent_id: "agent",
                repo_owner: "acme",
                repo_name: "api",
                number: 1,
                state: "paused",
                ended_reason: null,
                error: label,
                head_sha: null,
                ci_sha: null,
                ci_conclusion: null,
                created_at: 1,
                updated_at: 1,
                ci_pending: 0,
                read_at: null,
                seen_ci_sha: null,
                seen_ci_conclusion: null,
              },
            ],
          };
    const reply = () => {
      res.writeHead(status, {
        "content-type": "application/json",
        ...(status === 429 ? { "retry-after": "2" } : {}),
      });
      res.end(JSON.stringify(body));
    };
    if (hold) {
      hold = false;
      held.push(reply);
    } else reply();
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
  await expect(page.getByRole("alert")).toContainText(
    "Pull-request watches: Watch list unavailable",
  );
  fail = false;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByText("First", { exact: true })).toBeVisible();
  hold = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  label = "Second";
  await page.evaluate(() => window.select("thread-b"));
  await expect(page.getByText("Second", { exact: true })).toBeVisible();
  await expect.poll(() => aborted.includes("thread-a")).toBe(true);
  held.splice(0).forEach((reply) => reply());
  await expect(page.getByText("First", { exact: true })).toHaveCount(0);
  for (const scope of ["owner", "source"]) {
    hold = true;
    label = scope;
    await page.evaluate(
      (scope) => window[scope](scope === "owner" ? "bob" : "other-source"),
      scope,
    );
    await expect.poll(() => held.length).toBe(1);
    await expect(page.locator(".pr-watch-status")).toHaveCount(0);
    held.splice(0).forEach((reply) => reply());
    await expect(page.getByText(scope, { exact: true })).toBeVisible();
  }
  cooldown = true;
  const coolingResponse = page.waitForResponse(
    (response) => response.status() === 429,
  );
  await page.evaluate(() => window.select("thread-c"));
  await expect.poll(() => reads.at(-1).conversation).toBe("thread-c");
  await coolingResponse;
  await page.waitForTimeout(30);
  await page.evaluate(() => window.select(null));
  const idleCount = reads.length;
  await page.evaluate(() => window.refresh());
  await page.waitForTimeout(2200);
  assert.equal(
    reads.length,
    idleCount,
    "absent selection is idle and cancels cooldown continuation",
  );
  assert(
    reads.every((read) => read.conversation),
    "no fabricated/missing conversation request",
  );
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: watch read failure/retry, latest selection, HTTP abort, owner/source reset and absent-selection cooldown passed`,
  );
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
