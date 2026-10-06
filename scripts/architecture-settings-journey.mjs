import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
export async function architectureSettingsJourney(page) {
  await openSettings(page);
  await page.getByRole("button", { name: /Execution environments/ }).click();
  await expect(
    page.getByText(
      /No managed execution environment is connected yet\. Check runtime setup for preparation progress or direct fallback\./,
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
  await expect(page.getByText(/Lexical fallback/)).toBeVisible();
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
    const label = flavor === "codex" ? "Codex · ChatGPT" : "Claude Code · Claude";
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
    await page
      .getByLabel("Provider sign-in response", { exact: true })
      .fill("synthetic-code");
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
