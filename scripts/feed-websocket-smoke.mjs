import { installEventStreamProbe } from "./helpers/event-stream-probe.mjs";
import { pendingSourceRefreshSmoke } from "./helpers/feed-pending-refresh-smoke.mjs";
import { sourceRetryFeedSmoke } from "./helpers/feed-source-retry-smoke.mjs";
import {
  drainPageRoutes,
  temporaryPageRoute,
} from "./helpers/temporary-page-route.mjs";
import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

// Foreign commits wake the 250ms change drain, followed by up to two seconds
// of scoped source coalescing (three for broad invalidations) and 250ms of App coalescing.
const revisionTimeout = 8000;

function seed({ db, owner }, label, history = 55, activeHistory = 45) {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('agent',?,?,?,'openai','fixture',?)",
    ).run(owner, label, label.toLowerCase(), now);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('thread',?,'agent',?,?)",
    ).run(owner, label + " task", now);
    const run = db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'agent','thread','Prompt',?,?,?,?)",
    );
    const message = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,'thread',?,'assistant',?,'{}',?)",
    );
    for (let n = 0; n < history; n++) {
      const at = now - 100_000 + n;
      run.run("old-" + n, owner, "completed", "old-" + n, at, at);
      message.run(
        "answer-" + n,
        owner,
        "old-" + n,
        label + " history " + n,
        at,
      );
    }
    run.run("live", owner, "running", "live", now, now);
    db.prepare("UPDATE runs SET input=?").run(label + " task");
    for (let n = 0; n < activeHistory; n++) {
      const id = "active-" + n;
      const title = label + " earlier task " + n;
      const at = now - 10_000 + n;
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,'agent',?,?)",
      ).run(id, owner, title, at);
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'agent',?,?,'running',?,?,?)",
      ).run(id, owner, id, title, id, at, at);
    }
    const event = db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'old-0','delta','{}',?)",
    );
    for (let n = 0; n < 1000; n++) event.run(owner, now - 1000 + n);
  }).immediate();
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM feed_card_dirty WHERE owner_id=?")
      .get(owner).n,
    0,
    "fixture source writes must finish their projection before any HTTP read",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM feed_cards WHERE owner_id=? AND kind='result'",
      )
      .get(owner).n,
    history,
  );
}
function complete({ db, owner }, label) {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "UPDATE runs SET state='completed',updated_at=? WHERE id='live'",
    ).run(now);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('live-answer',?,'thread','live','assistant',?,'{}',?)",
    ).run(owner, label + " live final answer", now);
  }).immediate();
}
const engines = process.env.LOOP_BROWSER
  ? [process.env.LOOP_BROWSER]
  : ["chromium", "webkit"];
