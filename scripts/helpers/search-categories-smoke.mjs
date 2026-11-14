import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

export async function searchCategoriesSmoke(page, fixture, _engine, capture) {
  const { db, owner, base, conversations } = fixture;
  const running = conversations.find((item) => item.state === "running");
  const question = db
    .prepare("SELECT id FROM messages WHERE run_id=? AND role='user'")
    .get(running.run);
  const steering = randomUUID(),
    published = randomUUID();
  db.prepare(
    "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,state,created_at) VALUES(?,?,?,?,?,'{}','delivered',?)",
  ).run(steering, owner, running.run, question.id, steering, Date.now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','Searchable published reply about the review',?,?)",
  ).run(
    published,
    owner,
    running.id,
    running.run,
    JSON.stringify({
      progress: true,
      reply: { to: question.id, published: true },
    }),
    Date.now(),
  );
  db.prepare(
    "INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at) VALUES(?,?,?,?)",
  ).run(published, owner, steering, Date.now());
  await page.goto(base);
  const nav = page.locator(".mobile-nav");
  await nav.getByRole("button", { name: "Search", exact: true }).click();
  const category = page.getByRole("combobox", { name: "Search category" });
  await expect(category.locator("option")).toHaveText([
    "All Feed categories",
    "Done",
    "Working",
    "Queued",
    "Replies",
    "Threads",
  ]);
  const input = page.getByRole("searchbox", { name: "Search everything" });
  const results = page.locator(".search-result");
  const responseFor = (value) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/search" &&
        (url.searchParams.get("category") || "") === value
      );
    });
  async function choose(value) {
    const response = responseFor(value);
    await category.selectOption(value);
    expect((await response).ok()).toBe(true);
    await expect(page.getByText("Finding…", { exact: true })).toHaveCount(0);
  }
  // Selecting a category before the first search affects its first request.
  await category.selectOption("done");
  await input.fill("review");
  const first = responseFor("done");
  await input.press("Enter");
  expect((await first).ok()).toBe(true);
  await expect(results).toHaveCount(2);
  await choose("working");
  await expect(results).toHaveCount(1);
  await expect(results).toContainText("Review GitHub pull request");
  await choose("replies");
  await expect(results).toHaveCount(1);
  await expect(results).toContainText("Searchable published reply");
  await choose("queued");
  await expect(results).toHaveCount(0);
  await expect(
    page.getByText("Nothing found yet.", { exact: true }),
  ).toBeVisible();
  await choose("threads");
  expect(await results.count()).toBeGreaterThan(1);
  await choose("replies");
  // Navigation restores the selected category and matching results.
  await nav.getByRole("button", { name: "Feed", exact: true }).click();
  await nav.getByRole("button", { name: "Search", exact: true }).click();
  await expect(category).toHaveValue("replies");
  await expect(input).toHaveValue("review");
  await expect(results).toHaveCount(1);
  const project = db
    .prepare(
      "SELECT json_extract(payload,'$.folderId') id FROM runs WHERE id=?",
    )
    .get(running.run);
  const filtered = responseFor("replies");
  await page
    .getByRole("combobox", { name: "Search project" })
    .selectOption(project.id);
  const filteredResponse = await filtered;
  expect(new URL(filteredResponse.url()).searchParams.get("project")).toBe(
    project.id,
  );
  await expect(results).toHaveCount(1);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(category).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(`search-category-${width}`);
  }
  const cleared = responseFor("");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await cleared;
  await expect(category).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Search project" }),
  ).toHaveValue("");

  // A late response must not restore the previous category's results, even
  // when the category changes during the first request after clearing text.
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await category.selectOption("done");
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/search?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("category") === "done"
    ) {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await input.fill("review");
    await input.press("Enter");
    await pending;
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => {
        const url = new URL(request.url());
        return (
          url.pathname.endsWith("/search") &&
          url.searchParams.get("category") === "done"
        );
      },
    });
    await choose("replies");
    await aborted;
    await expect(results).toHaveCount(1);
    release();
    await expect(category).toHaveValue("replies");
    await expect(results).toHaveCount(1);
    await expect(results).toContainText("Searchable published reply");
  } finally {
    release();
    await page.unroute("**/api/search?**");
  }
}
