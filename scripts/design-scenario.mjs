import { profilePhotosRecipientSmoke } from "./helpers/profile-photos-recipient-smoke.mjs";
import { agentMailSmoke } from "./helpers/agent-mail-smoke.mjs";
import { geminiSmoke } from "./helpers/gemini-smoke.mjs";
import { antigravitySmoke } from "./helpers/antigravity-smoke.mjs";
import { createAgentLayoutSmoke } from "./helpers/create-agent-layout-smoke.mjs";
import { beginnerChatSmoke } from "./helpers/beginner-chat-smoke.mjs";
import { workspaceProjectSmoke } from "./helpers/workspace-project-smoke.mjs";
import { executionEnvironmentsSmoke } from "./helpers/execution-environments-smoke.mjs";
import { safariSheetKeyboardSmoke } from "./helpers/safari-sheet-keyboard-smoke.mjs";
import { feedReplyKeyboardSmoke } from "./helpers/feed-reply-keyboard-smoke.mjs";
import { mobileNavViewportSmoke } from "./helpers/mobile-nav-viewport-smoke.mjs";
import { feedReadingSmoke } from "./helpers/feed-reading-smoke.mjs";
import { feedThreadsSmoke } from "./helpers/feed-threads-smoke.mjs";
import { feedLoadingSmoke } from "./helpers/feed-loading-smoke.mjs";
import { mainComposerKeyboardSmoke } from "./helpers/main-composer-keyboard-smoke.mjs";
import { composerTypingSmoke } from "./helpers/composer-typing-smoke.mjs";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { trackSmokeCleanup } from "./helpers/smoke-lifecycle.mjs";
import {
  startSmokeTrace,
  reportSmokePressure,
} from "./helpers/smoke-diagnostics.mjs";
import { runReceipt } from "./helpers/run-receipt.mjs";
import { seedNewerReplyMessage } from "./helpers/quoted-reply-fixture.mjs";
import { isWebKitNavigationFetchError, collectionReadRecovery, signalCollection, legacyFallbackRecovery } from "./helpers/browser-errors.mjs";

import { workspaceControlsSmoke } from "./helpers/workspace-controls-smoke.mjs";
import { teamNavigationSmoke } from "./helpers/team-navigation-smoke.mjs";
import { teamPresetsSmoke } from "./helpers/team-presets-smoke.mjs";
import {
  markdownDefinitionsSmoke,
  markdownModelsSmoke,
  markdownSourceSmoke,
} from "./helpers/markdown-definitions-smoke.mjs";
import { teamFeedVisibilitySmoke } from "./helpers/team-feed-visibility-smoke.mjs";
import { profileNavigationSmoke } from "./helpers/profile-navigation-smoke.mjs";
import { personalDecisionsSmoke } from "./helpers/personal-decisions-smoke.mjs";
import { modelLabelsSmoke } from "./helpers/model-labels-smoke.mjs";
import { swipeBackSmoke } from "./helpers/swipe-back-smoke.mjs";
import { doneCardDismissalSmoke } from "./helpers/done-card-dismissal-smoke.mjs";
import { steeringRepliesSmoke } from "./helpers/steering-replies-smoke.mjs";
import { resultFilesSmoke } from "./helpers/result-files-smoke.mjs";
import { replyKeyboardSmoke } from "./helpers/reply-keyboard-smoke.mjs";
import { settingsReliabilityBrowser } from "./helpers/settings-reliability-browser.mjs";
import { dialogKeyboardSmoke } from "./helpers/dialog-keyboard-smoke.mjs";
import { profileWorkSmoke } from "./helpers/profile-work-smoke.mjs";
import { conversationLiveSmoke } from "./helpers/conversation-live-smoke.mjs";
import { messageNavigationSmoke } from "./helpers/message-navigation-smoke.mjs";
import { inboxFlowsSmoke } from "./helpers/inbox-flows-smoke.mjs";
import { cardRemindersSmoke } from "./helpers/card-reminders-smoke.mjs";
import { needsStackSmoke } from "./helpers/needs-stack-smoke.mjs";
import { continuitySmoke } from "./helpers/continuity-smoke.mjs";
import { continuationSmoke, continuationTabsSmoke, continuationLegacySmoke, continuationRecoverySmoke } from "./helpers/continuation-smoke.mjs";
import { threadLayoutSmoke } from "./helpers/thread-layout-smoke.mjs";
import { visualLayoutSmoke } from "./helpers/visual-layout-smoke.mjs";

import { withdrawDraftSmoke } from "./helpers/withdraw-draft-smoke.mjs";

import { uploadDestinationSmoke } from "./helpers/upload-destination-smoke.mjs";
import { attachmentPickerSmoke } from "./helpers/attachment-picker-smoke.mjs";

