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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
    await page.setViewportSize({ width, height: 844 });
    for (const project of fixture.projects.slice(0, 2)) {
      await page.goto(fixture.base + "/?page=projects&folder=" + project.id);
      await page
        .getByRole("button", { name: "Profile", exact: true })
        .filter({ visible: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Your profile" }),
      ).toBeVisible();
      await loadHistory();
    }
    await page.reload();
    await loadHistory();
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
  }
  assert.deepEqual(errors, []);
  console.log(
    "Personal profile browser checks passed at 1280, 390, and 320px: cross-project navigation, reload, pagination, conversation links preserving loaded pages and scroll, and no horizontal overflow.",
  );
} finally {
  await browser?.close();
  await fixture.close();
}
