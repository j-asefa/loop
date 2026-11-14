import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-webhook-reader-"));
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
    import {Webhooks} from ${JSON.stringify(resolve("src/client/Webhooks.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function App(){
      const [owner,setOwner]=useState('alice'),[source,setSource]=useState(''),[shown,setShown]=useState(true);
      window.source=value=>flushSync(()=>{setShellSource(value);setSource(value)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);setOwner(value)});
      window.shown=value=>flushSync(()=>setShown(value));
      window.refresh=()=>window.dispatchEvent(new CustomEvent('loop-workspace-change',{detail:{sources:[source],changes:[{source,events:[{type:'invalidate',scope:{kind:'collection',id:'webhooks'}}]}]}}));
      return shown?React.createElement(Webhooks,{key:owner+source,owner,sourceId:source}):null;
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let listFailure = false,
    historyFailure = false,
    holdHistory = false,
    cooldown = false,
    label = "initial";
  const requests = [];
  const subscription = (id) => ({
    id,
    url: "https://" + label + "-" + id + ".invalid/receiver",
    local: false,
    kinds: ["run.stopped"],
    state: "active",
    created_at: 1,
    activated_at: 1,
    revoked_at: null,
    failed_at: null,
    last_delivered_at: null,
    last_status: null,
    last_error: null,
    activation: null,
    last_attempts: 0,
  });
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
    const history = url.pathname.endsWith("/deliveries");
    requests.push({ path: url.pathname, history, method: req.method });
    const retry = cooldown;
    cooldown = false;
    const fail = history ? historyFailure : listFailure;
    const row = {
      id: label + "-" + (url.pathname.includes("/two/") ? "two" : "one"),
      event_id: null,
      kind: "control",
      purpose: "test",
      attempts: 1,
      available_at: 1,
      delivered_at: 1,
      last_status: 204,
      last_error: null,
      outcome: "accepted",
      exhausted: false,
      in_flight: false,
      created_at: 1,
    };
    const body = fail
      ? { error: history ? "History unavailable" : "List unavailable" }
      : history
        ? [row]
        : {
            policy: { installation: "companion", local_receivers: false },
            subscriptions: [subscription("one"), subscription("two")],
          };
    const reply = () => {
      res.writeHead(retry ? 429 : fail ? 503 : 200, {
        "content-type": "application/json",
        ...(retry ? { "retry-after": "2" } : {}),
      });
      res.end(JSON.stringify(retry ? { error: "Cooldown" } : body));
    };
    if (history && holdHistory) {
      holdHistory = false;
      held.push(reply);
    } else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const recent = page.getByRole("button", {
    name: "Recent deliveries",
    exact: true,
  });
  await expect(recent).toHaveCount(2);
  await recent.first().click();
  await expect(page.getByLabel("Recent webhook deliveries")).toContainText(
    "initial-one",
  );
  const idle = requests.length;
  await page.waitForTimeout(11000);
  assert.equal(
    requests.length,
    idle,
    "list and history have no independent polling timer",
  );
  label = "pushed";
  await page.evaluate(() => window.refresh());
  await expect(page.getByLabel("Webhook receivers")).toContainText(
    "pushed-one.invalid",
  );
  await expect(page.getByLabel("Recent webhook deliveries")).toContainText(
    "pushed-one",
  );
  historyFailure = true;
  await recent.first().click();
  await expect(page.getByRole("alert")).toContainText("History unavailable");
  label = "live";
  await page.evaluate(() => window.refresh());
  await expect(page.getByLabel("Webhook receivers")).toContainText(
    "live-one.invalid",
  );
  await expect(page.getByRole("alert")).toContainText("History unavailable");
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toBeEnabled({ timeout: 20000 });
  historyFailure = false;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  holdHistory = true;
  label = "obsolete";
  await recent.first().click();
  await expect.poll(() => held.length).toBe(1);
  label = "selected";
  await recent.nth(1).click();
  await expect(page.getByLabel("Recent webhook deliveries")).toContainText(
    "selected-two",
  );
  held.splice(0).forEach((reply) => reply());
  await page.waitForTimeout(50);
  await expect(page.getByLabel("Recent webhook deliveries")).not.toContainText(
    "obsolete",
  );
  console.log(
    engine +
      " webhook-reader scoped push/no poll/independent history/latest intent: passed",
  );
  listFailure = true;
  await page
    .getByRole("button", { name: "Refresh receivers", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("List unavailable");
  const before = requests.length;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toBeEnabled();
  assert.equal(
    requests.length,
    before + 1,
    "manual list retry has one transient attempt",
  );
  listFailure = false;
  label = "recovered";
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  for (const kind of ["source", "owner"]) {
    holdHistory = true;
    label = "obsolete-" + kind;
    await recent.first().click();
    await expect.poll(() => held.length).toBe(1);
    label = "current-" + kind;
    await page.evaluate(
      (value) => window[value](value === "source" ? "peer:other" : "bob"),
      kind,
    );
    await expect(recent).toHaveCount(2);
    held.splice(0).forEach((reply) => reply());
    await expect(page.getByLabel("Recent webhook deliveries")).toHaveCount(0);
  }
  cooldown = true;
  const last = requests.length;
  await page
    .getByRole("button", { name: "Refresh receivers", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(last + 1);
  await page.evaluate(() => window.shown(false));
  await page.waitForTimeout(2300);
  assert.equal(
    requests.length,
    last + 1,
    "closing settings aborts cooldown without replaying any command",
  );
  assert(requests.every((request) => request.method === "GET"));
  console.log(
    engine + " webhook-reader manual retry/source owner remount/cancel: passed",
  );
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