const scenarios = {
  "beginner-chat": beginnerChatSmoke,
  "profile-photos-recipient": profilePhotosRecipientSmoke,
  "visual-layout": visualLayoutSmoke,
  gemini: geminiSmoke,
  antigravity: antigravitySmoke,
  "workspace-project": workspaceProjectSmoke,
  "execution-environments": executionEnvironmentsSmoke,
  "clear-search": async (page, fixture) => {
    await page.goto(fixture.base);
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Search", exact: true })
      .click();
    const input = page.getByLabel("Search everything");
    const clear = page.getByRole("button", {
      name: "Clear search",
      exact: true,
    });
    await expect(clear).toHaveCount(0);
    await input.fill("preserve");
    await input.press("Enter");
    await page.locator(".search-result").first().waitFor();
    await clear.click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(page.locator(".search-result")).toHaveCount(0);
    await expect(clear).toHaveCount(0);
    let releaseSearch;
    const heldSearch = new Promise((resolve) => {
      releaseSearch = resolve;
    });
    await page.route("**/api/search?**", async (route) => {
      await heldSearch;
      await route.continue();
    });
    await input.fill("preserve");
    await input.press("Enter");
    await expect(page.getByText("Finding…", { exact: true })).toBeVisible();
    await clear.click();
    releaseSearch();
    await page.waitForResponse((response) =>
      response.url().includes("/api/search?"),
    );
    await expect(input).toHaveValue("");
    await expect(page.locator(".search-result")).toHaveCount(0);
  },
  "agent-mail": agentMailSmoke,
  "main-composer-keyboard": (p, f, e, c) => mainComposerKeyboardSmoke(p, f, c),
  "composer-typing": composerTypingSmoke,
  "feed-reply-keyboard": (p, f, e, c) => feedReplyKeyboardSmoke(p, f, c),
  "mobile-nav-viewport": (p, f, e, c) => mobileNavViewportSmoke(p, f, c),
  "feed-reading": (p, f, e, c) => feedReadingSmoke(p, f, c),
  "feed-threads": (p, f, e, c) => feedThreadsSmoke(p, f, c),
  "feed-loading": feedLoadingSmoke,
  "safari-sheet-keyboard": (p, f, e, c) => safariSheetKeyboardSmoke(p, f, c),
  "create-agent-layout": (p, f, e, c) => createAgentLayoutSmoke(p, f, c),
  "upload-destination": uploadDestinationSmoke,
  "attachment-picker": attachmentPickerSmoke,
  "withdraw-draft": withdrawDraftSmoke,
  inbox: (p, f, e, c) => inboxFlowsSmoke(p, f, c),
  "card-reminders": cardRemindersSmoke,
  "needs-stack": (p, f, e, c) => needsStackSmoke(p, f, c),
  "continuity-320": async (p, f, e, c) => {
    await p.setViewportSize({ width: 320, height: 844 });
    await continuitySmoke(p, f, c);
  },
  "continuity-390": async (p, f, e, c) => {
    await p.setViewportSize({ width: 390, height: 844 });
    await continuitySmoke(p, f, c);
  },
  continuation: continuationSmoke,
  "continuation-tabs": continuationTabsSmoke,
  "continuation-legacy": continuationLegacySmoke,
  "continuation-recovery": continuationRecoverySmoke,
  "reply-keyboard": (p, f, e, c) => replyKeyboardSmoke(p, f, c),
  "dialog-keyboard": (p, f, e, c) => dialogKeyboardSmoke(p, f, c),
  settings: (p, f, e, c) => settingsReliabilityBrowser(p, f.base, c),
  workspace: workspaceControlsSmoke,
  teams: teamNavigationSmoke,
  "team-feed-visibility": teamFeedVisibilitySmoke,
  "team-presets": teamPresetsSmoke,
  "markdown-definitions": markdownDefinitionsSmoke,
  "markdown-models": markdownModelsSmoke,
  "markdown-source": markdownSourceSmoke,
  profile: profileNavigationSmoke,
  "personal-decisions": personalDecisionsSmoke,
  models: (p, f, e, c) => modelLabelsSmoke(p, f, c),
  swipe: swipeBackSmoke,
  "done-card-dismissal": doneCardDismissalSmoke,
  "steering-replies": steeringRepliesSmoke,
  messages: (p, f) => messageNavigationSmoke(p, f),
  files: (p, f, e, c) => resultFilesSmoke(p, f, c),
  "profile-work": (p, f, e, c) => profileWorkSmoke(p, c),
  "conversation-live": (p, f, e, c) => conversationLiveSmoke(p, c),
  "thread-layout": (p, f, e, c) => threadLayoutSmoke(p, c),
};

const screenshots =
  process.env.LOOP_DESIGN_SCREENSHOT_DIR ||
  (process.env.CI ? join("docs", "loop-v0", "evidence") : undefined);
