import { openAgentModelOptions } from "./agent-model-options.mjs";
import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  collectionReadRecovery,
  signalCollection,
  isWebKitNavigationFetchError,
} from "./browser-errors.mjs";

// Frames the real workspace has sent for its own stream.
const localFrames = { count: 0 };

// Hold independent reads at the browser boundary: ready feed cards must not
// wait for discovery, agent metadata, or a slower environment's feed.
export async function feedLoadingSmoke(page, fixture, engine, capture) {
  // These fixture-only companion and linked sources have no real socket
  // servers. Negotiate a quiet complete stream; cases that assert explicit
  // retries also hold HTTP event probes unavailable below.
  const streamResets = new Map();
  const resetFrame = () => ({
    v: 3,
    type: "reset",
    epoch: "feed-loading",
    cursor: 0,
    build: "fixture",
    buildIdentity: null,
    serverNow: Date.now(),
    nextDeadline: null,
    capabilities: {
      invalidations: "complete",
      deadlines: true,
      transcript: "delta",
      feed: "delta",
      results: "delta",
    },
  });
  // Keyed by each source's own stream path, which the cases below use.
  const streamKey = (source) =>
    source
      ? `/api/agent-sources/${encodeURIComponent(source)}/events/ws`
      : "/ws";
  await page.routeWebSocket(
    (url) =>
      url.pathname === "/ws" ||
      url.pathname === "/api/events/multiplex/ws" ||
      /^\/api\/agent-sources\/[^/]+\/events\/ws$/.test(url.pathname),
    (route) => {
      const path = new URL(route.url()).pathname;
      if (path === "/api/events/multiplex/ws") {
        // The companion multiplexes every source over one socket. Its own
        // subscription reaches the real workspace; the fixture-only sources
        // get the same quiet stream as above.
        const server = route.connectToServer();
        const mocked = new Set();
        server.onMessage((message) => {
          const frame = JSON.parse(String(message));
          if (frame.type === "frame" && !frame.source) localFrames.count++;
          route.send(message);
        });
        route.onMessage((message) => {
          const request = JSON.parse(String(message));
          if (request.type === "subscribe" && request.source) {
            mocked.add(request.id);
            const reset = () =>
              route.send(
                JSON.stringify({
                  v: 1,
                  type: "frame",
                  id: request.id,
                  source: request.source,
                  frame: resetFrame(),
                }),
              );
            streamResets.set(streamKey(request.source), reset);
            reset();
          } else if (!mocked.has(request.id)) server.send(message);
        });
        return;
      }
      const reset = () => route.send(JSON.stringify(resetFrame()));
      streamResets.set(path, reset);
      reset();
    },
  );
  for (const cardsUnavailable of [false, true])
    await feedLoadingCase(
      page,
      fixture,
      cardsUnavailable,
      (name) =>
        capture((cardsUnavailable ? "cardsUnavailable-" : "cards-") + name),
      streamResets,
    );
  await openConnectedFeed(page, fixture.base);
  await page.getByRole("tab", { name: /^Working/ }).click();
  await collectionReadRecovery(page, {
    route: (url) =>
      url.pathname === "/api/feed" &&
      url.searchParams.get("filter") === "working",
    scope: page.getByRole("region", { name: "Feed", exact: true }),
    errorText:
      /Couldn.t load the Feed|Some environments|Collection recovery fixture/,
    start: () => signalCollection(page, "feed"),
  });
  await feedRefreshAfterAppendRecovery(page, fixture);
  await feedRetryDoneSummary(page, fixture);
  await feedClearTeamWithCursor(page, fixture, engine);
}

