import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-search-preferences-"));
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
    import {SearchSettings} from ${JSON.stringify(resolve("src/client/Workspace.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const [revision,setRevision]=useState(0),[closed,setClosed]=useState(0);
      window.source=value=>flushSync(()=>{setShellSource(value);setRevision(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);setRevision(n=>n+1)});
      return React.createElement(React.Fragment,null,
        React.createElement(SearchSettings,{connections:[{id:'10000000-0000-4000-8000-000000000001',provider:'openai',status:'connected',label:'Fixture account'}],onClose:()=>setClosed(n=>n+1)}),
        React.createElement('output',{id:'closed'},closed));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let storedConnection = null;
  let enabled = 0,
    failure = false,
    holdNext = false,
    writeFailure = false,
    reads = 0;
  const writes = [];
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
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
    if (path.endsWith("/search/status")) {
      send(200, {
        enabled: false,
        state: "disabled",
        total: 0,
        indexed: 0,
        pending: 0,
        detail: null,
      });
      return;
    }
    if (path.endsWith("/preferences")) {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        writes.push(JSON.parse(body));
        send(
          writeFailure ? 500 : 200,
          writeFailure
            ? { error: "Preference write unavailable" }
            : { ok: true },
        );
        return;
      }
      reads++;
      const status = failure ? 503 : 200,
        body = failure
          ? { error: "Preferences unavailable" }
          : {
              embedding_enabled: enabled,
              embedding_connection: storedConnection,
            };
      const reply = () => send(status, body);
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
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : ["initial", "explicit-off", "recovery", "scope"]) {
    enabled = scenario === "explicit-off" ? 1 : 0;
    storedConnection =
      scenario === "initial" ||
      scenario === "late-edit" ||
      scenario === "explicit-off"
        ? "10000000-0000-4000-8000-000000000001"
        : null;
    failure = scenario === "recovery";
    holdNext =
      scenario === "initial" ||
      scenario === "late-edit" ||
      scenario === "explicit-off";
    writeFailure = false;
    reads = 0;
    writes.length = 0;
    const context = await browser.newContext(),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const toggle = page.getByRole("checkbox", {
        name: "Enable semantic search",
      }),
      save = page.getByRole("button", { name: "Save preference", exact: true });
    const refresh = (source) =>
      page.evaluate(
        (source) =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: [source] },
            }),
          ),
        source,
      );
    try {
      if (scenario === "recovery") await page.clock.install();
      await page.goto("http://127.0.0.1:" + server.address().port);
      if (
        scenario === "initial" ||
        scenario === "late-edit" ||
        scenario === "explicit-off"
      ) {
        await expect.poll(() => held.length).toBe(1);
        if (scenario === "initial") await expect(save).toBeDisabled();
        await toggle.check();
        if (scenario === "explicit-off") {
          await page.getByRole("combobox").selectOption("");
          await toggle.uncheck();
        }
        const response = page.waitForResponse(
          (r) =>
            r.url().endsWith("/preferences") && r.request().method() === "GET",
        );
        held.shift()();
        await response;
        await page.waitForTimeout(100);
        await expect(save).toBeEnabled();
        if (scenario === "explicit-off") {
          await expect(toggle).not.toBeChecked();
        } else {
          await expect(toggle).toBeChecked();
          await expect(page.getByRole("combobox")).toHaveValue(
            "10000000-0000-4000-8000-000000000001",
          );
        }
        await save.click();
        await expect(page.locator("#closed")).toHaveText("1");
        assert.equal(writes[0].embeddingEnabled, scenario !== "explicit-off");
        assert.equal(
          writes[0].connectionId,
          scenario === "explicit-off"
            ? null
            : "10000000-0000-4000-8000-000000000001",
        );
      } else if (scenario === "recovery") {
        await expect.poll(() => reads).toBe(1);
        await page.clock.fastForward(2100);
        await expect.poll(() => reads).toBe(2);
        await page.clock.fastForward(4100);
        await expect.poll(() => reads).toBe(3);
        await expect(page.getByRole("alert")).toContainText(
          "Preferences unavailable",
        );
        await expect(save).toBeDisabled();
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect.poll(() => reads).toBe(4);
        await page.clock.runFor(20);
        assert.equal(reads, 4);
        failure = false;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(save).toBeEnabled();
        await toggle.check();
        await page
          .getByRole("combobox")
          .selectOption("10000000-0000-4000-8000-000000000001");
        await refresh("");
        await expect.poll(() => reads).toBe(6);
        await page.clock.runFor(20);
        await expect(toggle).toBeChecked();
        await expect(page.getByRole("combobox")).toHaveValue(
          "10000000-0000-4000-8000-000000000001",
        );
        writeFailure = true;
        await save.click();
        await expect(page.getByRole("alert")).toContainText(
          "Preference write unavailable",
        );
        await refresh("");
        await expect.poll(() => reads).toBe(7);
        await page.clock.runFor(20);
        await expect(page.getByRole("alert")).toContainText(
          "Preference write unavailable",
        );
        writeFailure = false;
        await save.click();
        await expect(page.locator("#closed")).toHaveText("1");
        assert.equal(writes.at(-1).embeddingEnabled, true);
        assert.equal(
          writes.at(-1).connectionId,
          "10000000-0000-4000-8000-000000000001",
        );
      } else {
        await expect(save).toBeEnabled();
        let source = "";
        for (const [kind, value] of [
          ["source", "docker:other"],
          ["owner", "bob"],
          ["owner", "alice"],
        ]) {
          await toggle.check();
          enabled = 1;
          holdNext = true;
          await refresh(source);
          await expect.poll(() => held.length).toBe(1);
          enabled = 0;
          holdNext = true;
          await page.evaluate(
            ([kind, value]) => window[kind](value),
            [kind, value],
          );
          if (kind === "source") source = value;
          await expect.poll(() => held.length).toBe(2);
          await expect(save).toBeDisabled();
          held.pop()();
          await expect(save).toBeEnabled();
          await expect(toggle).not.toBeChecked();
          held.shift()();
          await page.waitForTimeout(100);
          await expect(toggle).not.toBeChecked();
        }
      }
      assert.deepEqual(errors, []);
      console.log(engine + " Search preferences passed: " + scenario);
    } finally {
      held.splice(0).forEach((send) => send());
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
