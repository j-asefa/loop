import { briefIsolationSmoke } from "./brief-isolation-smoke.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function briefStatesSmoke(
  page,
  fixture,
  capture,
  { project, root, ids },
) {
  const { api, db } = fixture;
  const openProject = async () => {
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Projects", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Loop release/ })
      .first()
      .click();
    await page
      .locator(".project-tabs")
      .getByRole("button", { name: "Brief", exact: true })
      .click();
  };
  const sheet = page.locator("dialog.brief-sheet[open]");
  const close = () =>
    sheet.getByRole("button", { name: "Close", exact: true }).click();
  const refresh = async () => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith(root) && r.request().method() === "GET",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
    await response;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  };
  // Generation off keeps the ledger editable, without losing the explicit recorded view.
  await page
    .getByRole("button", { name: "Brief settings", exact: true })
    .click();
  await sheet.getByRole("button", { name: "Turn off", exact: true }).click();
  await page
    .getByRole("button", { name: "View recorded brief", exact: true })
    .click();
  await page.locator(".brief-goal").click();
  await sheet
    .getByLabel("Goal · you")
    .fill("Recorded goals stay visible with generation off.");
  await sheet.getByRole("button", { name: "Save goal", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".brief-goal")).toContainText(
    "Recorded goals stay visible",
  );
  await expect(
    page.getByText("Generation is off. These are your recorded items."),
  ).toBeVisible();
  await capture("disabled-recorded");
  await page
    .getByRole("button", { name: "Brief settings", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Enable brief", exact: true })
    .click();
  await expect(sheet).toHaveCount(0);

  const normal = await api(root);
  let snapshot = normal,
    fail = false;
  const pattern = "**/api" + root;
  await page.route(pattern, (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: "Brief refresh is temporarily unavailable" },
        })
      : route.fulfill({ json: snapshot }),
  );
  fail = true;
  await refresh();
  await expect(page.getByRole("alert")).toContainText(
    "Brief refresh is temporarily unavailable",
  );
  await expect(page.locator(".brief-headline h2")).toHaveText(
    normal.headline.text,
  );
  fail = false;
  await page.getByRole("button", { name: "Retry brief", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const unfinished = {
    ...normal.decisions[0],
    id: "fixture-unfinished",
    kind: "unfinished",
    status: "open",
    text: "A remaining task must stay visible",
    next: "Check the project record",
    blocker: "Waiting for a dependency",
  };
  for (const status of ["idle", "working", "blocked"]) {
    snapshot = {
      ...normal,
      needs_you: [],
      status,
      unfinished: [unfinished],
      overflow: { ...normal.overflow, unfinished: 0 },
    };
    await refresh();
    await expect(page.locator(".brief-quiet")).toContainText(
      status === "blocked"
        ? "Work is blocked"
        : status === "working"
          ? "Work is in progress"
          : "Nothing needs you",
    );
    await page.getByRole("tab", { name: /^Next / }).click();
    await expect(page.locator(".brief-record")).toContainText(
      "A remaining task must stay visible",
    );
    await capture(status);
  }
  snapshot = {
    ...snapshot,
    basis: { ...normal.basis, pending: 12, unincorporated_before: 1 },
    settings: {
      ...normal.settings,
      lastError: "The selected connection needs attention.",
    },
  };
  await refresh();
  await expect(page.locator(".brief-headline")).toContainText(
    "12 newer events are waiting to be incorporated.",
  );
  await expect(page.locator(".brief-headline")).toContainText(
    "Older project history has not been fully incorporated.",
  );
  await expect(page.getByRole("alert")).toContainText(
    "The brief could not update",
  );
  await expect(page.locator(".project-brief")).not.toContainText("Updating…");
  await page
    .getByRole("button", { name: "Check brief settings", exact: true })
    .click();
  await expect(
    sheet.getByRole("combobox", { name: "Connection", exact: true }),
  ).toBeVisible();
  await close();
  await capture("pending-and-error");

  // Oversized real-contract strings/counts and user text scaling must wrap.
  snapshot = {
    ...normal,
    headline: { ...normal.headline, text: "A".repeat(140) },
    goal: { text: "B".repeat(200) },
    needs_you: [],
    state: [
      {
        ...normal.decisions[0],
        kind: "state",
        id: "long-state",
        text: "C".repeat(240),
      },
    ],
    overflow: { ...normal.overflow, decisions: 123456 },
  };
  await refresh();
  await page.getByRole("tab", { name: /^State / }).click();
  const heading = page.locator(".project-heading h2");
  const originalName = await heading.textContent();
  await heading.evaluate((el) => {
    el.textContent = "LongProjectName".repeat(12);
  });
  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty("--reading-size", "24px");
      }, theme);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `Long content overflow at ${width}/${theme}`,
      );
      await capture(`long-${width}-${theme}`);
    }
  }
  await heading.evaluate((el, name) => {
    el.textContent = name;
  }, originalName);
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--reading-size");
    document.documentElement.dataset.theme = "light";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  snapshot = {
    ...normal,
    version: 0,
    acknowledged_version: 0,
    headline: null,
    goal: null,
    state: [],
    decisions: [],
    open_questions: [],
    unfinished: [],
    needs_you: [],
    status: "idle",
    overflow: { state: 0, decisions: 0, open_questions: 0, unfinished: 0 },
    changes: [],
    artifacts: [],
    sources: {},
    coverage: { results: 0, threads: 0, model: null },
    basis: {
      ...normal.basis,
      synth_at: null,
      pending: 0,
      unincorporated_before: null,
    },
  };
  await refresh();
  await expect(page.locator(".brief-headline")).toContainText(
    "Not generated yet",
  );
  for (const [tab, text] of [
    ["State", "No current state recorded."],
    ["Decisions", "No active decisions recorded."],
    ["Questions", "No open questions recorded."],
    ["Next", "No unfinished work recorded."],
  ]) {
    await page.getByRole("tab", { name: new RegExp("^" + tab + " ") }).click();
    await expect(page.locator(".brief-record")).toContainText(text);
    await expect(page.locator(".brief-all")).toBeVisible();
  }
  await capture("enabled-empty");
  snapshot = normal;
  await refresh();
  await page.unroute(pattern);

  // Closing and reopening a decision must not accept the old evidence response.
  let releaseChoices,
    firstChoices = true;
  const heldChoices = new Promise((resolve) => {
    releaseChoices = resolve;
  });
  await page.route("**/brief/decision-sources", async (route) => {
    if (!firstChoices) return route.continue();
    firstChoices = false;
    await heldChoices;
    await route.fulfill({ json: { items: [] } });
  });
  const add = () =>
    page
      .getByRole("button", { name: "Record a decision", exact: true })
      .click();
  await add();
  await expect(sheet.getByText("Loading evidence…")).toBeVisible();
  await close();
  await add();
  await expect(sheet.getByLabel("Evidence", { exact: true })).toBeVisible();
  await sheet
    .getByLabel("Decision", { exact: true })
    .fill("The current draft survives an old evidence response");
  const choicesResponse = page.waitForResponse((response) =>
    response.url().endsWith("/brief/decision-sources"),
  );
  releaseChoices();
  await choicesResponse;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(sheet.getByLabel("Evidence", { exact: true })).toBeVisible();
  await expect(sheet.getByLabel("Decision", { exact: true })).toHaveValue(
    "The current draft survives an old evidence response",
  );
  await close();
  await page.unroute("**/brief/decision-sources");

  // Initial-load failure has a real retry path, distinct from retained-content refresh.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      json: { error: "Initial brief load failed" },
    });
  });
  await page.goto(fixture.base, { waitUntil: "domcontentloaded" });
  await openProject();
  await expect(page.getByText("Loading brief…", { exact: true })).toBeVisible();
  await capture("first-load");
  release();
  await expect(page.getByRole("alert")).toContainText(
    "Initial brief load failed",
  );
  await capture("first-load-error");
  await page.unroute(pattern);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".project-brief")).toBeVisible();

  // Setup with no eligible provider is explicit and cannot claim success.
  const connections = db
    .prepare("SELECT id,status FROM connections WHERE owner_id=?")
    .all(fixture.owner);
  db.prepare(
    "UPDATE connections SET status='needs_sign_in' WHERE owner_id=?",
  ).run(fixture.owner);
  await api(
    root + "/settings",
    { enabled: false, connectionId: null, model: null },
    "PUT",
  );
  await page.goto(fixture.base);
  await openProject();
  await expect(
    page.getByRole("combobox", { name: "Connection", exact: true }),
  ).toContainText("No compatible connection available");
  await expect(
    page.getByRole("button", { name: "Enable brief", exact: true }),
  ).toBeDisabled();
  await capture("setup-no-connection");
  for (const connection of connections)
    db.prepare("UPDATE connections SET status=? WHERE id=?").run(
      connection.status,
      connection.id,
    );
  await api(
    root + "/settings",
    {
      enabled: true,
      connectionId: normal.settings.connectionId,
      model: normal.settings.model,
    },
    "PUT",
  );
  await page.goto(fixture.base);
  await openProject();
  await expect(page.locator(".project-brief")).toBeVisible();
  await briefIsolationSmoke(page, fixture, await api(root));
}
