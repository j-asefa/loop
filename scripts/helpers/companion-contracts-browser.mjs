import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import {
  isWebKitNavigationFetchError,
  collectionReadRecovery,
} from "./browser-errors.mjs";

// Inspect current paired production responses while exercising their views.
export async function companionContractsBrowser({ browser, host, db }) {
  // The main smoke sets its isolated data directory before loading server modules.
  const { applyActivity } = await import("../../dist/server/activities.js");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => {
    // Match the main smoke's WebKit diagnostic for reads cancelled by navigation.
    if (
      !isWebKitNavigationFetchError(
        process.env.LOOP_BROWSER,
        error,
        host.origin,
      )
    )
      errors.push(error.message);
  });
  let setupReads = 0,
    historyReads = 0,
    activityReads = 0;
  await context.route(/\/api\/workspace\/runtimes(\?.*)?$/, async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    assert(response.ok());
    assert("setup" in body);
    setupReads++;
    await route.fulfill({ response, json: body });
  });
  await context.route(/\/api\/native\/history\/[^/?]+$/, async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    assert(response.ok());
    assert(Array.isArray(body.activities));
    historyReads++;
    await route.fulfill({ response, json: body });
  });
  await context.route(
    /\/api\/conversations\/[^/]+\/activities(\?.*)?$/,
    async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      assert(response.ok());
      if (
        new URL(route.request().url()).searchParams.get("view") === "recent"
      ) {
        assert("earlier" in body);
        activityReads++;
      }
      await route.fulfill({ response, json: body });
    },
  );
  try {
    await page.goto(host.pair().url);
    await page
      .getByRole("button", { name: "Pair and open Loop", exact: true })
      .click();
    const settings = async (name) => {
      await page
        .getByRole("button", { name: "Open settings", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: new RegExp(name) })
        .click();
    };
    await settings("Provider connections");
    const connections = page.getByRole("dialog", {
      name: "Provider connections",
      exact: true,
    });
    await expect(connections).toContainText("Claude Code");
    await expect.poll(() => setupReads).toBeGreaterThan(0);
    await expect(connections.getByRole("alert")).toHaveCount(0);
    await page.goto(host.origin);
    await settings("Native conversations");
    const history = page.getByRole("dialog", {
      name: "Native conversations",
      exact: true,
    });
    await history
      .getByRole("button", { name: "Other Codex", exact: true })
      .click();
    await history
      .getByRole("button", { name: /Discover Codex history/ })
      .click();
    await history
      .getByRole("button", { name: /External fixture history/ })
      .click();
    await expect(
      history.getByText("Native saved context", { exact: true }),
    ).toBeVisible();
    assert(historyReads > 0);
    await expect(history.getByRole("alert")).toHaveCount(0);
    await collectionReadRecovery(page, {
      route: (url) => url.pathname === "/api/native/history",
      automaticRecovery: false,
      scope: history,
      start: () =>
        history.getByRole("button", { name: /Discover Codex history/ }).click(),
    });
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: `test-results/companion-contracts-${process.env.LOOP_BROWSER || "chromium"}-history.png`,
      fullPage: true,
    });

    const run = db
      .prepare(
        "SELECT r.id,r.conversation_id FROM runs r JOIN agents a ON a.id=r.agent_id WHERE a.name='setting-recovery' AND r.state='completed' ORDER BY r.created_at DESC LIMIT 1",
      )
      .get();
    assert(run);
    assert(
      applyActivity(
        {
          owner: "local-workspace",
          conversation: run.conversation_id,
          run: run.id,
        },
        {
          v: 1,
          kind: "plan",
          id: "contract-projection",
          source: {
            transport: "native",
            harness: "claude",
            origin: "contract-browser",
          },
          patch: {
            steps: [
              {
                id: "read",
                title: "Read current projection",
                status: "completed",
              },
            ],
          },
        },
      ).applied,
    );
    await page.goto(host.origin + "/?conversation=" + run.conversation_id);
    await page
      .getByRole("button", { name: "Conversation options", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    const activity = page.getByRole("dialog", {
      name: "Tool activity",
      exact: true,
    });
    await expect(
      activity.getByText("Read current projection", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => activityReads).toBeGreaterThan(0);
    await expect(activity.getByRole("alert")).toHaveCount(0);
    await expect(
      activity.getByRole("button", {
        name: "Load earlier activity",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `test-results/companion-contracts-${process.env.LOOP_BROWSER || "chromium"}-activities.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log("Current companion contracts render:", {
      setupReads,
      historyReads,
      activityReads,
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await context.unrouteAll({ behavior: "wait" });
    await context.close();
  }
}