async function feedRetryDoneSummary(page, fixture) {
  // A standalone answer produces a third Done card through the real projector.
  const messageId = randomUUID();
  fixture.db
    .prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'assistant','Additional completed answer for summary recovery',?)",
    )
    .run(
      messageId,
      fixture.owner,
      fixture.conversations.find((item) => item.state === "completed").id,
      Date.now(),
    );
  const first = await fixture.api("/v1/cards?view=done&limit=1");
  expect(first.next).toBeTruthy();
  const second = await fixture.api(
    "/v1/cards?view=done&limit=1&before=" + encodeURIComponent(first.next),
  );
  expect(second.next).toBeTruthy();
  const cardMatch = (url) =>
    url.pathname === "/api/v1/cards" && url.searchParams.get("view") === "done";
  const summaryMatch = (url) =>
    url.pathname === "/api/feed" && url.searchParams.get("filter") === "needs";
  const appends = [];
  let summaryReads = 0;
  let summaryFailed = false;
  let recovering = false;
  const cards = async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    if (before) {
      appends.push(before);
      if (before !== first.next)
        return route.fulfill({
          status: 503,
          json: { error: "The following Done page is still unavailable" },
        });
      summaryFailed = true;
    }
    url.searchParams.set("limit", "1");
    return route.fulfill({ response: await route.fetch({ url: url.href }) });
  };
  const summary = (route) => {
    if (summaryFailed || recovering) summaryReads++;
    return summaryFailed
      ? route.fulfill({
          status: 503,
          json: { error: "Done summary unavailable after a successful page" },
        })
      : route.continue();
  };
  await page.route(cardMatch, cards);
  await page.route(summaryMatch, summary);
  try {
    await openConnectedFeed(page, fixture.base + "/?filter=done");
    // Let the initial reset and fixture write notifications settle before the
    // outage, as in the other collection recovery cases.
    await page.waitForTimeout(2500);
    const feed = page.getByRole("region", { name: "Feed", exact: true });
    const rows = feed.locator(".feed-results .feed-row");
    const notice = feed.locator(".collection-read-error");
    const retry = notice.getByRole("button", {
      name: "Retry connection",
      exact: true,
    });
    await expect(rows).toHaveCount(1);
    await feed.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(notice).toBeVisible();
    await expect(rows).toHaveCount(1);
    expect(appends).toEqual([first.next]);
    expect(summaryReads).toBe(1);
    await retry.click();
    await expect.poll(() => summaryReads).toBe(2);
    await expect(retry).toBeEnabled();
    await page.waitForTimeout(6_500);
    expect(summaryReads).toBe(2);
    expect(appends).toEqual([first.next]);
    await expect(rows).toHaveCount(1);
    summaryFailed = false;
    recovering = true;
    await retry.click();
    await expect(rows).toHaveCount(2);
    await expect(notice).toHaveCount(0);
    expect(summaryReads).toBe(3);
    expect(appends).toEqual([first.next]);
    await expect(
      feed.getByRole("button", { name: "Load more", exact: true }),
    ).toBeVisible();
  } finally {
    await page.unroute(cardMatch, cards);
    await page.unroute(summaryMatch, summary);
    fixture.db.prepare("DELETE FROM messages WHERE id=?").run(messageId);
  }
}

