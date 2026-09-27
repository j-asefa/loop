import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";

import { workspaceControlsSmoke } from "./helpers/workspace-controls-smoke.mjs";
import { teamNavigationSmoke } from "./helpers/team-navigation-smoke.mjs";
import { profileNavigationSmoke } from "./helpers/profile-navigation-smoke.mjs";
import { replyKeyboardSmoke } from "./helpers/reply-keyboard-smoke.mjs";

const fixture = await designFixture();
const screenshots =
  process.env.LOOP_DESIGN_SCREENSHOT_DIR ||
  (process.env.CI ? join("docs", "loop-v0", "evidence") : undefined);
if (screenshots) mkdirSync(screenshots, { recursive: true });
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(
        `${engine.name()} page error at ${page.url()}: ${error.stack}`,
      );
    });
    const dialog = () => page.locator("dialog[open]").last();
    const capture = async (name) => {
      if (screenshots)
        await page.screenshot({
          path: join(screenshots, `${engine.name()}-${name}.png`),
        });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `Horizontal page overflow: ${name}`,
      );
    };
    const close = async () => {
      await dialog()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.waitForTimeout(100);
    };
    const nav = async (name) =>
      page
        .locator(".mobile-nav")
        .getByRole("button", { name, exact: true })
        .click();
    const openConversation = async (index = 0) => {
      await page.goto(
        fixture.base + "/?conversation=" + fixture.conversations[index].id,
      );
      await dialog()
        .getByRole("button", { name: "Commands & skills", exact: true })
        .waitFor();
      await expect(dialog().locator(".message").first()).toBeVisible();
    };
    try {
      await page.goto(fixture.base);
      await page.locator(".feed-card").first().waitFor();
      await capture("feed");
      const checkFirstResult = async () => {
        const author = page.locator(".feed-card .card-byline").first();
        await expect(author).toBeInViewport({ ratio: 1 });
        const byline = await author.boundingBox();
        const composer = await page.locator(".composer-launch").boundingBox();
        assert(
          byline.y + byline.height <= composer.y,
          `First result author must remain above the composer: ${JSON.stringify({ byline, composer })}`,
        );
      };
      await checkFirstResult();
      // System font metrics differ on Linux and macOS. A two-line subtitle is
      // valid; verify visible result identity instead of an absolute card offset.
      await page.locator(".page-description").evaluate((element) => {
        element.style.maxWidth = "240px";
      });
      await capture("feed-wrapped-description");
      await checkFirstResult();
      await page.locator(".page-description").evaluate((element) => {
        element.style.maxWidth = "";
      });
      await expect(
        page.getByRole("heading", { name: "Feed", exact: true }),
      ).toBeVisible();
      const shortcuts = page.getByRole("region", {
        name: "Your agents",
        exact: true,
      });
      await expect(shortcuts.locator(".agent-strip button")).toHaveCount(4);
      await expect(
        shortcuts.getByRole("button", { name: "New agent", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "New message", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Message your agent" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Collapse composer", exact: true })
        .click();

      // The response stays readable while its only primary action is Reply.
      const resultCard = page.locator(".feed-card").first();
      await resultCard
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await expect(dialog().locator(".result-author h2")).toContainText("@");
      await expect(
        dialog().getByRole("button", { name: "Copy", exact: true }),
      ).not.toBeVisible();
      await expect(
        dialog().getByRole("button", { name: "Use as prompt", exact: true }),
      ).not.toBeVisible();
      await expect(
        dialog().getByRole("textbox", { name: "Reply to agent" }),
      ).toBeInViewport({ ratio: 1 });
      await capture("result-reply");
      const requests = [];
      await page.route("**/api/runs", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          status: requests.length === 1 ? 503 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            requests.length === 1
              ? { error: "Fixture reply unavailable" }
              : { id: "accepted" },
          ),
        });
      });
      await dialog()
        .getByRole("textbox", { name: "Reply to agent" })
        .fill("Explain the next step");
      await dialog()
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await expect(dialog().getByRole("alert")).toContainText(
        "Fixture reply unavailable",
      );
      await close();
      await resultCard
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await expect(
        dialog().getByRole("textbox", { name: "Reply to agent" }),
      ).toHaveValue("Explain the next step");
      await dialog()
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
      const repliedConversation = fixture.db
        .prepare("SELECT agent_id FROM conversations WHERE id=?")
        .get(requests[1].conversationId);
      assert.equal(requests[1].agentId, repliedConversation.agent_id);
      await page.unroute("**/api/runs");
      await page
        .getByRole("button", { name: "All agents (11)", exact: true })
        .click();
      await dialog().getByRole("searchbox").fill("code-reviewer");
      await expect(dialog().locator(".project-agent")).toHaveCount(1);
      await dialog().locator(".project-agent").click();
      await expect(
        page.getByRole("heading", { name: "@code-reviewer", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".composer-launch")).toContainText(
        "@code-reviewer",
      );
      await expect(
        page.locator(".profile-head + .segmented button"),
      ).toHaveText(["Results", "Messages", "Files", "Traces", "Your prompts"]);
      await page.evaluate(() => scrollTo(0, 0));
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        for (const width of [320, 390, 768]) {
          await page.setViewportSize({ width, height: 844 });
          await capture(`profile-${theme}-${width}`);
          const header = await page.locator(".profile-head").boundingBox();
          const avatar = await page
            .locator(".profile-head > .avatar")
            .boundingBox();
          assert(
            Math.abs(
              header.x + header.width / 2 - avatar.x - avatar.width / 2,
            ) < 2,
            "Profile avatar stays centered",
          );
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "light"),
      );
      const longPrompt =
        "Review the navigation changes and runtime integration for this pull request. " +
        "Verify project switching, request recovery, account permissions and attachment handling. ".repeat(
          10,
        ) +
        "\n\n- Keep the draft after an error\n- Check the detailed evidence at https://example.com/" +
        "long-file-path-".repeat(40);
      fixture.db
        .prepare("UPDATE runs SET input=? WHERE id=?")
        .run(longPrompt, fixture.conversations[0].run);
      await page.getByRole("button", { name: "Traces", exact: true }).click();
      await page.locator(".trace-run").first().waitFor();
      const longRun = page.locator(".trace-run").filter({
        hasText: "Review the navigation changes and runtime integration",
      });
      assert(
        (await longRun.getByRole("heading").boundingBox()).height <= 49,
        "Long prompts must not take over the trace view",
      );
      await expect(longRun.locator(".trace-prompt")).not.toHaveAttribute(
        "open",
        "",
      );
      await longRun.locator(".trace-prompt summary").click();
      await expect(longRun.locator(".trace-prompt .markdown")).toContainText(
        "Check the detailed evidence",
      );
      await expect(longRun.locator(".trace-prompt li")).toHaveCount(2);
      await capture("trace-prompt-expanded");
      await longRun.locator(".trace-prompt summary").click();
      await longRun.locator(".trace-card summary").first().click();
      await expect(longRun.locator(".trace-log").first()).toContainText(
        "npm test\n\n35",
      );
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await capture(`traces-${width}`);
        assert(
          await page
            .locator(".trace-list")
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          "Traces overflow their container",
        );
      }
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "dark"),
      );
      await capture("traces-dark");
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "light"),
      );
      await openConversation();
      await capture("conversation");
      const dimensions = await dialog().evaluate((element) => ({
        height: element.clientHeight,
        scroll: element.scrollHeight,
        messages: element.querySelector(".messages").clientHeight,
      }));
      assert(
        dimensions.scroll <= dimensions.height + 1,
        "Conversation has an extra outer scroller",
      );
      assert(
        dimensions.messages > 430,
        "Conversation reading area is too short",
      );
      await page.getByLabel("Conversation options", { exact: true }).click();
      await dialog().locator(".native-conversation > summary").click();
      await expect(
        dialog().getByRole("checkbox", { name: "Include in shared memory" }),
      ).toBeVisible();
      assert(
        (await dialog().locator(".messages").evaluate((el) => el.clientHeight)) ===
          dimensions.messages,
        "Conversation controls shrink the reading area",
      );
      await dialog()
        .getByRole("button", { name: "Change model", exact: true })
        .click();
      assert(
        (await dialog().getByRole("radio").first().boundingBox()).width > 280,
      );
      assert(
        (await dialog().getByRole("radio").first().boundingBox()).height >= 44,
        "Model choice has a small touch target",
      );
      await capture("model");
      await page.goBack();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await page.getByLabel("Conversation options", { exact: true }).click();
      await dialog()
        .getByRole("button", {
          name: "Continue with another agent",
          exact: true,
        })
        .click();
      await expect(
        dialog().locator('input[type="checkbox"]').first(),
      ).toBeVisible();
      await close();
      await page.route("**/api/artifacts", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 422,
              contentType: "application/json",
              body: JSON.stringify({ error: "Synthetic save failure" }),
            })
          : route.continue(),
      );
      await dialog()
        .getByRole("button", { name: "Save as prompt", exact: true })
        .last()
        .click();
      await expect(dialog().getByRole("alert")).toContainText(
        "Synthetic save failure",
      );
      await page.unroute("**/api/artifacts");
      await dialog()
        .getByRole("button", { name: "Dismiss message", exact: true })
        .click();
      if (engine === chromium) {
        const client = await context.newCDPSession(page);
        const messages = dialog().locator(".messages");
        await messages.evaluate((element) => {
          element.scrollTop = 600;
        });
        const bounds = await messages.boundingBox();
        const swipe = async (x, y, distance) => {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y }],
          });
          for (let step = 1; step <= 6; step++)
            await client.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y + (distance * step) / 6 }],
            });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
          await page.waitForTimeout(260);
        };
        await swipe(bounds.x + 100, bounds.y + 120, 150);
        await expect(page.locator("dialog[open]")).toHaveCount(1);
        const grip = await page.locator(".sheet-grip").boundingBox();
        await swipe(grip.x + grip.width / 2, grip.y + grip.height / 2, 160);
        await expect(page.locator("dialog[open]")).toHaveCount(0);
      } else await close();
      const historyLength = await page.evaluate(() => history.length);
      for (let i = 0; i < 3; i++) {
        await page
          .locator(".feed-card")
          .first()
          .getByRole("button", { name: "Reply", exact: true })
          .click();
        await expect(
          dialog().getByRole("textbox", { name: "Reply to agent" }),
        ).toBeVisible();
        await close();
      }
      assert(
        (await page.evaluate(() => history.length)) <= historyLength + 1,
        "Closing sheets leaves redundant Back steps",
      );
      await page
        .getByLabel("Filter by project")
        .selectOption(fixture.projects[0].id);
      await expect(
        page.getByRole("button", { name: "All agents (4)", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".attention-banner b")).toHaveText("2");
      await nav("Running");
      await expect(page.getByLabel("Filter by project")).toHaveValue(
        fixture.projects[0].id,
      );
      await page.reload();
      await expect(page.getByLabel("Filter by project")).toHaveValue(
        fixture.projects[0].id,
      );
      await expect(
        page.locator('.mobile-nav [aria-current="page"]'),
      ).toContainText("Running");
      await page.getByLabel("Filter by project").selectOption("");
      await page
        .getByRole("button", { name: "Needs you", exact: true })
        .click();
      await page
        .locator(".run-card")
        .filter({ hasText: "Check why the GitHub review could not be posted" })
        .getByRole("button", { name: "View failure details", exact: true })
        .click();
      await expect(dialog()).toHaveAttribute(
        "aria-label",
        "Run failure details",
      );
      await expect(dialog()).toContainText(
        "The tool could not complete the request",
      );
      await expect(dialog().locator(".trace-run")).toHaveCount(1);
      await capture("failure-details");
      await close();
      await page.locator(".approval-summary").click();
      await capture("approval");
      await expect(dialog()).toContainText("sample/loop #42");
      const action = dialog().getByRole("button", {
        name: "Approve and continue",
        exact: true,
      });
      await action.scrollIntoViewIfNeeded();
      assert((await action.boundingBox()).y < 844);
      await close();
      await openConversation(3);
      await dialog().locator(".approval-summary").click();
      await expect(dialog()).toHaveAttribute("aria-label", "Review approval");
      await close();
      await close();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await capture("settings");
      await dialog()
        .getByRole("button", { name: /Tools & integrations/ })
        .click();
      await dialog().getByLabel("Search tools", { exact: true }).fill("GitHub");
      await expect(dialog().locator(".catalog-card h4").first()).toHaveText(
        "GitHub",
      );
      await capture("tools");
      await dialog()
        .getByRole("button", { name: "Permissions", exact: true })
        .click();
      await expect(dialog().getByLabel("Tool approvals")).toBeVisible();
      await close();
      await expect(dialog()).toHaveAttribute("aria-label", "Settings");
      await dialog()
        .getByRole("button", { name: /Provider connections/ })
        .click();
      await dialog()
        .getByRole("button", { name: "Add a provider", exact: true })
        .click();
      await dialog()
        .getByRole("button", { name: "Claude", exact: true })
        .click();
      await dialog()
        .getByRole("button", { name: "Add a remote machine", exact: true })
        .click();
      await expect(dialog().getByLabel("Connection type")).toHaveValue(
        "native-host",
      );
      await capture("remote");
      await close();
      await expect(dialog()).toHaveAttribute("aria-label", "Connect Claude");
      await close();
      await close();
      await nav("Projects");
      await page.getByRole("button", { name: /^Loop 4 agents/ }).click();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await page
        .locator('[aria-label="Project activity"] .feed-card')
        .first()
        .waitFor();
      await capture("project");
      // Live updates must not discard older project activity already loaded.
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      const historyIds = Array.from(
        { length: 45 },
        (_, i) => `design-history-${engine.name()}-${i}`,
      );
      fixture.db.transaction(() => {
        const insert = fixture.db.prepare(
          "INSERT INTO artifacts(id,owner_id,title,kind,content,folder_id,metadata,created_at,updated_at) VALUES(?,?,?,'markdown','Project history fixture',?,'{}',?,?)",
        );
        historyIds.forEach((id, i) =>
          insert.run(
            id,
            fixture.owner,
            `Project history ${i}`,
            fixture.projects[0].id,
            Date.now(),
            Date.now(),
          ),
        );
      })();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      const activity = page.getByLabel("Project activity", { exact: true });
      await expect(
        activity.getByRole("heading", {
          name: "Project history 44",
          exact: true,
        }),
      ).toBeVisible();
      await activity
        .getByRole("button", { name: "Earlier activity", exact: true })
        .click();
      const oldest = activity.getByRole("heading", {
        name: "Project history 0",
        exact: true,
      });
      await expect(oldest).toHaveCount(1);
      fixture.db
        .prepare("UPDATE artifacts SET title=?,updated_at=? WHERE id=?")
        .run("Updated project history", Date.now(), historyIds.at(-1));
      await expect(
        activity.getByRole("heading", {
          name: "Updated project history",
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(oldest).toHaveCount(1);
      fixture.db
        .prepare(
          "DELETE FROM artifacts WHERE id IN (SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(historyIds));
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await expect(
        page.locator('.mobile-nav [aria-current="page"]'),
      ).toHaveText("Projects");
      await page.getByRole("button", { name: /Nested work/ }).click();
      await expect(page.locator(".file-row").first()).toBeVisible();
      await expect(page.locator(".project-heading h2")).toHaveText("Loop");
      await nav("Saved");
      await expect(
        page.getByRole("button", { name: "Recent", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await nav("Search");
      await expect(page.getByLabel("From date")).not.toBeVisible();
      await page.getByLabel("Search everything").fill("preserve");
      await page
        .locator(".search-box")
        .getByRole("button", { name: "Search", exact: true })
        .click();
      await page.locator(".search-result").first().waitFor();
      await expect(page.locator(".search-result mark").first()).toContainText(
        /preserve/i,
      );
      await capture("search");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await dialog()
        .getByRole("button", { name: /Workflows/ })
        .click();
      const prompt = dialog()
        .getByRole("textbox", { name: "Prompt", exact: true })
        .first();
      await prompt.fill("An edited workflow prompt with {{inputs.topic}}");
      await dialog()
        .getByRole("button", { name: "Advanced JSON", exact: true })
        .click();
      await expect(dialog().locator(".workflow-source")).toHaveValue(
        /An edited workflow prompt/,
      );
      await dialog()
        .getByRole("button", { name: "Edit steps", exact: true })
        .click();
      await capture("workflow");
      await close();
      await dialog().getByRole("button", { name: "dark", exact: true }).click();
      await close();
      await openConversation();
      await capture("conversation-dark");
      await close();
      await page.setViewportSize({ width: 360, height: 780 });
      await nav("Feed");
      await capture("small-phone");
      await page.setViewportSize({ width: 1280, height: 900 });
      await capture("desktop");
      await replyKeyboardSmoke(page, fixture, capture);
      await workspaceControlsSmoke(page, fixture, engine.name(), capture);
      await teamNavigationSmoke(page, fixture, engine.name(), capture);
      await profileNavigationSmoke(page, fixture, engine.name(), capture);
      assert.deepEqual(errors, [], "Unexpected browser errors");
      console.log(`${engine.name()}: design regressions passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
