// Fixture-only: lose collection notifications, then exercise the actual pull
// gesture against the compiled UI. Published answers use the production writer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  seedAgent,
  seedConversation,
  seedRun,
  seedMessage,
} from "../test/helpers/seed.ts";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { publishCompletedRunResult } from "../src/server/result-publication.ts";
import { insert as insertLaterItem } from "../src/server/sql/later-items.ts";
import { chromiumExecutable, selectedEngines } from "./helpers/engines.mjs";

for (const engine of selectedEngines()) {
  const fixture = await cardsFixture(true, { projectedWrites: true });
  let browser;
  try {
    const { db, owner } = fixture;
    const at = Date.now() - 100_000;
    for (const agent of ["gemini", "astra"]) {
      seedAgent(db, {
        id: agent,
        owner_id: owner,
        name: agent,
        normalized_name: agent,
        provider: "openai",
        model: "fixture",
        created_at: at,
      });
      seedConversation(db, {
        id: agent,
        owner_id: owner,
        agent_id: agent,
        title: agent + " task",
        created_at: at,
      });
    }
    const publish = (
      id,
      agent,
      body,
      time = Date.now(),
      conversation = agent,
    ) => {
      seedRun(db, {
        id,
        owner_id: owner,
        agent_id: agent,
        conversation_id: conversation,
        input: body,
        state: "completed",
        idempotency_key: id,
        created_at: time,
        updated_at: time,
      });
      seedMessage(db, {
        id: "m-" + id,
        owner_id: owner,
        conversation_id: conversation,
        run_id: id,
        role: "assistant",
        content: body,
        created_at: time,
      });
      publishCompletedRunResult(id, owner, db);
    };
    for (let i = 0; i < 55; i++)
      publish("old-" + i, "astra", "Retained answer " + i, at + i);
    const group = randomUUID();
    const grouped = await fixture.request("/api/feed/threads", {
      headers: fixture.browser,
      body: {
        id: group,
        title: "Grouped old answers",
        cardIds: ["d:run:old-40", "d:run:old-41"],
      },
    });
    assert.equal(grouped.status, 200);
    browser = await engine.launch({
      headless: true,
      executablePath: chromiumExecutable(engine),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    const [name, value] = fixture.browser.cookie.split("=");
    await context.addCookies([
      { name, value, url: fixture.origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.addInitScript(() => {
      // Leave transport, publication and HTTP reads intact. Only withhold the
      // collection wakeup, modelling a missed notification on the mounted view.
      window.addEventListener(
        "loop-workspace-change",
        (event) => {
          if (window.__suppressFeedNotifications)
            event.stopImmediatePropagation();
        },
        true,
      );
      window.__pullRefreshes = 0;
      window.addEventListener("loop-refresh", () => window.__pullRefreshes++);
    });
    const page = await context.newPage();
    const doneRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.includes("/cards") &&
        url.searchParams.get("view") === "done"
      )
        doneRequests.push(url.pathname);
    });
    const feed = page.locator(".feed-results");
    const card = (text) =>
      feed.locator(".feed-item-card").filter({ hasText: text });
    const pull = async () => {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        const target = document.body;
        // Touch-shaped events also work in WebKit, which does not expose the
        // Touch constructor in every headless configuration.
        const dispatch = (type, y) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, "touches", {
            value:
              y === null
                ? []
                : [{ identifier: 1, target, clientX: 180, clientY: y }],
          });
          target.dispatchEvent(event);
        };
        dispatch("touchstart", 100);
        dispatch("touchmove", 280);
        dispatch("touchend", null);
      });
    };
    await page.goto(fixture.origin + "/?filter=done");
    await expect(card("Retained answer 54")).toHaveCount(1);
    await expect(card("Grouped old answers")).toHaveCount(1);
    let heldDoneAppend;
    let failDoneAppend = true;
    const olderDone = (url) =>
      url.pathname.endsWith("/cards") &&
      url.searchParams.get("view") === "done" &&
      url.searchParams.has("before");
    await page.route(olderDone, (route) => {
      if (!heldDoneAppend) heldDoneAppend = route;
      else if (failDoneAppend)
        return route.fulfill({
          status: 503,
          json: { error: "Older Done page unavailable" },
        });
      else return route.continue();
    });
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect.poll(() => !!heldDoneAppend).toBe(true);
    await page.evaluate(() => (window.__suppressFeedNotifications = true));
    publish(
      "head-before-append",
      "gemini",
      "New head despite failed older page",
    );
    await pull();
    await expect(card("New head despite failed older page")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText(
      "Older Done page unavailable",
    );
    publish("another-head", "gemini", "Another head despite failed older page");
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    await pull();
    await expect(card("Another head despite failed older page")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText(
      "Older Done page unavailable",
    );
    failDoneAppend = false;
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    await pull();
    await expect(card("Retained answer 0")).toHaveCount(1);
    await heldDoneAppend.continue();
    await page.unroute(olderDone);
    await page.evaluate(() => (window.__pullRefreshes = 0));
    await page.evaluate(() => (window.__suppressFeedNotifications = true));
    // Let any previously queued read finish before injecting missing results.
    await page.waitForTimeout(3500);
    const ungrouped = await fixture.request("/api/feed/threads/" + group, {
      method: "DELETE",
      headers: fixture.browser,
    });
    assert.equal(ungrouped.status, 200);
    publish("new-gemini", "gemini", "Recovered Gemini answer");
    publish("new-astra", "astra", "Recovered Astra answer");
    await page.waitForTimeout(3500);
    await expect(card("Recovered Gemini answer")).toHaveCount(0);
    await expect(card("Recovered Astra answer")).toHaveCount(0);
    const before = doneRequests.length;
    await pull();
    await expect(card("Recovered Gemini answer")).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(card("Recovered Astra answer")).toHaveCount(1);
    await expect(card("Grouped old answers")).toHaveCount(0);
    await expect(card("Retained answer 41")).toHaveCount(1);
    await expect(card("Retained answer 0")).toHaveCount(1);
    assert(
      doneRequests.length > before,
      "pull must read Done, not just Results",
    );
    assert.equal(await page.evaluate(() => window.__pullRefreshes), 1);
    // A failed explicit refresh keeps the visible window; another pull retries
    // the head and does not require a reload or Load more.
    publish("retry", "astra", "Recovered after failed refresh");
    const changes = (url) =>
      url.pathname.endsWith("/cards/changes") &&
      url.searchParams.get("view") === "done";
    await page.route(changes, (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Refresh fixture unavailable" },
      }),
    );
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    await pull();
    await expect(page.getByRole("alert")).toContainText(
      "Refresh fixture unavailable",
    );
    await expect(card("Retained answer 0")).toHaveCount(1);
    await page.unroute(changes);
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    await pull();
    await expect(card("Recovered after failed refresh")).toHaveCount(1);
    await expect(card("Retained answer 0")).toHaveCount(1);
    // Restore live delivery as a control: no explicit refresh or reload.
    await page.evaluate(() => (window.__suppressFeedNotifications = false));
    publish("live", "gemini", "Normal live delivery control");
    await expect(card("Normal live delivery control")).toHaveCount(1, {
      timeout: 10_000,
    });
    let heldDone;
    await page.route(changes, (route) => {
      if (!heldDone) heldDone = route;
      else return route.continue();
    });
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [""] },
        }),
      );
      window.__suppressFeedNotifications = true;
    });
    await expect.poll(() => !!heldDone).toBe(true);
    publish("stalled-done", "gemini", "Recovered despite stalled Done read");
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    await pull();
    await expect(card("Recovered despite stalled Done read")).toHaveCount(1);
    await heldDone.continue();
    await page.unroute(changes);
    await expect(card("Retained answer 0")).toHaveCount(1);
    const publishThread = (id, body, time = Date.now()) => {
      seedConversation(db, {
        id,
        owner_id: owner,
        agent_id: "astra",
        title: body,
        created_at: time,
      });
      publish(id, "astra", body, time, id);
    };
    // Agent profiles use filter=all. Their loaded thread pages must survive a
    // pull too, including when the first page is already fully populated.
    for (let i = 0; i < 105; i++)
      publishThread("history-" + i, "History thread " + i, at + i);
    await page.goto(fixture.origin + "/?agent=astra");
    await expect(
      page.getByText("No results yet.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Threads", exact: true }).click();
    await expect(card("History thread 104")).toHaveCount(1);
    let heldAppend;
    const olderThreads = (url) =>
      url.pathname.endsWith("/feed") &&
      url.searchParams.get("filter") === "all" &&
      url.searchParams.has("before");
    await page.route(olderThreads, (route) => {
      if (!heldAppend) heldAppend = route;
      else return route.continue();
    });
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect.poll(() => !!heldAppend).toBe(true);
    await pull();
    await expect(card("History thread 30")).toHaveCount(1);
    await heldAppend.continue();
    await page.unroute(olderThreads);
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect(card("History thread 0")).toHaveCount(1);
    await page.evaluate(() => (window.__suppressFeedNotifications = true));
    const historyRead = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/feed") &&
        url.searchParams.get("filter") === "all" &&
        url.searchParams.has("before")
      );
    });
    // Establish a saved background-reconciliation cursor after page two.
    await page.evaluate(() => {
      window.__suppressFeedNotifications = false;
      window.dispatchEvent(
        new CustomEvent("loop-workspace-change", {
          detail: { sources: [""] },
        }),
      );
      window.__suppressFeedNotifications = true;
    });
    await (await historyRead).finished();
    await page.waitForTimeout(100);
    // A thread on the third page leaves this view on another device. The pull
    // must reconcile that deep interval without another notification or gesture.
    insertLaterItem(
      db,
      randomUUID(),
      owner,
      "conversation",
      "history-10",
      "time",
      Date.now() + 3_600_000,
      null,
      Date.now(),
    );
    insertLaterItem(
      db,
      randomUUID(),
      owner,
      "conversation",
      "history-50",
      "time",
      Date.now() + 3_600_000,
      null,
      Date.now(),
    );
    publishThread("pulled-thread", "New thread recovered by pull");
    await pull();
    await expect(card("New thread recovered by pull")).toHaveCount(1);
    await expect(card("History thread 0")).toHaveCount(1);
    await expect(
      feed.getByRole("heading", { name: "History thread 10", exact: true }),
    ).toHaveCount(0);
    await expect(
      feed.getByRole("heading", { name: "History thread 50", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => (window.__suppressFeedNotifications = false));
    insertLaterItem(
      db,
      randomUUID(),
      owner,
      "conversation",
      "history-20",
      "time",
      Date.now() + 3_600_000,
      null,
      Date.now(),
    );
    await expect(
      feed.getByRole("heading", { name: "History thread 20", exact: true }),
    ).toHaveCount(0);
    // This view also uses the shared bounded read recovery. Observe the old
    // read's cancellation so an already scheduled retry cannot satisfy the test.
    const feedReads = (url) =>
      url.pathname.endsWith("/feed") &&
      url.searchParams.get("filter") === "all";
    await page.evaluate(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = new URL(String(input), location.href);
        if (
          url.pathname.endsWith("/feed") &&
          url.searchParams.get("filter") === "all" &&
          !window.__backgroundFeedSignal
        )
          window.__backgroundFeedSignal = init?.signal;
        return fetch(input, init);
      };
    });
    let unavailable = true;
    let recoveryAttempts = 0;
    await page.route(feedReads, (route) => {
      recoveryAttempts++;
      return unavailable
        ? route.fulfill({
            status: 503,
            json: { error: "Transient recovery fixture unavailable" },
          })
        : route.continue();
    });
    publishThread("automatic-recovery", "Recovered without another pull");
    await expect(page.getByRole("alert")).toContainText(
      "Transient recovery fixture unavailable",
    );
    await page.evaluate(() => (window.__suppressFeedNotifications = true));
    const beforeRecoveryPull = recoveryAttempts;
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    assert.equal(
      await page.evaluate(() => window.__backgroundFeedSignal?.aborted),
      false,
    );
    await pull();
    assert.equal(
      await page.evaluate(() => window.__backgroundFeedSignal?.aborted),
      true,
      "the pull must cancel the prior recovery before starting its fresh read",
    );
    await expect
      .poll(() => recoveryAttempts)
      .toBeGreaterThan(beforeRecoveryPull);
    // Restore the server only. No notification, reload or further pull may be
    // needed after the pull replaced the background read.
    unavailable = false;
    await expect
      .poll(() => recoveryAttempts, { timeout: 10_000 })
      .toBeGreaterThan(beforeRecoveryPull + 1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(card("Recovered without another pull")).toHaveCount(1);
    await expect(card("History thread 0")).toHaveCount(1);
    await page.unroute(feedReads);
    const workingThread = (i, time) => {
      const id = "working-" + i;
      seedConversation(db, {
        id,
        owner_id: owner,
        agent_id: "astra",
        title: "Working thread " + i,
        created_at: time,
      });
      seedRun(db, {
        id,
        owner_id: owner,
        agent_id: "astra",
        conversation_id: id,
        input: "Working thread " + i,
        state: "running",
        idempotency_key: id,
        created_at: time,
        updated_at: time,
      });
    };
    for (let i = 0; i < 105; i++) workingThread(i, at + i);
    await page.goto(fixture.origin + "/?filter=working");
    await expect(card("Working thread 104")).toHaveCount(1);
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect(card("Working thread 40")).toHaveCount(1);
    let heldWorking;
    const workingAppend = (url) =>
      url.pathname.endsWith("/feed") &&
      url.searchParams.get("filter") === "working" &&
      url.searchParams.has("before");
    await page.route(workingAppend, (route) => {
      if (!heldWorking) heldWorking = route;
      else return route.continue();
    });
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect.poll(() => !!heldWorking).toBe(true);
    const burstAt = Date.now();
    for (let i = 0; i < 100; i++) workingThread("burst-" + i, burstAt + i);
    await pull();
    await expect(card("Working thread 0")).toHaveCount(1);
    await expect(card("Working thread 40")).toHaveCount(1);
    await heldWorking.continue();
    await page.unroute(workingAppend);
    console.log(
      `PASS ${engine.name()}: pull recovers both missing results, retains loaded history, retries failure, and preserves live delivery and automatic recovery`,
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