for (const engine of engines) {
  const browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(engine === "chromium"
      ? {
          args: ["--no-sandbox"],
          executablePath: process.env.CHROMIUM_PATH || undefined,
        }
      : {}),
  });
  try {
    {
      let fixture, remote, context;
      try {
        remote = await cardsFixture(true, { projectedWrites: true });
        seed(remote, "Remote", 2, 0);
        fixture = await cardsFixture(true, { projectedWrites: true });
        await fixture.linkCompanion(remote);
        seed(fixture, "Local");
        context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          serviceWorkers: "block",
        });
        let blockSockets = false;
        // Install interception before pages capture their WebSocket constructor.
        await context.routeWebSocket(
          (url) =>
            url.pathname === "/ws" ||
            url.pathname.endsWith("/events/ws") ||
            url.pathname === "/api/events/multiplex/ws",
          (socket) => {
            if (blockSockets) socket.close();
            else socket.connectToServer();
          },
        );
        if (fixture.browser.cookie) {
          const [name, value] = fixture.browser.cookie.split("=");
          await context.addCookies([
            {
              name,
              value,
              url: fixture.origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
        }
        await context.addInitScript(installEventStreamProbe);
        await context.addInitScript(() => {
          // Exercise filters/cursors on browsers predating this optional API.
          Reflect.deleteProperty(URLSearchParams.prototype, "size");
          window.__workspaceUpdates = 0;
          window.__workspaceResets = 0;
          window.__feedReconciledCursor = 0;
          window.addEventListener("loop-workspace-change", (event) => {
            window.__workspaceUpdates++;
            if (
              event.detail?.changes?.some(
                (change) =>
                  change.source === "" &&
                  change.events.some(
                    (event) =>
                      event.scope?.kind === "collection" &&
                      event.scope.id === "all",
                  ),
              )
            )
              window.__workspaceResets++;
            if (
              event.detail?.changes?.some(
                (change) =>
                  change.source === "" &&
                  change.events.some(
                    (event) =>
                      event.scope?.kind === "collection" &&
                      ["feed", "all"].includes(event.scope.id),
                  ),
              )
            ) {
              const stream = window.__sourceStream("");
              window.__feedReconciledCursor = Math.max(
                window.__feedReconciledCursor,
                stream?.cursor ?? 0,
              );
            }
          });
        });
        // Passing this journey requires push: HTTP event polling cannot help.
        await context.route(
          /\/api\/(?:agent-sources\/[^/]+\/)?events\?/,
          (route) => route.abort(),
        );
        let currentBootstraps = 0,
          currentFeeds = 0,
          httpEvents;
        const currentSource = (url) =>
          url.pathname.startsWith("/api/agent-sources/") &&
          /\/(bootstrap|feed)$/.test(url.pathname);
        const currentResponse = async (route) => {
          const sourcePage = route.request().frame().page();
          try {
            const response = await route.fetch();
            if (!response.ok()) return await route.fulfill({ response });
            const body = await response.json();
            if (
              new URL(route.request().url()).pathname.endsWith("/bootstrap")
            ) {
              currentBootstraps++;
              for (const key of ["teams", "environmentName"])
                assert(
                  Object.hasOwn(body, key),
                  "Current bootstrap includes " + key,
                );
            } else {
              currentFeeds++;
            }
            await route.fulfill({ response, json: body });
          } catch (error) {
            // A tab may close after fetch succeeds but before its intercepted
            // response is fulfilled. Only that closed page or the existing
            // upstream cancellation case may end this fixture handler quietly.
            if (sourcePage.isClosed()) return;
            if (!String(error).includes("ECONNRESET")) throw error;
            await route.abort().catch(() => {});
          }
        };
        const installCurrentSource = async (page) => {
          if (remote)
            await temporaryPageRoute(page, currentSource, currentResponse);
        };
        // Keep asynchronous response transforms on the page that owns the
        // temporary routes. Removing the last page route can otherwise
        // continue a request still being fulfilled by a context callback.
        const newPage = async () => {
          const page = await context.newPage();
          await installCurrentSource(page);
          if (httpEvents)
            await temporaryPageRoute(
              page,
              /\/api\/(?:agent-sources\/[^/]+\/)?events\?/,
              httpEvents,
            );
          return page;
        };
        const closePage = async (page) => {
          await drainPageRoutes(page);
          await page.unrouteAll({ behavior: "wait" });
          await page.close();
        };
        const working = await newPage(),
          done = await newPage();
        const errors = [];
        for (const page of [working, done])
          page.on("pageerror", (e) => {
            if (!isWebKitNavigationFetchError(engine, e, fixture.origin))
              errors.push(e.message);
          });
        await working.goto(fixture.origin + "/?filter=working");
        assert.equal(
          await working.evaluate(() => "size" in new URLSearchParams()),
          false,
        );
        const row = (page, text) =>
          page
            .locator(".feed-results .feed-item-card")
            .filter({ hasText: text });
        await expect(row(working, "Local task"))
          .toHaveCount(1)
          .catch(async (error) => {
            console.error(await working.locator("body").innerText());
            console.error(
              await (
                await fixture.request("/api/feed?filter=working", {
                  headers: fixture.browser,
                })
              ).text(),
            );
            throw error;
          });
        // A reset supersedes an in-flight read, not the source's health. Watch
        // intermediate DOM mutations so even a brief false error is detected.
        await working.waitForTimeout(2500);
        const resetClock = (
          await (
            await fixture.request("/api/conversations/thread", {
              headers: fixture.browser,
            })
          ).json()
        ).projection;
        let heldFeed = false,
          releaseFeed;
        const heldFeedGate = new Promise((resolve) => {
          releaseFeed = resolve;
        });
        const workingQuery = (url) =>
          url.pathname === "/api/feed" &&
          url.searchParams.get("filter") === "working";
        const stopResetRoute = await temporaryPageRoute(
          working,
          workingQuery,
          async (route) => {
            if (heldFeed) return route.continue();
            const response = await route.fetch();
            heldFeed = true;
            await heldFeedGate;
            await route.fulfill({ response });
          },
        );
        await working.evaluate(() => {
          window.__feedResetErrors = [];
          window.__feedResetObserver = new MutationObserver(() => {
            for (const alert of document.querySelectorAll(
              '.feed-view [role="alert"]',
            ))
              if (/could not refresh|load the Feed/i.test(alert.textContent))
                window.__feedResetErrors.push(alert.textContent);
          });
          window.__feedResetObserver.observe(
            document.querySelector(".feed-view"),
            { subtree: true, childList: true, characterData: true },
          );
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: {
                sources: [""],
                changes: [
                  {
                    source: "",
                    events: [
                      {
                        type: "invalidate",
                        scope: { kind: "collection", id: "feed" },
                      },
                    ],
                  },
                ],
              },
            }),
          );
        });
        await expect.poll(() => heldFeed).toBe(true);
        await working.evaluate((clock) => {
          window.__injectSourceReset("", clock);
        }, resetClock);
        const resumedFeed = working.waitForResponse((response) =>
          workingQuery(new URL(response.url())),
        );
        releaseFeed();
        await (await resumedFeed).finished();
        await working.waitForTimeout(700);
        assert.deepEqual(
          await working.evaluate(() => {
            window.__feedResetObserver.disconnect();
            return window.__feedResetErrors;
          }),
          [],
        );
        await stopResetRoute();
        console.log(
          `PASS ${engine}/companion reset during Feed read does not report source failure`,
        );
        if (remote) {
          await expect(row(working, "Remote task")).toHaveCount(1);
          await expect(
            working.getByRole("region", { name: "Your agents" }),
          ).toContainText("@Remote");
          assert.ok(
            currentBootstraps > 0 && currentFeeds > 0,
            "Current linked catalogs and Feed pages must both reach the UI",
          );
          console.log(
            `PASS ${engine} linked current bootstrap metadata and Feed state remain readable`,
          );
          const failedSource = await newPage();
          const unavailable = "**/api/agent-sources/*/feed?*";
          const stopUnavailable = await temporaryPageRoute(
            failedSource,
            unavailable,
            async (route) => {
              if (await failedSource.evaluate(() => !!window.__feedManualRetry))
                return route.fallback();
              return route.fulfill({
                status: 403,
                json: { error: "Fixture source unavailable" },
              });
            },
          );
          await failedSource.goto(fixture.origin + "/?filter=working");
          const sourceError = failedSource.getByRole("alert").filter({
            hasText:
              "Some environments could not refresh. Showing their last loaded threads.",
          });
          await expect(sourceError).toBeVisible({ timeout: revisionTimeout });
          await expect(row(failedSource, "Remote task")).toHaveCount(0);
          await failedSource.waitForTimeout(2500); // Let initial reset/coalescing work settle.
          const localRefresh = failedSource.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === "/api/feed" &&
              url.searchParams.get("filter") === "working"
            );
          });
          await failedSource.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("loop-workspace-change", {
                detail: {
                  sources: [""],
                  changes: [
                    {
                      source: "",
                      events: [
                        {
                          type: "invalidate",
                          scope: { kind: "collection", id: "feed" },
                        },
                      ],
                    },
                  ],
                },
              }),
            ),
          );
          await (await localRefresh).finished();
          await failedSource.waitForTimeout(400);
          await expect(sourceError).toBeVisible();
          // Keep automatic reads failing until the real retry click, so they
          // cannot recover and remove the button while Playwright targets it.
          await failedSource.evaluate(() => {
            document.addEventListener(
              "click",
              (event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest("button")?.textContent?.trim() ===
                    "Retry connection"
                )
                  window.__feedManualRetry = true;
              },
              { capture: true },
            );
          });
          // Retry input only if no click arrived before a refresh replaced the button.
          await expect(async () => {
            if (
              !(await failedSource.evaluate(() => !!window.__feedManualRetry))
            )
              await sourceError
                .getByRole("button", { name: "Retry connection", exact: true })
                .click({ timeout: 3000 });
            assert.equal(
              await failedSource.evaluate(() => window.__feedManualRetry),
              true,
            );
          }).toPass({ timeout: 30000 });
          await expect(row(failedSource, "Remote task")).toHaveCount(1, {
            timeout: revisionTimeout,
          });
          await expect(sourceError).toHaveCount(0);
          await stopUnavailable();
          await closePage(failedSource);
          console.log(
            `PASS ${engine} scoped Feed refresh retains another source's failure until recovery`,
          );
          // A single refresh can include a healthy and an unavailable source.
          // Only successful sources may replace their cached Needs rows.
          for (const [source, label] of [
            [fixture, "Local"],
            [remote, "Remote"],
          ]) {
            source.db.transaction(() => {
              source.db
                .prepare(
                  "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('needs-thread',?,'agent',?,?)",
                )
                .run(source.owner, label + " approval task", Date.now());
              source.db
                .prepare(
                  "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('needs-run',?,'agent','needs-thread',?,'awaiting_approval','needs-run',?,?)",
                )
                .run(
                  source.owner,
                  label + " approval task",
                  Date.now(),
                  Date.now(),
                );
              source.db
                .prepare(
                  "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('needs-approval',?,'needs-run','digest','{\"tool\":\"deploy\"}','pending',?,?)",
                )
                .run(source.owner, Date.now(), Date.now() + 60_000);
            })();
          }
          const needsPage = await newPage();
          await needsPage.goto(fixture.origin + "/?filter=working");
          const remoteNeed = needsPage
            .locator(".needs-stack .feed-item-card")
            .filter({ hasText: "Remote approval task" });
          await expect(remoteNeed).toHaveCount(1, { timeout: revisionTimeout });
          await needsPage.waitForTimeout(2500);
          const sourceIds = await needsPage.evaluate(() => [
            ...new Set(
              window.__eventStreams
                .filter((stream) => stream.readyState === WebSocket.OPEN)
                .map((stream) => stream.source),
            ),
          ]);
          let failedNeeds = 0,
            localNeeds = 0;
          const needsRoute = (url) =>
            url.pathname.endsWith("/feed") &&
            url.searchParams.get("filter") === "needs";
          const stopNeedsFailure = await temporaryPageRoute(
            needsPage,
            needsRoute,
            (route) => {
              if (
                new URL(route.request().url()).pathname.includes(
                  "agent-sources",
                )
              ) {
                failedNeeds++;
                return route.fulfill({
                  status: 403,
                  json: { error: "Fixture Needs unavailable" },
                });
              }
              localNeeds++;
              return route.continue();
            },
          );
          await needsPage.evaluate(
            (sources) =>
              window.dispatchEvent(
                new CustomEvent("loop-workspace-change", {
                  detail: {
                    sources,
                    changes: sources.map((source) => ({
                      source,
                      events: [
                        {
                          type: "invalidate",
                          scope: { kind: "collection", id: "feed" },
                        },
                      ],
                    })),
                  },
                }),
              ),
            sourceIds,
          );
          await expect.poll(() => failedNeeds).toBeGreaterThan(0);
          await expect.poll(() => localNeeds).toBeGreaterThan(0);
          await needsPage.waitForTimeout(800);
          await expect(remoteNeed).toHaveCount(1);
          await stopNeedsFailure();
          // A local refresh must not cancel an independent remote Needs read.
          // Hold a valid remote display response across the local completion.
          let remoteNeedsHeld = false,
            releaseRemoteNeeds;
          const remoteNeedsGate = new Promise((resolve) => {
            releaseRemoteNeeds = resolve;
          });
          const stopNeedsHold = await temporaryPageRoute(
            needsPage,
            needsRoute,
            async (route) => {
              if (
                !new URL(route.request().url()).pathname.includes(
                  "agent-sources",
                )
              )
                return route.continue();
              const response = await route.fetch();
              const body = await response.json();
              body.items = body.items.map((item) =>
                item.conversation_id === "needs-thread"
                  ? { ...item, title: "Updated remote approval task" }
                  : item,
              );
              remoteNeedsHeld = true;
              await remoteNeedsGate;
              await route.fulfill({ response, json: body });
            },
          );
          const refreshNeedsSources = (sources) =>
            needsPage.evaluate(
              (sources) =>
                window.dispatchEvent(
                  new CustomEvent("loop-workspace-change", {
                    detail: {
                      sources,
                      changes: sources.map((source) => ({
                        source,
                        events: [
                          {
                            type: "invalidate",
                            scope: { kind: "collection", id: "feed" },
                          },
                        ],
                      })),
                    },
                  }),
                ),
              sources,
            );
          try {
            const remoteFeed = needsPage.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname.includes("agent-sources") &&
                url.pathname.endsWith("/feed") &&
                url.searchParams.get("filter") === "working"
              );
            });
            await refreshNeedsSources(sourceIds.filter(Boolean));
            await expect.poll(() => remoteNeedsHeld).toBe(true);
            await (await remoteFeed).finished();
            await needsPage.waitForTimeout(800);
            const localNeedsRead = needsPage.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/feed" &&
                url.searchParams.get("filter") === "needs"
              );
            });
            await refreshNeedsSources([""]);
            await (await localNeedsRead).finished();
            releaseRemoteNeeds();
            await expect(
              needsPage
                .locator(".needs-stack .feed-item-card")
                .filter({ hasText: "Updated remote approval task" }),
            ).toHaveCount(1);
          } finally {
            releaseRemoteNeeds();
            await stopNeedsHold();
          }
          await closePage(needsPage);
          await pendingSourceRefreshSmoke(
            newPage,
            fixture.origin,
            sourceIds.find(Boolean),
            closePage,
          );
          console.log(
            `PASS ${engine} slow local read allows remote Feed/Needs updates and retains its trailing notification`,
          );
          await sourceRetryFeedSmoke(
            newPage,
            fixture.origin,
            sourceIds.find(Boolean),
            closePage,
          );
          console.log(
            `PASS ${engine} a retrying source preserves healthy Feed/Needs updates and recovers without another notification`,
          );
          for (const source of [fixture, remote])
            source.db.transaction(() => {
              source.db
                .prepare("DELETE FROM approvals WHERE id='needs-approval'")
                .run();
              source.db.prepare("DELETE FROM runs WHERE id='needs-run'").run();
              source.db
                .prepare("DELETE FROM conversations WHERE id='needs-thread'")
                .run();
            })();
          console.log(
            `PASS ${engine} mixed-source Needs refresh retains failed-source cards`,
          );
          const localSockets = () =>
            working.evaluate(
              () =>
                window.__eventSockets.filter((socket) =>
                  ["/ws", "/api/events/multiplex/ws"].includes(
                    new URL(socket.url).pathname,
                  ),
                ).length,
            );
          await expect.poll(localSockets).toBe(1);
          assert.equal(
            await working.evaluate(
              () =>
                window.__eventSockets.filter(
                  (socket) => socket.readyState === WebSocket.OPEN,
                ).length,
            ),
            1,
            "The companion page must share one browser socket across its sources",
          );
          // A source disappearing and returning must only replace its own
          // watcher. Keep the healthy local socket, cursor and build baseline.
          const stopDiscovery = await temporaryPageRoute(
            working,
            "**/api/agent-sources",
            (route) => route.fulfill({ json: [] }),
          );
          await working.evaluate(() =>
            window.dispatchEvent(new Event("loop-source-refresh")),
          );
          await expect
            .poll(() =>
              working.evaluate(() =>
                window.__eventStreams
                  .filter((stream) => stream.source !== "")
                  .every((stream) => stream.readyState === WebSocket.CLOSED),
              ),
            )
            .toBe(true);
          assert.equal(await localSockets(), 1);
          await stopDiscovery();
          await working.evaluate(() =>
            window.dispatchEvent(new Event("loop-source-refresh")),
          );
          await expect
            .poll(() =>
              working.evaluate(
                () =>
                  window.__eventStreams.filter(
                    (stream) =>
                      stream.source !== "" &&
                      stream.readyState === WebSocket.OPEN,
                  ).length,
              ),
            )
            .toBe(1);
          assert.equal(await localSockets(), 1);
          // The last metadata signal must survive a source-specific cooldown.
          let limitedMetadata = false;
          const stopMetadataLimit = await temporaryPageRoute(
            working,
            "**/api/agent-sources/*/bootstrap",
            (route) => {
              if (limitedMetadata) return route.continue();
              limitedMetadata = true;
              return route.fulfill({
                status: 429,
                headers: { "Retry-After": "2" },
                json: { error: "Fixture metadata cooldown" },
              });
            },
          );
          remote.db
            .prepare(
              "UPDATE agents SET name='Remote recovered' WHERE id='agent'",
            )
            .run();
          await expect.poll(() => limitedMetadata).toBe(true);
          await expect(
            working.getByRole("region", { name: "Your agents" }),
          ).toContainText("@Remote recovered", { timeout: revisionTimeout });
          await stopMetadataLimit();
          // A successful run read cannot clear a failed metadata projection.
          // Discovery must keep retrying the source until bootstrap recovers.
          let failedMetadataReads = 0;
          const stopMetadataFailure = await temporaryPageRoute(
            working,
            "**/api/agent-sources/*/bootstrap",
            (route) => {
              failedMetadataReads++;
              return route.fulfill({
                status: 403,
                json: { error: "Fixture metadata unavailable" },
              });
            },
          );
          remote.db
            .prepare(
              "UPDATE agents SET name='Remote metadata recovered' WHERE id='agent'",
            )
            .run();
          const metadataWarning = working.getByRole("status").filter({
            hasText:
              /temporarily unavailable\. Last loaded agents are still shown\./,
          });
          await expect(metadataWarning).toBeVisible({
            timeout: revisionTimeout,
          });
          const failedBeforeRuns = failedMetadataReads;
          const linkedSource = await working.evaluate(
            () =>
              window.__eventStreams.find(
                (stream) =>
                  stream.source && stream.readyState === WebSocket.OPEN,
              ).source,
          );
          await working.evaluate(
            (source) =>
              window.dispatchEvent(
                new CustomEvent("loop-workspace-change", {
                  detail: {
                    sources: [source],
                    changes: [
                      {
                        source,
                        events: [
                          {
                            type: "invalidate",
                            scope: { kind: "collection", id: "runs" },
                          },
                        ],
                      },
                    ],
                  },
                }),
              ),
            linkedSource,
          );
          await expect
            .poll(() => failedMetadataReads, { timeout: revisionTimeout })
            .toBeGreaterThan(failedBeforeRuns);
          await expect(metadataWarning).toBeVisible();
          await stopMetadataFailure();
          await expect(
            working.getByRole("region", { name: "Your agents" }),
          ).toContainText("@Remote metadata recovered", { timeout: 35000 });
          await expect(metadataWarning).toHaveCount(0);
          console.log(
            `PASS ${engine} run refresh preserves metadata failure and discovery recovers the source`,
          );
          remote.db
            .prepare("UPDATE agents SET name='Remote' WHERE id='agent'")
            .run();
          fixture.db
            .prepare(
              "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES('late-decision','live','thread','fixture','adapter',?,?)",
            )
            .run(
              JSON.stringify({
                id: "adapter",
                kind: "approval",
                title: "Late decision snapshot",
                detail: "Fixture only",
                choices: ["allow", "deny"],
              }),
              Date.now(),
            );
          const decision = working.getByRole("heading", {
            name: "Late decision snapshot",
          });
          await expect(decision).toHaveCount(1);
          let capturedDecision = false,
            releaseDecision,
            deliveredDecision;
          const decisionGate = new Promise((resolve) => {
            releaseDecision = resolve;
          });
          const decisionDelivered = new Promise((resolve) => {
            deliveredDecision = resolve;
          });
          const stopDecision = await temporaryPageRoute(
            working,
            "**/api/native/decisions",
            async (route) => {
              if (capturedDecision) return route.continue();
              const response = await route.fetch();
              capturedDecision = true;
              await decisionGate;
              await route.fulfill({ response });
              deliveredDecision();
            },
          );
          try {
            await working.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent("loop-workspace-change", {
                  detail: {
                    sources: [""],
                    changes: [
                      {
                        source: "",
                        events: [
                          {
                            type: "invalidate",
                            scope: { kind: "collection", id: "decisions" },
                          },
                        ],
                      },
                    ],
                  },
                }),
              ),
            );
            await expect.poll(() => capturedDecision).toBe(true);
            fixture.db
              .prepare(
                "UPDATE native_decisions SET state='resolved' WHERE id='late-decision'",
              )
              .run();
            await expect(decision).toHaveCount(0, { timeout: revisionTimeout });
            releaseDecision();
            await decisionDelivered;
            await working.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            await expect(decision).toHaveCount(0);
          } finally {
            releaseDecision();
            await stopDecision();
            fixture.db
              .prepare("DELETE FROM native_decisions WHERE id='late-decision'")
              .run();
          }
          console.log(
            `PASS ${engine} native decision rejects an older pending snapshot after resolution`,
          );
          assert.equal(
            await working.evaluate(
              () =>
                window.__eventSockets.find((socket) =>
                  ["/ws", "/api/events/multiplex/ws"].includes(
                    new URL(socket.url).pathname,
                  ),
                ).readyState,
            ),
            1,
          );
        }
        await done.goto(fixture.origin + "/?filter=done");
        await done.getByRole("button", { name: /Load more/i }).click();
        await expect(row(done, "Local history 0")).toHaveCount(1);
        const beforeCount = await done
          .locator(".feed-results .feed-item-card")
          .count();
        // A foreground append must preserve a notification queued behind a
        // slower head read. Start a fresh page to exclude periodic recovery.
        await working.reload();
        await expect(row(working, "Local task")).toHaveCount(1);
        await working.waitForTimeout(2500);
        let headHeld = false;
        let releaseHead;
        const headGate = new Promise((resolve) => {
          releaseHead = resolve;
        });
        const stopHead = await temporaryPageRoute(
          working,
          "**/api/feed?*",
          async (route) => {
            const query = new URL(route.request().url()).searchParams;
            if (
              headHeld ||
              query.get("filter") !== "working" ||
              query.has("before")
            )
              return route.continue();
            const response = await route.fetch();
            headHeld = true;
            await headGate;
            await route.fulfill({ response });
          },
        );
        try {
          await working.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("loop-workspace-change", {
                detail: {
                  sources: [""],
                  changes: [
                    {
                      source: "",
                      events: [
                        {
                          type: "invalidate",
                          scope: { kind: "collection", id: "feed" },
                        },
                      ],
                    },
                  ],
                },
              }),
            ),
          );
          await expect.poll(() => headHeld).toBe(true);
          const updates = await working.evaluate(
            () => window.__workspaceUpdates,
          );
          complete(fixture, "Local");
          await expect
            .poll(() => working.evaluate(() => window.__workspaceUpdates), {
              timeout: revisionTimeout,
            })
            .toBeGreaterThan(updates);
          await working.waitForTimeout(400);
          const appended = working.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === "/api/feed" &&
              url.searchParams.get("filter") === "working" &&
              url.searchParams.has("before")
            );
          });
          await working.getByRole("button", { name: /Load more/i }).click();
          await appended;
          await expect(row(working, "Local task")).toHaveCount(0, {
            timeout: 3000,
          });
        } finally {
          releaseHead();
          await stopHead();
        }
        await expect(row(working, "Local task")).toHaveCount(0, {
          timeout: 5000,
        });
        await expect(row(done, "Local live final answer")).toHaveCount(1, {
          timeout: 5000,
        });
        await expect(row(done, "Local history 0")).toHaveCount(1);
        assert.ok(
          (await done.locator(".feed-results .feed-item-card").count()) >
            beforeCount,
        );
        if (remote) {
          await expect(row(working, "Remote task")).toHaveCount(1);
          complete(remote, "Remote");
          await expect(row(working, "Remote task")).toHaveCount(0, {
            timeout: revisionTimeout,
          });
          await expect(row(done, "Remote live final answer")).toHaveCount(1, {
            timeout: revisionTimeout,
          });
        }
        // Retain the final notification when it arrives during a slower read.
        let held = false,
          release,
          cardChangeReads = 0;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        await temporaryPageRoute(
          done,
          "**/api/v1/cards/changes?*",
          async (route) => {
            if (
              new URL(route.request().url()).searchParams.get("view") !== "done"
            )
              return route.continue();
            cardChangeReads++;
            if (held) return route.continue();
            const response = await route.fetch();
            held = true;
            await gate;
            await route.fulfill({ response });
          },
        );
        fixture.db
          .prepare(
            "UPDATE messages SET content='First edit' WHERE id='live-answer'",
          )
          .run();
        await expect.poll(() => held, { timeout: revisionTimeout }).toBe(true);
        const updates = await done.evaluate(() => window.__workspaceUpdates);
        fixture.db
          .prepare(
            "UPDATE messages SET content='Final edit during refresh' WHERE id='live-answer'",
          )
          .run();
        await expect
          .poll(() => done.evaluate(() => window.__workspaceUpdates), {
            timeout: revisionTimeout,
          })
          .toBeGreaterThan(updates);
        await done.waitForTimeout(400); // App coalesces the notification before Feed sees it.
        release();
        await expect.poll(() => cardChangeReads).toBeGreaterThan(1);
        await expect(row(done, "Final edit during refresh")).toHaveCount(1, {
          timeout: 5000,
        });
        // Reconcile revisions on reconnect even without new run events.
        await done.evaluate(() =>
          window.__eventSockets.forEach((socket) => socket.close()),
        );
        fixture.db
          .prepare(
            "UPDATE messages SET content='Changed while disconnected' WHERE id='live-answer'",
          )
          .run();
        await expect(row(done, "Changed while disconnected")).toHaveCount(1, {
          timeout: 5000,
        });
        await expect(row(done, "Local history 0")).toHaveCount(1);

        // A complete source applies real message identities in place. Leave
        // the stream quiet beyond both former five-second thread timers.
        fixture.db
          .prepare("UPDATE runs SET state='running' WHERE id='live'")
          .run();
        const thread = await newPage();
        await thread.goto(fixture.origin + "/?conversation=thread");
        const answer = thread.locator('[data-message-id="live-answer"]');
        await expect(answer).toContainText("Changed while disconnected");
        // Initial broad reconciliation can be coalesced for three seconds.
        // Finish that startup snapshot before measuring streamed updates.
        await expect
          .poll(() => thread.evaluate(() => window.__workspaceResets), {
            timeout: revisionTimeout,
          })
          .toBeGreaterThan(0);
        await thread.waitForLoadState("networkidle");
        const transcriptReads = [],
          idleReads = [];
        let idle = false;
        const record = (request) => {
          const path = new URL(request.url()).pathname;
          if (
            request.method() === "GET" &&
            path === "/api/conversations/thread"
          )
            transcriptReads.push(path);
          if (idle && path.startsWith("/api/")) idleReads.push(path);
        };
        thread.on("request", record);
        for (let n = 1; n <= 6; n++) {
          const text = "Live projection " + "token ".repeat(n);
          fixture.db
            .prepare("UPDATE messages SET content=? WHERE id='live-answer'")
            .run(text);
          await expect(answer).toContainText(text.trim());
        }
        await thread.waitForTimeout(2500);
        // The separate writer commits source events and Feed cards together.
        // Finish coalesced delivery and its reads before measuring quiet.
        await expect
          .poll(
            () =>
              fixture.db
                .prepare(
                  "SELECT count(*) n FROM feed_card_dirty WHERE owner_id=?",
                )
                .get(fixture.owner).n,
            { timeout: revisionTimeout },
          )
          .toBe(0);
        const projectedCursor = fixture.db
          .prepare(
            "SELECT COALESCE(max(id),0) cursor FROM events WHERE owner_id=? AND type='feed.card'",
          )
          .get(fixture.owner).cursor;
        assert.ok(
          projectedCursor > 0,
          "streaming writes must publish Feed projection changes",
        );
        await expect
          .poll(() => thread.evaluate(() => window.__feedReconciledCursor), {
            timeout: revisionTimeout,
          })
          .toBeGreaterThanOrEqual(projectedCursor);
        await thread.waitForLoadState("networkidle");
        const quietUpdates = await thread.evaluate(
          () => window.__workspaceUpdates,
        );
        idle = true;
        await thread.waitForTimeout(6500);
        assert.equal(
          await thread.evaluate(() => window.__workspaceUpdates),
          quietUpdates,
          "the quiet measurement must not include a pending workspace invalidation",
        );
        assert.equal(
          transcriptReads.length,
          0,
          "streaming transcript must not refetch its snapshot",
        );
        const feedMode = await thread.evaluate(
          () => window.__sourceStream("")?.reset?.capabilities.feed,
        );
        assert.ok(
          ["snapshot", "delta"].includes(feedMode),
          "the source must declare its Feed delivery mode",
        );
        // A snapshot Feed retains its 30s poll (two Feed reads and a Cards
        // change read). Once Feed advertises deltas, the strict total budget
        // applies automatically; covered transcript/Results paths stay quiet.
        const coveredReads =
          feedMode === "snapshot"
            ? idleReads.filter(
                (path) =>
                  !["/api/feed", "/api/v1/cards/changes"].includes(path),
              )
            : idleReads;
        assert.ok(
          coveredReads.length <= 2,
          `covered surfaces made ${coveredReads.length} quiet requests: ${coveredReads}`,
        );
        assert.ok(
          idleReads.length <= (feedMode === "snapshot" ? 5 : 2),
          `quiet stream made ${idleReads.length} API requests between frames: ${idleReads}`,
        );
        console.log(
          `PASS ${engine} transcript deltas: zero snapshot reads; ${idleReads.length} requests during 6.5s without frames`,
        );
        thread.off("request", record);
        // Recover an unloaded row without exposing a detached history page.
        const recovery = thread.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/conversations/thread" &&
            url.searchParams.get("message") === "answer-0"
          );
        });
        fixture.db
          .prepare(
            "UPDATE messages SET content=content||' recovered older chunk' WHERE id='answer-0'",
          )
          .run();
        await (await recovery).finished();
        fixture.db
          .prepare(
            "UPDATE messages SET content='Updated unloaded history' WHERE id='answer-0'",
          )
          .run();
        await expect(row(done, "Updated unloaded history")).toHaveCount(1, {
          timeout: revisionTimeout,
        });
        await expect(
          thread.locator('[data-message-id="answer-0"]'),
        ).toHaveCount(0);
        await thread
          .getByRole("button", { name: "Load earlier messages", exact: true })
          .click();
        await expect(
          thread.locator('[data-message-id="answer-0"]'),
        ).toContainText("Updated unloaded history");
        const loadedIds = await thread
          .locator("[data-message-id]")
          .evaluateAll((rows) =>
            rows.map((row) => row.dataset.messageId).sort(),
          );
        // A reset replaces the loaded page set. Its new cursor must let the
        // reader request the discarded history again, including the middle.
        fixture.db
          .prepare(
            "UPDATE messages SET content=content||' reset probe' WHERE id='live-answer'",
          )
          .run();
        await expect(answer).toContainText("reset probe");
        const clock = (
          await (
            await fixture.request("/api/conversations/thread", {
              headers: fixture.browser,
            })
          ).json()
        ).projection;
        const resetRead = thread.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/conversations/thread",
        );
        await thread.evaluate((clock) => {
          window.__injectSourceReset("", clock);
        }, clock);
        await (await resetRead).finished();
        await expect(
          thread.locator('[data-message-id="answer-0"]'),
        ).toHaveCount(0);
        await thread
          .getByRole("button", { name: "Load earlier messages", exact: true })
          .click();
        await expect
          .poll(() =>
            thread
              .locator("[data-message-id]")
              .evaluateAll((rows) =>
                rows.map((row) => row.dataset.messageId).sort(),
              ),
          )
          .toEqual(loadedIds);
        console.log(
          `PASS ${engine} unloaded deltas stay outside displayed pages and reset pagination restores all history`,
        );
        // Fault-inject a missing frame, then explicitly refresh. An absent
        // row in the page must disappear instead of merging back from cache.
        fixture.db
          .prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('snapshot-delete',?,'thread','assistant','Temporary display row',?)",
          )
          .run(fixture.owner, Date.now());
        await expect(
          thread.locator('[data-message-id="snapshot-delete"]'),
        ).toHaveCount(1);
        await thread.evaluate(() =>
          window.__eventSockets.forEach((socket) => {
            socket.__forward = socket.onmessage;
            socket.onmessage = null;
          }),
        );
        fixture.db
          .prepare("DELETE FROM messages WHERE id='snapshot-delete'")
          .run();
        await thread.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(
          thread.locator('[data-message-id="snapshot-delete"]'),
        ).toHaveCount(0);
        await thread.evaluate(() =>
          window.__eventSockets.forEach((socket) => {
            socket.onmessage = socket.__forward;
          }),
        );
        console.log(
          `PASS ${engine} transcript gap recovery and explicit-refresh deletion reconciliation`,
        );
        await closePage(thread);
        fixture.db
          .transaction(() => {
            fixture.db
              .prepare("UPDATE runs SET state='completed' WHERE id='live'")
              .run();
            fixture.db
              .prepare(
                "UPDATE messages SET content='Changed while disconnected' WHERE id='live-answer'",
              )
              .run();
          })
          .immediate();
        await expect(row(done, "Changed while disconnected")).toHaveCount(1, {
          timeout: revisionTimeout,
        });

        // Give HTTP fallback its own database/request budget after the many
        // navigation and streaming probes above; keep the real 600/min limit.
        await closePage(working);
        await closePage(done);
        await fixture.close();
        fixture = undefined;
        fixture = await cardsFixture(true, { projectedWrites: true });
        await fixture.linkCompanion(remote);
        seed(fixture, "Local", 2, 0);
        complete(fixture, "Local");
        if (fixture.browser.cookie) {
          const [name, value] = fixture.browser.cookie.split("=");
          await context.addCookies([
            {
              name,
              value,
              url: fixture.origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
        }
        await context.unroute(/\/api\/(?:agent-sources\/[^/]+\/)?events\?/);
        const httpEventRows = new Set();
        httpEvents = async (route) => {
          const response = await route.fetch();
          if (!response.ok()) return route.fulfill({ response });
          const rows = await response.json();
          const localRows = [];
          for (const row of rows) {
            if (
              new URL(route.request().url()).pathname === "/api/events" &&
              row.owner_id === fixture.owner &&
              ("subject_kind" in row || "subject_id" in row)
            )
              localRows.push(row.id);
            assert(Object.hasOwn(row, "subject_kind"));
            assert(Object.hasOwn(row, "subject_id"));
          }
          await route.fulfill({ response, json: rows });
          for (const id of localRows) httpEventRows.add(id);
        };
        const replay = await newPage();
        replay.on("pageerror", (e) => {
          if (!isWebKitNavigationFetchError(engine, e, fixture.origin))
            errors.push(e.message);
        });
        await replay.goto(fixture.origin + "/?filter=working");
        await expect(replay.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        blockSockets = true;
        const cursor = fixture.db
          .prepare("SELECT max(id) cursor FROM events WHERE owner_id=?")
          .get(fixture.owner).cursor;
        await expect
          .poll(() => replay.evaluate(() => window.__sourceStream("")?.cursor))
          .toBe(cursor);
        assert.ok(
          cursor >= 1000,
          "the socket already covered the historical events",
        );
        const firstPoll = replay.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/events",
        );
        await replay.evaluate(() =>
          window.__eventSockets.forEach((socket) => socket.close()),
        );
        assert.equal(
          Number(new URL((await firstPoll).url()).searchParams.get("after")),
          cursor,
          "fallback resumes at the socket watermark",
        );
        await expect(replay.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        await expect(replay.locator(".connection-notice")).toHaveCount(0);
        await closePage(replay);
        const fallback = await newPage();
        const fallbackRequests = [];
        fallback.on("response", (response) => {
          const url = new URL(response.url());
          if (url.pathname.startsWith("/api/"))
            fallbackRequests.push({
              path: url.pathname,
              status: response.status(),
            });
        });
        fallback.on("requestfailed", (request) =>
          fallbackRequests.push({
            path: new URL(request.url()).pathname,
            error: request.failure()?.errorText,
          }),
        );
        fallback.on("pageerror", (e) => errors.push(e.message));
        const initialFeed = fallback.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/feed" &&
            url.searchParams.get("filter") === "working"
          );
        });
        await fallback.goto(fixture.origin + "/?filter=working");
        await expect(fallback.locator(".workspace-connection"))
          .toHaveText("Connected to workspace")
          .catch((error) => {
            console.error(
              "HTTP fallback diagnostic",
              JSON.stringify({ engine, requests: fallbackRequests }),
            );
            throw error;
          });
        await expect(fallback.locator(".connection-notice")).toHaveCount(0);
        // Finish the initial snapshot before mutating: otherwise startup can
        // render the changed row and advance the cursor without polling it.
        assert.equal((await initialFeed).status(), 200);
        await (await initialFeed).finished();
        await expect(
          fallback.getByRole("status", { name: "Loading feed", exact: true }),
        ).toHaveCount(0);
        await expect(row(fallback, "Local task")).toHaveCount(0);
        const fallbackUpdates = await fallback.evaluate(
          () => window.__workspaceUpdates,
        );
        const eventId = Number(
          fixture.db
            .transaction(() => {
              fixture.db
                .prepare(
                  "UPDATE runs SET state='running',updated_at=? WHERE id='live'",
                )
                .run(Date.now());
              return fixture.db
                .prepare(
                  "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'live','run_started','{}',?)",
                )
                .run(fixture.owner, Date.now()).lastInsertRowid;
            })
            .immediate(),
        );
        await expect
          .poll(() => httpEventRows.has(eventId), {
            message:
              "The actual new event reaches HTTP fallback without subject fields",
            timeout: revisionTimeout,
          })
          .toBe(true);
        await expect
          .poll(() => fallback.evaluate(() => window.__workspaceUpdates), {
            timeout: revisionTimeout,
          })
          .toBeGreaterThan(fallbackUpdates);
        await expect(row(fallback, "Local task"))
          .toHaveCount(1, {
            timeout: 5000,
          })
          .catch((error) => {
            console.error(
              "HTTP fallback transition diagnostic",
              JSON.stringify({ engine, requests: fallbackRequests }),
            );
            throw error;
          });
        await expect(fallback.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        await expect(fallback.locator(".connection-notice")).toHaveCount(0);
        assert(
          httpEventRows.has(eventId),
          "HTTP fallback renders current production events",
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${engine}/companion: Working -> Done, retained history, concurrent refresh, reconnect, HTTP fallback health${remote ? ", linked source isolation" : ""}`,
        );
      } finally {
        for (const page of context?.pages() || []) {
          await drainPageRoutes(page);
          await page.unrouteAll({ behavior: "wait" });
        }
        await context?.unrouteAll({ behavior: "wait" });
        await context?.close();
        await fixture?.close();
        await remote?.close();
      }
    }
  } finally {
    await browser.close();
  }
}
