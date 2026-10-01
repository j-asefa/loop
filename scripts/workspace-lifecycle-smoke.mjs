import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const evidence = process.env.LOOP_LIFECYCLE_EVIDENCE;
if (evidence) mkdirSync(evidence, { recursive: true });
for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  const browser = await engine.launch({
    executablePath:
      engine === chromium ? process.env.CHROMIUM_PATH || undefined : undefined,
  });
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
    const inboxFilter = (name) =>
      page
        .locator(".inbox")
        .getByRole("tablist", { name: "Show" })
        .getByRole("tab", { name, exact: true });
    // The header Settings button became the "Account and settings" menu.
    const accountMenu = async (item) => {
      await page
        .getByRole("button", { name: "Account and settings", exact: true })
        .click();
      await dialog()
        .getByRole("menuitem", { name: new RegExp(`^${item}`) })
        .click();
    };
    const openSettings = async () => {
      await accountMenu("Settings");
      await expect(
        page.getByRole("dialog", { name: "Settings", exact: true }),
      ).toBeVisible();
    };
    await page.goto(fixture.base);
    await expect(
      page.getByRole("heading", { name: "Feed", level: 1, exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".page-heading .feed-compose-button"),
    ).toHaveCount(0);
    // Finished results live on their agent's profile.
    const author = fixture.db
      .prepare(
        "SELECT g.name FROM agents g JOIN artifacts a ON a.agent_id=g.id WHERE a.id=?",
      )
      .get(fixture.artifacts[0]).name;
    await page
      .locator(".agent-strip")
      .getByRole("button", { name: new RegExp(`^@${author} ·`) })
      .click();
    const results = page.locator(".feed-card:not(.inbox-card)");
    await expect(results.first()).toBeVisible();
    const firstTitle = await results.locator("h2").first().innerText();
    const card = page.locator(".feed-card").filter({
      has: page.getByRole("heading", { name: firstTitle, exact: true }),
    });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Remove from Saved", exact: true }),
    ).toBeVisible();
    // Saved results and saved messages share Later → Saved.
    await nav("Later");
    await expect(
      page.getByRole("heading", { name: "Later", level: 1, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Saved", exact: true }),
    ).toBeVisible();
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
    // A failed refresh keeps the loaded list and says so.
    await page.route(
      "**/api/saved?*",
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Temporary saved refresh failure" },
        }),
      { times: 1 },
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-later-change")),
    );
    await expect(page.getByRole("alert")).toHaveText(
      /Temporary saved refresh failure/,
    );
    await expect(card).toBeVisible();
    const saved = (await fixture.api("/saved")).items.find(
      (item) => item.kind === "result",
    ).result;
    fixture.db
      .prepare(
        "UPDATE artifacts SET content=?||content,version=version+1 WHERE id=?",
      )
      .run("Live edit stays on the same card.\n\n", saved.id);
    // Refreshing updates cards in place rather than remounting them.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-later-change")),
    );
    await expect(card.locator(".preview")).toContainText(
      "Live edit stays on the same card.",
    );
    assert(
      await card.evaluate(
        (element) => window.savedCard === element && !window.savedRemoved,
      ),
      "Refreshing must not unmount saved cards",
    );
    await page
      .getByLabel("Filter by project")
      .selectOption(fixture.projects[2].id);
    await expect(page.getByText("Tap Save on any result or message")).toBeVisible();
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
    await expect(
      page.getByRole("heading", { name: "Later", level: 1, exact: true }),
    ).toBeVisible();
    // The team filter lives on the Feed; its selection also scopes Later.
    await nav("Feed");
    await page.getByRole("button", { name: /^Filter by team:/ }).click();
    await dialog().getByLabel(team.name, { exact: true }).check();
    await dialog().getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: `Filter by team: ${team.name}`,
        exact: true,
      }),
    ).toBeVisible();
    await nav("Later");
    await expect(card).toBeVisible();
    if (evidence)
      await page.screenshot({ path: `${evidence}/${engine.name()}-saved.png` });
    await card
      .getByRole("button", { name: "Remove from Saved", exact: true })
      .click();
    await expect(page.getByText("Tap Save on any result or message")).toBeVisible();
    await nav("Feed");
    await expect(inboxFilter("All")).toHaveAttribute("aria-selected", "true");
    // The saved result's thread is in the selected team's Feed.
    await expect(
      page.locator(`.inbox-row[aria-label^="${saved.title}"]`),
    ).toBeVisible();

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
    // Retire and Restore moved into the profile's "Agent actions" menu.
    const agentAction = async (name) => {
      await page
        .getByRole("button", { name: "Agent actions", exact: true })
        .click();
      await dialog()
        .getByRole("menuitem", { name: new RegExp(`^${name}`) })
        .click();
      await dialog().getByRole("button", { name, exact: true }).click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    };
    await agentAction("Retire agent");
    await expect(
      page.getByRole("status").filter({ hasText: /^Retired/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Agent actions", exact: true })
      .click();
    await expect(
      dialog().getByRole("menuitem", { name: /^Restore agent/ }),
    ).toBeVisible();
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page
        .locator(".profile-actions")
        .getByRole("button", { name: "Message", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page
        .locator(".agent-strip")
        .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) }),
    ).toHaveCount(0);
    await openSettings();
    await page.getByRole("button", { name: /Manage agents/ }).click();
    await dialog()
      .getByRole("button", { name: "Retired agents", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: new RegExp(`@${agent.name}`) })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await agentAction("Restore agent");
    await expect(
      page.getByRole("status").filter({ hasText: /^Retired/ }),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".profile-actions")
        .getByRole("button", { name: "Message", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Back", exact: true }).click();
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
    // Settings → Notifications (formerly "Result notifications") and the
    // account menu's direct Notifications item open the same sheet.
    await openSettings();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Notifications", exact: true }),
    ).toBeVisible();
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
    await accountMenu("Notifications");
    await expect(
      page.getByRole("dialog", { name: "Notifications", exact: true }),
    ).toBeVisible();
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
