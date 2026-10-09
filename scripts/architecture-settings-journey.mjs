import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
export async function architectureSettingsJourney(page) {
  await openSettings(page);
  await page.getByRole("button", { name: /Execution environments/ }).click();
  // The empty state leads with the state and keeps both explanations one tap
  // away instead of printing them as a paragraph.
  await expect(page.getByText("No environment connected yet")).toBeVisible();
  await page.getByRole("button", { name: /Add Docker execution/ }).click();
  await expect(
    page.getByText(/Restart Loop with .*to run agents in Docker/),
  ).toBeVisible();
  await page.getByRole("button", { name: /Environment not appearing/ }).click();
  await expect(
    page.getByText(
      /check runtime setup for preparation progress or direct fallback\./,
    ),
  ).toBeVisible();
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  await closeSheets(page);
  await openSettings(page);
  await page.getByRole("button", { name: /Shared memory/ }).click();
  // Readiness is a note beside the toggle rather than a status sentence.
  await expect(page.getByText(/Keyword matching for now/)).toBeVisible();
  await expect(page.getByText(/semantic index is unavailable/)).toBeVisible();
  // Pinning a note is a focused sub-form, not three fields on the page.
  await page.getByRole("button", { name: "Pin a note" }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Synthetic mobile decision");
  await page
    .getByLabel("Note", { exact: true })
    .fill("User chose SQLite WAL for durable queue state.");
  await page.getByRole("button", { name: "Pin note", exact: true }).click();
  await page
    .getByRole("button", { name: "Synthetic mobile decision", exact: true })
    .click();
  await page
    .getByLabel("Note content", { exact: true })
    .fill("User reaffirmed SQLite WAL after the outage review.");
  await page.getByRole("button", { name: "Save note revision" }).click();
  await expect(page.getByText(/Revision 2/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(tmpdir(), "loop-architecture-memory-mobile.png"),
  });
  await page
    .getByRole("button", { name: "Remove from shared memory" })
    .last()
    .click();
  await expect(page.getByText(/Removed/)).toBeVisible();
  await closeSheets(page);
  console.log(
    "PASS: setup-required state, 320/390/1024 layout, memory readiness, note creation/revision/tombstone through the real application API.",
  );
  await nativeLoginFixture(page);
}

async function nativeLoginFixture(originalPage) {
  // WebKit service-worker requests bypass page routing. Use a fresh fixture
  // context; the preceding real-API journey already checks the installed PWA.
  const context = await originalPage
    .context()
    .browser()
    .newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
  const page = await context.newPage();
  const states = {};
  const providers = (flavor) => [
    {
      id: flavor,
      name: flavor === "codex" ? "ChatGPT" : "Claude",
      methods: [{ id: "oauth", type: "oauth", label: "Native OAuth" }],
    },
  ];
  const submissions = [];
  const environments = "**/api/environments";
  const environment = "**/api/environments/fixture-native/**";
  await page.route(environments, (route) =>
    route.fulfill({
      json: [
        {
          id: "fixture-native",
          name: "Synthetic native login fixture",
          instance_id: "i-fixture",
          state: "online",
          capacity: 2,
          health: "{}",
          last_seen: Date.now(),
        },
      ],
    }),
  );
  await page.route(environment, async (route) => {
    const match = new URL(route.request().url()).pathname.match(
      /provider\/(codex|claude)\/(\w+)$/,
    );
    if (!match) return route.fulfill({ json: [] });
    const [, flavor, action] = match;
    if (action === "start") {
      const body = route.request().postDataJSON();
      assert.equal(body.provider, flavor);
      assert.equal(body.method, "oauth");
      assert.ok(body.commandId);
      states[flavor] = {
        id: crypto.randomUUID(),
        provider: flavor,
        method: "oauth",
        state: "waiting",
        expiresAt: Date.now() + 60000,
        url:
          flavor === "codex"
            ? "https://auth.openai.com/codex/device"
            : "https://claude.ai/oauth/authorize",
        code: flavor === "codex" ? "AB12-CD34" : undefined,
        ...(flavor === "claude"
          ? {
              prompt: {
                id: crypto.randomUUID(),
                type: "manual_code",
                message: "Enter verification code",
              },
            }
          : {}),
      };
    }
    if (["cancel", "input"].includes(action)) {
      const body = route.request().postDataJSON();
      assert.equal(body.attemptId, states[flavor].id);
      if (action === "input") {
        assert.equal(body.promptId, states[flavor].prompt.id);
        assert.equal(body.value, "synthetic-code");
        delete states[flavor].prompt;
      }
      submissions.push({ flavor, action, body });
      if (action === "cancel") states[flavor].state = "cancelled";
    }
    const snapshot = {
      providers: providers(flavor),
      attempt: structuredClone(states[flavor]),
    };
    if (action === "status")
      await new Promise((resolve) => setTimeout(resolve, 120));
    return route.fulfill({ json: snapshot });
  });
  const connect = async (flavor) => {
    const label =
      flavor === "codex" ? "Codex · ChatGPT" : "Claude Code · Claude";
    // Each provider signs in on its own sheet above the provider list; leave
    // the open one the way a person would before choosing another provider.
    const providerSheet = page.locator(
      'dialog[aria-label="Codex"], dialog[aria-label="Claude Code"]',
    );
    if (await providerSheet.count()) {
      await providerSheet
        .locator(":scope > .sheet-inner > .sheet-head")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(providerSheet).toHaveCount(0);
    }
    await page
      .locator(".environment-provider")
      .filter({ hasText: label })
      .getByRole("button", { name: "Connect", exact: true })
      .click();
  };
  const open = async (flavor) => {
    await openSettings(page);
    await page.getByRole("button", { name: /Execution environments/ }).click();
    await connect(flavor);
  };
  try {
    await page.goto(new URL("/", originalPage.url()).href);
    await open("codex");
    await page
      .getByRole("button", { name: "Start sign-in", exact: true })
      .click();
    await expect(page.getByText("AB12-CD34", { exact: true })).toBeVisible();
    await closeSheets(page);
    await open("codex");
    await expect(page.getByText("AB12-CD34", { exact: true })).toBeVisible();
    await connect("claude");
    await expect(page.getByText("AB12-CD34", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Start sign-in", exact: true })
      .click();
    const response = page.getByLabel("Provider sign-in response", {
      exact: true,
    });
    await response.fill("previous-prompt-code");
    // A status refresh of the same prompt must preserve the response. A new
    // prompt must clear it before becoming interactive, even in the same attempt.
    await page.waitForResponse((res) =>
      res.url().endsWith("/provider/claude/status"),
    );
    await expect(response).toHaveValue("previous-prompt-code");
    states.claude.prompt = {
      ...states.claude.prompt,
      id: crypto.randomUUID(),
      message: "Enter the next verification code",
    };
    await expect(
      page.getByText("Enter the next verification code", { exact: true }),
    ).toBeVisible();
    await expect(response).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Continue sign-in", exact: true }),
    ).toBeDisabled();
    await response.fill("synthetic-code");
    await page
      .getByRole("button", { name: "Continue sign-in", exact: true })
      .click();
    await expect
      .poll(() => submissions.filter((s) => s.action === "input").length)
      .toBe(1);
    await page
      .getByRole("button", { name: "Cancel sign-in", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel sign-in", exact: true }),
    ).toHaveCount(0);
    await connect("codex");
    await expect(page.getByText("AB12-CD34", { exact: true })).toBeVisible();
    assert.deepEqual(
      submissions.map(({ flavor, action }) => ({ flavor, action })),
      [
        { flavor: "claude", action: "input" },
        { flavor: "claude", action: "cancel" },
      ],
    );
    await closeSheets(page);
    console.log(
      "PASS: native sign-in recovery on reopen, provider isolation and attempt-bound code/cancel on phone (protocol fixture; no provider login).",
    );
  } finally {
    await page.unroute(environments);
    await page.unroute(environment);
    await context.close();
  }
}
