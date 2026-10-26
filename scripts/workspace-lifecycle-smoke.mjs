import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

const notificationsOnly = process.argv.includes("--notifications-only");
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
    // The header gear opens the settings drawer; its pages open from there.
    const accountMenu = async (item) => {
      await page
        .getByRole("button", { name: "Open settings", exact: true })
        .click();
      if (item !== "Settings")
        await dialog().getByRole("button", { name: item, exact: true }).click();
    };
    const openSettings = async () => {
      await accountMenu("Settings");
      await expect(
        page.getByRole("dialog", { name: "Settings", exact: true }),
      ).toBeVisible();
    };
    if (!notificationsOnly) {
      await page.goto(fixture.base);
      await expect(
        page.getByRole("heading", { name: "Feed", level: 1, exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".page-heading .feed-compose-button"),
      ).toHaveCount(0);
      // Finished results live on their agent's profile.
      const result = fixture.db
        .prepare(
          "SELECT g.name AS author, a.title FROM agents g JOIN artifacts a ON a.agent_id=g.id WHERE a.id=?",
        )
        .get(fixture.artifacts[0]);
      await page
        .locator(".agent-strip")
        .getByRole("button", { name: new RegExp(`^@${result.author} ·`) })
        .click();
      // Wait for this agent’s fixture result, not a stale card from the previous feed.
      const card = page.locator(".feed-card").filter({
        has: page.getByRole("heading", { name: result.title, exact: true }),
      });
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        card.getByRole("button", { name: "Remove from Saved", exact: true }),
      ).toBeVisible();
      // Saved results and saved messages share the Saved tab on your profile.
      const savedTab = () =>
        page
          .getByRole("region", { name: "Your profile", exact: true })
          .getByRole("tab", { name: "Saved", exact: true });
      await nav("Your profile");
      await savedTab().click();
      await expect(savedTab()).toHaveAttribute("aria-selected", "true");
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
      const savedReads = (url) =>
        /^\/api\/v1\/cards(?:\/changes)?$/.test(url.pathname) &&
        url.searchParams.get("view") === "saved";
      const failSaved = (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Temporary saved refresh failure" },
        });
      await page.route(savedReads, failSaved);
      await page.evaluate(() =>
        window.dispatchEvent(new Event("loop-later-change")),
      );
      await expect(page.getByRole("alert")).toHaveText(
        /Temporary saved refresh failure/,
        // The existing GET helper retries after two and four seconds.
        { timeout: 10000 },
      );
      await expect(card).toBeVisible();
      await page.unroute(savedReads, failSaved);
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
      await expect(
        page.getByText("Tap Save on any result or message"),
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
      await expect(
        page.getByRole("region", { name: "Your profile", exact: true }),
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
      await nav("Your profile");
      await savedTab().click();
      await expect(card).toBeVisible();
      if (evidence)
        await page.screenshot({
          path: `${evidence}/${engine.name()}-saved.png`,
        });
      await card
        .getByRole("button", { name: "Remove from Saved", exact: true })
        .click();
      await expect(
        page.getByText("Tap Save on any result or message"),
      ).toBeVisible();
      await nav("Feed");
      await expect(inboxFilter("Done")).toHaveAttribute(
        "aria-selected",
        "true",
      );
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
      await dialog()
        .getByRole("button", { name: "Close", exact: true })
        .click();
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
    } else {
      await page.goto(fixture.base);
    }

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
    // The button became a switch; its position is the state.
    await dialog()
      .getByRole("checkbox", { name: "Enable notifications" })
      .click();
    await expect(dialog().getByRole("status")).toHaveText(
      "Notifications are on for this device.",
    );
    await expect(
      dialog().getByRole("checkbox", { name: /^Needs you/ }),
    ).toBeChecked();
    for (const name of ["Completed work", "Reminders", "Social watches"])
      await expect(
        dialog().getByRole("checkbox", { name: new RegExp(`^${name}`) }),
      ).not.toBeChecked();
    await dialog()
      .getByRole("checkbox", { name: /^Completed work/ })
      .click();
    await expect(
      dialog().getByRole("checkbox", { name: /^Completed work/ }),
    ).toBeChecked();
    assert.equal(
      await page.evaluate(() => window.notificationUserActivation),
      true,
      "Permission must be requested directly from a tap",
    );
    await page.reload();
    if (!notificationsOnly) {
      // An agent-created pull request shows its automatic watch in the thread.
      const thread = fixture.db
        .prepare(
          "SELECT c.id,c.agent_id FROM conversations c WHERE c.owner_id=? AND c.agent_id IS NOT NULL ORDER BY c.created_at DESC LIMIT 1",
        )
        .get(fixture.owner);
      const prCard = randomUUID();
      fixture.db
        .prepare(
          "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,head_sha,since_at,next_poll_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'watching',?,?,0,?,?)",
        )
        .run(
          randomUUID(),
          fixture.owner,
          thread.id,
          thread.agent_id,
          "acme",
          "api",
          42,
          "a".repeat(40),
          Date.now(),
          Date.now(),
          Date.now(),
        );
      fixture.db
        .prepare(
          "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          prCard,
          fixture.owner,
          thread.agent_id,
          thread.id,
          "acme/api #42",
          "github_pr",
          JSON.stringify({
            type: "github_pull_requests",
            tool: "pull_request_read",
            fetchedAt: Date.now(),
            pulls: [
              {
                owner: "acme",
                repo: "api",
                number: 42,
                title: "Add rate limiting",
                url: "https://github.com/acme/api/pull/42",
                state: "open",
                headSha: "a".repeat(40),
              },
            ],
          }),
          Date.now(),
          Date.now(),
        );
      await page.goto(fixture.base + "/?artifact=" + prCard);
      const watch = page.getByRole("group", { name: "Watch pull request" });
      await expect(watch).toContainText("Watching. CI results, reviews");
      assert.equal(
        fixture.db
          .prepare(
            "SELECT state FROM pr_watches WHERE conversation_id=? AND number=42",
          )
          .get(thread.id).state,
        "watching",
      );
      if (evidence)
        await page.screenshot({
          path: `${evidence}/${engine.name()}-pr-watch.png`,
        });
      await watch
        .getByRole("button", { name: "Stop watching", exact: true })
        .click();
      await expect(watch).toContainText(
        "Stopped watching: You stopped watching.",
      );
      await expect(watch.getByRole("button")).toHaveCount(0);
    }
    await page.goto(fixture.base);
    await accountMenu("Notifications");
    await expect(
      page.getByRole("dialog", { name: "Notifications", exact: true }),
    ).toBeVisible();
    // Reopening shows the switch already on; turning it off uses the same
    // control rather than a separate button.
    const resultNotifications = () =>
      dialog().getByRole("checkbox", { name: "Enable notifications" });
    await expect(resultNotifications()).toBeChecked();
    await expect(
      dialog().getByRole("checkbox", { name: /^Needs you/ }),
    ).toBeChecked();
    await expect(
      dialog().getByRole("checkbox", { name: /^Completed work/ }),
    ).toBeChecked();
    await expect(
      dialog().getByRole("checkbox", { name: /^Reminders/ }),
    ).not.toBeChecked();
    await dialog()
      .getByRole("checkbox", { name: /^Completed work/ })
      .click();
    await expect(
      dialog().getByRole("checkbox", { name: /^Completed work/ }),
    ).not.toBeChecked();
    if (evidence)
      await page.screenshot({
        path: `${evidence}/${engine.name()}-notifications.png`,
      });
    await resultNotifications().click();
    await expect(dialog().getByRole("status")).toHaveText(
      "Notifications are off for this device.",
    );
    assert.deepEqual((await fixture.api("/notifications")).endpoints, []);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: ${notificationsOnly ? "notification categories, persistence and opt-in" : "bookmark feed stability, filters, team deletion recovery, retirement/restore, phone notification opt-in"} passed`,
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
}
