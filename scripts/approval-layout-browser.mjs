import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";

// Fixture-only: real UI, no native provider or external tool execution.
const fixture = await designFixture();
try {
  for (const engine of selectedEngines()) {
    const browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium
          ? process.env.CHROMIUM_PATH || undefined
          : undefined,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      await page.route("**/api/capabilities", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), nativeHarnesses: true },
        });
      });
      await page.route("**/api/bootstrap", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({
          json: {
            ...data,
            agents: data.agents.map((a) => ({ ...a, provider: "pi" })),
          },
        });
      });
      const decisions = [];
      await page.route("**/api/native/decisions**", async (route) => {
        if (route.request().method() === "POST") {
          decisions.push(route.request().postDataJSON());
          return route.fulfill({ json: { state: "resolved" } });
        }
        await route.fulfill({
          json: [
            {
              id: "layout-approval",
              conversation_id: fixture.conversations[0].id,
              name: "winter",
              state: "pending",
              request: JSON.stringify({
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
              }),
            },
          ],
        });
      });
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(fixture.base);
        await page.locator(".composer-launch").click();
        const composer = page.locator(".composer-dock:not(.thread-mode)");
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
        const card = page.locator(".native-decision");
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
      console.log(
        `${engine.name()}: approval actions and Pi composer layout passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