if (screenshots) mkdirSync(screenshots, { recursive: true });
const scenario = process.argv[2] || "core";
if (scenario !== "core" && !Object.hasOwn(scenarios, scenario))
  throw new Error(`Unknown design scenario: ${scenario}`);
for (const engine of selectedEngines()) {
  const started = performance.now();
  const fixture = await designFixture();
  try {
    const browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium
          ? process.env.CHROMIUM_PATH || undefined
          : undefined,
    });
    const closeBrowser = trackSmokeCleanup(() => browser.close());
    let page;
    let finishTrace = async (_failed) => {};
    let failed = false;
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      finishTrace = await startSmokeTrace(
        context,
        `${engine.name()}-${scenario}`,
      );
      page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      // Some journeys use their own fixture server. Keep its origin while
      // navigating to about:blank so interrupted reads are recognized too.
      let documentOrigin = fixture.base;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && /^https?:/.test(frame.url()))
          documentOrigin = new URL(frame.url()).origin;
      });
      page.on("pageerror", (error) => {
        // WebKit reports a same-origin fetch interrupted by page navigation as
        // an access-control page error. The app handles the rejected request;
        // this browser-only message does not indicate a failed API response.
        if (isWebKitNavigationFetchError(engine.name(), error, documentOrigin))
          return;
        errors.push(error.message);
        console.error(
          `${engine.name()} page error at ${page.url()}: ${error.stack}`,
        );
      });
      const dialog = () => page.locator("dialog[open]").last();
      const thread = () => page.locator("dialog.conversation-sheet[open]");
      const capture = async (name) => {
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `${engine.name()}-${scenario}-${name}.png`),
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
          .getByRole("textbox", { name: "Reply to agent", exact: true })
          .waitFor();
        await expect(thread().locator(".message").first()).toBeVisible();
      };
      if (scenario === "core") {
        await seedNewerReplyMessage(fixture);
        await page.goto(fixture.base);
        const inbox = page.getByRole("region", { name: "Feed", exact: true });
        // The filtered list, not the Needs you stack above the filters.
        const inboxRows = inbox.locator(":scope > .inbox-results .inbox-row");
        const needsStack = inbox.getByRole("region", { name: "Needs you" });
        await inboxRows.first().waitFor();
        await capture("feed");
        await expect(
          page.getByRole("heading", { name: "Feed", exact: true }),
        ).toBeVisible();
        // The Feed title replaced the old tagline; nothing wraps above threads.
        await expect(page.locator(".page-description")).toHaveCount(0);
        const checkAboveComposer = async (target, label) => {
          await expect(target).toBeInViewport({ ratio: 1 });
          const box = await target.boundingBox();
          const composer = await page.locator(".composer-launch").boundingBox();
          assert(
            box.y + box.height <= composer.y,
            `${label} must remain above the composer: ${JSON.stringify({ box, composer })}`,
          );
        };
        // Minimized, the composer is a plus button in the bottom-right corner.
        const launch = await page.locator(".composer-launch").boundingBox();
        const viewport = page.viewportSize();
        assert(
          launch.width <= 64 &&
            launch.height <= 64 &&
            launch.x + launch.width > viewport.width - 40 &&
            launch.x > viewport.width / 2,
          `The minimized composer must be a corner button: ${JSON.stringify({ launch, viewport })}`,
        );
        // What needs you leads the Feed; its first card stays in view.
        await checkAboveComposer(
          needsStack.locator(".approval-card").first(),
          "First card that needs you",
        );
        const inboxFilters = inbox.getByRole("tablist", { name: "Show" });
        await expect(inboxFilters.getByRole("tab")).toHaveText([
          "Done",
          /^Working/,
          /^Queued/,
          "Threads",
          "Replies",
        ]);
        await expect(
          inboxFilters.getByRole("tab", { name: "Done", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        // Every Feed filter fits a small phone. Social lives on Your profile.
        await page.setViewportSize({ width: 360, height: 780 });
        assert.ok(
          await inboxFilters.evaluate((el) => el.scrollWidth <= el.clientWidth),
          "The Feed filters fit a 360px phone",
        );
        await page.setViewportSize({ width: 390, height: 844 });
        // Done holds only finished threads: none working, queued or needing you.
        const finished = fixture.conversations.filter(
          (c) => c.state === "completed",
        ).length;
        await expect(inboxRows).toHaveCount(finished);
        // The Results and All filters are gone; their old links open Done.
        for (const old of ["results", "all"]) {
          await page.goto(fixture.base + "/?filter=" + old);
          await expect(
            inboxFilters.getByRole("tab", { name: "Done", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(inboxRows).toHaveCount(finished);
        }
        const shortcuts = page.getByRole("region", {
          name: "Your agents",
          exact: true,
        });
        await expect(shortcuts.locator(".agent-strip button")).toHaveCount(
          fixture.agents.length + 1,
        );
        await expect(
          shortcuts.locator(".agent-strip button").first(),
        ).toHaveAccessibleName("New agent");
        await expect(
          shortcuts.getByRole("button", { name: /^All agents/ }),
        ).toHaveCount(0);
        await expect(page.locator(".feed-compose-button")).toHaveCount(0);
        await shortcuts
          .getByRole("button", { name: "New agent", exact: true })
          .click();
        await expect(
          dialog().getByRole("heading", {
            name: "New chat",
            exact: true,
          }),
        ).toBeVisible();
        await close();
        await page
          .getByRole("button", { name: "Compose a message", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Message your agent" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Collapse composer", exact: true })
          .click();

        // Result cards live on agent profiles (and project pages), not the Feed.
        const resultsAuthor = fixture.db
          .prepare(
            "SELECT g.name FROM agents g JOIN artifacts a ON a.agent_id=g.id WHERE a.id=?",
          )
          .get(fixture.artifacts[0]).name;
        const results = page.locator(".feed-card:not(.inbox-card)");
        const openResults = async () => {
          await shortcuts
            .getByRole("button", { name: new RegExp(`^@${resultsAuthor} ·`) })
            .click();
          await expect(
            page.getByRole("heading", {
              name: resultsAuthor,
              exact: true,
            }),
          ).toBeVisible();
          await page.getByRole("tab", { name: "Results", exact: true }).click();
          await results.first().waitFor();
        };
        await openResults();
        await capture("agent-results");
        // Replying to an older result opens its thread at that message, with
        // the result quoted in the thread composer.
        const resultCard = results.first();
        const replyToResult = async () => {
          await resultCard
            .getByRole("button", { name: "Reply", exact: true })
            .click();
          await expect(page.locator("dialog[open]")).toHaveCount(1);
          await expect(page).toHaveURL(/[?&]message=/);
          // Results and messages are quoted the same way: by their agent.
          await expect(dialog().locator(".composer-reply-chip")).toContainText(
            /^Replying to @/,
          );
        };
        await replyToResult();
        const composer = dialog().locator(".composer");
        await expect(
          composer.getByRole("textbox", { name: "Reply to agent" }),
        ).toBeInViewport({ ratio: 1 });
        await composer.locator(".composer-quote-toggle > summary").click();
        await expect(
          composer.getByRole("region", { name: "Original message" }),
        ).toBeVisible();
        await composer.locator(".composer-quote-toggle > summary").click();
        await expect(
          composer.getByRole("button", { name: "Select model and effort" }),
        ).toBeHidden();
        await composer
          .getByRole("button", { name: "Chat options", exact: true })
          .click();
        await expect(
          composer.getByRole("button", { name: "Select model and effort" }),
        ).toBeVisible();
        await expect(
          composer.getByRole("button", { name: "Add attachments" }),
        ).toBeVisible();
        await expect(page.locator(".composer textarea")).toHaveCount(1);
        await capture("result-reply");
        const requests = [];
        await page.route("**/api/runs", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          requests.push(route.request().postDataJSON());
          if (requests.length > 1)
            return route.fulfill({
              json: runReceipt(route.request(), "accepted"),
            });
          return route.fulfill({
            status: 503,
            json: { error: "Fixture reply unavailable" },
          });
        });
        await composer
          .getByRole("textbox", { name: "Reply to agent" })
          .fill("Explain the next step");
        await composer
          .getByRole("button", { name: "Send reply", exact: true })
          .click();
        await expect(composer.getByRole("alert")).toContainText(
          "Fixture reply unavailable",
        );
        // Leaving the thread keeps the failed reply as its draft.
        await close();
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        await replyToResult();
        await expect(
          composer.getByRole("textbox", { name: "Reply to agent" }),
        ).toHaveValue("Explain the next step");
        await composer
          .getByRole("button", { name: "Send reply", exact: true })
          .click();
        // Sending keeps the thread open and clears the draft.
        await expect(
          composer.getByRole("textbox", { name: "Reply to agent" }),
        ).toHaveValue("");
        await expect(page.locator("dialog[open]")).toHaveCount(1);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
        assert.equal(
          requests[0].replyToMessageId,
          requests[1].replyToMessageId,
        );
        assert(requests[1].replyToMessageId, "Result reply keeps its message");
        const repliedConversation = fixture.db
          .prepare("SELECT agent_id FROM conversations WHERE id=?")
          .get(requests[1].conversationId);
        assert.equal(requests[1].agentId, repliedConversation.agent_id);
        await page.unroute("**/api/runs");
        await close();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await shortcuts
          .getByRole("button", { name: /^@code-reviewer ·/ })
          .click();
        await expect(
          page.getByRole("heading", { name: "code-reviewer", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".profile-handle")).toHaveText(
          "@code-reviewer",
        );
        await expect(page.locator(".composer-launch")).toHaveAttribute(
          "title",
          /@code-reviewer/,
        );
        // The personal "Your prompts" tab moved to Search; the agent's threads
        // gained their own tab.
        await expect(
          page.locator(".profile-head ~ .segmented button"),
        ).toHaveText([
          "Results",
          "Threads",
          "Messages",
          "Agent mail",
          "Files",
          "Traces",
        ]);
        await expect(
          page
            .locator(".profile-head")
            .getByRole("button", { name: "Message", exact: true }),
        ).toBeVisible();
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
            const cover = await page
              .locator(".profile-head > .profile-cover")
              .boundingBox();
            assert(
              avatar.x >= header.x &&
                avatar.x + avatar.width <= header.x + header.width / 2 &&
                avatar.y < cover.y + cover.height &&
                avatar.y + avatar.height > cover.y + cover.height,
              "Profile avatar stays on the left and overlaps its cover",
            );
            // The agent menu sits in the header corner without covering the avatar.
            const menu = await page
              .locator(".profile-head")
              .getByRole("button", { name: "Agent actions", exact: true })
              .boundingBox();
            assert(
              menu.x + menu.width <= header.x + header.width &&
                menu.y >= header.y &&
                menu.x >= avatar.x + avatar.width,
              "Agent actions stay in the profile header corner",
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
        // Older linked workspaces omit optional message/trace display metadata.
        // Remove it from real production responses, then exercise the real views.
        const removedMetadata = new Set();
        const olderAgentResponse = async (route) => {
          const response = await route.fetch();
          assert(response.ok());
          const body = await response.json();
          const messages = new URL(route.request().url()).pathname.endsWith(
            "/messages",
          );
          const keys = messages
            ? ["model", "run_id"]
            : ["trace_key", "run_error", "server", "invocation_state"];
          for (const item of body.items) {
            for (const key of keys) {
              if (Object.hasOwn(item, key)) removedMetadata.add(key);
              delete item[key];
            }
            if (messages) item.final = Boolean(item.final);
          }
          await route.fulfill({ response, json: body });
        };
        const agentHistory = (url) =>
          /^\/api\/agents\/[^/]+\/(messages|traces)$/.test(url.pathname);
        await page.route(agentHistory, olderAgentResponse);
        await page.getByRole("tab", { name: "Messages", exact: true }).click();
        const agentMessages = page.getByRole("region", {
          name: "Agent messages",
          exact: true,
        });
        await expect(agentMessages.locator(".feed-card").first()).toBeVisible();
        await expect(agentMessages.getByRole("alert")).toHaveCount(0);
        await page.getByRole("tab", { name: "Traces", exact: true }).click();
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
        // Traces are newest first; open the command trace by its title.
        const command = longRun
          .locator(".trace-card")
          .filter({ hasText: "Run command" });
        await command.locator("summary").first().click();
        await expect(command.locator(".trace-log").first()).toContainText(
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
        await expect(page.locator(".trace-list [role=alert]")).toHaveCount(0);
        assert.deepEqual(
          [...removedMetadata].sort(),
          [
            "model",
            "run_id",
            "trace_key",
            "run_error",
            "server",
            "invocation_state",
          ].sort(),
        );
        await page.unroute(agentHistory, olderAgentResponse);
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
          dimensions.messages > 300,
          "Conversation reading area is too short",
        );
        await page.getByLabel("Conversation options", { exact: true }).click();
        await expect(dialog()).toHaveAttribute("aria-label", "Conversation");
        await dialog().locator(".native-conversation > summary").click();
        await expect(
          dialog().getByRole("checkbox", { name: "Include in shared memory" }),
        ).toBeVisible();
        await collectionReadRecovery(page, {
          route: (url) => url.pathname === `/api/conversations/${fixture.conversations[0].id}/memory`,
          scope: dialog(),
          start: () => signalCollection(page, "metadata"),
          recovered: () => signalCollection(page, "metadata"),
        });
        assert(
          (await thread()
            .locator(".messages")
            .evaluate((el) => el.clientHeight)) === dimensions.messages,
          "Conversation controls shrink the reading area",
        );
        await dialog()
          .getByRole("menuitem", { name: /^Change model/ })
          .click();
        assert(
          (await dialog().getByRole("radio").first().boundingBox()).width > 280,
        );
        assert(
          (await dialog().getByRole("radio").first().boundingBox()).height >=
            44,
          "Model choice has a small touch target",
        );
        await capture("model");
        await page.goBack();
        await expect(page.locator("dialog[open]")).toHaveCount(1);
        await page.getByLabel("Conversation options", { exact: true }).click();
        await dialog()
          .getByRole("menuitem", { name: /^Continue with another agent/ })
          .click();
        await expect(
          dialog().locator('input[type="checkbox"]').first(),
        ).toBeVisible();
        await close();
        await expect(page.locator("dialog[open]")).toHaveCount(1);
        // Per-message actions moved from a Copy/Link row into one menu.
        await thread()
          .getByRole("button", { name: "Message actions", exact: true })
          .last()
          .click();
        await expect(dialog()).toHaveAttribute("aria-label", "Message");
        // Reply, Save and Remind me lead; the rest wait behind a visible More.
        await expect(
          dialog()
            .getByRole("group", { name: "Main actions" })
            .getByRole("button"),
        ).toHaveText(["Reply", "Save", "Remind me"]);
        await expect(dialog().getByRole("menuitem")).toHaveCount(0);
        const more = dialog().getByRole("button", {
          name: "More",
          exact: true,
        });
        await expect(more).toHaveAttribute("aria-expanded", "false");
        await more.click();
        await expect(more).toHaveAttribute("aria-expanded", "true");
        await expect(dialog().getByRole("menuitem")).toHaveText([
          /^Reply to part.*Only those are quoted/,
          /^Fork from here.*Files are not rewound/,
          /^Reuse as prompt.*editable draft/,
          /^Save as snippet.*reusable instructions/,
          "Copy text",
          /^Share link/,
        ]);
        await capture("message-actions");
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
          .getByRole("menuitem", { name: /^Save as snippet/ })
          .click();
        await expect(thread().getByRole("alert")).toContainText(
          "Synthetic save failure",
        );
        await page.unroute("**/api/artifacts");
        await thread()
          .getByRole("button", { name: "Dismiss message", exact: true })
          .click();
        if (engine === chromium) {
          const client = await context.newCDPSession(page);
          const messages = thread().locator(".messages");
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
        // Tapping a result opens it; closing must not leave extra Back steps.
        await openResults();
        const historyLength = await page.evaluate(() => history.length);
        for (let i = 0; i < 3; i++) {
          await results
            .first()
            .getByRole("button", { name: "View full result", exact: true })
            .click();
          await expect(dialog().locator(".result-author-name")).toBeVisible();
          await close();
        }
        assert(
          (await page.evaluate(() => history.length)) <= historyLength + 1,
          "Closing sheets leaves redundant Back steps",
        );
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(page.locator(".profile-head")).toHaveCount(0);
        await page
          .getByLabel("Filter by project")
          .selectOption(fixture.projects[0].id);
        await expect(shortcuts.locator(".agent-strip button")).toHaveCount(5);
        // What needs you stacks above the filters: one card, the rest behind.
        await expect(needsStack).toContainText("1 more needs you");
        // The Running tab became the Feed Working filter.
        await inboxFilters.getByRole("tab", { name: /^Working/ }).click();
        await expect(page).toHaveURL(/filter=working/);
        await expect(page.getByLabel("Filter by project")).toHaveValue(
          fixture.projects[0].id,
        );
        await page.reload();
        await expect(page.getByLabel("Filter by project")).toHaveValue(
          fixture.projects[0].id,
        );
        await expect(
          page.locator('.mobile-nav [aria-current="page"]'),
        ).toContainText("Feed");
        await expect(
          inboxFilters.getByRole("tab", { name: /^Working/ }),
        ).toHaveAttribute("aria-selected", "true");
        await page.getByLabel("Filter by project").selectOption("");
        await expect(inboxRows).toHaveCount(1);
        await expect(inboxRows.first()).toHaveAccessibleName(
          /^Review GitHub pull request #42 .*Working$/,
        );
        // Failed runs need you: the thread row shows the failure and opens it.
        await needsStack.getByRole("button", { name: "Show all" }).click();
        await expect(needsStack).toContainText(/\d+ need you/);
        const failedRow = needsStack.locator(".inbox-row").filter({
          hasText: "Check why the GitHub review could not be posted",
        });
        await expect(failedRow).toHaveAccessibleName(/, Failed$/);
        await expect(failedRow).toContainText(
          "The tool could not complete the request",
        );
        await capture("needs-you");
        await needsStack
          .locator(".inbox-card")
          .filter({
            hasText: "Check why the GitHub review could not be posted",
          })
          .getByRole("button", { name: "Thread actions", exact: true })
          .click();
        await expect(
          dialog().getByRole("menuitem", {
            name: "Dismiss from Needs you",
            exact: true,
          }),
        ).toBeVisible();
        await close();
        await failedRow.click();
        await expect(thread()).toContainText(
          "The tool could not complete the request",
        );
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
        const openSettings = async () => {
          await page
            .getByRole("button", { name: "Open settings", exact: true })
            .evaluate((el) => el.click());
          await expect(dialog()).toHaveAttribute("aria-label", "Settings");
        };
        // The page behind the open drawer holds still; the drawer's list scrolls.
        assert(
          await page.evaluate(
            () => document.documentElement.scrollHeight > innerHeight + 200,
          ),
          "The page must be long enough to scroll",
        );
        // Open partway down without Playwright scrolling the gear into view.
        // The modal freezes the body at that position until its last sheet closes.
        await page.evaluate(() =>
          window.scrollTo({ top: 150, behavior: "instant" }),
        );
        assert.equal(await page.evaluate(() => scrollY), 150);
        await openSettings();
        assert.equal(
          await page.evaluate(() => document.body.style.top),
          "-150px",
          "The open drawer preserves the reading position",
        );
        const pageOverflow = () =>
          page.evaluate(
            () => getComputedStyle(document.documentElement).overflow,
          );
        assert.equal(
          await pageOverflow(),
          "hidden",
          "The open drawer locks the page",
        );
        const list = dialog().locator(".sheet-body");
        assert.match(
          await list.evaluate((el) => getComputedStyle(el).overflowY),
          /auto|scroll/,
          "The drawer's list scrolls",
        );
        // Mobile WebKit has no wheel input in Playwright; Chromium checks the
        // gestures themselves.
        if (engine.name() === "chromium") {
          const pageTop = await page.evaluate(() => scrollY);
          assert.equal(
            pageTop,
            0,
            "The page body is fixed while a sheet is open",
          );
          const drawer = await dialog().boundingBox();
          for (const [x, y] of [
            [drawer.x + drawer.width / 2, drawer.y + 30],
            [drawer.x / 2, drawer.height / 2],
          ]) {
            await page.mouse.move(x, y);
            await page.mouse.wheel(0, 400);
            await page.waitForTimeout(150);
            assert.equal(
              await page.evaluate(() => scrollY),
              pageTop,
              "Scrolling over the settings drawer must not scroll the page",
            );
            assert.equal(
              await page.evaluate(() => document.body.style.top),
              "-150px",
              "Scrolling must not move the frozen body",
            );
          }
          const listBox = await list.boundingBox();
          await page.mouse.move(
            listBox.x + listBox.width / 2,
            listBox.y + listBox.height / 2,
          );
          await page.mouse.wheel(0, 200);
          if (await list.evaluate((el) => el.scrollHeight > el.clientHeight))
            await expect
              .poll(() => list.evaluate((el) => el.scrollTop))
              .toBeGreaterThan(0);
          await list.evaluate((el) => (el.scrollTop = 0));
        }
        await capture("settings");
        await dialog()
          .getByRole("button", { name: /Tools & integrations/ })
          .click();
        await dialog()
          .getByLabel("Search tools", { exact: true })
          .fill("GitHub");
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
        await expect(
          page.getByRole("heading", { name: "Projects", exact: true }),
        ).toBeVisible();
        const projectRow = page
          .locator(".project-tile")
          .filter({ has: page.locator("strong", { hasText: /^Loop$/ }) });
        await expect(projectRow).toContainText("4 agents");
        await capture("projects");
        await projectRow.click();
        const projectTab = (name) =>
          page
            .locator(".project-tabs")
            .getByRole("button", { name, exact: true });
        await projectTab("Threads").click();
        await expect(
          page.locator(".projects-view .inbox-row").first(),
        ).toBeVisible();
        await capture("project-threads");
        await projectTab("Activity").click();
        await page
          .locator('[aria-label="Project activity"] .feed-card')
          .first()
          .waitFor();
        await capture("project");
        // Live updates must not discard older project activity already loaded.
        await projectTab("Agents").click();
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
        // Start a fresh paginated collection; an existing cached collection
        // can receive all newly inserted cards through its changes cursor.
        await page.reload({ waitUntil: "networkidle" });
        await projectTab("Activity").click();
        const activity = page.getByLabel("Project activity", { exact: true });
        await expect(
          activity.getByRole("heading", {
            name: "Project history 44",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          activity.getByRole("heading", {
            name: "Project history 0",
            exact: true,
          }),
        ).toHaveCount(0);
        await activity
          .getByRole("button", { name: "Earlier activity", exact: true })
          .click();
        const oldest = activity.getByRole("heading", {
          name: "Project history 0",
          exact: true,
        });
        await expect(oldest).toHaveCount(1);
        await collectionReadRecovery(page, {
          route: (url) => /^\/api\/v1\/cards(?:\/changes)?$/.test(url.pathname) && url.searchParams.get("view") === "results" && url.searchParams.get("project") === fixture.projects[0].id,
          scope: activity,
          start: () => page.evaluate(() => window.dispatchEvent(new Event("loop-later-change"))),
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
        await projectTab("Files").click();
        await expect(
          page.locator('.mobile-nav [aria-current="page"]'),
        ).toHaveText("Projects");
        await page.getByRole("button", { name: /Nested work/ }).click();
        await expect(page.locator(".file-row").first()).toBeVisible();
        await expect(page.locator(".project-heading h2")).toHaveText("Loop");
        // Later shares your profile with messages, decision history, Files
        // and Social. Keep the full tab order covered as sections are added.
        await nav("Your profile");
        const yourProfile = page.getByRole("region", {
          name: "Your profile",
          exact: true,
        });
        await expect(yourProfile).toBeVisible();
        await expect(
          yourProfile.getByRole("tablist", { name: "Show" }).getByRole("tab"),
        ).toHaveText([
          "Messages",
          "Approvals",
          "Answers",
          "Saved",
          "Reminders",
          "Scheduled",
          "Files",
          /^Social/,
        ]);
        await expect(
          page.getByRole("button", { name: "Recent", exact: true }),
        ).toHaveCount(0);
        await capture("later");
        await nav("Search");
        await expect(
          page.getByRole("heading", { name: "Search", exact: true }),
        ).toBeVisible();
        await expect(page.getByLabel("From date")).not.toBeVisible();
        await page.getByLabel("Search everything").fill("preserve");
        await page.getByLabel("Search everything").press("Enter");
        await page.locator(".search-result").first().waitFor();
        await expect(page.locator(".search-result mark").first()).toContainText(
          /preserve/i,
        );
        await capture("search");
        // The Profile tab's prompt history is the Search "Your prompts" scope.
        fixture.db
          .prepare(
            "UPDATE messages SET metadata='{\"personal\":true}' WHERE run_id=? AND role='user'",
          )
          .run(fixture.conversations[5].run);
        await page
          .getByRole("tab", { name: "Your prompts", exact: true })
          .click();
        await expect(
          page.getByText("No prompts match your search."),
        ).toBeVisible();
        await page.getByLabel("Search everything").fill("release notes");
        await expect(page.locator(".personal-message-card")).toHaveCount(1);
        await collectionReadRecovery(page, {
          route: (url) => /^\/api\/v1\/cards(?:\/changes)?$/.test(url.pathname) && url.searchParams.get("view") === "sent",
          scope: page.getByRole("region", { name: "Your sent prompts" }),
          start: () => signalCollection(page, "results"),
        });
        await expect(page.locator(".personal-message-card")).toContainText(
          "Summarize the release notes and draft a short update",
        );
        await capture("search-your-prompts");
        // Workflows moved from Settings to Projects → Across projects.
        await nav("Projects");
        const allProjects = page.getByRole("button", {
          name: "All projects",
          exact: true,
        });
        if (await allProjects.isVisible()) await allProjects.click();
        await page
          .locator(".projects-view")
          .getByRole("button", { name: /^Workflows/ })
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
        await dialog().getByRole("button", { name: "Save workflow", exact: true }).click();
        await dialog().getByRole("button", { name: "Go for it · v1", exact: true }).click();
        await expect(dialog().locator(".workflow-trace")).toBeAttached();
        await collectionReadRecovery(page, {
          route: (url) => /^\/api\/runs\/[^/]+\/steps$/.test(url.pathname),
          scope: dialog().locator(".workflow-trace"),
          start: () => signalCollection(page, "runs"),
          recovered: () => signalCollection(page, "runs"),
        });
        await legacyFallbackRecovery(browser, fixture);
        await close();
        await openSettings();
        await dialog()
          .getByRole("button", { name: "Dark", exact: true })
          .click();
        await close();
        // Closing the drawer releases the page again.
        assert.notEqual(await pageOverflow(), "hidden");
        await openConversation();
        await capture("conversation-dark");
        await close();
        await page.setViewportSize({ width: 360, height: 780 });
        await nav("Feed");
        await capture("small-phone");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.setViewportSize({ width: 1280, height: 900 });
        await capture("desktop");
      } else {
        await page.goto(fixture.base);
        await expect(page.locator(".inbox-row:visible").first()).toBeVisible();
        await scenarios[scenario](page, fixture, engine.name(), capture);
      }
      assert.deepEqual(errors, [], "Unexpected browser errors");
      console.log(
        `${engine.name()}: design/${scenario} passed (${((performance.now() - started) / 1000).toFixed(1)}s)`,
      );
    } catch (error) {
      failed = true;
      reportSmokePressure();
      if (screenshots && page)
        await page
          .screenshot({
            path: join(screenshots, `${engine.name()}-${scenario}-failure.png`),
          })
          .catch(() => {});
      throw error;
    } finally {
      try {
        await finishTrace(failed);
      } catch (error) {
        console.error("Trace capture:", error.message);
      }
      await closeBrowser();
    }
  } finally {
    await fixture.close();
  }
}