async function feedClearTeamWithCursor(page, fixture, engine) {
  const team = (await fixture.api("/teams"))[0];
  const cards = await fixture.api("/v1/cards?view=done");
  const ids = [
    ...new Set(cards.items.map((item) => item.card.source.conversation_id)),
  ]
    .filter(Boolean)
    .slice(0, 2);
  expect(ids).toHaveLength(2);
  const previous = ids.map((id) =>
    fixture.db
      .prepare("SELECT id,team_id FROM conversations WHERE id=?")
      .get(id),
  );
  const setTeam = fixture.db.prepare(
    "UPDATE conversations SET team_id=? WHERE id=?",
  );
  fixture.db.transaction(() => {
    for (const id of ids) setTeam.run(team.id, id);
  })();
  const match = (url) =>
    url.pathname === "/api/v1/cards" && url.searchParams.get("view") === "done";
  let combinedHeads = 0;
  const errors = [];
  const onError = (error) => {
    if (!isWebKitNavigationFetchError(engine, error, fixture.base))
      errors.push(error.message);
  };
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("teams") === team.id) {
      // Ask the real server for a small page, retaining its real opaque cursor.
      url.searchParams.set("limit", "1");
      const response = await route.fetch({ url: url.href });
      return route.fulfill({ response });
    }
    if (!url.searchParams.get("teams") && !url.searchParams.has("before"))
      combinedHeads++;
    return route.continue();
  };
  await page.route(match, handler);
  try {
    const scoped = await fixture.api(
      `/v1/cards?view=done&teams=${team.id}&limit=1`,
    );
    expect(scoped.next).toBeTruthy();
    expect(() => JSON.parse(scoped.next)).toThrow();
    await openConnectedFeed(
      page,
      `${fixture.base}/?filter=done&teams=${team.id}`,
    );
    const feed = page.getByRole("region", { name: "Feed", exact: true });
    await expect(feed.locator(".feed-row")).toHaveCount(1);
    await expect(
      feed.getByRole("button", { name: "Load more", exact: true }),
    ).toBeVisible();
    page.on("pageerror", onError);
    combinedHeads = 0;
    await page.getByRole("button", { name: /^Filter by team:/ }).click();
    const dialog = page.locator("dialog[open]").last();
    await dialog.getByRole("button", { name: /^All teams/ }).click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(() => combinedHeads).toBeGreaterThan(0);
    await expect
      .poll(() => feed.locator(".feed-row").count())
      .toBeGreaterThan(1);
    await expect(feed.locator(".collection-read-error")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    page.off("pageerror", onError);
    await page.unroute(match, handler);
    fixture.db.transaction(() => {
      for (const row of previous) setTeam.run(row.team_id, row.id);
    })();
  }
}

async function openConnectedFeed(page, url) {
  const before = localFrames.count;
  await page.goto(url);
  // HTTP fallback also reports Connected. Wait for the socket's initial
  // frame so its later reset cannot cancel the recovery under test.
  await expect
    .poll(() => localFrames.count > before, { timeout: 15_000 })
    .toBe(true);
}

async function feedRefreshAfterAppendRecovery(page, fixture) {
  const working = await fixture.api("/feed?filter=working");
  expect(working.items.length).toBeGreaterThan(0);
  const match = (url) =>
    url.pathname === "/api/feed" &&
    url.searchParams.get("filter") === "working";
  let phase = "initial";
  const appendReads = [];
  const refreshReads = [];
  const manual = Promise.withResolvers();
  // This case controls recovery with explicit signals and a manual retry.
  // Failed reads can now probe HTTP even with a ready socket; keep that
  // transport unavailable so it cannot race the operation being asserted.
  const eventsMatch = (url) => url.pathname === "/api/events";
  const eventsUnavailable = (route) =>
    route.fulfill({ status: 503, json: { error: "Event transport outage" } });
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (phase === "append" && url.searchParams.has("before")) {
      appendReads.push(url);
      return route.fulfill({ status: 503, json: { error: "Append outage" } });
    }
    if (phase === "refresh") {
      refreshReads.push(url);
      return route.fulfill({ status: 503, json: { error: "Refresh outage" } });
    }
    if (phase === "manual") {
      refreshReads.push(url);
      await manual.promise;
    }
    return route.fulfill({
      json: {
        ...working,
        items: [{ ...working.items[0], title: `Recovery head ${phase}` }],
        next: "older",
      },
    });
  };
  await page.route(match, handler);
  await page.route(eventsMatch, eventsUnavailable);
  try {
    await openConnectedFeed(page, fixture.base + "/?filter=working");
    await expect(
      page.getByText("Recovery head initial", { exact: true }),
    ).toBeVisible();
    // Let the initial reset's trailing refresh settle before the outage.
    await page.waitForTimeout(2500);
    const feed = page.getByRole("region", { name: "Feed", exact: true });
    const marker = feed.locator(".collection-read-error");
    phase = "append";
    await feed.getByRole("button", { name: "Load more", exact: true }).click();
    await expect.poll(() => appendReads.length, { timeout: 10_000 }).toBe(3);
    await expect(marker).toBeVisible();
    expect(appendReads.map((url) => url.searchParams.get("before"))).toEqual([
      "older",
      "older",
      "older",
    ]);
    await page.waitForTimeout(2100);
    expect(appendReads).toHaveLength(3);

    // A successful signal-driven head read clears a failed append. A later
    // post-action refresh must read the head, even with a remaining tail cursor.
    phase = "recovered";
    await signalCollection(page, "feed");
    await expect(
      page.getByText("Recovery head recovered", { exact: true }),
    ).toBeVisible();
    await expect(marker).toHaveCount(0);
    phase = "refresh";
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect.poll(() => refreshReads.length).toBeGreaterThan(0);
    expect(refreshReads[0].searchParams.get("filter")).toBe("working");
    expect(refreshReads[0].searchParams.has("before")).toBe(false);
    // This shared event retains the automatic two-retry budget.
    await expect.poll(() => refreshReads.length, { timeout: 10_000 }).toBe(3);
    expect(refreshReads.every((url) => !url.searchParams.has("before"))).toBe(
      true,
    );
    await expect(marker).toBeVisible();
    await page.waitForTimeout(2100);
    expect(refreshReads).toHaveLength(3);

    phase = "manual";
    const retry = marker.getByRole("button", {
      name: "Retry connection",
      exact: true,
    });
    await retry.click();
    await expect.poll(() => refreshReads.length).toBe(4);
    await expect(retry).toBeDisabled();
    expect(refreshReads[3].searchParams.has("before")).toBe(false);
    manual.resolve();
    await expect(marker).toHaveCount(0);
    await expect(
      page.getByText("Recovery head manual", { exact: true }),
    ).toBeVisible();
  } finally {
    manual.resolve();
    await page.unroute(match, handler);
    await page.unroute(eventsMatch, eventsUnavailable);
  }
}

