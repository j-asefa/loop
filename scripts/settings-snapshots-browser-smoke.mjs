import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-settings-snapshots-"));
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
    import {McpCatalog} from ${JSON.stringify(resolve("src/client/McpCatalog.tsx"))};
    import {Tools} from ${JSON.stringify(resolve("src/client/Tools.tsx"))};
    import {PairedDevices} from ${JSON.stringify(resolve("src/client/PairedDevices.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function App(){
      const [mode,setMode]=useState('catalog'),[,render]=useState(0);
      window.mode=value=>flushSync(()=>setMode(value));
      window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
      window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
      window.refresh=()=>window.dispatchEvent(new CustomEvent('loop-workspace-change'));
      return mode==='tools'?React.createElement(Tools,{initialView:'permissions',onClose:()=>{}}):mode==='devices'?React.createElement(PairedDevices,{onClose:()=>{}}):React.createElement(McpCatalog,{connections:[],onInstalled:async()=>{}});
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let label = "First",
    failCatalog = false,
    failDevices = false,
    hold = "",
    nativeProcesses = 3,
    devicePresent = true;
  let preferences = { approvalMode: "ask", agentPermissionMode: "default" };
  const requests = [];
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
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
    const kind = path.endsWith("/catalog")
      ? "catalog"
      : path.endsWith("/preferences")
        ? "preferences"
        : path.endsWith("/devices")
          ? "devices"
          : path.endsWith("/workspace")
            ? "workspace"
            : path.endsWith("/revoke")
              ? "revoke"
              : "empty";
    requests.push({ kind, path, method: req.method });
    if (req.method === "PUT") {
      let body = "";
      for await (const data of req) body += data;
      preferences = { ...preferences, ...JSON.parse(body) };
    }
    if (kind === "revoke") devicePresent = false;
    const failure =
      (kind === "catalog" && failCatalog) ||
      (kind === "devices" && failDevices);
    const body = failure
      ? {
          error:
            kind === "catalog" ? "Catalog unavailable" : "Devices unavailable",
        }
      : kind === "catalog"
        ? {
            entries: [
              {
                id: "fixture",
                name: "Catalog " + label,
                description: "Fixture catalog entry",
                publisher: "Fixture",
                category: "Development",
                auth: "none",
                inputs: [],
                transport: "http",
                source: "https://fixture.invalid",
              },
            ],
            reviewedAt: "2026-11-14",
            oauthRedirectUrl: "https://fixture.invalid/oauth",
          }
        : kind === "preferences"
          ? { ...preferences, ...(req.method === "PUT" ? { resumed: 0 } : {}) }
          : kind === "workspace"
            ? {
                harnesses: [],
                nativeProcesses,
                concurrency: 4,
                hostLifetime: "foreground",
                tunnelOrigin: "",
                projectPaths: [],
              }
            : kind === "devices"
              ? devicePresent
                ? [
                    {
                      id: "device",
                      name: "Device " + label,
                      expires: Date.now() + 100000,
                    },
                  ]
                : []
              : kind === "revoke"
                ? { ok: true }
                : [];
    const reply = () => {
      res.writeHead(failure ? 503 : 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(body));
    };
    if (hold === kind && req.method === "GET") {
      hold = "";
      held.push(reply);
    } else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const scenarios = ["catalog", "preferences", "devices"],
    selected = process.argv[2];
  assert(!selected || scenarios.includes(selected));
  for (const scenario of selected ? [selected] : scenarios) {
    label = "First";
    preferences = { approvalMode: "ask", agentPermissionMode: "default" };
    devicePresent = true;
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    await expect(
      page.getByRole("article", { name: "Catalog First", exact: true }),
    ).toBeVisible();
    if (scenario === "catalog") {
      failCatalog = true;
      await page.evaluate(() => window.refresh());
      await expect(page.getByRole("alert")).toContainText(
        "Catalog unavailable",
        { timeout: 15000 },
      );
      await expect(
        page.getByRole("article", { name: "Catalog First", exact: true }),
      ).toBeVisible();
      const before = requests.filter((r) => r.kind === "catalog").length;
      await page.getByRole("button", { name: "Retry loading catalog" }).click();
      await expect(
        page.getByRole("button", { name: "Retry loading catalog" }),
      ).toBeEnabled();
      assert.equal(
        requests.filter((r) => r.kind === "catalog").length,
        before + 1,
      );
      failCatalog = false;
      label = "Recovered";
      await page.getByRole("button", { name: "Retry loading catalog" }).click();
      await expect(
        page.getByRole("article", { name: "Catalog Recovered", exact: true }),
      ).toBeVisible();
      for (const kind of ["source", "owner"]) {
        hold = "catalog";
        await page.evaluate(() => window.refresh());
        await expect.poll(() => held.length).toBe(1);
        label = "Current " + kind;
        await page.evaluate(
          (k) => window[k](k === "source" ? "peer:other" : "bob"),
          kind,
        );
        await expect(
          page.getByRole("article", { name: "Catalog " + label, exact: true }),
        ).toBeVisible();
        held.splice(0).forEach((reply) => reply());
        await page.waitForTimeout(50);
        await expect(
          page.getByRole("article", { name: "Catalog " + label, exact: true }),
        ).toBeVisible();
      }
    } else if (scenario === "preferences") {
      await page.evaluate(() => window.mode("tools"));
      const approvals = page.getByLabel("Tool approvals", { exact: true });
      await expect(approvals).toBeEnabled();
      hold = "preferences";
      await page.evaluate(() => window.refresh());
      await expect.poll(() => held.length).toBe(1);
      await approvals.selectOption("allow");
      await expect(approvals).toHaveValue("allow");
      await expect(approvals).toBeEnabled();
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(approvals).toHaveValue("allow");
      assert(
        requests.some((r) => r.kind === "preferences" && r.method === "PUT"),
      );
      preferences = { approvalMode: "ask", agentPermissionMode: "acceptEdits" };
      await page.evaluate(() => window.source("peer:other"));
      await expect(approvals).toHaveValue("ask");
      await expect(
        page.getByLabel("Agent tool calls", { exact: true }),
      ).toHaveValue("acceptEdits");
    } else {
      await page.evaluate(() => window.mode("devices"));
      await expect(
        page.getByText("Device First", { exact: true }),
      ).toBeVisible();
      failDevices = true;
      await page.evaluate(() => window.refresh());
      const notice = page
        .getByRole("alert")
        .filter({ hasText: "Devices unavailable" });
      await expect(notice).toBeVisible({ timeout: 15000 });
      await expect(
        page.getByText("Device First", { exact: true }),
      ).toBeVisible();
      nativeProcesses = 8;
      await page.evaluate(() => window.refresh());
      await expect(page.getByText(/8 native processes/)).toBeVisible();
      await expect(notice).toBeVisible();
      await expect(notice.getByRole("button")).toBeEnabled({ timeout: 15000 });
      failDevices = false;
      await notice.getByRole("button").click();
      await expect(notice).toHaveCount(0);
      hold = "devices";
      await page.evaluate(() => window.refresh());
      await expect.poll(() => held.length).toBe(1);
      await page.getByRole("button", { name: "Revoke device" }).click();
      await expect(page.getByText("Device First", { exact: true })).toHaveCount(
        0,
      );
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(page.getByText("Device First", { exact: true })).toHaveCount(
        0,
      );
      assert(requests.some((r) => r.kind === "revoke" && r.method === "POST"));
    }
    console.log(engine + " settings-snapshots " + scenario + ": passed");
    await page.close();
  }
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
