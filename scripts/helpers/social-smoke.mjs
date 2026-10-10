import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Social, driven against stories already in the store: Loop reads a feed from
// feed_stories, so this needs no network and no feed fixture server. It checks
// what the page does with them — reading, saving, narrowing, searching — which
// is where the behaviour lives.

const story = (n, title, extra = {}) => ({
  id: `s${n}`,
  title,
  url: `https://example.com/${n}`,
  site: "example.com",
  comments_url: `https://news.ycombinator.com/item?id=${n}`,
  published_at: Date.UTC(2026, 9, 5, 12 - n),
  community: null,
  author: null,
  points: 10 * n,
  comments: n,
  summary: `What story ${n} is about.`,
  image: null,
  media: null,
  ...extra,
});

/** Two catalog feeds, followed, with stories Loop has already read. */
export function seedFeeds(db, owner) {
  const feeds = [
    [
      "hackernews",
      "Tech news",
      ["A faster build system", "Rust in the kernel"],
    ],
    ["lobsters", "Communities", ["A note on Postgres indexes"]],
  ];
  let n = 0;
  for (const [feed, , titles] of feeds) {
    db.prepare(
      "INSERT OR IGNORE INTO feed_subscriptions(owner_id,feed_id,created_at) VALUES(?,?,?)",
    ).run(owner, feed, Date.now());
    for (const title of titles) {
      const item = story(++n, title, {
        image: n === 1 ? "https://pictures.example/a.png" : null,
      });
      db.prepare(
        `INSERT OR REPLACE INTO feed_stories(feed_id,story_id,url,title,summary,story,published_at,first_seen_at,fetched_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        feed,
        item.id,
        item.url,
        item.title,
        item.summary,
        JSON.stringify(item),
        item.published_at,
        Date.now(),
        Date.now(),
      );
    }
    db.prepare(
      `INSERT OR REPLACE INTO feed_state(feed_id,title,home,fetched_at,failures,stories)
       VALUES(?,?,?,?,0,?)`,
    ).run(feed, feed, feed + ".example", Date.now(), titles.length);
  }
  return { total: n, titles: feeds.flatMap(([, , titles]) => titles) };
}

export async function socialSmoke(page, fixture, shot) {
  const { total, titles } = seedFeeds(fixture.db, fixture.owner);
  await page.goto(fixture.base + "/?filter=social");
  const social = page.getByRole("list", { name: "Social" });
  await page.waitForSelector(".news-card");
  const cards = social.locator(".news-card");
  await cards.first().waitFor();
  assert.equal(await cards.count(), total, "Every stored story must show");
  const agents = page.getByRole("region", { name: "Your agents", exact: true });
  // Toggling the header keeps your place partway down the page, even without
  // scroll anchoring (Safari has none).
  const noAnchoring = await page.addStyleTag({
    content: "* { overflow-anchor: none !important; }",
  });
  const toggle = page.locator(".social-header-toggle");
  for (const name of ["Hide feed header", "Show feed header"]) {
    await toggle.evaluate((el) =>
      window.scrollBy(0, el.getBoundingClientRect().top - 120),
    );
    const before = Math.round((await toggle.boundingBox()).y);
    await page.getByRole("button", { name, exact: true }).click();
    await expect
      .poll(async () => Math.round((await toggle.boundingBox()).y))
      .toBe(before);
  }
  await noAnchoring.evaluate((el) => el.remove());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Hide feed header", exact: true }).click();
  await expect(page.locator(".social-controls")).toBeHidden();
  await expect(agents).toBeHidden();
  await shot("rss-header-hidden");
  await page.reload();
  await expect(page.getByRole("button", { name: "Show feed header", exact: true })).toBeVisible();
  await expect(page.locator(".social-controls")).toBeHidden();
  await expect(cards).toHaveCount(total);
  await page.getByRole("tab", { name: "Done", exact: true }).click();
  await expect(agents).toBeVisible();
  await page.getByRole("tab", { name: /^Social/ }).click();
  await expect(agents).toBeHidden();
  await page.getByRole("button", { name: "Show feed header", exact: true }).click();
  await expect(page.locator(".social-controls")).toBeVisible();
  await expect(agents).toBeVisible();
  // Stories are unread until read, and the Social chip says how many.
  assert.equal(
    await social.locator(".news-card[data-unread]").count(),
    total,
    "Stored stories start unread",
  );
  const chip = page
    .getByRole("tablist", { name: "Show" })
    .getByRole("tab", { name: /^Social/ });
  await chip.locator(".chip-count").waitFor();
  assert.equal(await chip.locator(".chip-count").innerText(), String(total));
  await shot("social-list");

  // Opening the headline is what most people do, so it has to count as reading
  // the story, like Open and Discussion do.
  const headline = cards.first().locator("h2 a");
  const title = await headline.innerText();
  await headline.click({ modifiers: ["Alt"] });
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll(".news-card")].some(
        (card) =>
          card.querySelector("h2 a")?.textContent === text &&
          !card.hasAttribute("data-unread"),
      ),
    title,
  );
  await page.getByRole("button", { name: `Mark ${title} unread` }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card[data-unread]").length === n,
    total,
  );

  // Marking one read drops the count and the accent.
  await cards
    .first()
    .getByRole("button", { name: /^Mark .* read$/ })
    .click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card[data-unread]").length === n,
    total - 1,
  );
  // The chip's count comes from the Feed's summary, which reloads behind it.
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.textContent?.startsWith("Social"))
        ?.querySelector(".chip-count")?.textContent === text,
    String(total - 1),
  );

  // Narrowing to one feed shows only its stories.
  const feedChips = page.getByRole("group", { name: "Feed" });
  await feedChips.getByRole("button", { name: "Lobsters" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".news-card").length === 1,
  );
  await feedChips.getByRole("button", { name: "Lobsters" }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total,
  );

  // Searching reaches the store, not just the page.
  const search = page.getByRole("searchbox", { name: /Search your feeds/i });
  await search.fill("postgres");
  await page.waitForFunction(
    () => document.querySelectorAll(".news-card").length === 1,
  );
  assert.match(
    await cards.first().locator("h2").innerText(),
    /Postgres/,
    "Search must find the story by a word in its title",
  );
  const searchTitle = await cards.first().locator("h2 a").innerText();
  await cards.first().getByRole("button", { name: `Mark ${searchTitle} read`, exact: true }).click();
  await page.getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true }).waitFor();
  await page.getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true }).click();
  await page.getByRole("button", { name: `Mark ${searchTitle} read`, exact: true }).waitFor();
  await search.fill("");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total,
  );

  // Even a transport that ignores abort cannot paint a stale search result.
  await page.evaluate(() => {
    window.__socialFetch = window.fetch;
    window.fetch = (input, init) => String(input).includes("/social/search?q=delayed")
      ? new Promise(resolve => { window.__releaseSearch = () => resolve(new Response(JSON.stringify({ stories: [] }), { headers: { "content-type": "application/json" } })); })
      : window.__socialFetch(input, init);
  });
  await search.fill("delayed");
  await page.waitForFunction(() => typeof window.__releaseSearch === "function");
  await search.fill("");
  await page.evaluate(() => { window.__releaseSearch(); window.fetch = window.__socialFetch; });
  await page.waitForFunction(n => document.querySelectorAll(".news-card").length === n, total);

  // Unread-only hides what was just read.
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total - 1,
  );
  await page.getByRole("button", { name: "Unread", exact: true }).click();

  // Saving a story opens the Later sheet and keeps it.
  await cards
    .first()
    .getByRole("button", { name: /^Save / })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.waitFor();
  await shot("social-save");
  // Whatever the first reminder choice is: the point is that it saves.
  await sheet.locator(".action-list button").first().click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  // Read back through the API: what the user would see in Later.
  const later = await page.evaluate(() =>
    fetch("/api/later").then((r) => r.json()),
  );
  const saved = [...later.due, ...later.upcoming];
  assert.equal(saved.length, 1, "Saving a story must put it in Later");
  assert.equal(saved[0].kind, "story");
  assert.ok(
    titles.includes(saved[0].title),
    `Later must show the story's own title, not ${saved[0].title}`,
  );
  assert.match(saved[0].preview, /What story \d is about/);
  assert.match(saved[0].url, /^https:\/\/example\.com\//);

  // A feed's picture is fetched by Loop, never by the browser: the page's own
  // policy allows no third-party images, and the publisher should not learn
  // who is reading. Turning the preference on must ask Loop for it.
  const requested = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") requested.push(request.url());
  });
  await cards
    .first()
    .getByRole("button", { name: /^Hide / })
    .click();
  const hiding = page.getByRole("dialog");
  await hiding.waitFor();
  await hiding.getByRole("checkbox").last().check();
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForSelector(".news-image", { state: "attached" });
  assert.equal(
    await page.locator(".news-image").first().getAttribute("src"),
    `/api/social/image?story=${encodeURIComponent(
      await page.locator(".news-card").first().getAttribute("data-story"),
    )}`,
    "A feed picture must be requested from Loop",
  );
  await page.waitForFunction(() => !!document.querySelector(".news-image"));
  assert.ok(
    requested.some((url) => url.startsWith(fixture.base + "/api/social/image")),
    `The picture must be fetched from Loop: ${JSON.stringify(requested)}`,
  );
  assert.deepEqual(
    requested.filter((url) => !url.startsWith(fixture.base)),
    [],
    "No image may be loaded from a publisher",
  );
  await shot("social-images");

  // The catalog sheet offers the feeds Loop ships and adding one by address.
  await page.getByRole("button", { name: "Add feeds" }).click();
  const catalog = page.getByRole("region", { name: "Feed catalog" });
  await catalog.waitFor();
  await catalog
    .getByRole("region", { name: "Add a feed by address" })
    .waitFor();
  assert.ok(
    (await catalog.locator(".feed-catalog-card").count()) > 20,
    "The catalog must offer its feeds",
  );
  await shot("social-catalog");
  await page.getByRole("button", { name: "Close" }).click();

  // Following a word previews against what is stored before creating a watch.
  await page.getByRole("button", { name: "Follow a word" }).click();
  const watches = page.getByRole("dialog");
  await watches.waitFor();
  await watches.getByRole("searchbox").fill("rust");
  await watches.getByRole("button", { name: "Preview" }).click();
  await watches.locator(".watch-preview li").first().waitFor();
  assert.equal(await watches.locator(".watch-preview li").count(), 1);
  await shot("social-watch");
  await watches.getByRole("button", { name: /^Follow / }).click();
  await page.waitForFunction(() => !!document.querySelector(".digest-row"));
  const following = await page.evaluate(() =>
    fetch("/api/social/watches").then((r) => r.json()),
  );
  assert.deepEqual(
    following.watches.map((watch) => watch.query),
    ["rust"],
    "Following a word must create a watch",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await search.fill("postgres");
  await cards.first().waitFor();
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await cards.first().getByRole("button", { name: `Mark ${searchTitle} read`, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".news-card").length === 0);
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await page.getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true }).click();
  await page.getByRole("button", { name: "Mark all read", exact: true }).click();
  await page.getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true }).waitFor();
  assert.equal(await cards.first().getAttribute("data-unread"), null);

  // Notification links also accept catalog IDs that begin with a digit.
  fixture.db.prepare("INSERT INTO feed_subscriptions(owner_id,feed_id,created_at) VALUES(?, '404-media', ?)").run(fixture.owner, Date.now());
  fixture.db.exec("INSERT INTO feed_state(feed_id,title,home,fetched_at,failures,stories) SELECT '404-media',title,home,fetched_at,failures,stories FROM feed_state WHERE feed_id='lobsters'");
  fixture.db.exec("INSERT INTO feed_stories(feed_id,story_id,url,title,summary,story,published_at,first_seen_at,fetched_at) SELECT '404-media',story_id,'https://example.com/404',title,summary,json_set(story,'$.url','https://example.com/404'),published_at,first_seen_at,fetched_at FROM feed_stories WHERE feed_id='lobsters'");
  await page.goto(fixture.base + "/?social=" + encodeURIComponent("404-media:s3"));
  await page.locator('.news-card[data-focused="true"][data-story="404-media:s3"]').waitFor();

}
