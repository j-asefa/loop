import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";
import { closeSheets } from "./helpers/browser-ui.mjs";
const fixture = await designFixture();
let browser;
try {
  fixture.db
    .prepare(
      "UPDATE messages SET metadata=json_set(metadata,'$.personal',json('true'),'$.attachments',json('[]')) WHERE role='user'",
    )
    .run();
  const seed = fixture.db
    .prepare("SELECT id FROM messages WHERE role='user' LIMIT 1")
    .get();
  for (let index = 0; index < 60; index++)
    fixture.db
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) SELECT ?,owner_id,conversation_id,run_id,role,content,metadata,created_at-? FROM messages WHERE id=?",
      )
      .run("personal-history-smoke-" + index, index + 1, seed.id);
  const fullPrompt =
    "Review the complete design. ".repeat(65) + "End of the full prompt.";
  fixture.db
    .prepare("UPDATE messages SET content=? WHERE id=?")
    .run(fullPrompt, seed.id);
  const expected = fixture.db
    .prepare("SELECT COUNT(*) n FROM messages WHERE role='user'")
    .get().n;
  const pageData = await fixture.api("/me/prompts?owner=someone-else");
  assert.equal(pageData.items.length, 50);
  assert(pageData.next, "Fixture must exercise multiple history pages");
  const history = [...pageData.items];
  let cursor = pageData.next;
  while (cursor) {
    const more = await fixture.api(
      "/me/prompts?before=" + encodeURIComponent(cursor),
    );
    history.push(...more.items);
    assert(
      history.length <= expected,
      "History pagination must not repeat entries",
    );
    assert.notEqual(more.next, cursor, "History cursor must advance");
    cursor = more.next;
  }
  assert.equal(history.length, expected);
  assert.equal(new Set(history.map((item) => item.id)).size, expected);
  assert(new Set(history.map((item) => item.project_name)).size > 1);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  });
  let page;
  const errors = [];

  async function loadHistory() {
    const articles = page.locator(".personal-history article");
    await expect(articles.first()).toBeVisible();
    while ((await articles.count()) < expected) {
      const count = await articles.count();
      await page
        .locator(".personal-history > div")
        .last()
        .scrollIntoViewIfNeeded();
      await expect.poll(() => articles.count()).toBeGreaterThan(count);
    }
    await expect(articles).toHaveCount(expected);
  }
  for (const width of [1280, 390, 320]) {
    page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on("pageerror", (error) => errors.push(error.message));
    let historyRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/me/prompts")
        historyRequests++;
    });
    for (const project of fixture.projects.slice(0, 2)) {
      await page.goto(fixture.base + "/?page=projects&folder=" + project.id);
      await page
        .getByRole("button", { name: "Profile", exact: true })
        .filter({ visible: true })
        .click();
      await page.locator(".personal-profile-head").scrollIntoViewIfNeeded();
      await expect(page.locator(".personal-profile-head h1")).toBeVisible();
      await expect(page.locator(".workspace-content h1:visible")).toHaveCount(
        1,
      );
      await loadHistory();
    }
    await page.reload();
    await loadHistory();
    await page.locator(".personal-profile-head").scrollIntoViewIfNeeded();
    await expect(page.locator(".personal-profile-head h1")).toBeVisible();
    await expect(page.getByText(fullPrompt, { exact: true })).toBeVisible();
    const avatar = page.locator(".personal-agent-avatar").last();
    await avatar.scrollIntoViewIfNeeded();
    const agentLabel = await avatar.getAttribute("aria-label");
    const agentName = agentLabel.slice(5, -8);
    const profileScroll = await page.evaluate(() => scrollY);
    assert(profileScroll > 0, "Agent link should be in scrolled history");
    const loadedRequests = historyRequests;
    await avatar.click();
    await expect(
      page.locator(".profile-head:not(.personal-profile-head) h1"),
    ).toHaveText(agentName);
    await expect(page.locator(".profile-handle")).toHaveText("@" + agentName);
    await expect(page.locator(".personal-history")).toBeHidden();
    await page
      .getByRole("button", { name: "Back to profile", exact: true })
      .click();
    assert.equal(
      await page.locator(".personal-history article").count(),
      expected,
      "Returning from an agent must keep every loaded history page",
    );
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(profileScroll);
    await expect(page.locator(".workspace-content h1:visible")).toHaveCount(1);
    assert.equal(
      historyRequests,
      loadedRequests,
      "Returning must not refetch prompt history",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Horizontal overflow",
    );
    const link = page.locator(".personal-history article a").last();
    await link.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => {
      window.__personalHistoryProbe = true;
      return scrollY;
    });
    await link.click();
    await expect(page.locator("dialog[open] .message").first()).toBeVisible();
    assert(new URL(page.url()).searchParams.has("message"));
    assert(
      await page.evaluate(() => window.__personalHistoryProbe),
      "Conversation link must not reload the app",
    );
    await expect(page.locator(".personal-history article")).toHaveCount(
      expected,
    );
    await closeSheets(page);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(scroll);
    await expect(page.locator(".personal-history article")).toHaveCount(
      expected,
    );
    await page.close();
  }
  const namePage = await browser.newPage();
  let sessionName = "  🌟 Ada  ";
  await namePage.route("**/api/auth/get-session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    session.user.name = sessionName;
    await route.fulfill({ response, json: session });
  });
  await namePage.goto(fixture.base + "/?page=personal");
  await expect(namePage.locator(".personal-profile-head h1")).toHaveText(
    "🌟 Ada",
  );
  await expect(
    namePage.locator(".personal-profile-head .avatar.user"),
  ).toHaveText("🌟A");
  sessionName = "   ";
  await namePage.reload();
  await expect(namePage.locator(".personal-profile-head h1")).toHaveText("You");
  await expect(
    namePage.locator(".personal-profile-head .avatar.user"),
  ).toHaveText("Y");
  await namePage.close();
  assert.deepEqual(errors, []);
  console.log(
    "Personal profile browser checks passed at 1280, 390, and 320px: cross-project navigation, reload, pagination, agent and conversation links preserving loaded pages and scroll, Unicode and blank names, and no horizontal overflow.",
  );
} finally {
  await browser?.close();
  await fixture.close();
}
