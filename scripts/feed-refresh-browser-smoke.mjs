// Fixture-only: lose collection notifications, then exercise the actual pull
// gesture against the compiled UI. Published answers use the production writer.
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  seedAgent,
  seedConversation,
  seedRun,
  seedMessage,
} from "../test/helpers/seed.ts";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { publishCompletedRunResult } from "../src/server/result-publication.ts";
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
    const publish = (id, agent, body, time = Date.now()) => {
      seedRun(db, {
        id,
        owner_id: owner,
        agent_id: agent,
        conversation_id: agent,
        input: body,
        state: "completed",
        idempotency_key: id,
        created_at: time,
        updated_at: time,
      });
      seedMessage(db, {
        id: "m-" + id,
        owner_id: owner,
        conversation_id: agent,
        run_id: id,
        role: "assistant",
        content: body,
        created_at: time,
      });
      publishCompletedRunResult(id, owner, db);
    };
    for (let i = 0; i < 55; i++)
      publish("old-" + i, "astra", "Retained answer " + i, at + i);
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
    await page.getByRole("button", { name: /Load more/i }).click();
    await expect(card("Retained answer 0")).toHaveCount(1);
    await page.evaluate(() => (window.__suppressFeedNotifications = true));
    // Let any previously queued read finish before injecting missing results.
    await page.waitForTimeout(3500);
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
    // Replies uses the Feed's shared bounded read recovery. A pull during that
    // recovery must restart it even when the new read fails without Retry-After.
    const feedReads = (url) =>
      url.pathname.endsWith("/feed") &&
      url.searchParams.get("filter") === "replies";
    const repliesLoaded = page.waitForResponse(
      (response) => feedReads(new URL(response.url())) && response.ok(),
    );
    await page.getByRole("tab", { name: /^Replies/ }).click();
    await repliesLoaded;
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
    publish("automatic-recovery", "astra", "Background recovery stimulus");
    await expect(page.getByRole("alert")).toContainText(
      "Transient recovery fixture unavailable",
    );
    await page.evaluate(() => (window.__suppressFeedNotifications = true));
    const beforeRecoveryPull = recoveryAttempts;
    await expect(page.locator(".pull-refresh.refreshing")).toHaveCount(0);
    await pull();
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
    await page.unroute(feedReads);
    console.log(
      `PASS ${engine.name()}: pull recovers both missing results, retains loaded history, retries failure, and preserves live delivery and automatic recovery`,
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
