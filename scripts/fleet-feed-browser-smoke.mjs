// Production source-loading and composer-lifetime hooks in real browsers with
// isolated HTTP fixtures. This measures browser scheduling, not live tunnels.
// The nine-source fixture holds one response while healthy sources render,
// then returns 503 and records request counts, bytes and partial-result timing;
// these describe the fixture workload, not Internet latency.
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { workspaceCapabilities } from "../src/shared/capabilities.ts";
import { CardEntrySchema } from "../src/shared/cards.ts";

const feedOnly = process.argv.includes("--feed-only");
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
const doneTemplate = JSON.parse(
  await readFile("test/snapshots/feed/feed-done-none.json", "utf8"),
).body.items[0];
const doneEntry = (n) =>
  CardEntrySchema.parse({
    card: {
      type: "done",
      id: "d:message:fixture-" + n,
      display: {
        ...doneTemplate,
        conversation_id: "done-" + n,
        done_card_key: "message:fixture-" + n,
        title: "Done fixture " + n,
        last_activity_at: n,
        run: null,
        next_action: null,
      },
      content: "Done fixture " + n,
      format: "markdown",
      created_at: n,
      updated_at: null,
      saved: false,
      attachments: [],
      href: "/",
      author: { kind: "unknown", id: null, name: null, provider: null },
      recipient: null,
      source: {
        agent_id: null,
        artifact_id: null,
        message_id: "fixture-" + n,
        conversation_id: "done-" + n,
        run_id: null,
      },
      context: {
        conversation_title: "Done fixture " + n,
        folder_id: null,
        project_id: null,
        project_name: null,
        team_id: null,
      },
    },
    order: [n, "fixture-" + n],
    saved: null,
  });
const donePageReads = [];
let holdDoneSummary = false,
  releaseDoneSummary;
const feedMetrics = { requests: 0, responseBodyBytes: 0, active: 0, peak: 0 };
const needsMetrics = { requests: 0, active: 0, peak: 0 };
let needsRevision = 0;
let feedFailSlow = false;
let feedRevision = 0;
let feedPageRows = [4, 3, 2, 1, 0];
let failPaginationHead = false,
  failPaginationAppend = false;
const paginationReads = [];
let feedPagination = false,
  holdOlder = false,
  releaseOlder;
let holdOlderBefore;
let failReplayCursor;
let headFailureStatus = 503;
let refusedAppendReads = 0;
let appendFailureSource;
const refusedAppendCursors = [];
let movingFeedHead = false;
let feedPageSize = 1,
  feedLabelSuffix = "",
  delayOlderMs = 0,
  delayedOlderReads = 0;
let allPaginated = false,
  queuedHeadChanged = false;
