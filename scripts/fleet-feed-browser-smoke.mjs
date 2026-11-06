// Production source-loading and composer-lifetime hooks in real browsers with
// isolated HTTP fixtures. This measures browser scheduling, not live tunnels.
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { workspaceCapabilities } from "../src/shared/capabilities.ts";

const dir = await mkdtemp(join(tmpdir(), "loop-fleet-feed-"));
const sources = Array.from({ length: 9 }, (_, index) => ({
  id: "peer:m_" + String(index + 1).repeat(64),
  name: `Machine ${index}`,
  kind: "peer",
}));
let browser,
  server,
  hold = true,
  fixtureOwner = "alice",
  mode = "sources";
const pending = new Set();
const feedTemplate = JSON.parse(
  await readFile("test/snapshots/feed/feed-working-none.json", "utf8"),
).body.items[0];
const needsTemplate = JSON.parse(
  await readFile("test/snapshots/feed/feed-needs-none.json", "utf8"),
).body.items[0];
const feedMetrics = { requests: 0, responseBodyBytes: 0, active: 0, peak: 0 };
const needsMetrics = { requests: 0, active: 0, peak: 0 };
let needsRevision = 0;
let feedFailSlow = false;
let metadataRevision = 0;
const metadataMetrics = { requests: 0, active: 0, peak: 0 };
function trackResponse(metrics, res) {
  metrics.requests++;
  metrics.active++;
  metrics.peak = Math.max(metrics.peak, metrics.active);
  let completed = false;
  const done = () => {
    if (!completed) {
      completed = true;
      metrics.active--;
    }
  };
  res.once("close", done);
  res.once("finish", done);
}
const engineName =
  process.env.LOOP_BROWSER === "webkit" ? "webkit" : "chromium";
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import ${JSON.stringify(resolve("src/client/style.css"))};
    import ${JSON.stringify(resolve("src/client/design.css"))};
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import { useAgentSources } from ${JSON.stringify(resolve("src/client/agentSources.ts"))};
    import { useAppController } from ${JSON.stringify(resolve("src/client/app/AppController.tsx"))};
    import { Feed } from ${JSON.stringify(resolve("src/client/Feed.tsx"))};
    import { loadCapabilities } from ${JSON.stringify(resolve("src/client/capabilities.ts"))};
    import { setViewOwner } from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import { setShellSource } from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    await loadCapabilities();
    const root = createRoot(document.getElementById("root"));
    const empty = {agents:[],connections:[],folders:[],runs:[]};
    function Sources({owner}) {
      setViewOwner(owner);
      const value = useAgentSources(owner, empty);
      window.snapshot = value;
      return React.createElement("output",null,value.agents.map(agent=>agent.name).join(","));
    }
    let revision = 0;
    function AppProbe() {
      const model = useAppController(); window.model = model;
      return React.createElement("output",null,JSON.stringify({owner:model.session?.user?.id,selected:model.selected,share:model.sharedDraft,context:model.replyContext,folder:model.folderChoice}));
    }
    window.showSources = owner => root.render(React.createElement(Sources,{owner}));
    window.showFeed = () => {
      setViewOwner("measured-feed");setShellSource("");
      root.render(React.createElement(Feed,{filter:"working",onFilter:()=>{},revision:0,agents:[],sources:${JSON.stringify(sources)},onOpen:()=>{},onAgent:()=>{},onChanged:()=>{}}));
    };
    window.showNeeds = () => {
      setViewOwner("measured-needs");setShellSource("");
      root.render(React.createElement(Feed,{key:"needs-probe",filter:"working",onFilter:()=>{},revision:0,agents:[],sources:${JSON.stringify(sources)},onOpen:()=>{},onAgent:()=>{},onChanged:()=>{}}));
    };
    window.showApp = (source="") => {setShellSource(source);root.render(React.createElement(AppProbe,{revision:++revision}));};
    window.showSources("alice");
  `,
  );
  const { script, style: bundledStyle } = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    const reply = (body, status = 200, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (url.pathname === "/client.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(bundledStyle);
      return;
    }
    if (url.pathname === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
      return;
    }
    if (url.pathname === "/session") {
      reply({ csrf: "fixture-only" });
      return;
    }
    if (url.pathname === "/api/agent-sources") {
      reply(mode === "sources" ? sources : []);
      return;
    }
    const match = /^\/api\/agent-sources\/([^/]+)\/(.+)$/.exec(url.pathname);
    const path = match ? match[2] : url.pathname.replace(/^\/api\//, "");
    const source =
      match && sources.find((item) => item.id === decodeURIComponent(match[1]));
    const owner = fixtureOwner;
    const waitForSource = async () => {
      if (hold && source.id === sources[0].id) {
        await new Promise((resolve) => {
          pending.add(resolve);
          res.once("close", () => {
            pending.delete(resolve);
            resolve();
          });
        });
      } else await new Promise((resolve) => setTimeout(resolve, 20));
    };
    if (
      source &&
      mode === "sources" &&
      ["bootstrap", "runs", "capabilities"].includes(path)
    ) {
      trackResponse(metadataMetrics, res);
      await waitForSource();
    }
    if (path === "capabilities") {
      reply(workspaceCapabilities());
      return;
    }
    if (path === "auth/get-session") {
      reply({ user: { id: owner, name: owner }, mode: "paired" });
      return;
    }
    if (path === "bootstrap") {
      reply({
        agents:
          mode === "sources" && source
            ? [
                {
                  id: "same-agent",
                  owner_id: owner,
                  name: `${owner}-${source.name}${metadataRevision ? "-updated" : ""}`,
                  provider: "openai",
                  model: "fixture",
                  instructions: "",
                  connection_id: null,
                  folder_id: null,
                  origin: "direct",
                  retired_at: null,
                  created_at: 1,
                },
              ]
            : [],
        connections: [],
        folders: [],
        teams: [],
      });
      return;
    }
    if (path === "runs" || path === "events") {
      reply([]);
      return;
    }
    if (path === "feed") {
      if (
        mode === "needs" &&
        source &&
        url.searchParams.get("filter") === "needs"
      ) {
        trackResponse(needsMetrics, res);
        await waitForSource();
        reply({
          items: [
            {
              ...needsTemplate,
              title: `Needs ${source.name}${needsRevision ? " updated" : ""}`,
            },
          ],
          next: null,
          summary: { needs: 1, working: 1, queued: 0, later_due: 0 },
        });
        return;
      }
      if (
        mode === "feed" &&
        source &&
        url.searchParams.get("filter") === "working"
      ) {
        trackResponse(feedMetrics, res);
        await waitForSource();
        if (res.destroyed) return;
        if (feedFailSlow && source.id === sources[0].id) {
          reply({ error: "Synthetic source unavailable" }, 503, {
            "retry-after": "1",
          });
          return;
        }
        const body = {
          items: [
            {
              ...feedTemplate,
              conversation_id: "same-conversation",
              title: "Measured " + source.name,
              last_activity_at: Date.now(),
              queued_runs: [],
            },
          ],
          next: null,
          summary: { needs: 0, working: 1, queued: 0, later_due: 0 },
        };
        feedMetrics.responseBodyBytes += Buffer.byteLength(
          JSON.stringify(body),
        );
        reply(body);
        return;
      }
      reply({
        items: [],
        next: null,
        summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
      });
      return;
    }
    reply({ error: "Fixture route unavailable" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (engineName === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(engineName === "chromium" ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const began = Date.now();
  await page.goto(origin);
  await expect
    .poll(() => page.evaluate(() => window.snapshot?.agents.length ?? 0))
    .toBe(8);
  const useful = Date.now() - began;
  assert(
    hold && pending.size > 0,
    "Healthy metadata must publish before the slow source settles",
  );
  assert(
    metadataMetrics.peak <= 12,
    `Four source workers exceeded twelve HTTP requests: ${metadataMetrics.peak}`,
  );
  const initialRequests = metadataMetrics.requests;
  metadataRevision++;
  await page.evaluate(
    (source) =>
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [source] },
        }),
      ),
    sources[1].id,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (source) =>
          window.snapshot?.agents.find((agent) => agent.sourceId === source)
            ?.name,
        sources[1].id,
      ),
    )
    .toBe("alice-Machine 1-updated");
  assert(
    hold && pending.size > 0,
    "A healthy source's metadata update must not wait for the held source",
  );
  assert(
    metadataMetrics.peak <= 12,
    "Metadata invalidations must share the four-worker budget",
  );
  fixtureOwner = "bob";
  await page.evaluate(() => window.showSources("bob"));
  await expect
    .poll(() => page.evaluate(() => window.snapshot?.agents.length ?? 0))
    .toBe(8);
  hold = false;
  for (const release of pending) release();
  pending.clear();
  await expect
    .poll(() => page.evaluate(() => window.snapshot?.agents.length ?? 0))
    .toBe(9);
  assert(
    (await page.evaluate(() => window.snapshot.agents)).every((agent) =>
      agent.name.startsWith("bob-"),
    ),
    "Late reads must stay with their original owner",
  );
  console.log(
    `PASS ${engineName} partial metadata: first eight sources ${useful}ms while one held; initial ${initialRequests} requests; peak ${metadataMetrics.peak} concurrent requests`,
  );
  console.log(
    "FLEET_METRIC " +
      JSON.stringify({
        boundary:
          "production source metadata loader in browser with synthetic HTTP",
        engine: engineName,
        sourceCount: sources.length,
        heldSources: 1,
        firstHealthySourcesMs: useful,
        initialRequests,
        peakRequests: metadataMetrics.peak,
      }),
  );

  mode = "feed";
  hold = true;
  const feedStart = performance.now();
  await page.evaluate(() => window.showFeed());
  await page
    .locator(".inbox-results .inbox-row")
    .first()
    .waitFor({ state: "visible" });
  const firstUsefulFeedMs = Math.round(performance.now() - feedStart);
  await expect(page.locator(".inbox-results .inbox-row")).toHaveCount(8);
  assert(
    pending.size > 0,
    "Healthy Feed rows must render while the slow source remains pending",
  );
  const allHealthySourcesMs = Math.round(performance.now() - feedStart);
  const beforeIdle = feedMetrics.requests;
  await page.waitForTimeout(2000);
  const idleRequests = feedMetrics.requests - beforeIdle;
  feedFailSlow = true;
  hold = false;
  for (const release of pending) release();
  pending.clear();
  const failedAt = performance.now();
  await expect(
    page.getByText(
      "Some environments could not refresh. Showing their last loaded threads.",
    ),
  ).toBeVisible();
  await expect(page.locator(".inbox-results .inbox-row")).toHaveCount(8);
  assert(
    feedMetrics.peak <= 4,
    "Feed reads must retain the production four-source concurrency bound",
  );
  console.log(
    "FLEET_METRIC " +
      JSON.stringify({
        boundary:
          "production combined Feed in browser with nine synthetic HTTP sources",
        engine: engineName,
        sourceCount: sources.length,
        firstUsefulFeedMs,
        allHealthySourcesMs,
        heldSourceReleasedAs: 503,
        partialFailureVisibleMs: Math.round(performance.now() - failedAt),
        idleIntervalMs: 2000,
        idleRequests,
        ...feedMetrics,
        limitations:
          "A held response followed by HTTP 503 is an injected failure, not a measured Internet timeout; counts cover Feed reads only.",
      }),
  );

  mode = "needs";
  hold = true;
  await page.evaluate(() => window.showNeeds());
  await expect(page.locator(".needs-stack .inbox-row")).toHaveCount(8);
  await expect(page.locator('[data-filter="working"] .chip-count')).toHaveText(
    "8",
  );
  assert(
    pending.size > 0,
    "Needs you must show healthy sources while one remains held",
  );
  needsRevision++;
  await page.evaluate(
    (source) =>
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [source] },
        }),
      ),
    sources[1].id,
  );
  await expect(
    page
      .locator(".needs-stack")
      .getByText("Needs Machine 1 updated", { exact: true }),
  ).toHaveCount(1);
  assert(
    pending.size > 0,
    "A healthy approval update must not wait for another source",
  );
  assert(
    needsMetrics.peak <= 4,
    `Needs reads exceeded the shared four-source budget: ${needsMetrics.peak}`,
  );
  hold = false;
  for (const release of pending) release();
  pending.clear();
  await expect(page.locator(".needs-stack .inbox-row")).toHaveCount(9);
  await expect(page.locator('[data-filter="working"] .chip-count')).toHaveText(
    "9",
  );
  console.log(
    `PASS ${engineName} independent Needs you and operational counters: ${needsMetrics.requests} requests, peak ${needsMetrics.peak}`,
  );

  mode = "app";
  fixtureOwner = "alice";
  await page.evaluate(() => {
    for (const prefix of ["loop"]) {
      sessionStorage.setItem(`${prefix}-draft-agent`, "foreign-agent");
      sessionStorage.setItem(
        `${prefix}-draft-context`,
        JSON.stringify({
          agentId: "foreign-agent",
          conversationId: "foreign-thread",
          content: "foreign private context",
        }),
      );
      sessionStorage.setItem(
        `${prefix}-share`,
        JSON.stringify({ excerpt: "foreign private share" }),
      );
    }
    window.showApp();
  });
  await expect
    .poll(() => page.evaluate(() => window.model?.session?.user?.id))
    .toBe("alice");
  await expect.poll(() => page.evaluate(() => window.model?.selected)).toBe("");
  assert.equal(await page.evaluate(() => window.model.sharedDraft.excerpt), "");
  await page.evaluate(() => {
    window.model.setSelected("same-agent");
    window.model.setReplyContext({
      agentId: "same-agent",
      conversationId: "private-thread",
      content: "Alice local context",
    });
    window.model.setFolderChoice("alice-local-folder");
    window.model.setSharedDraft({
      url: "",
      title: "",
      excerpt: "Alice local share",
      question: "",
      folderId: "alice-local-folder",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(sessionStorage).some((value) =>
          value.includes("Alice local share"),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate((source) => window.showApp(source), sources[0].id);
  await expect
    .poll(() => page.evaluate(() => window.model.sharedDraft.excerpt))
    .toBe("");
  assert.equal(await page.evaluate(() => window.model.replyContext), null);
  assert.equal(await page.evaluate(() => window.model.folderChoice), undefined);
  await page.evaluate(() =>
    window.model.setSharedDraft({
      url: "",
      title: "",
      excerpt: "Alice remote share",
      question: "",
      folderId: "",
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(sessionStorage).some((value) =>
          value.includes("Alice remote share"),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.model.setSession({
      user: { id: "bob", name: "Bob" },
      mode: "paired",
    }),
  );
  await expect
    .poll(() => page.evaluate(() => window.model.sharedDraft.excerpt))
    .toBe("");
  await page.evaluate(() =>
    window.model.setSession({
      user: { id: "alice", name: "Alice" },
      mode: "paired",
    }),
  );
  await expect
    .poll(() => page.evaluate(() => window.model.sharedDraft.excerpt))
    .toBe("Alice remote share");
  await page.evaluate(() => window.showApp(""));
  await expect
    .poll(() => page.evaluate(() => window.model.sharedDraft.excerpt))
    .toBe("Alice local share");
  assert.equal(
    await page.evaluate(() => window.model.replyContext?.content),
    "Alice local context",
  );
  assert.equal(
    await page.evaluate(() => window.model.folderChoice),
    "alice-local-folder",
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${engineName} actual app draft hydration isolates owners and sources, restores returning drafts and ignores unattributed legacy keys`,
  );
} finally {
  for (const release of pending) release();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
