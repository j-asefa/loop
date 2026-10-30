import "../runtime/environment.mjs";
// Real trace controls and typed browser transport against isolated HTTP fixtures.
// No provider, user data or fleet credential is used by this browser regression.
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop55-fleet-traces-"));
const engine = process.env.LOOP55_BROWSER === "webkit" ? webkit : chromium;
const peerA = "peer:m_" + "1".repeat(64),
  peerB = "peer:m_" + "2".repeat(64);
const calls = [];
let browser, server, held, release;
const trace = (source, id = 2) => ({
  id,
  owner_id: "fixture-owner",
  run_id: "same-run",
  kind: "tool",
  title: (source === peerA ? "Source A" : "Source B") + " trace " + id,
  content: "Fixture content",
  metadata: "{}",
  artifact_id: "same-artifact",
  created_at: 1,
  input: "Fixture run",
  run_state: "completed",
  conversation_id: "same-thread",
});
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import { SourceProvider } from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import { Traces } from ${JSON.stringify(resolve("src/client/Traces.tsx"))};
    import { setViewOwner } from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import { setShellSource } from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    // The shell deliberately disagrees with the opened panel.
    setShellSource(${JSON.stringify(peerB)});
    const root = createRoot(document.getElementById("root"));
    window.artifacts = []; window.downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (this.download) { window.downloads.push(this.download); return; }
      return click.call(this);
    };
    const text = Blob.prototype.text;
    Blob.prototype.text = async function() {
      const value = await text.call(this);
      if (value.includes("traceExportMarker") && window.holdText) {
        window.textWaiting = true;
        await new Promise(resolve => { window.releaseText = resolve; });
        window.textWaiting = false;
      }
      return value;
    };
    window.showTraces = (source=${JSON.stringify(peerA)}, owner="fixture-owner", files=true) => {
      setViewOwner(owner);
      root.render(React.createElement(SourceProvider,{sourceId:source,capabilities:{
        profile:"companion",nativeHarnesses:true,pairedDevices:false,runtimeHosts:false,localProjects:true,
        fleet:{version:1,machineId:source.slice(5),reads:["agentTraces","artifactDetail"],actions:[],files,events:false}
      }},React.createElement(Traces,{agentId:"same-agent",revision:0,onConversation:()=>{},onArtifact:artifact=>window.artifacts.push(artifact)})));
    };
    window.showTraces();
  `,
  );
  const { script, style: bundledStyle } = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const reply = (body) => {
      if (res.destroyed) return;
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><title>Isolated fleet traces</title><link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (req.url === "/client.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(bundledStyle);
      return;
    }
    if (req.url === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
      return;
    }
    const url = new URL(req.url, "http://fixture.invalid");
    const match = /^\/api\/agent-sources\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const source = decodeURIComponent(match[1]),
      path = match[2];
    calls.push({ source, path, before: url.searchParams.get("before") });
    if (
      (held === "artifact" && path === "artifacts/same-artifact") ||
      (held === "page" && url.searchParams.has("before"))
    )
      await new Promise((resolve) => {
        release = resolve;
      });
    if (path === "agents/same-agent/traces/export") {
      reply({ traceExportMarker: true, source });
      return;
    }
    if (path === "agents/same-agent/traces") {
      reply({
        items: [trace(source, url.searchParams.has("before") ? 1 : 2)],
        next: url.searchParams.has("before") ? null : 2,
      });
      return;
    }
    if (path === "artifacts/same-artifact") {
      reply({
        id: "same-artifact",
        owner_id: "fixture-owner",
        agent_id: "same-agent",
        conversation_id: "same-thread",
        run_id: "same-run",
        title: source,
        kind: "text",
        content: "Fixture result",
        metadata: "{}",
        folder_id: null,
        pinned: 0,
        archived: 0,
        version: 1,
        created_at: 1,
        updated_at: 1,
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const cards = page.locator(".trace-card");
  const result = page.getByRole("button", {
    name: "View tool result",
    exact: true,
  });
  const download = page.getByRole("button", {
    name: "Download run",
    exact: true,
  });
  await expect(cards).toHaveCount(1);
  await result.click();
  await expect
    .poll(() => page.evaluate(() => window.artifacts.map((a) => a.title)))
    .toEqual([peerA]);
  assert.equal(
    calls.at(-1).source,
    peerA,
    "An artifact must belong to the panel, even when the shell selects B",
  );
  await download.click();
  await expect
    .poll(() => page.evaluate(() => window.downloads))
    .toEqual(["loop55-run-same-run-traces.json"]);
  assert.equal(calls.at(-1).source, peerA);

  // The HTTP response has completed, but the asynchronous browser Blob read has
  // not. Sign-out must still prevent creating a download for that previous view.
  await page.evaluate(() => {
    window.holdText = true;
  });
  await download.click();
  await expect.poll(() => page.evaluate(() => window.textWaiting)).toBe(true);
  await expect(download).toBeDisabled();
  await page.evaluate(() => window.showTraces(undefined, "new-owner"));
  await expect(cards).toHaveCount(1);
  await page.evaluate(() => {
    window.holdText = false;
    window.releaseText();
  });
  await expect.poll(() => page.evaluate(() => window.textWaiting)).toBe(false);
  assert.equal(await page.evaluate(() => window.downloads.length), 1);

  held = "artifact";
  const artifactCount = calls.filter((c) =>
    c.path.startsWith("artifacts/"),
  ).length;
  await result.click();
  await expect
    .poll(() => calls.filter((c) => c.path.startsWith("artifacts/")).length)
    .toBe(artifactCount + 1);
  await page.evaluate(
    (source) => window.showTraces(source, "new-owner"),
    peerB,
  );
  await expect(cards).toContainText("Source B trace");
  release();
  held = undefined;
  await result.click();
  await expect
    .poll(() => page.evaluate(() => window.artifacts.map((a) => a.title)))
    .toEqual([peerA, peerB]);

  held = "page";
  await page
    .getByRole("button", { name: "Earlier traces", exact: true })
    .click();
  await expect.poll(() => calls.filter((c) => c.before).length).toBe(1);
  await page.evaluate(
    (source) => window.showTraces(source, "new-owner"),
    peerA,
  );
  await expect(cards).toContainText("Source A trace");
  release();
  held = undefined;
  await page
    .getByRole("button", { name: "Earlier traces", exact: true })
    .click();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Source A trace");
  await expect(cards.nth(1)).toContainText("Source A trace");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The same Blob delay also fences an ordinary source switch without sign-out.
  await page.evaluate(() => {
    window.holdText = true;
  });
  await download.click();
  await expect.poll(() => page.evaluate(() => window.textWaiting)).toBe(true);
  await page.evaluate(
    (source) => window.showTraces(source, "new-owner", false),
    peerB,
  );
  await expect(download).toBeDisabled();
  await expect(download).toHaveAttribute("title", /files are unavailable/);
  await expect(
    page.getByText(/files are unavailable through the fleet/),
  ).toBeVisible();
  await page.evaluate(() => {
    window.holdText = false;
    window.releaseText();
  });
  await expect.poll(() => page.evaluate(() => window.textWaiting)).toBe(false);
  assert.equal(await page.evaluate(() => window.downloads.length), 1);
  assert.deepEqual(errors, []);
  console.log(
    `PASS (${engine.name()}): trace pagination, artifact reads and run exports retain the panel source; owner/source changes fence pending responses and Blob reads; unavailable file capability disables exports. Deterministic browser/HTTP fixture.`,
  );
} finally {
  release?.();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
