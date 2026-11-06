import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { trackSmokeCleanup } from "./helpers/smoke-lifecycle.mjs";
import codexToolApproval from "../test/fixtures/codex-tool-approval.json" with { type: "json" };
import codexReviewApproval from "../test/fixtures/codex-review-approval.json" with { type: "json" };
import { nativeQuestionLayoutSmoke } from "./helpers/native-question-layout-smoke.mjs";

// Fixture-only: real UI, no native provider or external tool execution.
const screenshots =
  process.env.LOOP_DESIGN_SCREENSHOT_DIR ||
  (process.env.CI ? join("test-results", "screenshots") : undefined);
if (screenshots) mkdirSync(screenshots, { recursive: true });
for (const engine of selectedEngines()) {
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
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      await fixture.pair(page.context());
      // Each full navigation starts an independent layout/decision case. The
      // suite compresses many cases into seconds; keep a fresh fixture-owned
      // request window per case while retaining the real limiter within it.
      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame() &&
          new URL(request.url()).origin === fixture.base
        )
          fixture.db
            .prepare("DELETE FROM request_limits WHERE owner_id=?")
            .run(fixture.owner);
      });
      await page.route("**/api/bootstrap", async (route) => {
        const response = await route.fetch();
        assert(
          response.ok(),
          `Bootstrap failed with HTTP ${response.status()}`,
        );
        const data = await response.json();
        await route.fulfill({
          json: {
            ...data,
            agents: data.agents.map((a) => ({ ...a, provider: "pi" })),
          },
        });
      });
      const decisions = [];
      let council = false;
      let review = false;
      await page.route("**/api/native/decisions**", async (route) => {
        if (route.request().method() === "POST") {
          decisions.push(route.request().postDataJSON());
          return route.fulfill({ json: { state: "resolved" } });
        }
        await route.fulfill({
          json: [
            {
              id: "layout-approval",
              run_id: "layout-run",
              conversation_id: fixture.conversations[0].id,
              generation: "layout-generation",
              native_id: council ? "council-request" : "request",
              command_id: null,
              digest: null,
              created_at: Date.now(),
              name: "winter",
              provider: "pi",
              input: "Review the layout fixture",
              state: "pending",
              request: JSON.stringify(
                council
                  ? {
                      id: "council-request",
                      kind: "approval",
                      title: review
                        ? "Allow tool call?"
                        : "Allow loop_delegate?",
                      choices: ["accept", "decline", "cancel"],
                      allow: "accept",
                      detail: JSON.stringify(
                        review
                          ? codexReviewApproval
                          : {
                              ...codexToolApproval,
                              threadId: "native-thread-must-be-collapsed",
                              _meta: {
                                ...codexToolApproval._meta,
                                tool_params: {
                                  agent: "reviewer",
                                  task: "Review the proposed plan. ".repeat(
                                    100,
                                  ),
                                },
                              },
                            },
                      ),
                    }
                  : {
                      id: "request",
                      kind: "approval",
                      title: "WebFetch",
                      choices: ["allow", "deny"],
                      detail: JSON.stringify({
                        input: {
                          url: "https://example.com/" + "long-path/".repeat(15),
                          prompt: "Review the study. ".repeat(100),
                        },
                      }),
                    },
              ),
            },
          ],
        });
      });
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(fixture.base);
        await page.locator(".composer-launch").click();
        const composer = page.locator(".composer-dock:not(.thread-mode)");
        await composer
          .getByRole("button", { name: "Chat options", exact: true })
          .click();
        await expect(
          composer.getByRole("button", { name: "Active in this chat" }),
        ).toBeVisible();
        await composer.locator("textarea").fill("A new task");
        const send = composer.locator(".send-button");
        await expect(send).toBeInViewport({ ratio: 1 });
        assert(
          await composer.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return [...node.querySelectorAll(".composer-actions > *")].every(
              (child) => {
                const box = child.getBoundingClientRect();
                return box.left >= bounds.left && box.right <= bounds.right;
              },
            );
          }),
          `Composer controls clipped at ${width}px in ${engine.name()}`,
        );
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
      }
      await page.setViewportSize({ width: 390, height: 844 });
      for (const choice of ["allow", "deny"]) {
        await page.goto(
          fixture.base + "/?conversation=" + fixture.conversations[0].id,
        );
        const card = page.locator(".conversation-sheet .native-decision");
        const button = card.getByRole("button", {
          name: choice === "allow" ? "Allow" : "Deny",
          exact: true,
        });
        await expect(button).toBeVisible();
        assert(
          await button.evaluate(
            (node) => node.getBoundingClientRect().height >= 48,
          ),
        );
        assert(
          await card
            .locator(".native-decision-detail")
            .evaluate((node) => node.scrollHeight > node.clientHeight),
          "Long request must scroll separately from decision buttons",
        );
        assert(
          await card.evaluate((node) => node.scrollWidth <= node.clientWidth),
          "Long request details must wrap inside the approval card",
        );
        await card.getByText("Fewer approval prompts", { exact: true }).click();
        await expect(
          card.getByRole("button", { name: "Session settings", exact: true }),
        ).toBeVisible();
        await card
          .getByRole("button", { name: "Permissions", exact: true })
          .click();
        const settings = page.getByRole("dialog", {
          name: "Tools & integrations",
        });
        await expect(
          settings.getByRole("combobox", { name: "Agent tool calls" }),
        ).toBeVisible();
        await expect(
          settings.getByRole("combobox", { name: "Tool approvals" }),
        ).toBeVisible();
        await settings
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await button.click();
        await expect(card).toHaveCount(0);
        assert.equal(
          decisions.at(-1).answer.choice,
          choice,
          "Display labels must preserve protocol choices",
        );
        assert(decisions.at(-1).commandId);
      }
      council = true;
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(
          fixture.base + "/?conversation=" + fixture.conversations[0].id,
        );
        const card = page.locator(".conversation-sheet .native-decision");
        const detail = card.locator(".native-decision-detail");
        await expect(detail.locator("strong")).toHaveText("loop_delegate");
        await expect(
          detail.getByRole("heading", { name: "Tool arguments" }),
        ).toBeVisible();
        await expect(
          card.locator("details").filter({ hasText: "Native request details" }),
        ).not.toHaveAttribute("open");
        await expect(detail).not.toContainText("codex_approval_kind");
        await expect(detail).not.toContainText(
          "native-thread-must-be-collapsed",
        );
        assert(
          await card.evaluate((node) => node.scrollWidth <= node.clientWidth),
        );
        const accept = card.getByRole("button", {
          name: "Accept",
          exact: true,
        });
        await accept.scrollIntoViewIfNeeded();
        await expect(accept).toBeInViewport({ ratio: 1 });
        assert(
          await accept.evaluate(
            (node) => node.getBoundingClientRect().height >= 48,
          ),
        );
        await accept.click();
        await expect(card).toHaveCount(0);
        assert.equal(decisions.at(-1).answer.choice, "accept");
      }
      review = true;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(
        fixture.base + "/?conversation=" + fixture.conversations[0].id,
      );
      const reviewCard = page.locator(".conversation-sheet .native-decision");
      await expect(
        reviewCard.getByRole("heading", {
          name: "Allow tool call?",
          exact: true,
        }),
      ).toBeVisible();
      await expect(reviewCard.locator(".native-decision-detail")).toContainText(
        codexReviewApproval.message,
      );
      const reviewAccept = reviewCard.getByRole("button", {
        name: "Accept",
        exact: true,
      });
      await expect(reviewAccept).toBeInViewport({ ratio: 1 });
      await reviewAccept.click();
      await expect(reviewCard).toHaveCount(0);
      assert.equal(decisions.at(-1).answer.choice, "accept");
      await nativeQuestionLayoutSmoke(page, fixture, async (name) => {
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `${engine.name()}-${name}.png`),
          });
      });
      console.log(
        `${engine.name()}: approval actions, native question responses and Pi composer layout passed`,
      );
    } finally {
      await closeBrowser();
    }
  } finally {
    await fixture.close();
  }
}
