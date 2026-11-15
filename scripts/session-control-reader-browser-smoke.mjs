import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

import {
  reduceActivity,
  undiscoveredCapabilities,
} from "../src/shared/agent-activities.ts";
import { SessionControls } from "../src/shared/session-controls.ts";
const dir = await mkdtemp(join(tmpdir(), "loop-session-control-reader-"));
let browser, server;
const held = [];
const generation = "11111111-1111-4111-8111-111111111111",
  nextGeneration = "22222222-2222-4222-8222-222222222222";
const capabilities = undiscoveredCapabilities("fixture");
capabilities.settings = { state: "supported", source: "fixture" };
const option = (value) => ({
  id: "mode",
  label: "Mode",
  type: "text",
  confirmed: value,
  mutable: true,
  application: "live",
});
const record = reduceActivity(undefined, {
  v: 1,
  kind: "settings",
  id: "settings",
  source: { transport: "api", origin: "fixture" },
  generation,
  patch: { revision: 7, options: [option("Recorded")] },
}).record;
let controls = SessionControls.parse({
  generation,
  state: "connected",
  settings: { revision: 10, options: [option("Current")] },
  commands: { revision: 0, commands: [] },
  capabilities,
});
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
 import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
 import {SessionActivityControls} from ${JSON.stringify(resolve("src/client/SessionActivityControls.tsx"))};import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
 ownerSession.change('alice');setShellSource('');const record=${JSON.stringify(record)},capabilities=${JSON.stringify(capabilities)};
 function App(){const [shown,setShown]=useState(true),[thread,setThread]=useState('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),[matching,setMatching]=useState(true),[,render]=useState(0);
 window.shown=value=>flushSync(()=>setShown(value));window.thread=value=>flushSync(()=>setThread(value));window.matching=value=>flushSync(()=>setMatching(value));window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});window.refresh=()=>window.dispatchEvent(new Event('loop-workspace-change'));
 return shown?React.createElement(SessionActivityControls,{conversationId:thread,recorded:{settings:record,capabilities,capabilityGeneration:matching?${JSON.stringify(generation)}:${JSON.stringify(nextGeneration)}}}):null;}createRoot(document.getElementById('root')).render(React.createElement(App));
 `,
  );
  const { script } = await browserFixtureBundle(entry);
  let status = 200,
    holdNext = false,
    aborted = 0;
  const requests = [];
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (path === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
      return;
    }
    if (!path.endsWith("/settings")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    requests.push({ path, method: req.method });
    const code = status,
      body = JSON.stringify(
        code === 200
          ? SessionControls.parse(controls)
          : { error: "Settings unavailable" },
      );
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body);
    };
    res.on("close", () => {
      if (!res.writableEnded) aborted++;
    });
    if (holdNext) {
      holdNext = false;
      held.push(send);
    } else send();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page
    .getByRole("button", { name: "Session settings", exact: true })
    .click();
  const sheet = page.getByRole("dialog", {
      name: "Session settings",
      exact: true,
    }),
    mode = sheet.getByLabel("Mode", { exact: true });
  await expect(mode).toHaveValue("Current");
  const refresh = async () => {
    const response = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith("/settings"),
    );
    await page.evaluate(() => window.refresh());
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  };
  controls.settings = { revision: 2, options: [option("Older")] };
  await refresh();
  await expect(mode).toHaveValue("Current");
  controls.generation = nextGeneration;
  controls.settings = { revision: 1, options: [option("New generation")] };
  await refresh();
  await expect(mode).toHaveValue("New generation");
  status = 404;
  await refresh();
  await expect(mode).toHaveValue("Recorded");
  await expect(mode).toBeDisabled();
  await expect(sheet).toContainText("Recorded session settings.");
  status = 200;
  controls.settings = { revision: 3, options: [option("Restored")] };
  await refresh();
  await expect(mode).toHaveValue("Restored");
  await page.evaluate(() => window.matching(false));
  status = 404;
  await refresh();
  await expect(sheet.getByRole("alert")).toContainText("Settings unavailable");
  await expect(mode).toHaveValue("Restored");
  await expect(mode).toBeDisabled();
  status = 200;
  await refresh();
  await expect(sheet.getByRole("alert")).toHaveCount(0);
  for (const transition of ["thread", "source", "owner"]) {
    holdNext = true;
    await page.evaluate(() => window.refresh());
    await expect.poll(() => held.length).toBe(1);
    const old = aborted;
    await page.evaluate(
      (kind) =>
        window[kind](
          kind === "source"
            ? "peer:other"
            : kind === "owner"
              ? "bob"
              : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ),
      transition,
    );
    await expect.poll(() => aborted).toBe(old + 1);
    held.shift()();
    await expect(mode).toHaveValue("Restored");
  }
  assert(requests.some((r) => r.path.includes("agent-sources/peer%3Aother/")));
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  const beforeClose = aborted;
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => aborted).toBe(beforeClose + 1);
  held.shift()();
  await page
    .getByRole("button", { name: "Session settings", exact: true })
    .click();
  await expect(mode).toHaveValue("Restored");
  holdNext = true;
  await page.evaluate(() => window.refresh());
  await expect.poll(() => held.length).toBe(1);
  const beforeUnmount = aborted;
  await page.evaluate(() => window.shown(false));
  await expect.poll(() => aborted).toBe(beforeUnmount + 1);
  held.shift()();
  assert(requests.every((r) => r.method === "GET"));
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": session controls preserve revision/generation and recorded history, reject mismatched snapshots, abort obsolete scoped/closed reads, and dispatch no commands: passed",
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
