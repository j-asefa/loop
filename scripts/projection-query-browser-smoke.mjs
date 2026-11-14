import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-projection-query-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React, {useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {useProjectionQuery, CollectionReadNotice} from ${JSON.stringify(resolve("src/client/CollectionRead.tsx"))};
    import {NativeDecisions} from ${JSON.stringify(resolve("src/client/NativeControls.tsx"))};
    import {workspaceApi} from ${JSON.stringify(resolve("src/shared/workspace-api.ts"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {ProjectSearchResults} from ${JSON.stringify(resolve("src/client/Projects.tsx"))};
    import {watchWorkspaceEvents} from ${JSON.stringify(resolve("src/client/workspace-events.ts"))};
    import {WorkspaceChangeQueue} from ${JSON.stringify(resolve("src/client/workspace-changes.ts"))};
    import {readRoute} from ${JSON.stringify(resolve("src/client/api.ts"))};
    window.startRecovery = () => {
      const pending = new WorkspaceChangeQueue();
      const stop = watchWorkspaceEvents({
        url: new URL("ws://fixture.invalid/ws"),
        source: "",
        socket: () => ({readyState:0, close() {this.readyState = 3;}}),
        read: (after, signal) => readRoute(workspaceApi.events, {query:{after}}, "", signal),
        changed: events => {
          pending.add("", events);
          pending.schedule(detail => window.dispatchEvent(new CustomEvent("loop-workspace-change", {detail})));
        },
      });
      window.stopRecovery = () => {stop(); pending.clear();};
    };
    setShellSource("");
    ownerSession.change("alice");
    function Probe() {
      const [id, setId] = useState("first");
      const [source, setSource] = useState("");
      const [revision, setRevision] = useState(0);
      window.select = value => flushSync(() => setId(value));
      window.source = value => flushSync(() => setSource(value));
      window.owner = value => flushSync(() => {ownerSession.change(value); setRevision(n => n + 1);});
      const query = useProjectionQuery(workspaceApi.personalApproval, id === undefined ? undefined : {params:{id}}, {source, revision, collections:["approvals"], events:["fixture-refresh"]});
      window.captureReplace = () => { window.capturedReplace = query.replace; };
      window.probeState = () => ({loading:query.loading, busy:query.busy, error:query.error});
      window.probeRetry = () => query.retry();
      window.publishCaptured = title => window.capturedReplace({source:'native',request:{title}});
      return React.createElement("section", {id:"probe"}, React.createElement("output", null, query.data?.request.title ?? "empty"), React.createElement(CollectionReadNotice, query));
    }
    function App() {
      const [shown, setShown] = useState(true);
      const [searching, setSearching] = useState(false);
      window.searching = setSearching;
      window.show = value => flushSync(() => setShown(value));
      return React.createElement(React.Fragment, null, shown && React.createElement(Probe), React.createElement("section", {id:"native"}, React.createElement(NativeDecisions)), searching && React.createElement("section", {id:"recovery"}, React.createElement(ProjectSearchResults, {project:"fixture-project",query:"needle",onConversation:()=>{},onArtifact:()=>{}})));
    }
    createRoot(document.getElementById("root")).render(React.createElement(App));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let title = "Initial snapshot",
    status = 200,
    holdNext = false;
  let nativeFailure = true;
  let recoveryHealthy = false,
    searchReads = 0,
    eventReads = 0;
  const requests = [];
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
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
    if (path === "/api/events") {
      eventReads++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (path === "/api/search") {
      searchReads++;
      res.writeHead(recoveryHealthy ? 200 : 503, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          recoveryHealthy
            ? {
                mode: "keyword",
                detail: null,
                pending: 0,
                next: null,
                items: [],
                semantic: {
                  enabled: false,
                  state: "disabled",
                  total: 0,
                  indexed: 0,
                  pending: 0,
                  detail: null,
                },
              }
            : { error: "Search temporarily unavailable" },
        ),
      );
      return;
    }
    if (path === "/api/native/decisions") {
      res.writeHead(nativeFailure ? 400 : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(nativeFailure ? { error: "Decisions unavailable" } : []),
      );
      return;
    }
    if (path.includes("/me/approvals/")) {
      requests.push(path);
      const code = status;
      const body = JSON.stringify(
        code === 200
          ? { source: "native", request: { title } }
          : { error: "Snapshot unavailable" },
      );
      const send = () => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(body);
      };
      if (holdNext) {
        holdNext = false;
        held.push(send);
      } else send();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No fixture route" }));
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
  const output = page.locator("#probe output");
  const notice = page.locator("#probe [role=alert]");
  const refresh = () =>
    page.evaluate(() => window.dispatchEvent(new Event("fixture-refresh")));
  await expect(output).toHaveText("Initial snapshot");
  await expect(page.locator("#native [role=alert]")).toContainText(
    "Decisions unavailable",
  );
  nativeFailure = false;
  await page
    .locator("#native")
    .getByRole("button", { name: "Retry connection" })
    .click();
  await expect(page.locator("#native [role=alert]")).toHaveCount(0);

  await page.evaluate(() => window.searching(true));
  await expect(page.locator("#recovery [role=alert]")).toContainText(
    "Search temporarily unavailable",
    { timeout: 12000 },
  );
  assert.equal(
    searchReads,
    3,
    "automatic search exhausts its bounded retry budget",
  );
  recoveryHealthy = true;
  await page.evaluate(() => window.startRecovery());
  await expect(page.locator("#recovery")).toContainText(
    "Nothing found in this project.",
    { timeout: 8000 },
  );
  assert(eventReads > 0, "the production watcher polled the quiet event log");
  assert.equal(
    searchReads,
    4,
    "recovery invalidation retries the failed query without a click",
  );
  await page.evaluate(() => {
    window.stopRecovery();
    window.searching(false);
  });

  const before = requests.length;
  title = "Older snapshot";
  holdNext = true;
  await refresh();
  await expect.poll(() => held.length).toBe(1);
  title = "Latest snapshot";
  await page.evaluate(() => {
    for (let n = 0; n < 20; n++)
      window.dispatchEvent(new Event("fixture-refresh"));
  });
  assert.equal(
    requests.length,
    before + 1,
    "bursts must not abort and restart the held read",
  );
  held.shift()();
  await expect(output).toHaveText("Latest snapshot");
  assert.equal(
    requests.length,
    before + 2,
    "one trailing read reconciles the burst",
  );

  status = 400;
  await refresh();
  await expect(notice).toContainText("Snapshot unavailable");
  await expect(output).toHaveText("Latest snapshot");
  status = 503;
  const retryBefore = requests.length;
  await page
    .locator("#probe")
    .getByRole("button", { name: "Retry connection" })
    .click();
  await expect(page.locator("#probe button")).toBeEnabled();
  assert.equal(
    requests.length,
    retryBefore + 1,
    "manual retry has no automatic transient retry budget",
  );
  await expect(notice).toBeVisible();
  status = 200;
  title = "Recovered snapshot";
  await page.locator("#probe button").click();
  await expect(output).toHaveText(title);
  await expect(notice).toHaveCount(0);

  for (const change of ["selection", "source", "owner"]) {
    title = "Late old snapshot";
    holdNext = true;
    await refresh();
    await expect.poll(() => held.length).toBe(1);
    title = "New " + change;
    await page.evaluate(() => window.captureReplace());
    const immediate = await page.evaluate((change) => {
      if (change === "selection") window.select("second");
      if (change === "source") window.source("device:second");
      if (change === "owner") window.owner("bob");
      return document.querySelector("#probe output").textContent;
    }, change);
    assert.equal(
      immediate,
      "empty",
      "changed identity must hide the prior snapshot in its first render",
    );
    await expect(output).toHaveText(title);
    held.shift()();
    await expect(output).toHaveText(title);
    await page.evaluate(() =>
      window.publishCaptured("Obsolete saved response"),
    );
    await expect(output).toHaveText(title);
  }
  assert(
    requests.some((path) =>
      path.includes("agent-sources/device%3Asecond/me/approvals/second"),
    ),
    "source is captured in the request path",
  );
  const scopedBefore = requests.length;
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("loop-workspace-change", {
        detail: { sources: ["other"] },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("fixture-refresh", { detail: { sources: ["other"] } }),
    );
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    requests.length,
    scopedBefore,
    "unrelated sources do not refresh this query",
  );

  holdNext = true;
  await refresh();
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(() => window.show(false));
  held.shift()();
  await expect(output).toHaveCount(0);
  title = "Remounted snapshot";
  await page.evaluate(() => window.show(true));
  await expect(output).toHaveText(title);
  holdNext = true;
  await refresh();
  await expect.poll(() => held.length).toBe(1);
  const beforeAbsent = requests.length;
  await page.evaluate(() => {
    window.captureReplace();
    window.select(undefined);
  });
  held.shift()();
  await expect(output).toHaveText("empty");
  await expect
    .poll(() => page.evaluate(() => window.probeState()))
    .toEqual({ loading: false, busy: false, error: "" });
  await page.evaluate(() => {
    window.publishCaptured("obsolete selection");
    void window.probeRetry();
  });
  await expect(output).toHaveText("empty");
  assert.equal(
    requests.length,
    beforeAbsent,
    "Absent input is idle, including manual retry",
  );
  await page.evaluate(() => window.source("idle-source"));
  await expect
    .poll(() => page.evaluate(() => window.probeState()))
    .toEqual({ loading: false, busy: false, error: "" });
  assert.equal(requests.length, beforeAbsent);
  await page.evaluate(() => window.select("first"));
  await expect(output).toHaveText(title);
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: snapshot coalescing, quiet-log recovery after exhausted search reads, retained data/error retry, selection/source/owner fencing, unmount and native read notice passed`,
  );
} finally {
  for (const release of held) release();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(dir, { recursive: true, force: true });
}