async function feedLoadingCase(
  page,
  fixture,
  cardsUnavailable,
  capture,
  streamResets,
) {
  const sources = [
    { id: "cloud:first", name: "First environment", kind: "cloud" },
    { id: "cloud:second", name: "Second environment", kind: "cloud" },
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
  let workingRevision = 0;
  const workingEmptySources = new Set();
  const workingCursors = [];
  let pause = null;
  let pauseReads = 0;
  let queuedHold = null;
  let slowFeed = Promise.withResolvers();
  let firstFeed = null;
  const doneReads = new Map();
  const savedBySource = new Map(sources.map((source) => [source.id, true]));
  const savedWrites = [];
  let refresh = null;
  let refreshReads = 0;
  let discoveryReads = 0;
  const paginationReads = [];
  const rows = page.locator(".feed-results .feed-row");
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
      : cardsUnavailable
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
  // This case asserts explicit signals and exact manual page retries. A quiet
  // socket alone does not prevent failed reads from probing HTTP for recovery.
  const eventsMatch = (url) => url.pathname === "/api/events";
  const eventsUnavailable = (route) =>
    route.fulfill({ status: 503, json: { error: "Event transport outage" } });
  const sourceRequests = new Set();
  const readSource = async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/agent-sources\/([^/]+)\/(.*)$/.exec(url.pathname);
    const source = sources.find(
      (item) => item.id === decodeURIComponent(match[1]),
    );
    if (match[2] === "events") return eventsUnavailable(route);
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
    if (typed && cardsUnavailable)
      return route.fulfill({ status: 404, body: "{}" });
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
              title:
                source.name +
                " page " +
                index +
                (index === 1 && workingRevision
                  ? " update " + workingRevision
                  : ""),
              last_activity_at: working.items[0].last_activity_at - index,
            },
          ],
          next: index < 4 ? String(index) : null,
        });
      }
      if (
        !typed &&
        (url.searchParams.get("filter") !== "done" || !cardsUnavailable)
      )
        return fulfill(route, empty);
      doneReads.set(source.id, (doneReads.get(source.id) || 0) + 1);
      if (source === sources[0]) await firstFeed?.promise;
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
  await page.route(eventsMatch, eventsUnavailable);
  try {
    const localRead = page.waitForResponse((response) =>
      cardsUnavailable
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
    // A failed initial lookup does not establish an empty source list, even
    // after the typed reader's two bounded transient retries (2s, then 4s).
    discovery.resolve();
    await expect(
      page.getByText(
        "Couldn’t connect to your execution environments. Check your connection and retry.",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 10_000 });
    await expect(noResults).toHaveCount(0);
    discoveryFails = false;
    discovery = Promise.withResolvers();
    await page
      .getByRole("status")
      .filter({ hasText: "Couldn’t connect to your execution environments" })
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
              (node.matches(".feed-empty") || node.querySelector(".feed-empty"))
            )
              window.__feedEmptyFlashes++;
      });
      window.__feedEmptyObserver.observe(document.querySelector(".feed-view"), {
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
    await openAgentModelOptions(creation);
    await expect(
      creation.getByRole("radiogroup", { name: "Connection", exact: true }),
    ).not.toContainText(sources[0].name);
    await creation.getByRole("button", { name: "Close", exact: true }).click();
    await capture("first-result-before-other-reads");
    metadata.resolve();
    // Finish the metadata pass before asking discovery for another topology.
    // The first Feed result is intentionally visible before these agents load.
    await expect(
      page
        .getByRole("region", { name: "Your agents", exact: true })
        .getByRole("button")
        .filter({ hasText: sources[0].name })
        .first(),
    ).toBeVisible();
    // The first source has been displayed, but the held second source means
    // no combined cache exists yet. Discovery churn must retain that page.
    discoveredSources = [sources[1]];
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(first).toHaveCount(0);
    // Destination discovery publishes before metadata. Finish removal from
    // both views before requesting the next discovery pass.
    await expect(
      page
        .getByRole("region", { name: "Your agents", exact: true })
        .getByRole("button")
        .filter({ hasText: sources[0].name }),
    ).toHaveCount(0);
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
            `/api/agent-sources/${encodeURIComponent(source.id)}/${cardsUnavailable ? "feed" : "v1/cards/changes"}` &&
          (!cardsUnavailable || url.searchParams.get("filter") === "done")
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
    await page.getByRole("tab", { name: /^Done/ }).click();
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
    await expect(
      page
        .getByRole("region", { name: "Your agents", exact: true })
        .getByRole("button")
        .filter({ hasText: sources[1].name }),
    ).toHaveCount(0);
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
      /temporarily unavailable\. Last loaded agents are still shown\./,
      { exact: false },
    );
    // Metadata reads retry after two and four seconds before showing an outage.
    await expect(outage).toBeVisible({ timeout: 10_000 });
    metadataFails = false;
    metadata = Promise.withResolvers();
    const beforeRetry = metadataReads;
    await outage
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
    const appendRequests = [];
    const captureAppend = (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.includes("/agent-sources/") &&
        url.pathname.endsWith("/feed") &&
        url.searchParams.get("filter") === "working" &&
        url.searchParams.has("before")
      )
        appendRequests.push({
          source: decodeURIComponent(url.pathname.split("/")[3]),
          before: url.searchParams.get("before"),
        });
    };
    page.on("request", captureAppend);
    try {
      unavailableFeeds.add(sources[1].id);
      await loadMore.click();
      const failedReads = () =>
        appendRequests.filter((read) => read.source === sources[1].id).length;
      await expect.poll(failedReads, { timeout: 10_000 }).toBe(3);
      await expect(rows).toHaveCount(3); // Only the healthy source advanced.
      const retry = page
        .getByRole("region", { name: "Feed", exact: true })
        .locator(".collection-read-error")
        .getByRole("button", { name: "Retry connection", exact: true });
      await retry.click();
      await expect.poll(failedReads).toBe(4);
      await page.waitForTimeout(6500);
      expect(failedReads()).toBe(4);
      expect(
        appendRequests.filter((read) => read.source === sources[0].id),
      ).toEqual([{ source: sources[0].id, before: "1" }]);
      unavailableFeeds.clear();
      await retry.click();
      await expect(rows).toHaveCount(4);
      await expect(retry).toHaveCount(0);
      expect(
        appendRequests.filter((read) => read.source === sources[1].id),
      ).toEqual(
        Array.from({ length: 5 }, () => ({
          source: sources[1].id,
          before: "1",
        })),
      );
      expect(
        appendRequests.filter((read) => read.source === sources[0].id),
      ).toHaveLength(1);
    } finally {
      page.off("request", captureAppend);
    }
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
    workingRevision = 1;
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
    // A cached healthy source publishes without the held source completing,
    // and a later scoped invalidation can refresh it again in that same pass.
    await expect(
      rows.filter({ hasText: "First environment page 1 update 1" }),
    ).toBeVisible({ timeout: 3000 });
    workingRevision = 2;
    await page.evaluate(
      (source) =>
        window.dispatchEvent(
          new CustomEvent("loop-workspace-change", {
            detail: {
              sources: [source],
              changes: [
                {
                  source,
                  events: [
                    {
                      type: "invalidate",
                      scope: { kind: "collection", id: "feed" },
                    },
                  ],
                },
              ],
            },
          }),
        ),
      sources[0].id,
    );
    await expect(
      rows.filter({ hasText: "First environment page 1 update 2" }),
    ).toBeVisible({ timeout: 3000 });
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

    // A healthy source's exhaustive empty response removes its stale rows
    // immediately. Until the other source settles, show pending work rather
    // than claiming that the complete combined feed is empty.
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
    await expect(rows).toHaveCount(0);
    await expect(loading).toBeVisible();
    await expect(page.locator(".feed-empty")).toHaveCount(0);
    workingHold.resolve();
    workingHold = null;
    await expect(rows).toHaveCount(0);
    await expect(page.locator(".feed-empty")).toBeVisible();
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
      .locator(".feed-item-card")
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
      .locator(".feed-item-card")
      .filter({ hasText: "First environment result" })
      .locator(".card-environment");
    await expect(firstBadge).toHaveText("Connected environment");
    discovery.resolve();
    // Names update even when discovery returns the same source ids and the
    // card's archived agent has no metadata projection to provide its label.
    await expect(firstBadge).toHaveText(sources[0].name);
    // The badge updates before source metadata settles. Finish that discovery
    // pass before requesting another topology change; local agents appear only
    // after its metadata projection has been published.
    await expect(
      page
        .getByRole("region", { name: "Your agents", exact: true })
        .getByRole("button")
        .filter({ hasText: bootstrap.environmentName })
        .first(),
    ).toBeVisible();
    discoveredSources = sources;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect(second).toBeVisible();
    await expect(page.locator('.feed-row[data-retained="yes"]')).toBeVisible();

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
    if (cardsUnavailable) {
      firstFeed = Promise.withResolvers();
      doneReads.clear();
      streamResets.clear();
    }
    await page.goto(fixture.base);
    if (cardsUnavailable) {
      // Reset both linked streams after their first reads start. The empty
      // local page may complete, but cannot suppress either source's first
      // successful page on retry while the other source is still held.
      const streamPath = (source) =>
        `/api/agent-sources/${encodeURIComponent(source.id)}/events/ws`;
      await expect
        .poll(() =>
          sources.every(
            (source) =>
              doneReads.get(source.id) > 0 &&
              streamResets.has(streamPath(source)),
          ),
        )
        .toBe(true);
      const before = new Map(doneReads);
      for (const source of sources) streamResets.get(streamPath(source))();
      await expect
        .poll(() =>
          sources.every(
            (source) => doneReads.get(source.id) > before.get(source.id),
          ),
        )
        .toBe(true);
      firstFeed.resolve();
    }
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    await expect(loadMore).toHaveCount(0);
    const firstCard = page
      .locator(".feed-item-card")
      .filter({ hasText: "First environment result" });
    const secondCard = page
      .locator(".feed-item-card")
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

    // A missing discovery endpoint cannot confirm an empty source list.
    discoveryFails = true;
    discoveryStatus = 404;
    await page.goto(fixture.base);
    await expect(
      page.getByText(
        "Couldn’t connect to your execution environments. Check your connection and retry.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(noResults).toHaveCount(0);
  } finally {
    discovery.resolve();
    metadata.resolve();
    slowFeed.resolve();
    firstFeed?.resolve();
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
    await page.unroute(eventsMatch, eventsUnavailable);
    await Promise.allSettled([...sourceRequests]);
  }
}