const holdFleetAppends = new Set();
const heldFleetAppends = new Map();
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
    import { setViewOwner, cacheView } from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
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
    window.evictFeedCache = () => {for(let i=0;i<60;i++)cacheView("eviction-"+i,{},"measured-feed");};
    window.showFeed = (owner="measured-feed",filter="working",includeSlow=true) => {
      setViewOwner(owner);setShellSource("");
      root.render(React.createElement(Feed,{filter,onFilter:()=>{},revision:0,agents:[],sources:${JSON.stringify(sources)}.filter((_,i)=>includeSlow||i!==0),onOpen:()=>{},onAgent:()=>{},onChanged:()=>{}}));
    };
    window.showNeeds = () => {
      setViewOwner("measured-needs");setShellSource("");
      root.render(React.createElement(Feed,{key:"needs-probe",filter:"working",onFilter:()=>{},revision:0,agents:[],sources:${JSON.stringify(sources)},onOpen:()=>{},onAgent:()=>{},onChanged:()=>{}}));
    };
    window.showApp = (source="") => {setShellSource(source);root.render(React.createElement(AppProbe,{revision:++revision}));};
    if (!${JSON.stringify(feedOnly)}) window.showSources("alice");
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
    if (mode === "cards" && source) {
      if (path === "v1/cards") {
        const before = url.searchParams.get("before");
        const n = before ? Number(before) - 1 : 3;
        const selected = source.id === sources[1].id;
        if (selected) donePageReads.push(before);
        reply({
          revision: "r",
          items: selected ? [doneEntry(n)] : [],
          next: selected && n > 1 ? String(n) : null,
        });
        return;
      }
      if (path === "v1/cards/changes") {
        reply({ revision: "r", items: [], removed: [], more: false });
        return;
      }
      if (path === "feed") {
        if (holdDoneSummary && source.id === sources[1].id) {
          holdDoneSummary = false;
          await new Promise((resolve) => {
            releaseDoneSummary = resolve;
          });
        }
        reply({
          items: [],
          next: null,
          summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
        });
        return;
      }
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
        const paginated =
          allPaginated || (feedPagination && source.id === sources[1].id);
        const older = paginated && url.searchParams.has("before");
        if (paginated) paginationReads.push(url.searchParams.get("before"));
        if (
          older &&
          failPaginationAppend &&
          (!appendFailureSource || source.id === appendFailureSource)
        ) {
          refusedAppendReads++;
          refusedAppendCursors.push(url.searchParams.get("before"));
          reply({ error: "Synthetic append refused" }, 400);
          return;
        }
        if (older && url.searchParams.get("before") === failReplayCursor) {
          reply({ error: "Synthetic replay refused" }, 400);
          return;
        }
        if (paginated && !older && failPaginationHead) {
          reply({ error: "Synthetic head unavailable" }, headFailureStatus, {
            "retry-after": "1",
          });
          return;
        }
        if (movingFeedHead && paginated && !older)
          feedPageRows.unshift(feedPageRows[0] + 1);
        const pageRows =
          allPaginated && queuedHeadChanged && source.id === sources[4].id
            ? [4, 3, 2, 1]
            : feedPageRows;
        const firstOlder = older
          ? pageRows.findIndex(
              (n) => n < Number(url.searchParams.get("before")),
            )
          : 0;
        const index = firstOlder < 0 ? pageRows.length : firstOlder;
        const pageNumbers = paginated
          ? pageRows.slice(index, index + feedPageSize)
          : [undefined];
        if (older && delayOlderMs) {
          delayedOlderReads++;
          await new Promise((resolve) => setTimeout(resolve, delayOlderMs));
          if (res.destroyed) return;
        }
        if (older && holdFleetAppends.delete(source.id)) {
          await new Promise((resolve) =>
            heldFleetAppends.set(source.id, resolve),
          );
          if (res.destroyed) return;
        }
        if (
          older &&
          holdOlder &&
          (!holdOlderBefore ||
            url.searchParams.get("before") === holdOlderBefore)
        ) {
          holdOlder = false;
          await new Promise((resolve) => {
            releaseOlder = resolve;
          });
          if (res.destroyed) return;
        }
        const body = {
          items: pageNumbers.map((rowNumber) => ({
            ...feedTemplate,
            conversation_id: paginated
              ? "conversation-" + rowNumber
              : "same-conversation",
            title:
              (older ? "Older " : "Measured ") +
              source.name +
              (source.id === sources[1].id && feedRevision ? " updated" : "") +
              (paginated ? " " + rowNumber + feedLabelSuffix : ""),
            last_activity_at: paginated ? rowNumber : Date.now(),
            queued_runs: [],
          })),
          next:
            paginated && index + feedPageSize < pageRows.length
              ? String(pageNumbers.at(-1))
              : null,
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
  if (!feedOnly) {
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
  }
  mode = "feed";
  hold = true;
  const feedStart = performance.now();
  await page.waitForFunction(() => typeof window.showFeed === "function");
  await page.evaluate(() => window.showFeed());
  await page
    .locator(".feed-results .feed-row")
    .first()
    .waitFor({ state: "visible" });
  const firstUsefulFeedMs = Math.round(performance.now() - feedStart);
  await expect(page.locator(".feed-results .feed-row")).toHaveCount(8);
  assert(
    pending.size > 0,
    "Healthy Feed rows must render while the slow source remains pending",
  );
  const allHealthySourcesMs = Math.round(performance.now() - feedStart);
  feedRevision++;
  await page.evaluate((source) => {
    const notify = () =>
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [source] },
        }),
      );
    notify();
    window.__feedPulse = setInterval(notify, 25);
  }, sources[1].id);
  await expect(
    page.getByText("Measured Machine 1 updated", { exact: true }),
  ).toBeVisible();
  assert(
    hold && pending.size > 0,
    "A healthy source must update while its peer is still stalled",
  );
  await page.evaluate(() => clearInterval(window.__feedPulse));
  await page.waitForTimeout(1250);
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
  await expect(page.locator(".feed-results .feed-row")).toHaveCount(8);
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

  feedFailSlow = false;
  feedPagination = true;
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  const moreFeed = page.getByRole("button", { name: /Load more/i });
  await expect(moreFeed).toBeVisible();
  await expect(page.locator(".feed-results .feed-row")).toHaveCount(9);
  await page.evaluate(() => window.evictFeedCache());
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  holdOlder = true;
  await moreFeed.click();
  await expect.poll(() => !!releaseOlder).toBe(true);
  hold = true;
  feedPageRows = [8, 7, 6, 5, 4, 3, 2, 1, 0];
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  assert(
    hold && pending.size > 0,
    "Interrupted healthy pagination resumes before the stalled peer",
  );
  await expect(
    page.getByText("Older Machine 1 updated 6", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  assert(
    hold && pending.size > 0,
    "Replayed append preserves follow-up reconciliation while the peer is stalled",
  );
  hold = false;
  for (const release of pending) release();
  pending.clear();
  releaseOlder();
  console.log("Interrupted healthy pagination passed: " + engineName);
  await expect
    .poll(() => paginationReads.filter((before) => before === "3").length)
    .toBeGreaterThanOrEqual(3);
  await expect.poll(() => feedMetrics.active).toBe(0);
  await expect(moreFeed).toBeEnabled();
  releaseOlder = undefined;
  holdOlder = true;
  await moreFeed.click();
  await expect.poll(() => !!releaseOlder).toBe(true);
  hold = true;
  failPaginationHead = true;
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(page.getByText("Older Machine 1 updated 1", { exact: true }))
    .toBeVisible({ timeout: 20_000 })
    .catch((error) => {
      console.error("Pagination requests", JSON.stringify(paginationReads));
      throw error;
    });
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic head unavailable",
  );
  assert(
    hold && pending.size > 0,
    "A failed replacement head does not block available pagination behind a stalled peer",
  );
  failPaginationHead = false;
  hold = false;
  for (const release of pending) release();
  pending.clear();
  releaseOlder();
  console.log(
    "Cache eviction and failed-head pagination passed: " + engineName,
  );
  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("notification-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Measured Machine 1 updated 8", { exact: true }),
  ).toHaveCount(0);
  failPaginationAppend = true;
  await moreFeed.click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic append refused",
  );
  feedPageRows = [4, 3, 2, 1];
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
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  failPaginationAppend = false;
  holdOlder = true;
  holdOlderBefore = "3";
  releaseOlder = undefined;
  feedPageRows = [5, 4, 3, 2, 1];
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
    page.getByText("Measured Machine 1 updated 5", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => !!releaseOlder).toBe(true);
  feedPageRows = [6, 5, 4, 3, 2, 1];
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
    page.getByText("Measured Machine 1 updated 6", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  releaseOlder();
  holdOlderBefore = undefined;
  console.log(
    "Failed append preserves the single head notification: " + engineName,
  );
  allPaginated = true;
  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("queued-append-feed"));
  await expect(
    page.getByText("Measured Machine 4 3", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".feed-results .feed-row")).toHaveCount(9);
  for (const source of sources.slice(0, 4)) holdFleetAppends.add(source.id);
  await moreFeed.click();
  await expect.poll(() => heldFleetAppends.size).toBe(4);
  queuedHeadChanged = true;
  await page.evaluate(
    (source) =>
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [source] },
        }),
      ),
    sources[4].id,
  );
  for (const release of heldFleetAppends.values()) release();
  heldFleetAppends.clear();
  await expect(
    page.getByText("Measured Machine 4 4", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 4 2", { exact: true }),
  ).toBeVisible();
  console.log(
    "Queued append preserved its pending head notification: " + engineName,
  );
  allPaginated = false;
  feedPageSize = 2;
  feedPageRows = [8, 6, 4, 2, 0];
  await page.evaluate(() => window.showFeed("reopen-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 6", { exact: true }),
  ).toBeVisible();
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  feedPageRows = [15, 14, 13, 12, 11, 10, 9, 8, 6, 4, 2, 0];
  failPaginationAppend = true;
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 15", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.evaluate(() => window.showFeed("reopen-feed", "queued"));
  await expect(
    page.getByText("Measured Machine 1 updated 15", { exact: true }),
  ).toHaveCount(0);
  failPaginationAppend = false;
  feedLabelSuffix = " reopened";
  await page.evaluate(() => window.showFeed("reopen-feed"));
  await expect(
    page.getByText("Older Machine 1 updated 2 reopened", { exact: true }),
  ).toBeVisible({ timeout: 12_000 });
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 0 reopened", { exact: true }),
  ).toBeVisible();
  console.log(
    "Reopened Working retained its actual continuation: " + engineName,
  );

  feedPageSize = 1;
  feedLabelSuffix = "";
  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("slow-append-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  delayOlderMs = 1800;
  delayedOlderReads = 0;
  await moreFeed.click();
  await page.evaluate((source) => {
    window.slowAppendPulse = setInterval(
      () =>
        window.dispatchEvent(
          new CustomEvent("loop-workspace-change", {
            detail: { sources: [source] },
          }),
        ),
      50,
    );
  }, sources[1].id);
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible({ timeout: 8_000 });
  await page.evaluate(() => clearInterval(window.slowAppendPulse));
  assert(
    delayedOlderReads <= 3,
    "A slow append must finish under continuous notifications without repeated cancellation",
  );
  delayOlderMs = 0;
  console.log(
    "Slow append completed under continuous notifications: " + engineName,
  );
  allPaginated = true;
  queuedHeadChanged = false;
  feedFailSlow = true;
  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("partial-window-feed"));
  await expect(page.locator(".feed-results .feed-row")).toHaveCount(8);
  await expect(page.getByRole("alert")).toBeVisible();
  holdFleetAppends.add(sources[2].id);
  await moreFeed.click();
  await expect.poll(() => heldFleetAppends.has(sources[2].id)).toBe(true);
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  feedPageRows = [4, 3, 2, 1];
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
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  for (const release of heldFleetAppends.values()) release();
  heldFleetAppends.clear();
  feedFailSlow = false;
  console.log(
    "Partial failed-peer window retained the displayed append: " + engineName,
  );

  allPaginated = false;
  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("failed-replay-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  holdOlder = true;
  releaseOlder = undefined;
  await moreFeed.click();
  await expect.poll(() => !!releaseOlder).toBe(true);
  feedPageRows = [8, 7, 6, 5, 4, 3, 2, 1];
  failReplayCursor = "3";
  hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 8", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 1 updated 4", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  assert(
    hold && pending.size > 0,
    "History reconciliation must continue despite a failed replay while a peer is stalled",
  );
  failReplayCursor = undefined;
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
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  hold = false;
  for (const release of pending) release();
  pending.clear();
  releaseOlder();
  console.log(
    "Failed replay preserved the unfinished history scan: " + engineName,
  );

  feedPageRows = [3, 2, 1, 0];
  await page.evaluate(() => window.showFeed("gap-continuation-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  feedPageRows = [8, 7, 6, 5, 4, 3, 2, 1, 0];
  failReplayCursor = "8";
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 8", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  failReplayCursor = undefined;
  failPaginationHead = true;
  headFailureStatus = 400;
  for (const n of [7, 6, 5, 4, 3]) {
    await expect(moreFeed).toBeEnabled();
    await moreFeed.click();
    await expect(
      page.getByText("Older Machine 1 updated " + n, { exact: true }),
    ).toBeVisible();
  }
  await expect(moreFeed).toBeEnabled();
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 1", { exact: true }),
  ).toBeVisible();
  failPaginationHead = false;
  headFailureStatus = 503;
  console.log("Gap pagination skipped retained history: " + engineName);

  feedPageRows = [3, 2, 1, 0];
  await page.evaluate(() => window.showFeed("overlapping-append-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  holdOlder = true;
  releaseOlder = undefined;
  await moreFeed.click();
  await expect.poll(() => !!releaseOlder).toBe(true);
  feedPageRows = [2, 1, 0];
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 1 updated 1", { exact: true }),
  ).toBeVisible();
  releaseOlder();
  console.log(
    "Interrupted Feed append skipped refreshed overlap: " + engineName,
  );

  feedPageRows = [3, 2, 1, 0];
  await page.evaluate(() => window.showFeed("partial-history-error-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  feedPageRows = [8, 7, 6, 5, 4, 3, 2, 1, 0];
  hold = true;
  failReplayCursor = "8";
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 8", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic replay refused",
  );
  assert(
    hold && pending.size > 0,
    "A history error must be visible before the stalled peer returns",
  );
  hold = false;
  for (const release of pending) release();
  pending.clear();
  failReplayCursor = undefined;
  console.log(
    "Partial history failure surfaced before stalled peer: " + engineName,
  );

  feedPageRows = [3, 2, 1, 0];
  await page.evaluate(() => window.showFeed("moving-head-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  movingFeedHead = true;
  const movingStart = paginationReads.length;
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(6500);
  assert(
    paginationReads.length - movingStart <= 6,
    "One refresh must finish its sweep without polling a moving head indefinitely",
  );
  const settledReads = paginationReads.length;
  await page.waitForTimeout(1500);
  assert.equal(
    paginationReads.length,
    settledReads,
    "No further reads without another notification or user action",
  );
  movingFeedHead = false;
  console.log(
    "Moving head reconciliation settled after one sweep: " + engineName,
  );

  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("notified-removal-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  for (const n of [2, 1]) {
    await moreFeed.click();
    await expect(
      page.getByText("Older Machine 1 updated " + n, { exact: true }),
    ).toBeVisible();
  }
  feedPageRows = [8, 7, 6, 5, 4, 3, 2, 1];
  holdOlder = true;
  holdOlderBefore = "4";
  releaseOlder = undefined;
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect.poll(() => !!releaseOlder, { timeout: 15000 }).toBe(true);
  await expect(
    page.getByText("Older Machine 1 updated 6", { exact: true }),
  ).toBeVisible();
  feedPageRows = feedPageRows.filter((n) => n !== 6);
  await page.evaluate(
    (source) =>
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [source] },
        }),
      ),
    sources[1].id,
  );
  releaseOlder();
  holdOlderBefore = undefined;
  await expect(
    page.getByText("Older Machine 1 updated 6", { exact: true }),
  ).not.toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("Older Machine 1 updated 1", { exact: true }),
  ).toBeVisible();
  console.log(
    "Mid-sweep notification removed previously visited history: " + engineName,
  );

  feedPageRows = [3, 2, 1];
  await page.evaluate(() =>
    window.showFeed("discovery-history-feed", "working", false),
  );
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  await moreFeed.click();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  hold = true;
  feedPageRows = [4, 3, 2, 1];
  await page.evaluate(() => window.showFeed("discovery-history-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older Machine 1 updated 2", { exact: true }),
  ).toBeVisible();
  assert(
    hold && pending.size > 0,
    "Source discovery retains expanded history while the new peer is stalled",
  );
  hold = false;
  for (const release of pending) release();
  pending.clear();
  console.log("Source discovery retained expanded history: " + engineName);

  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("failed-head-and-replay-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  holdOlder = true;
  releaseOlder = undefined;
  await moreFeed.click();
  await expect.poll(() => !!releaseOlder).toBe(true);
  failPaginationHead = true;
  failPaginationAppend = true;
  const refusedBefore = refusedAppendReads;
  feedPageRows = [4, 3, 2, 1];
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect
    .poll(() => refusedAppendReads, { timeout: 12000 })
    .toBeGreaterThan(refusedBefore);
  await expect(page.getByRole("alert")).toBeVisible();
  failPaginationHead = false;
  await expect(
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible({ timeout: 12000 });
  releaseOlder();
  failPaginationAppend = false;
  console.log("Failed append preserved automatic head recovery: " + engineName);

  allPaginated = true;
  feedPageRows = [3, 2, 1];
  await page.evaluate(() => window.showFeed("failed-append-pull-feed"));
  await expect(
    page.getByText("Measured Machine 1 updated 3", { exact: true }),
  ).toBeVisible();
  holdFleetAppends.add(sources[2].id);
  appendFailureSource = sources[1].id;
  failPaginationAppend = true;
  const refusalStart = refusedAppendCursors.length;
  await moreFeed.click();
  await expect.poll(() => heldFleetAppends.has(sources[2].id)).toBe(true);
  await expect
    .poll(() => refusedAppendCursors.length)
    .toBeGreaterThan(refusalStart);
  const refusedCursorReads = refusedAppendCursors.filter(
    (before) => before === "3",
  ).length;
  feedPageRows = [4, 3, 2, 1];
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await expect(
    page.getByText("Measured Machine 1 updated 4", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1200);
  assert.equal(
    refusedAppendCursors.filter((before) => before === "3").length,
    refusedCursorReads,
    "Pull must not replay an append that already failed before the gesture",
  );
  for (const release of heldFleetAppends.values()) release();
  heldFleetAppends.clear();
  appendFailureSource = undefined;
  failPaginationAppend = false;
  allPaginated = false;
  console.log("Pull did not replay an already failed append: " + engineName);

  mode = "cards";
  await page.evaluate(() => window.showFeed("done-summary-feed", "done"));
  await expect(
    page.getByText("Done fixture 3", { exact: true }).first(),
  ).toBeVisible();
  holdDoneSummary = true;
  await moreFeed.click();
  await expect.poll(() => !!releaseDoneSummary).toBe(true);
  await page.evaluate(
    (source) =>
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [source] },
        }),
      ),
    sources[1].id,
  );
  releaseDoneSummary();
  await expect(
    page.getByText("Done fixture 2", { exact: true }).first(),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  assert.deepEqual(
    donePageReads,
    [null, "3"],
    "A notification during the summary read must not append a second Cards page",
  );
  console.log(
    "Done summary notification preserved one-page intent: " + engineName,
  );

  if (!feedOnly) {
    mode = "needs";
    hold = true;
    await page.evaluate(() => window.showNeeds());
    await expect(page.locator(".needs-stack .feed-row")).toHaveCount(8);
    await expect(
      page.locator('[data-filter="working"] .chip-count'),
    ).toHaveText("8");
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
    await expect(page.locator(".needs-stack .feed-row")).toHaveCount(9);
    await expect(
      page.locator('[data-filter="working"] .chip-count'),
    ).toHaveText("9");
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
    await expect
      .poll(() => page.evaluate(() => window.model?.selected))
      .toBe("");
    assert.equal(
      await page.evaluate(() => window.model.sharedDraft.excerpt),
      "",
    );
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
    assert.equal(
      await page.evaluate(() => window.model.folderChoice),
      undefined,
    );
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
      `PASS ${engineName} actual app draft hydration isolates owners and sources and restores returning drafts`,
    );
  }
} finally {
  for (const release of heldFleetAppends.values()) release();
  for (const release of pending) release();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
