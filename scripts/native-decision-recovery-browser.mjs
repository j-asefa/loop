import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";

for (const engine of process.env.LOOP_BROWSER
  ? [process.env.LOOP_BROWSER]
  : ["chromium", "webkit"]) {
  const fixture = await cardsFixture(true, { projectedWrites: true });
  const browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(engine === "chromium" ? { args: ["--no-sandbox"] } : {}),
  });
  try {
    const { db, owner } = fixture,
      now = Date.now();
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('agent',?,'Local','local','openai','fixture',?)",
    ).run(owner, now);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('thread',?,'agent','Recovery task',?)",
    ).run(owner, now);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('live',?,'agent','thread','Recovery task','running','live',?,?)",
    ).run(owner, now, now);
    db.prepare(
      "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES('pending','live','thread','fixture','adapter',?,?)",
    ).run(
      JSON.stringify({
        id: "adapter",
        kind: "approval",
        title: "Pending recovery decision",
        detail: "Fixture only",
        choices: ["allow", "deny"],
      }),
      now,
    );
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const [name, value] = fixture.browser.cookie.split("=");
    await context.addCookies([
      { name, value, url: fixture.origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.routeWebSocket("**/api/events/multiplex/ws", (socket) =>
      socket.close(),
    );
    let polls = 0,
      reads = 0,
      blocked = true;
    await context.route(
      (url) => url.pathname === "/api/events",
      (route) => {
        polls++;
        return route.fulfill({ json: [] });
      },
    );
    await context.route(
      (url) => url.pathname === "/api/native/decisions",
      (route) => {
        reads++;
        return blocked
          ? route.fulfill({
              status: 503,
              json: { error: "Temporary decision outage" },
            })
          : route.continue();
      },
    );
    const page = await context.newPage();
    await page.goto(fixture.origin + "/?filter=working");
    await expect
      .poll(() => reads, { timeout: 15000 })
      .toBeGreaterThanOrEqual(3);
    // Let all bounded read retries exhaust while the event feed remains quiet.
    await page.waitForTimeout(10000);
    blocked = false;
    const before = { reads, polls };
    await page.waitForTimeout(6500);
    const after = {
      reads,
      polls,
      visible: await page
        .getByRole("heading", { name: "Pending recovery decision" })
        .count(),
    };
    console.log(JSON.stringify({ before, after }));
    assert(after.polls > before.polls, "shared HTTP polling stayed active");
    assert(
      after.reads > before.reads,
      "the shared watcher retries failed snapshots",
    );
    assert.equal(
      after.visible,
      1,
      "the pending decision appears without a wake or new event",
    );
    console.log(
      `${engine}: pending decision recovered while event polls stayed empty`,
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
}
