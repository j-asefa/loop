import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function doneFeedFiltersSmoke(page, fixture, engine, capture) {
  const agents = [];
  for (const name of ["filter-alder", "filter-birch", "filter-empty"])
    agents.push(
      await fixture.api("/agents", {
        name,
        connectionId: fixture.agents[0].connection_id,
        model: fixture.agents[0].model,
      }),
    );
  const run = fixture.db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,'completed',?,?,?)",
  );
  const message = fixture.db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,?)",
  );
  const read = fixture.db.prepare(
    "INSERT INTO done_card_reads(owner_id,conversation_id,card_key,read_at) VALUES(?,?,?,?)",
  );
  const at = Date.now();
  fixture.db.transaction(() => {
    for (const [index, agent] of agents.entries()) {
      fixture.db
        .prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
        )
        .run(agent.id, fixture.owner, agent.id, agent.name, at);
      for (let n = 0; n < (index === 0 ? 84 : index === 1 ? 3 : 0); n++) {
        const id = `${index}-${n}`;
        run.run(
          id,
          fixture.owner,
          agent.id,
          agent.id,
          `Filter result ${id}`,
          id,
          at + n,
          at + n,
        );
        message.run(
          id,
          fixture.owner,
          agent.id,
          id,
          `Answer for filter result ${id}`,
          at + n,
        );
        if (n % 2 === 0) read.run(fixture.owner, agent.id, `run:${id}`, at + n);
      }
    }
  })();
  await fixture.api("/feed/threads", {
    id: randomUUID(),
    title: "Mixed agent results",
    cardIds: ["d:run:0-82", "d:run:1-1"],
  });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  const controls = page.getByRole("group", {
    name: "Filter Done",
    exact: true,
  });
  const status = (name) => controls.getByRole("button", { name, exact: true });
  const picker = controls.getByRole("button", {
    name: "Filter Done by agent",
  });
  const agentSheet = page.getByRole("dialog", {
    name: "Filter Done by agent",
    exact: true,
  });
  const search = agentSheet.getByRole("searchbox", { name: "Search agents" });
  const choose = async (agent, environment) => {
    await picker.click();
    await search.fill(`@${agent.name.toUpperCase()}`);
    const options = agentSheet.getByRole("button", {
      name: new RegExp(`^@${agent.name}(?: · |$)`),
    });
    await (
      environment ? options.filter({ hasText: environment }) : options.first()
    ).click();
    await expect(agentSheet).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const rows = page.locator(".inbox-results .inbox-row");
  const card = (title) =>
    rows.filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
  const closeReader = async () => {
    await page
      .locator("dialog[open]")
      .last()
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  await expect(status("All")).toHaveAttribute("aria-pressed", "true");
  await picker.click();
  await search.fill("@FILTER-AL");
  await expect(
    agentSheet.getByRole("button", { name: /^@filter-alder/ }),
  ).toBeVisible();
  await expect(
    agentSheet.getByRole("button", { name: /^@filter-birch/ }),
  ).toHaveCount(0);
  await search.fill("no-matching-agent");
  await expect(agentSheet.getByRole("status")).toHaveText(
    "No agents match your search.",
  );
  await expect(
    agentSheet.getByRole("button", { name: "All agents", exact: true }),
  ).toBeVisible();
  // A native search input consumes Escape to clear a nonempty query first.
  await search.fill("");
  await search.press("Escape");
  await expect(agentSheet).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveText("All agents");
  await choose(agents[0]);
  await status("Unread").click();
  await expect(card("Filter result 0-83")).toBeVisible();
  await expect(card("Filter result 0-80")).toHaveCount(0);
  await expect(card("Filter result 1-2")).toHaveCount(0);
  // The group is unread even though its member for this agent is read.
  await expect(card("Mixed agent results")).toContainText("Unread");
  await expect(card("Filter result 0-1")).toHaveCount(0);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(card("Filter result 0-1")).toHaveCount(1);
  await expect(rows).toHaveCount(43);
  const readRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/cards/changes" &&
      url.searchParams.get("agent") === agents[0].id &&
      url.searchParams.get("read") === "unread"
    );
  });
  await card("Filter result 0-83").getByRole("heading").click();
  await expect(page.locator("dialog[open]")).toContainText(
    "Answer for filter result 0-83",
  );
  await expect
    .poll(
      () =>
        fixture.db
          .prepare(
            "SELECT unread FROM feed_cards WHERE owner_id=? AND kind='result' AND card_key='run:0-83'",
          )
          .get(fixture.owner).unread,
    )
    .toBe(0);
  // The read-state refresh must not unmount the sheet being read.
  await readRefresh;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator("dialog[open]")).toBeVisible();
  await closeReader();
  await expect(card("Filter result 0-83")).toHaveCount(0);
  // Clearing the unread state refreshes the group independently of card pages.
  await card("Mixed agent results").getByRole("heading").click();
  await expect(page.locator("dialog[open]")).toContainText(
    "Answer for filter result 1-1",
  );
  await closeReader();
  await expect(card("Mixed agent results")).toHaveCount(0);
  await status("Read").click();
  await expect(card("Filter result 0-83")).toBeVisible();
  await expect(card("Mixed agent results")).toHaveCount(1);
  await expect(card("Filter result 0-81")).toHaveCount(0);
  const unreadCount = () =>
    fixture
      .api("/feed?filter=done&agent=" + agents[0].id)
      .then((feed) => feed.summary.done_unread);
  const beforeUnread = await unreadCount();
  const markUnread = async (title) => {
    await page
      .locator(".inbox-results article")
      .filter({
        has: page.getByRole("heading", { name: title, exact: true }),
      })
      .getByRole("button", { name: "Thread actions" })
      .click();
    await page
      .getByRole("menuitem", { name: "Mark unread", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  await markUnread("Filter result 0-83");
  await expect(card("Filter result 0-83")).toHaveCount(0);
  await expect.poll(unreadCount).toBe(beforeUnread + 1);
  await markUnread("Mixed agent results");
  await expect(card("Mixed agent results")).toHaveCount(0);
  await expect.poll(unreadCount).toBe(beforeUnread + 2);
  await page.reload({ waitUntil: "networkidle" });
  await choose(agents[0]);
  await status("Unread").click();
  await expect(card("Filter result 0-83")).toContainText("Unread");
  await expect(card("Mixed agent results")).toContainText("Unread");
  await capture("marked-unread");
  // The reader retains the original unread card after opening marks it read.
  // Its action menu must still let the user leave that result unread for later.
  await card("Filter result 0-83").getByRole("heading").click();
  await expect.poll(unreadCount).toBe(beforeUnread + 1);
  await page
    .locator(".feed-reading-sheet")
    .getByRole("button", { name: "Thread actions" })
    .click();
  await page
    .getByRole("menuitem", { name: "Mark unread", exact: true })
    .click();
  await expect.poll(unreadCount).toBe(beforeUnread + 2);
  await expect(page.locator(".feed-reading-sheet")).toBeVisible();
  await closeReader();
  await expect(card("Filter result 0-83")).toContainText("Unread");
  // Opening the cards again returns them to Read, including all group members.
  await card("Filter result 0-83").getByRole("heading").click();
  await closeReader();
  await card("Mixed agent results").getByRole("heading").click();
  await closeReader();
  await expect.poll(unreadCount).toBe(beforeUnread);
  await status("Read").click();
  await choose(agents[1]);
  await expect(card("Filter result 1-2")).toBeVisible();
  await expect(card("Filter result 0-83")).toHaveCount(0);
  await choose(agents[2]);
  await expect(page.getByText("No results match these filters.")).toBeVisible();
  await expect(rows).toHaveCount(0);
  await capture("empty");
  await controls.getByRole("button", { name: "Clear filters" }).click();
  await expect(status("All")).toHaveAttribute("aria-pressed", "true");
  await expect(picker).toHaveText("All agents");
  await expect(card("Filter result 0-83")).toBeVisible();
  await choose(agents[1]);
  await status("Unread").click();
  // Other Feed tabs keep their normal scope; returning restores Done choices.
  const tabs = page.getByRole("tablist", { name: "Show", exact: true });
  await tabs.getByRole("tab", { name: /^Working/ }).click();
  await expect(controls).toHaveCount(0);
  await expect(rows.first()).toBeVisible();
  await tabs.getByRole("tab", { name: /^Done/ }).click();
  await expect(status("Unread")).toHaveAttribute("aria-pressed", "true");
  await expect(picker).toHaveText("@" + agents[1].name);
  await expect(page.getByText("No results match these filters.")).toBeVisible();
  // A response from a prior selection must never replace a newer one.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let started;
  const pending = new Promise((resolve) => (started = resolve));
  const oldSelection = (url) =>
    /^\/api\/v1\/cards(?:\/changes)?$/.test(url.pathname) &&
    url.searchParams.get("agent") === agents[0].id &&
    url.searchParams.get("read") === "read";
  await page.route(oldSelection, async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await choose(agents[0]);
  await status("Read").click();
  await pending;
  await choose(agents[1]);
  const settled = page.waitForResponse((response) =>
    oldSelection(new URL(response.url())),
  );
  release();
  await settled;
  await expect(card("Filter result 1-2")).toBeVisible();
  await expect(card("Filter result 0-83")).toHaveCount(0);
  await page.unroute(oldSelection);
  for (const width of [320, 390, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    await controls.scrollIntoViewIfNeeded();
    await capture(`filters-${width}`);
    assert(await picker.isVisible(), `${engine}: agent filter at ${width}px`);
    await picker.click();
    await expect(search).toHaveValue("");
    await search.fill("filter-");
    await capture(`agent-search-${width}`);
    assert(
      await agentSheet.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
      `${engine}: agent picker fits at ${width}px`,
    );
    await closeReader();
  }

  // A linked-source fixture deliberately reuses local agent and card IDs.
  // Selecting it must address that source without mixing local cached pages.
  const source = "docker:done-filters";
  const prefix = `/api/agent-sources/${encodeURIComponent(source)}/`;
  const localSummary = (await fixture.api("/feed?filter=needs")).summary;
  const remoteSummary = {
    ...localSummary,
    working: 2,
    queued: 3,
    replies_unread: 4,
    scheduled_failed: 2,
    scheduled_pending: 3,
  };
  const expectOperationalCounts = async () => {
    for (const [tab, field] of [
      ["working", "working"],
      ["queued", "queued"],
      ["replies", "replies_unread"],
    ])
      await expect(
        tabs.locator(`[data-filter="${tab}"] .chip-count`),
      ).toHaveText(String((localSummary[field] || 0) + remoteSummary[field]));
  };
  await page.goto("about:blank");
  await page.route(
    (url) => url.pathname === "/session",
    (route) => route.fulfill({ json: { csrf: "filter-fixture" } }),
  );
  await page.route(
    (url) => url.pathname === "/api/capabilities",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), pairedDevices: true },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/agent-sources",
    (route) =>
      route.fulfill({
        json: [{ id: source, name: "Filter fixture", kind: "docker" }],
      }),
  );
  await page.route(
    (url) => url.pathname.startsWith(prefix),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(prefix.length);
      if (path === "feed/threads") return route.fulfill({ json: [] });
      if (path === "feed/agent-threads")
        return route.fulfill({ json: { items: [], next: null } });
      url.pathname = "/api/" + path;
      if (path === "feed") url.searchParams.delete("known");
      const response = await route.fetch({ url: url.href });
      if (path === "feed")
        return route.fulfill({
          response,
          json: { ...(await response.json()), summary: { ...remoteSummary } },
        });
      if (!/^v1\/cards(?:\/changes)?$/.test(path))
        return route.fulfill({ response });
      const body = await response.json();
      body.items = body.items.map((entry) => ({
        ...entry,
        card: {
          ...entry.card,
          display: {
            ...entry.card.display,
            title: "Remote " + entry.card.display.title,
          },
        },
      }));
      await route.fulfill({ response, json: body });
    },
  );
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await picker.click();
  await search.fill("@filter-alder");
  await expect(
    agentSheet.getByRole("button", { name: /^@filter-alder/ }),
  ).toHaveCount(2);
  await search.fill("Filter fixture");
  await expect(
    agentSheet.getByRole("button", { name: /^@filter-alder/ }),
  ).toHaveCount(1);
  await closeReader();
  await expectOperationalCounts();
  await choose(agents[0], "Filter fixture");
  await status("Unread").click();
  await expect(card("Remote Filter result 0-81")).toBeVisible();
  await expect(card("Filter result 0-81")).toHaveCount(0);
  await expectOperationalCounts();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(card("Remote Filter result 0-1")).toHaveCount(1);
  await choose(agents[0]);
  await expect(card("Filter result 0-81")).toBeVisible();
  await expect(card("Remote Filter result 0-81")).toHaveCount(0);
  await expectOperationalCounts();
  // Updates from the unselected workspace still refresh operational counts.
  remoteSummary.working = 5;
  await page.evaluate((source) => {
    window.dispatchEvent(
      new CustomEvent("loop-workspace-change", {
        detail: { sources: [source] },
      }),
    );
  }, source);
  await expectOperationalCounts();
  const needs = page.getByRole("region", { name: "Needs you", exact: true });
  await needs.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(needs.locator(".scheduled-summary")).toContainText(
    `${(localSummary.scheduled_failed || 0) + remoteSummary.scheduled_failed} scheduled messages not sent`,
  );
  await needs.getByRole("button", { name: "Collapse", exact: true }).click();
  await choose(agents[0], "Filter fixture");
  await expect(card("Remote Filter result 0-1")).toHaveCount(1);
  await expect(card("Filter result 0-81")).toHaveCount(0);
  await expectOperationalCounts();
  await capture("source-isolation");
  await status("Read").click();
  const remoteUnread = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === `${prefix}feed/${agents[0].id}/read`,
  );
  const [, unreadRequest] = await Promise.all([
    markUnread("Remote Filter result 0-83"),
    remoteUnread,
  ]);
  assert.deepEqual(unreadRequest.postDataJSON(), {
    cardKey: "run:0-83",
  });
  await expect(card("Remote Filter result 0-83")).toHaveCount(0);
  await status("Unread").click();
  await expect(card("Remote Filter result 0-83")).toContainText("Unread");
}
