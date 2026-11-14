import { readFile } from "node:fs/promises";
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
  await page.goto(fixture.base + "/?page=profile&profileTab=messages");
  await expect(
    page.getByRole("tab", { name: "Messages", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: /^Social/ }).locator(".chip-count"),
  ).toHaveText(String(total));
  await expect(page.locator(".news-card")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("tab", { name: /^Social/ }).locator(".chip-count"),
  ).toHaveText(String(total));
  // Explicit Later links outrank the previously selected profile tab.
  await page.goto(
    fixture.base + "/?page=profile&profileTab=messages&later=reminders",
  );
  await expect(
    page.getByRole("tab", { name: "Reminders", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto(fixture.base + "/?page=profile&profileTab=social");
  const social = page.getByRole("list", { name: "Social" });
  await page.waitForSelector(".news-card");
  const cards = social.locator(".news-card");
  await cards.first().waitFor();
  assert.equal(await cards.count(), total, "Every stored story must show");
  const agents = page.getByRole("region", { name: "Your agents", exact: true });
  // Feed options start closed: Social is the stories alone, without the page
  // heading and agents above them.
  const toggle = page.locator(".social-options-toggle");
  const controls = page.locator(".social-controls");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("Feed options");
  await expect(controls).toBeHidden();
  await expect(agents).toBeHidden();
  await shot("rss-options-closed");
  // Toggling keeps your place partway down the page, even without scroll
  // anchoring (Safari has none).
  const noAnchoring = await page.addStyleTag({
    content: "* { overflow-anchor: none !important; }",
  });
  for (const expanded of ["true", "false"]) {
    await toggle.evaluate((el) =>
      window.scrollBy(0, el.getBoundingClientRect().top - 120),
    );
    const before = Math.round((await toggle.boundingBox()).y);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", expanded);
    await expect
      .poll(async () => Math.round((await toggle.boundingBox()).y))
      .toBe(before);
  }
  await noAnchoring.evaluate((el) => el.remove());
  await page.evaluate(() => window.scrollTo(0, 0));
  // Opening is not remembered: every visit starts closed.
  await toggle.click();
  await expect(controls).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(controls).toBeHidden();
  await expect(cards).toHaveCount(total);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await page.getByRole("tab", { name: /^Social/ }).click();
  await expect(agents).toBeHidden();
  await toggle.click();
  await expect(controls).toBeVisible();
  await expect(agents).toBeHidden();
  await shot("rss-options-open");
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
  // The profile’s Social count follows the reader’s confirmed unread count.
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
  await cards
    .first()
    .getByRole("button", { name: `Mark ${searchTitle} read`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `Mark ${searchTitle} read`, exact: true })
    .waitFor();
  await search.fill("");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total,
  );

  // Even a transport that ignores abort cannot paint a stale search result.
  await page.evaluate(() => {
    window.__socialFetch = window.fetch;
    window.fetch = (input, init) =>
      String(input).includes("/social/search?q=delayed")
        ? new Promise((resolve) => {
            window.__releaseSearch = () =>
              resolve(
                new Response(JSON.stringify({ stories: [] }), {
                  headers: { "content-type": "application/json" },
                }),
              );
          })
        : window.__socialFetch(input, init);
  });
  await search.fill("delayed");
  await page.waitForFunction(
    () => typeof window.__releaseSearch === "function",
  );
  await search.fill("");
  await page.evaluate(() => {
    window.__releaseSearch();
    window.fetch = window.__socialFetch;
  });
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total,
  );

  // Unread-only hides what was just read.
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total - 1,
  );
  await page.getByRole("button", { name: "Unread", exact: true }).click();

  // Swiping a story left removes it, and Undo brings it back.
  const swipeStory = (card, dx) =>
    card.evaluate(async (card, dx) => {
      const box = card.getBoundingClientRect();
      const x = dx < 0 ? box.right - 30 : box.left + 30,
        y = box.top + box.height / 2;
      const send = (type, offset) =>
        card.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX: x + offset,
            clientY: y,
          }),
        );
      // A frame between moves, as a finger gives, so each one renders.
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      send("pointerdown", 0);
      for (let step = 1; step <= 8; step++) {
        send("pointermove", (dx * step) / 8);
        await frame();
      }
      send("pointerup", dx);
    }, dx);
  // Turning Unread off brings the read story back first; wait for it.
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total,
  );
  const swiped = await cards.first().getAttribute("data-story");
  await swipeStory(page.locator(`[data-story="${swiped}"]`), -160);
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total - 1,
  );
  assert.equal(
    await page.locator(`[data-story="${swiped}"]`).count(),
    0,
    "A swiped story must leave Social",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".news-card").length === n,
    total,
  );

  // Swiping a story right offers the same reminders as Save.
  await swipeStory(cards.first(), 160);
  await page.getByRole("dialog").waitFor();
  assert.equal(await cards.count(), total, "A reminder swipe keeps the story");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

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
  // OPML keeps its original XML in the existing JSON envelope. An empty
  // import exercises the browser receipt without fetching any public feed.
  const xml = '<opml version="2.0"><body></body></opml>';
  const importRequests = [];
  const imported = (request) => {
    if (
      new URL(request.url()).pathname === "/api/social/opml" &&
      request.method() === "POST"
    )
      importRequests.push(request.postDataJSON());
  };
  page.on("request", imported);
  try {
    await catalog.locator('input[type="file"]').setInputFiles({
      name: "subscriptions.opml",
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    await expect(
      page.getByText("Added 0 feeds.", { exact: true }),
    ).toBeVisible();
    assert.deepEqual(
      importRequests,
      [{ opml: xml }],
      "One explicit OPML import, without rewriting XML",
    );
    const downloadEvent = page.waitForEvent("download");
    await catalog.getByRole("link", { name: "Export OPML" }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "loop-feeds.opml");
    const exported = await readFile(await download.path(), "utf8");
    assert(
      exported.includes("<opml") &&
        exported.includes("https://news.ycombinator.com/rss"),
      "Export contains the followed production subscription",
    );
    await shot("social-opml");
  } finally {
    page.off("request", imported);
  }
  await page.getByRole("button", { name: "Close" }).click();

  // Following a word previews against what is stored before creating a watch.
  let failWatchRead = true;
  let watchReadFailures = 0;
  await page.route("**/api/social/watches", async (route) => {
    if (route.request().method() === "GET" && failWatchRead) {
      watchReadFailures++;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Watch read unavailable" }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Follow a word" }).click();
  const watches = page.getByRole("dialog");
  await watches.waitFor();
  await expect.poll(() => watchReadFailures).toBeGreaterThan(0);
  await expect(watches.getByRole("alert")).toContainText(
    "Watch read unavailable",
  );
  failWatchRead = false;
  await watches
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(watches.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/social/watches");
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
  await watches.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    watches.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await watches.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    watches.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await watches.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(watches.locator(".digest-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  let failDigestRead = true;
  await page.route("**/api/social/digests", async (route) => {
    if (route.request().method() === "GET" && failDigestRead)
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Digest read unavailable" }),
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Digest", exact: true }).click();
  const digests = page.getByRole("dialog", { name: "Digest", exact: true });
  const access = digests.getByRole("checkbox", {
    name: /Let agents read your feeds/,
  });
  await expect(access).not.toBeChecked();
  await expect(digests.getByRole("alert")).toContainText(
    "Digest read unavailable",
  );
  failDigestRead = false;
  await digests
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(digests.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/social/digests");
  await digests
    .getByRole("combobox", { name: "Agent", exact: true })
    .selectOption({ index: 1 });
  await digests.getByLabel("Time", { exact: true }).fill("09:30");
  await digests
    .getByRole("button", { name: "Schedule digest", exact: true })
    .click();
  await expect(digests.locator(".digest-row")).toHaveCount(1);
  assert.equal(
    fixture.db
      .prepare("SELECT minute_of_day FROM feed_digests WHERE owner_id=?")
      .get(fixture.owner).minute_of_day,
    570,
  );
  await digests.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    digests.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await digests.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    digests.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  let failAccessRead = true;
  await page.route("**/api/social/preferences", async (route) => {
    if (route.request().method() === "GET" && failAccessRead)
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Access read unavailable" }),
      });
    else await route.continue();
  });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("loop-workspace-change")),
  );
  await expect(digests.getByRole("alert")).toContainText(
    "Feed access: Access read unavailable",
  );
  await expect(digests.locator(".digest-row")).toHaveCount(1);
  failAccessRead = false;
  await digests
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(digests.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/social/preferences");
  await shot("social-digest");
  await digests.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(digests.locator(".digest-row")).toHaveCount(0);
  await access.check();
  await expect
    .poll(
      () =>
        fixture.db
          .prepare("SELECT agent_access FROM feed_preferences WHERE owner_id=?")
          .get(fixture.owner)?.agent_access,
    )
    .toBe(1);
  await access.uncheck();
  await expect
    .poll(
      () =>
        fixture.db
          .prepare("SELECT agent_access FROM feed_preferences WHERE owner_id=?")
          .get(fixture.owner)?.agent_access,
    )
    .toBe(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await search.fill("postgres");
  await cards.first().waitFor();
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await cards
    .first()
    .getByRole("button", { name: `Mark ${searchTitle} read`, exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".news-card").length === 0,
  );
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await page
    .getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark all read", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Mark ${searchTitle} unread`, exact: true })
    .waitFor();
  assert.equal(await cards.first().getAttribute("data-unread"), null);

  let coolingReads = 0;
  await page.route("**/api/social/watches", async (route) => {
    coolingReads++;
    await route.fulfill({
      status: 429,
      headers: { "retry-after": "2" },
      contentType: "application/json",
      body: JSON.stringify({ error: "Cooling" }),
    });
  });
  await page
    .getByRole("button", { name: "Follow a word", exact: true })
    .click();
  await expect.poll(() => coolingReads).toBe(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.waitForTimeout(2200);
  assert.equal(
    coolingReads,
    1,
    "closing watches cancels Retry-After continuation",
  );
  await page.unroute("**/api/social/watches");

  // Notification links also accept catalog IDs that begin with a digit.
  fixture.db
    .prepare(
      "INSERT INTO feed_subscriptions(owner_id,feed_id,created_at) VALUES(?, '404-media', ?)",
    )
    .run(fixture.owner, Date.now());
  fixture.db.exec(
    "INSERT INTO feed_state(feed_id,title,home,fetched_at,failures,stories) SELECT '404-media',title,home,fetched_at,failures,stories FROM feed_state WHERE feed_id='lobsters'",
  );
  fixture.db.exec(
    "INSERT INTO feed_stories(feed_id,story_id,url,title,summary,story,published_at,first_seen_at,fetched_at) SELECT '404-media',story_id,'https://example.com/404',title,summary,json_set(story,'$.url','https://example.com/404'),published_at,first_seen_at,fetched_at FROM feed_stories WHERE feed_id='lobsters'",
  );
  await page.goto(
    fixture.base + "/?social=" + encodeURIComponent("404-media:s3"),
  );
  await page
    .locator('.news-card[data-focused="true"][data-story="404-media:s3"]')
    .waitFor();
}
