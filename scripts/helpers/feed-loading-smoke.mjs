import { expect } from "@playwright/test";

// Hold independent reads at the browser boundary: ready feed cards must not
// wait for discovery, agent metadata, or a slower environment's feed.
export async function feedLoadingSmoke(page, fixture, _engine, capture) {
  for (const legacy of [false, true])
    await feedLoadingCase(page, fixture, legacy, (name) =>
      capture((legacy ? "legacy-" : "cards-") + name),
    );
}

async function feedLoadingCase(page, fixture, legacy, capture) {
  const sources = [
    { id: "cloud:first", name: "First environment" },
    { id: "cloud:second", name: "Second environment" },
  ];
  const bootstrap = await fixture.api("/bootstrap");
  const feed = await fixture.api("/feed?filter=done");
  const working = await fixture.api("/feed?filter=working");
  const cards = await fixture.api("/v1/cards?view=done");
  const changes = {
    revision: cards.revision,
    items: [],
    removed: [],
    more: false,
  };
  const capabilities = await fixture.api("/capabilities");
  const empty = { ...feed, items: [], next: null };
  let discovery = Promise.withResolvers();
  let discoveryFails = true;
  let discoveryStatus = 503;
  let localUnavailable = false;
  let discoveredSources = sources;
  let metadata = Promise.withResolvers();
  let metadataFails = false;
  let metadataReads = 0;
  let archivedAgent = false;
  const unavailableFeeds = new Set();
  let workingHistory = false;
  let workingHold = null;
  let workingStarts = 0;
  const workingEmptySources = new Set();
  const workingCursors = [];
  let pause = null;
  let pauseReads = 0;
  let queuedHold = null;
  let slowFeed = Promise.withResolvers();
  const savedBySource = new Map(sources.map((source) => [source.id, true]));
  const savedWrites = [];
  let refresh = null;
  let refreshReads = 0;
  let discoveryReads = 0;
  const paginationReads = [];
  const rows = page.locator(".inbox-results .inbox-row");
  const first = rows.filter({ hasText: "First environment result" });
  const second = rows.filter({ hasText: "Second environment result" });
  const loading = page.getByRole("status", {
    name: "Loading feed",
    exact: true,
  });
  const noResults = page.getByText("Nothing finished yet.", { exact: true });
  const feedOutage = page.getByText(
    "Some environments could not refresh. Showing their last loaded threads.",
    { exact: false },
  );
  const loadMore = page.getByRole("button", { name: "Load more", exact: true });
  const fulfill = (route, json) => route.fulfill({ json });
  const capabilityRoute = (route) =>
    fulfill(route, { ...capabilities, pairedDevices: true });
  const sessionRoute = (route) => fulfill(route, { csrf: "fixture" });
  const localFeed = (route) =>
    localUnavailable
      ? route.fulfill({ status: 503, json: { error: "Fixture outage" } })
      : fulfill(route, empty);
  const localCards = (route) =>
    localUnavailable
      ? route.fulfill({ status: 503, json: { error: "Fixture outage" } })
      : legacy
        ? route.fulfill({ status: 404, body: "{}" })
        : fulfill(
            route,
            new URL(route.request().url()).pathname.endsWith("/changes")
              ? changes
              : { ...cards, items: [], next: null },
          );
  const discoveryRoute = async (route) => {
    discoveryReads++;
    await discovery.promise;
    if (discoveryFails)
      return route.fulfill({
        status: discoveryStatus,
        json: { error: "Fixture discovery outage" },
      });
    await fulfill(route, discoveredSources);
  };
  const sourceRequests = new Set();
  const readSource = async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/agent-sources\/([^/]+)\/(.*)$/.exec(url.pathname);
    const source = sources.find(
      (item) => item.id === decodeURIComponent(match[1]),
    );
    if (/^messages\/[^/]+\/saved$/.test(match[2])) {
      const method = route.request().method();
      savedWrites.push({ source: source.id, method });
      savedBySource.set(source.id, method === "POST");
      // Use the production acknowledgement, including its saved boolean.
      // A fabricated Ok-only receipt would be an uncertain contract response.
      return fulfill(
        route,
        await fixture.api(
          "/" + match[2],
          method === "POST" ? {} : undefined,
          method,
        ),
      );
    }
    if (match[2] === `runs/${working.items[0].run.id}/pause`) {
      pauseReads++;
      await pause?.promise;
      return fulfill(route, { ok: true });
    }
    if (match[2] === "bootstrap") {
      metadataReads++;
      await metadata.promise;
      if (metadataFails)
        return route.fulfill({
          status: 503,
          json: { error: "Fixture outage" },
        });
      return fulfill(route, bootstrap);
    }
    const typed = match[2].startsWith("v1/cards");
    if (typed && legacy) return route.fulfill({ status: 404, body: "{}" });
    if (match[2] === "feed" || typed) {
      if (!typed && url.searchParams.get("filter") === "queued")
        await queuedHold?.promise;
      if (unavailableFeeds.has(source.id))
        return route.fulfill({
          status: 503,
          json: { error: "Fixture outage" },
        });
      if (
        !typed &&
        workingHistory &&
        url.searchParams.get("filter") === "working"
      ) {
        const before = url.searchParams.get("before");
        if (source === sources[1] && !before && workingStarts++ > 0)
          await workingHold?.promise;
        if (workingEmptySources.has(source.id)) return fulfill(route, empty);
        const index = before ? Number(before) + 1 : 1;
        if (before) workingCursors.push({ source: source.id, before });
        return fulfill(route, {
          ...working,
          items: [
            {
              ...working.items[0],
              conversation_id: "working-page-" + index,
              title: source.name + " page " + index,
              last_activity_at: working.items[0].last_activity_at - index,
            },
          ],
          next: index < 4 ? String(index) : null,
        });
      }
      if (!typed && (url.searchParams.get("filter") !== "done" || !legacy))
        return fulfill(route, empty);
      if (source === sources[1]) await slowFeed.promise;
      if (refresh) {
        refreshReads++;
        await refresh.promise;
      }
      if (match[2] === "v1/cards/changes") return fulfill(route, changes);
      const before = url.searchParams.get("before");
      if (typed) {
        if (before) paginationReads.push({ source: source.id, before });
        const original = cards.items[0];
        const suffix = before ? "-older" : "";
        const display = {
          ...original.card.display,
          last_message: {
            ...original.card.display.last_message,
            saved: savedBySource.get(source.id),
          },
          ...(archivedAgent ? { agent_id: "archived-agent" } : {}),
          conversation_id: original.card.display.conversation_id + suffix,
          title: source.name + (before ? " older result" : " result"),
          last_activity_at:
            original.card.display.last_activity_at - (before ? 1 : 0),
        };
        return fulfill(route, {
          ...cards,
          items: [
            {
              ...original,
              card: {
                ...original.card,
                saved: savedBySource.get(source.id),
                id: original.card.id + suffix,
                display,
              },
              order: [
                original.order[0] - (before ? 1 : 0),
                original.order[1] + suffix,
              ],
            },
          ],
          next: before ? null : "older",
        });
      }
      if (before) {
        paginationReads.push({ source: source.id, before });
        return fulfill(route, {
          ...feed,
          items: [
            {
              ...feed.items[0],
              conversation_id: feed.items[0].conversation_id + "-older",
              title: source.name + " older result",
              last_activity_at: feed.items[0].last_activity_at - 1,
            },
          ],
          next: null,
        });
      }
      return fulfill(route, {
        ...feed,
        items: [
          {
            ...feed.items[0],
            title: source.name + " result",
            last_message: {
              ...feed.items[0].last_message,
              saved: savedBySource.get(source.id),
            },
            ...(archivedAgent ? { agent_id: "archived-agent" } : {}),
          },
        ],
        next: "older",
      });
    }
    url.pathname = "/api/" + match[2];
    return route.fulfill({
      response: await route.fetch({ url: url.toString() }),
    });
  };
  const sourceRoute = (route) => {
    const request = readSource(route);
    sourceRequests.add(request);
    void request.then(
      () => sourceRequests.delete(request),
      () => sourceRequests.delete(request),
    );
    return request;
  };
  await page.route("**/api/capabilities", capabilityRoute);
  await page.route("**/session", sessionRoute);
  await page.route("**/api/feed?*", localFeed);
  await page.route("**/api/v1/cards**", localCards);
  await page.route("**/api/agent-sources", discoveryRoute);
  await page.route("**/api/agent-sources/**", sourceRoute);
  try {
    const localRead = page.waitForResponse((response) =>
      legacy
        ? new URL(response.url()).pathname === "/api/feed" &&
          new URL(response.url()).searchParams.get("filter") === "done"
        : new URL(response.url()).pathname === "/api/v1/cards",
    );
    await page.goto(fixture.base);
    await localRead;
    await expect.poll(() => discoveryReads).toBeGreaterThan(0);
    // An empty local read cannot establish that the combined feed is empty.
    await expect(loading).toBeVisible();
    await expect(noResults).toHaveCount(0);
    // A failed initial lookup does not establish an empty source list.
    discovery.resolve();
    await expect(
      page.getByText(
        "Couldn’t connect to your execution environments. Check your connection and retry.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(noResults).toHaveCount(0);
    discoveryFails = false;
    discovery = Promise.withResolvers();
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect(loading).toBeVisible();
    await page.evaluate(() => {
      window.__feedEmptyFlashes = 0;
      window.__feedEmptyObserver = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (
              node.nodeType === 1 &&
              (node.matches(".inbox-empty") ||
                node.querySelector(".inbox-empty"))
            )
              window.__feedEmptyFlashes++;
      });
      window.__feedEmptyObserver.observe(document.querySelector(".inbox"), {
        childList: true,
        subtree: true,
      });
    });
    discovery.resolve();
    // Neither linked bootstrap is ready, and the second feed is still held.
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    await expect(loadMore).toHaveCount(0);
    await expect(noResults).toHaveCount(0);
    // Discovery alone cannot offer setup for an already connected source.
    await page
      .getByRole("region", { name: "Your agents", exact: true })
      .getByRole("button", { name: "New agent", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "New chat", exact: true })
      .getByText("Customize", { exact: true })
      .click();
    const creation = page.getByRole("dialog", { name: "New chat" });
    await expect(creation.getByLabel("Run on")).not.toContainText(
      sources[0].name,
    );
    await creation.getByRole("button", { name: "Close", exact: true }).click();
    await capture("first-result-before-other-reads");
    metadata.resolve();
    // The first source has been displayed, but the held second source means
    // no combined cache exists yet. Discovery churn must retain that page.
    discoveredSources = [sources[1]];
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(first).toHaveCount(0);
    unavailableFeeds.add(sources[0].id);
    discoveredSources = sources;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(first).toBeVisible();
    slowFeed.resolve();
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await expect(feedOutage).toBeVisible();
    unavailableFeeds.clear();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(feedOutage).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    expect(
      await page.evaluate(() => {
        window.__feedEmptyObserver.disconnect();
        return window.__feedEmptyFlashes;
      }),
    ).toBe(0);

    // Each source keeps its own cursor and identity, including colliding ids.
    await loadMore.click();
    await expect(rows).toHaveCount(4);
    await expect(loadMore).toHaveCount(0);
    expect(
      paginationReads.sort((a, b) => a.source.localeCompare(b.source)),
    ).toEqual(
      sources.map((source) => ({ source: source.id, before: "older" })),
    );

    // A superseded progressive read cannot put Done cards in Queued.
    const refreshed = sources.map((source) =>
      page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.pathname ===
            `/api/agent-sources/${encodeURIComponent(source.id)}/${legacy ? "feed" : "v1/cards/changes"}` &&
          (!legacy || url.searchParams.get("filter") === "done")
        );
      }),
    );
    refresh = Promise.withResolvers();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    const refreshRequests = await Promise.all(refreshed);
    await expect.poll(() => refreshReads).toBeGreaterThanOrEqual(2);
    await page.getByRole("tab", { name: /^Queued/ }).click();
    await expect(
      page.getByText("Nothing is queued.", { exact: true }),
    ).toBeVisible();
    // Selection changes can cancel these exact reads. Finish the held route
    // handlers and observe completion or cancellation before checking the UI.
    const delivered = Promise.all([...sourceRequests]);
    refresh.resolve();
    refresh = null;
    await delivered;
    for (const request of refreshRequests) {
      const response = await request.response();
      if (response) await response.finished();
      else expect(request.failure()).toBeTruthy();
    }
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(rows).toHaveCount(0);
    await expect(loading).toHaveCount(0);

    // Returning to a cached feed keeps all sources visible, including after
    // the fast, empty local response, while both linked reads are pending.
    refresh = Promise.withResolvers();
    refreshReads = 0;
    await page.getByRole("tab", { name: "Done", exact: true }).click();
    await expect.poll(() => refreshReads).toBeGreaterThanOrEqual(2);
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    refresh.resolve();
    refresh = null;

    // A removed source can return while offline. Its last complete cached
    // page must survive the failed refresh, for both feed API contracts.
    discoveredSources = [sources[0]];
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(second).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Working/ })).toHaveText(
      new RegExp(`^Working\\s*${feed.summary.working * 2}$`),
    );
    unavailableFeeds.add(sources[1].id);
    discoveredSources = sources;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(feedOutage).toBeVisible();
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    unavailableFeeds.clear();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(feedOutage).toHaveCount(0);

    // An outage stays visible until its metadata retry actually succeeds.
    metadataFails = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    const outage = page.getByText(
      "An environment is temporarily unavailable. Its last loaded agents are still shown.",
      { exact: false },
    );
    // Metadata reads retry after two and four seconds before showing an outage.
    await expect(outage).toBeVisible({ timeout: 10_000 });
    metadataFails = false;
    metadata = Promise.withResolvers();
    const beforeRetry = metadataReads;
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect
      .poll(() => metadataReads)
      .toBeGreaterThanOrEqual(beforeRetry + 2);
    await expect(outage).toBeVisible();
    metadata.resolve();
    await expect(outage).toHaveCount(0);

    // A partial background refresh must not separate loaded rows from their
    // cursor. Load more can supersede it without skipping pages two and three.
    workingHistory = true;
    workingHold = Promise.withResolvers();
    await page.getByRole("tab", { name: /^Working/ }).click();
    await expect(rows).toHaveCount(2);
    await loadMore.click();
    await expect(rows).toHaveCount(4);
    await loadMore.click();
    await expect(rows).toHaveCount(6);
    const fastWorkingRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname ===
          `/api/agent-sources/${encodeURIComponent(sources[0].id)}/feed` &&
        url.searchParams.get("filter") === "working" &&
        !url.searchParams.has("before")
      );
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await fastWorkingRefresh;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(rows).toHaveCount(6);
    await loadMore.click();
    await expect(rows).toHaveCount(8);
    for (const source of sources)
      for (const index of [2, 3, 4])
        await expect(
          rows.filter({ hasText: source.name + " page " + index }),
        ).toBeVisible();
    expect(
      workingCursors.slice(-2).sort((a, b) => a.source.localeCompare(b.source)),
    ).toEqual(sources.map((source) => ({ source: source.id, before: "3" })));

    // An empty fast response cannot erase the last displayed result while
    // another source's background refresh is still unresolved.
    workingEmptySources.add(sources[1].id);
    workingHold.resolve();
    workingHold = null;
    await expect(rows).toHaveCount(1);
    workingEmptySources.add(sources[0].id);
    workingHold = Promise.withResolvers();
    const emptyWorkingRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname ===
          `/api/agent-sources/${encodeURIComponent(sources[0].id)}/feed` &&
        url.searchParams.get("filter") === "working" &&
        !url.searchParams.has("before")
      );
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await emptyWorkingRefresh;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(rows).toHaveCount(1);
    await expect(page.locator(".inbox-empty")).toHaveCount(0);
    workingHold.resolve();
    workingHold = null;
    await expect(rows).toHaveCount(0);
    await expect(page.locator(".inbox-empty")).toBeVisible();
    await page.getByRole("tab", { name: /^Queued/ }).click();
    workingHistory = false;

    // An action can finish after the user chooses a new, uncached filter.
    // Its old-render refresh must not supersede that filter's pending read.
    workingEmptySources.clear();
    workingHistory = true;
    await page.goto(fixture.base + "/?filter=working");
    await expect(loadMore).toBeVisible();
    pause = Promise.withResolvers();
    queuedHold = Promise.withResolvers();
    await page
      .locator(".inbox-card")
      .filter({ hasText: "First environment page 1" })
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Pause", exact: true }).click();
    await expect.poll(() => pauseReads).toBe(1);
    await page.getByRole("tab", { name: /^Queued/ }).click();
    await expect(loading).toBeVisible();
    const paused = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/pause"),
    );
    workingHold = Promise.withResolvers();
    pause.resolve();
    pause = null;
    await paused;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    queuedHold.resolve();
    queuedHold = null;
    await expect(
      page.getByText("Nothing is queued.", { exact: true }),
    ).toBeVisible();
    await expect(loading).toHaveCount(0);
    workingHold.resolve();
    workingHold = null;
    workingHistory = false;

    // A new source page already knows its own destination. It must not read
    // only the empty local feed while waiting for discovery to finish.
    discovery = Promise.withResolvers();
    discoveredSources = [sources[0]];
    archivedAgent = true;
    await page.goto(
      fixture.base + "/?source=" + encodeURIComponent(sources[0].id),
    );
    await expect(first).toBeVisible();
    await expect(noResults).toHaveCount(0);
    await first.evaluate((element) => {
      element.dataset.retained = "yes";
    });
    const firstBadge = page
      .locator(".inbox-card")
      .filter({ hasText: "First environment result" })
      .locator(".card-environment");
    await expect(firstBadge).toHaveText("Connected environment");
    discovery.resolve();
    // Names update even when discovery returns the same source ids and the
    // card's archived agent has no metadata projection to provide its label.
    await expect(firstBadge).toHaveText(sources[0].name);
    discoveredSources = sources;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(second).toBeVisible();
    await expect(page.locator('.inbox-row[data-retained="yes"]')).toBeVisible();

    await page.getByRole("tab", { name: /^Queued/ }).click();
    await expect(
      page.getByText("Nothing is queued.", { exact: true }),
    ).toBeVisible();
    await expect(loading).toHaveCount(0);
    await capture("loaded-empty-feed");

    // An all-source feed failure also stays distinct from a confirmed empty
    // result, and a retry can establish the first complete view.
    localUnavailable = true;
    sources.forEach((source) => unavailableFeeds.add(source.id));
    await page.goto(fixture.base);
    await expect(
      page.getByText("Couldn’t load the Feed from any environment.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(noResults).toHaveCount(0);
    localUnavailable = false;
    unavailableFeeds.clear();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    // Unsaving an early card must not postpone other sources until the Undo
    // window ends. Refreshes keep the pending unsave scoped to its source.
    slowFeed = Promise.withResolvers();
    await page.goto(fixture.base);
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    const firstCard = page
      .locator(".inbox-card")
      .filter({ hasText: "First environment result" });
    const secondCard = page
      .locator(".inbox-card")
      .filter({ hasText: "Second environment result" });
    await firstCard
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Remove from Saved", exact: true })
      .click();
    const unsaved = page
      .getByRole("status")
      .filter({ hasText: "Removed from Saved." });
    await expect(unsaved).toBeVisible();
    expect(savedWrites).toEqual([]);
    slowFeed.resolve();
    await expect(second).toBeVisible({ timeout: 3000 });
    await expect(unsaved).toBeVisible();
    await firstCard
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await expect(page.getByRole("menuitem", { name: /^Save/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await secondCard
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Remove from Saved", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await unsaved.getByRole("button", { name: "Undo", exact: true }).click();
    expect(savedWrites).toEqual([]);
    await firstCard
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Remove from Saved", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "Remove from Saved", exact: true })
      .click();
    await unsaved.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect
      .poll(() => savedWrites)
      .toEqual([{ source: sources[0].id, method: "DELETE" }]);
    await firstCard
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await expect(page.getByRole("menuitem", { name: /^Save/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(second).toBeVisible();

    // Older workspaces without source discovery confirm a local-only feed.
    discoveryFails = true;
    discoveryStatus = 404;
    await page.goto(fixture.base);
    await expect(noResults).toBeVisible();
    await expect(loading).toHaveCount(0);
  } finally {
    discovery.resolve();
    metadata.resolve();
    slowFeed.resolve();
    refresh?.resolve();
    workingHold?.resolve();
    pause?.resolve();
    queuedHold?.resolve();
    await page.unroute("**/api/capabilities", capabilityRoute);
    await page.unroute("**/session", sessionRoute);
    await page.unroute("**/api/feed?*", localFeed);
    await page.unroute("**/api/v1/cards**", localCards);
    await page.unroute("**/api/agent-sources", discoveryRoute);
    await page.unroute("**/api/agent-sources/**", sourceRoute);
    await Promise.allSettled([...sourceRequests]);
  }
}
