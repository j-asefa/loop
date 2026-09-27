import { closeSheets } from "./helpers/browser-ui.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
export async function architectureSettingsJourney(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Execution environments/ }).click();
  await expect(
    page.getByText(
      /Run loop on your laptop to set up an execution environment/,
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  const states = { codex: { state: "idle" }, claude: { state: "idle" } };
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
    if (action === "start")
      states[flavor] = {
        id: crypto.randomUUID(),
        state: "waiting",
        expiresAt: Date.now() + 60000,
        login: {
          url:
            flavor === "codex"
              ? "https://auth.openai.com/codex/device"
              : "https://claude.ai/oauth/authorize",
          code: flavor === "codex" ? "AB12-CD34" : undefined,
          acceptsCode: flavor === "claude",
        },
      };
    if (["cancel", "code"].includes(action)) {
      const body = route.request().postDataJSON();
      assert.equal(body.attemptId, states[flavor].id);
      submissions.push({ flavor, action, body });
      if (action === "cancel") states[flavor] = { state: "cancelled" };
      return route.fulfill({ json: { ok: true } });
    }
    const snapshot = structuredClone(states[flavor]);
    if (action === "status")
      await new Promise((resolve) => setTimeout(resolve, 120));
    return route.fulfill({ json: snapshot });
  });
  const open = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /Execution environments/ }).click();
  };
  try {
    await page.goto(new URL("/", originalPage.url()).href);
    await open();
    await page
      .getByRole("button", { name: "Start sign-in", exact: true })
      .click();
    await expect(page.getByText("AB12-CD34", { exact: true })).toBeVisible();
    await closeSheets(page);
    await open();
    await expect(page.getByText("AB12-CD34", { exact: true })).toBeVisible();
    await page
      .getByLabel("Native runtime", { exact: true })
      .selectOption("claude");
    await expect(page.getByText("AB12-CD34", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Start sign-in", exact: true })
      .click();
    await page
      .getByLabel("Provider verification code", { exact: true })
      .fill("synthetic-code");
    await page
      .getByRole("button", { name: "Submit code", exact: true })
      .click();
    await expect
      .poll(() => submissions.filter((s) => s.action === "code").length)
      .toBe(1);
    await page
      .getByRole("button", { name: "Cancel sign-in", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel sign-in", exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("Native runtime", { exact: true })
      .selectOption("codex");
    await expect(page.getByText("AB12-CD34", { exact: true })).toBeVisible();
    assert.deepEqual(
      submissions.map(({ flavor, action }) => ({ flavor, action })),
      [
        { flavor: "claude", action: "code" },
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
