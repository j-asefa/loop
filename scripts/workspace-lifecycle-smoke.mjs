import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium, webkit, expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const evidence = process.env.LOOP_LIFECYCLE_EVIDENCE;
if (evidence) mkdirSync(evidence, { recursive: true });
for (const engine of [chromium, webkit]) {
  const fixture = await designFixture();
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => {
      if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
        errors.push(error.message);
    });
    const dialog = () => page.locator("dialog[open]").last();
    const nav = (name) =>
      page
        .locator(".mobile-nav")
        .getByRole("button", { name, exact: true })
        .click();
    await page.goto(fixture.base);
    await expect(page.locator(".feed-card").first()).toBeVisible();
    await expect(
      page.locator(".page-heading .feed-compose-button"),
    ).toHaveCount(0);
    const firstTitle = await page.locator(".feed-card h2").first().innerText();
    const card = page.locator(".feed-card").filter({
      has: page.getByRole("heading", { name: firstTitle, exact: true }),
    });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Unsave", exact: true }),
    ).toBeVisible();
    await nav("Saved");
    await expect(card).toBeVisible();
    await expect(page.locator(".feed-card")).toHaveCount(1);
    await expect(card.locator(".preview")).toContainText("Review complete");
    await expect(
      card.getByRole("button", { name: "Reply", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Filter by project")).toBeVisible();
    await card.evaluate((element) => {
      window.savedCard = element;
      window.savedRemoved = false;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations)
          for (const node of mutation.removedNodes)
            if (node === element || node.contains?.(element))
              window.savedRemoved = true;
      });
      observer.observe(element.parentElement, { childList: true });
    });
    await page.route(
      "**/api/feed/updates?*",
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Temporary saved refresh failure" },
        }),
      { times: 1 },
    );
    await expect(page.getByRole("alert")).toHaveText(
      /Temporary saved refresh failure/,
    );
    await expect(card).toBeVisible();
    assert(
      await card.evaluate(
        (element) => window.savedCard === element && !window.savedRemoved,
      ),
    );
    for (let i = 0; i < 3; i++)
      await page.waitForResponse(
        (r) =>
          r.url().includes("/api/feed/updates?") &&
          r.url().includes("saved=1") &&
          r.ok(),
      );
    assert(
      await card.evaluate(
        (element) => window.savedCard === element && !window.savedRemoved,
      ),
      "Polling must not unmount saved cards",
    );
    const saved = (await fixture.api("/feed?saved=1")).items[0];
    fixture.db
      .prepare(
        "UPDATE artifacts SET content=?||content,version=version+1 WHERE id=?",
      )
      .run("Live edit stays on the same card.\n\n", saved.id);
    await expect(card.locator(".preview")).toContainText(
      "Live edit stays on the same card.",
    );
    assert(
      await card.evaluate(
        (element) => window.savedCard === element && !window.savedRemoved,
      ),
    );
    await page
      .getByLabel("Filter by project")
      .selectOption(fixture.projects[2].id);
    await expect(
      page.getByRole("heading", { name: "No saved cards yet." }),
    ).toBeVisible();
    await page.getByLabel("Filter by project").selectOption("");
    await expect(card).toBeVisible();
    const team = await fixture.api("/teams", {
      name: `Saved ${engine.name()}`,
      managerId: fixture.agents[8].id,
      members: [fixture.agents[9].id],
    });
    fixture.db
      .prepare("UPDATE conversations SET team_id=? WHERE id=?")
      .run(team.id, saved.conversation_id);
    await page.reload();
    await page.getByRole("button", { name: /^Filter by team:/ }).click();
    await dialog().getByLabel(team.name, { exact: true }).check();
    await dialog().getByRole("button", { name: "Done", exact: true }).click();
    await expect(card).toBeVisible();
    if (evidence)
      await page.screenshot({ path: `${evidence}/${engine.name()}-saved.png` });
    await card.getByRole("button", { name: "Unsave", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No saved cards yet." }),
    ).toBeVisible();
    await nav("Feed");
    await expect(card).toBeVisible();

    // Failed requests leave the confirmation usable, then the same action can
    // be retried without losing agents, history or the selected-filter state.
    await page.getByRole("button", { name: /^Filter by team:/ }).click();
    await dialog()
      .getByRole("button", { name: "Delete team", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await page.route(
      `**/api/teams/${team.id}`,
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Temporary delete failure" },
        }),
      { times: 1 },
    );
    await dialog()
      .getByRole("button", { name: "Delete team", exact: true })
      .click();
    await expect(dialog().getByRole("alert")).toHaveText(
      "Temporary delete failure",
    );
    await dialog()
      .getByRole("button", { name: "Delete team", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Filter by team: All teams",
        exact: true,
      }),
    ).toBeVisible();
    assert(!(await fixture.api("/teams")).some((t) => t.id === team.id));

    const agent = fixture.agents.at(-1);
    await page
      .locator(".agent-strip")
      .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) })
      .click();
    await page
      .getByRole("button", { name: "Retire agent", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: "Retire agent", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Restore agent", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".profile-actions")
        .getByRole("button", { name: "Message", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Back to feed", exact: true })
      .click();
    await expect(
      page
        .locator(".agent-strip")
        .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /Manage agents/ }).click();
    await dialog()
      .getByRole("button", { name: "Retired agents", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: new RegExp(`@${agent.name}`) })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Restore agent", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: "Restore agent", exact: true })
      .click();
    await expect(
      page
        .locator(".profile-actions")
        .getByRole("button", { name: "Message", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Back to feed", exact: true })
      .click();
    await expect(
      page
        .locator(".agent-strip")
        .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) }),
    ).toBeAttached();

    // Browser-issued subscription fixture: exercise permission and server
    // persistence without sending any push or contacting a real push service.
    await context.addInitScript(() => {
      let enabled = sessionStorage.getItem("test-push") === "on";
      const json = {
        endpoint: "https://web.push.apple.com/test-lifecycle",
        keys: {
          p256dh: btoa(String.fromCharCode(4) + "a".repeat(64))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", ""),
          auth: btoa("b".repeat(16)).replaceAll("=", ""),
        },
      };
      const subscription = {
        endpoint: json.endpoint,
        options: {},
        toJSON: () => json,
        unsubscribe: async () => {
          enabled = false;
          sessionStorage.removeItem("test-push");
          return true;
        },
      };
      const registration = {
        waiting: null,
        addEventListener() {},
        pushManager: {
          getSubscription: async () => (enabled ? subscription : null),
          subscribe: async (options) => {
            if (
              !options.userVisibleOnly ||
              options.applicationServerKey.length !== 65
            )
              throw Error("Missing VAPID key");
            enabled = true;
            sessionStorage.setItem("test-push", "on");
            return subscription;
          },
        },
      };
      Object.defineProperty(window, "PushManager", {
        configurable: true,
        value: class {},
      });
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          permission: "default",
          requestPermission: async () => {
            window.notificationUserActivation =
              navigator.userActivation?.isActive;
            return "granted";
          },
        },
      });
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => registration,
          ready: Promise.resolve(registration),
          addEventListener() {},
        },
      });
    });
    await page.reload();
    const notifications = async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /Result notifications/ }).click();
    };
    await notifications();
    await dialog()
      .getByRole("button", { name: "Enable notifications", exact: true })
      .click();
    await expect(dialog().getByRole("status")).toHaveText(
      "Result notifications are on for this device.",
    );
    assert.equal(
      await page.evaluate(() => window.notificationUserActivation),
      true,
      "Permission must be requested directly from a tap",
    );
    await page.reload();
    await notifications();
    await expect(
      dialog().getByRole("button", {
        name: "Turn off notifications",
        exact: true,
      }),
    ).toBeVisible();
    if (evidence)
      await page.screenshot({
        path: `${evidence}/${engine.name()}-notifications.png`,
      });
    await dialog()
      .getByRole("button", { name: "Turn off notifications", exact: true })
      .click();
    await expect(dialog().getByRole("status")).toHaveText(
      "Result notifications are off for this device.",
    );
    assert.deepEqual((await fixture.api("/notifications")).endpoints, []);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: bookmark feed stability, filters, team deletion recovery, retirement/restore, phone notification opt-in passed`,
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
}
