import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-pi-configuration-"));
let browser, server;
const held = [],
  requests = [],
  aborted = [];
let hold = false,
  fail = false;
let revision = 0;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {PiCustomizations} from ${JSON.stringify(resolve("src/client/PiCustomizations.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {SourceProvider} from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import {workspaceCapabilities} from ${JSON.stringify(resolve("src/shared/capabilities.ts"))};
    setShellSource("");
    const root = createRoot(document.getElementById("root"));
    window.show = (owner="alice", source="", shown=true) => flushSync(() => {
      ownerSession.change(owner);
      root.render(shown ? React.createElement(SourceProvider,{sourceId:source,capabilities:workspaceCapabilities()},React.createElement(PiCustomizations,{agents:[{id:"agent-a",name:"Agent A",provider:"pi"},{id:"agent-b",name:"Agent B",provider:"pi"}],onClose:()=>{}})):null);
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
    if (
      url.pathname.endsWith("/pi-packages") ||
      url.pathname.endsWith("/pi-trust")
    ) {
      const mutation = req.method === "POST";
      if (mutation) revision++;
      const path = url.pathname.replace(/pi-trust$/, "pi-packages");
      const body = {
        project: `Configuration ${path} revision${revision}`,
        trust: {
          required: true,
          trusted: mutation,
          decision: mutation ? "trusted" : "none",
          fingerprint: "a".repeat(64),
          paths: [],
        },
        packages: [],
        instructions: [],
        ...(mutation
          ? { status: "configured", application: "new-session" }
          : {}),
      };
      const status = fail && !mutation ? 503 : 200;
      requests.push({ path, mutation });
      res.on("close", () => {
        if (!res.writableEnded) aborted.push(path);
      });
      const send = () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            status === 200 ? body : { error: "Configuration unavailable" },
          ),
        );
      };
      if (hold && !mutation) held.push(send);
      else send();
      return;
    }
    if (url.pathname.endsWith("/harness")) {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          available: false,
          commands: [],
          message: "Catalog unavailable on fixture",
        }),
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const configuration = page.getByRole("region", { name: "Project trust" });
  await expect(configuration).toContainText("agent-a/pi-packages revision0");
  hold = true;
  await page.getByRole("button", { name: "Refresh from machine" }).click();
  await expect.poll(() => held.length).toBe(1);
  await page
    .getByRole("button", { name: "Trust project", exact: true })
    .click();
  await expect(configuration).toContainText("revision1");
  await expect.poll(() => aborted.length).toBe(1);
  await expect.poll(() => held.length).toBe(2);
  hold = false;
  held.splice(0).forEach((send) => send());
  await expect(configuration).toContainText("revision1");
  hold = true;
  await page.getByRole("button", { name: "Refresh from machine" }).click();
  await expect.poll(() => held.length).toBe(1);
  const beforeSelection = aborted.length;
  await page.getByRole("combobox").selectOption("agent-b");
  await expect.poll(() => aborted.length).toBe(beforeSelection + 1);
  await expect(configuration).toHaveCount(0);
  await expect.poll(() => held.length).toBe(2);
  hold = false;
  held.splice(0).forEach((send) => send());
  await expect(configuration).toContainText("agent-b/pi-packages revision1");
  fail = true;
  await page.getByRole("button", { name: "Refresh from machine" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Configuration unavailable",
  );
  await expect(configuration).toContainText("agent-b/pi-packages revision1");
  fail = false;
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  hold = true;
  await page.getByRole("button", { name: "Refresh from machine" }).click();
  await expect.poll(() => held.length).toBe(1);
  const beforeUnmount = aborted.length;
  await page.evaluate(() => window.show("alice", "", false));
  await expect.poll(() => aborted.length).toBe(beforeUnmount + 1);
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: Pi configuration mutation authority, selection/unmount cancellation, retained failure and retry passed (HTTP fixture)`,
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
