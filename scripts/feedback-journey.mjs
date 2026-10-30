import { closeSheets } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function feedbackJourney(page, api, base, dir) {
  // The fixture runs many independent journeys as one user. Keep this one
  // from inheriting earlier journeys' per-minute request budget.
  {
    const limits = new Database(join(dir, "loop55.db"));
    limits.pragma("busy_timeout = 10000");
    limits.prepare("DELETE FROM request_limits").run();
    limits.close();
  }
  await page.goto(base);
  await page.getByRole("heading", { name: "Feed", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Message your agent").isVisible(), false);
  await page.getByRole("button", { name: "Compose a message" }).click();
  await page.getByLabel("Message your agent").fill("Keep this draft");
  await page.getByLabel("Message your agent").press("Escape");
  await page.getByRole("button", { name: "Compose a message" }).click();
  assert.equal(
    await page.getByLabel("Message your agent").inputValue(),
    "Keep this draft",
  );
  await page.getByLabel("Message your agent").fill("");
  await page.getByLabel("Message your agent").press("Escape");

  const bootstrap = await api("/bootstrap");
  const connection = bootstrap.connections.find(
    (c) => c.provider === "openai" && c.status === "connected",
  );
  const worker = await api("/agents", {
    name: "feedback-worker",
    connectionId: connection.id,
    model: "openai-fixture",
  });
  const manager = await api("/agents", {
    name: "feedback-manager",
    connectionId: connection.id,
    model: "openai-fixture",
    instructions: "fixture-team:" + worker.id,
  });
  await page.reload();
  await page.getByRole("button", { name: /^Filter by team:/ }).click();
  await page.getByRole("button", { name: "New team", exact: true }).click();
  await page.getByLabel("Team name").fill("Feedback team");
  await page.getByLabel("Manager", { exact: true }).selectOption(manager.id);
  await page.getByRole("checkbox", { name: /^@feedback-worker · / }).check();
  await page
    .getByRole("button", { name: "Create team & talk to manager" })
    .click();
  const thread = page.locator("dialog.swipe-sheet");
  await thread.getByLabel("Reply to agent").fill("Coordinate this work");
  await page.getByRole("button", { name: "Send reply" }).click();
  // Sending from a thread keeps the thread open and shows the new message.
  await expect(thread).toBeVisible();
  await expect(thread.getByLabel("Reply to agent")).toHaveValue("");
  await expect(
    thread
      .locator("article.message")
      .filter({ hasText: "Coordinate this work" }),
  ).toBeVisible();
  await closeSheets(page);
  await expect(
    page.getByRole("button", { name: "Compose a message" }),
  ).toBeVisible();
  // Result cards live on agent profiles. Replying to one opens its thread
  // with the quoted result instead of the global composer.
  const strip = (name) =>
    page
      .locator(".agent-strip")
      .getByRole("button", { name: new RegExp(`^@${name} ·`) });
  const openProfile = async (name) => {
    await strip(name).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await expect(page.locator(".profile-handle")).toHaveText("@" + name);
    await page.getByRole("tab", { name: "Results", exact: true }).click();
  };
  await openProfile("feedback-manager");
  await page
    .locator(".feed-card")
    .filter({
      has: page.getByRole("heading", {
        name: "Coordinate this work",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(thread.getByLabel("Reply to agent")).toBeVisible();
  const chip = page.locator(".composer-reply-chip");
  await chip.locator("summary").click();
  await expect(
    page.getByRole("region", { name: "Original message" }),
  ).toContainText("Fixture response:");
  await page.getByRole("button", { name: "Clear reply context" }).click();
  await expect(chip).toHaveCount(0);
  await closeSheets(page);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".profile-head")).toHaveCount(0);
  const team = (await api("/teams")).find((t) => t.name === "Feedback team");
  await expect
    .poll(async () => (await api("/results?teams=" + team.id)).items.length)
    .toBe(2);
  // Running became the Feed "Working" filter; completed runs stay out of it.
  await page.getByRole("tab", { name: /^Working/ }).click();
  await expect(
    page.getByText("No agents are working right now.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".inbox-row")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Done/ }).click();
  await openProfile("feedback-worker");
  const card = page.locator(".feed-card").filter({
    has: page.getByRole("heading", {
      name: "Collect evidence for the team",
      exact: true,
    }),
  });
  await card
    .getByRole("button", { name: "View full result", exact: true })
    .click();
  await page.locator("dialog[open]").last().waitFor();
  await page.getByLabel("Result options", { exact: true }).click();
  await page
    .getByRole("button", { name: "Source conversation", exact: true })
    .click();
  await page.locator(".message.anchored").waitFor();
  await closeSheets(page);
  // Leaving the profile and opening it again reloads that agent's results.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".profile-head")).toHaveCount(0);
  const loadedFeed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/results" &&
      url.searchParams.get("agent") === worker.id &&
      response.ok()
    );
  });
  await strip("feedback-worker").click();
  await loadedFeed;
  await card.waitFor();
  // Long-press now opens the card's action menu (the same one as the
  // "More actions" button); archiving is an item in that menu.
  await expect(
    card.getByRole("button", { name: "More actions", exact: true }),
  ).toBeVisible();
  await card.locator(".card-content").hover();
  const rect = await card.locator(".card-content").boundingBox();
  assert.ok(rect);
  await page.mouse.move(rect.x + 20, rect.y + 25);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("menuitem", { name: "Archive" })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Archived from feed" })
    .waitFor();
  await card.waitFor({ state: "hidden" });
  const archived = (await api("/search?q=resting&agent=" + worker.id)).items;
  assert.equal(
    archived.length,
    1,
    "Archived output is searchable and deduplicated",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await card.waitFor();

  const second = await api("/teams", {
    name: "Second team",
    managerId: manager.id,
    members: [worker.id],
  });
  await page.reload();
  await page.getByRole("button", { name: /^Filter by team:/ }).click();
  await page.getByLabel("Feedback team", { exact: true }).check();
  await page.getByLabel("Second team", { exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  // The Feed shows threads from both selected teams.
  const bothTeams = (
    await api("/feed?teams=" + [team.id, second.id].sort().join(","))
  ).items.length;
  assert.ok(bothTeams > 0);
  await expect(page.locator(".inbox-card")).toHaveCount(bothTeams);
  await page.screenshot({
    path: join(tmpdir(), "loop55-feedback-mobile.png"),
    fullPage: true,
  });

  // Deep-link into a long conversation, well before the newest page.
  const fixture = new Database(join(dir, "loop55.db"));
  fixture.pragma("busy_timeout = 10000");
  const owner = (await api("/bootstrap")).agents.find(
    (a) => a.id === manager.id,
  ).owner_id;
  const ids = [];
  // The API and worker are live writers. Acquire the write lock before any
  // statement preparation can open a read snapshot on this connection.
  fixture
    .transaction(() => {
      for (let i = 0; i < 140; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        const text =
          i === 65
            ? "Anchor marker\n\n```mermaid\nflowchart TD\nA[Plan] --> B[Build]\n```"
            : "Long conversation message " + i;
        fixture
          .prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            owner,
            team.conversation_id,
            null,
            "assistant",
            text,
            "{}",
            Date.now(),
          );
      }
    })
    .immediate();
  fixture.close();
  await page.goto(
    base + "/?conversation=" + team.conversation_id + "&message=" + ids[65],
  );
  const anchor = page.locator("#message-" + ids[65]);
  await anchor.waitFor();
  await anchor.locator(".diagram svg").waitFor();
  assert.match(await anchor.locator(".diagram svg").textContent(), /Plan/);
  assert.match(await anchor.locator(".diagram svg").textContent(), /Build/);
  assert.equal(await anchor.locator(".diagram foreignObject").count(), 0);
  // The composer and diagram resize after the initial deep-link scroll.
  await expect(anchor).toBeInViewport();
  await page.screenshot({
    path: join(tmpdir(), "loop55-feedback-diagram.png"),
  });
  await closeSheets(page);
  for (const width of [320, 390, 430, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "No overflow at " + width,
    );
  }
  assert.equal((await api("/results?teams=" + second.id)).items.length, 0);
  console.log(
    "PASS: composer drafts, Anthropic selection, team delegation and multi-select feeds, completed runs out of Working, in-thread send and result reply, card/profile navigation, long-press menu archive/search/Undo, older message anchors, native diagrams, responsive layout.",
  );
}
