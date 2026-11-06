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
  const groupId = randomUUID();
  await fixture.api("/feed/threads", {
    id: groupId,
    title: "Mixed agent results",
    cardIds: ["d:run:0-82", "d:run:1-1"],
  });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  const controls = page.getByRole("group", {
    name: "Filter Done",
    exact: true,
  });
  const status = (name) => controls.getByRole("button", { name, exact: true });
  const picker = page
    .getByRole("group", { name: "Workspace filters", exact: true })
    .getByRole("button", { name: /^Filters/ });
  const agentSheet = page.getByRole("dialog", {
    name: "Filter workspace",
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
    await agentSheet
      .getByRole("button", { name: "Apply filters", exact: true })
      .click();
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
    "No agents match these filters.",
  );
  await expect(
    agentSheet.getByRole("button", { name: "All agents", exact: true }),
  ).toBeVisible();
  // A native search input consumes Escape to clear a nonempty query first.
  await search.fill("");
  await search.press("Escape");
  await expect(agentSheet).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveText("Filters");
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
  const openActions = async (title) => {
    await page
      .locator(".inbox-results article")
      .filter({
        has: page.getByRole("heading", { name: title, exact: true }),
      })
      .getByRole("button", { name: "Thread actions" })
      .click();
  };
  const markUnread = async (title) => {
    await openActions(title);
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
  // Hold the initial read before the server sees it, then choose unread. The
  // later choice must wait for that read, including after closing a group.
  const unreadDuringRead = async (
    title,
    path,
    insideReader,
    { unreadPath = path, unreadTitle = title, afterOpen } = {},
  ) => {
    let release, started;
    const held = new Promise((resolve) => (release = resolve));
    const pending = new Promise((resolve) => (started = resolve));
    const applied = [];
    const matches = (url) => [path, unreadPath].includes(url.pathname);
    await page.route(matches, async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        started();
        await held;
      }
      const response = await route.fetch();
      applied.push(method);
      await route.fulfill({ response });
    });
    const responseFor = (method) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            (method === "PUT" ? path : unreadPath) &&
          response.request().method() === method,
      );
    const readResponse = responseFor("PUT");
    const unreadResponse = responseFor("DELETE");
    try {
      await card(title).getByRole("heading").click();
      await pending;
      await afterOpen?.();
      if (insideReader)
        await page
          .locator(".feed-reading-sheet")
          .getByRole("button", { name: "Thread actions" })
          .click();
      else {
        await closeReader();
        await openActions(unreadTitle);
      }
      await page
        .getByRole("menuitem", { name: "Mark unread", exact: true })
        .click();
      // Give an incorrectly parallel DELETE time to overtake the held PUT.
      await page.waitForTimeout(150);
      release();
      await Promise.all([readResponse, unreadResponse]);
      assert.deepEqual(applied, ["PUT", "DELETE"]);
      await expect.poll(unreadCount).toBe(beforeUnread + 2);
      if (insideReader) {
        await expect(page.locator(".feed-reading-sheet")).toBeVisible();
        await closeReader();
      }
    } finally {
      release();
      await page.unroute(matches);
    }
  };
  await unreadDuringRead(
    "Filter result 0-83",
    `/api/feed/${agents[0].id}/read`,
    true,
  );
  await expect(card("Filter result 0-83")).toContainText("Unread");
  await unreadDuringRead(
    "Mixed agent results",
    `/api/feed/threads/${groupId}/read`,
    false,
  );
  // Model another device adding the pending result to the group while this
  // browser still has the previous membership list. The group action applies
  // to current server membership and must also wait for that result's PUT.
  const oldThreads = await fixture.api(
    `/feed/threads/page?agent=${agents[0].id}`,
  );
  const threadList = (url) => url.pathname === "/api/feed/threads/page";
  await page.route(threadList, (route) => route.fulfill({ json: oldThreads }));
  try {
    await unreadDuringRead(
      "Filter result 0-83",
      `/api/feed/${agents[0].id}/read`,
      false,
      {
        unreadPath: `/api/feed/threads/${groupId}/read`,
        unreadTitle: "Mixed agent results",
        afterOpen: () =>
          fixture.api(`/feed/threads/${groupId}/cards`, {
            cardIds: ["d:run:0-83"],
          }),
      },
    );
  } finally {
    await fixture.api(
      `/feed/threads/${groupId}/cards/${encodeURIComponent("d:run:0-83")}`,
      undefined,
      "DELETE",
    );
    await page.unroute(threadList);
  }
  // An independent client can mark unread while this tab's older read is held
  // before dispatch. The server must reject that stale decision for both paths.
  for (const [title, path, body] of [
    [
      "Filter result 0-83",
      `/feed/${agents[0].id}/read`,
      { cardKey: "run:0-83" },
    ],
    ["Mixed agent results", `/feed/threads/${groupId}/read`, undefined],
  ]) {
    let release, started;
    const held = new Promise((resolve) => (release = resolve));
    const pending = new Promise((resolve) => (started = resolve));
    const matches = (url) => url.pathname === "/api" + path;
    await page.route(matches, async (route) => {
      if (route.request().method() === "PUT") {
        started();
        await held;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    try {
      const settled = page.waitForResponse(
        (response) =>
          matches(new URL(response.url())) &&
          response.request().method() === "PUT",
      );
      await card(title).getByRole("heading").click();
      await pending;
      // This request bypasses the page and its module-level write queue.
      await fixture.api(path, body, "DELETE");
      release();
      await settled;
      assert.equal(
        await unreadCount(),
        beforeUnread + 2,
        `${engine}: a delayed read cannot erase another client's unread`,
      );
      await closeReader();
      await expect(card(title)).toContainText("Unread");
    } finally {
      release();
      await page.unroute(matches);
    }
  }
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
  await expect(page.locator('[aria-label$=" in Feed"]')).toHaveCount(0);
  await expect(page.getByText("No results match these filters.")).toBeVisible();
  await expect(rows).toHaveCount(0);
  await capture("empty");
  await controls.getByRole("button", { name: "Clear filters" }).click();
  await page
    .getByRole("button", { name: "Remove agent filter", exact: true })
    .click();
  await expect(status("All")).toHaveAttribute("aria-pressed", "true");
  await expect(picker).toHaveText("Filters");
  await expect(card("Filter result 0-83")).toBeVisible();
  await choose(agents[1]);
  await status("Unread").click();
  // Agent scope carries across tabs; read status remains specific to Done.
  const tabs = page.getByRole("tablist", { name: "Show", exact: true });
  await tabs.getByRole("tab", { name: /^Working/ }).click();
  await expect(controls).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove agent filter" }),
  ).toContainText(agents[1].name);
  await tabs.getByRole("tab", { name: /^Done/ }).click();
  await expect(status("Unread")).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Remove agent filter" }),
  ).toContainText("@" + agents[1].name);
  await expect(page.getByText("No results match these filters.")).toBeVisible();
  // Workspace navigation remembers the tab and agent without leaking filters
  // into a newly entered project.
  const workspace = page.getByRole("combobox", { name: "Project workspace" });
  await tabs.getByRole("tab", { name: /^Replies/ }).click();
  await workspace.selectOption(fixture.projects[0].id);
  await expect(tabs.getByRole("tab", { name: /^Done/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(picker).toHaveText("Filters");
  await workspace.selectOption("");
  await expect(tabs.getByRole("tab", { name: /^Replies/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Remove agent filter" }),
  ).toContainText(agents[1].name);
  await expect(page.locator(".agent-strip > button")).toHaveCount(2);
  await tabs.getByRole("tab", { name: /^Done/ }).click();
  await tabs.getByRole("tab", { name: /^Replies/ }).click();
  await page
    .locator(".agent-strip")
    .getByRole("button", { name: new RegExp(`^@${agents[1].name} ·`) })
    .click();
  await page
    .locator(".profile-backbar")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect(tabs.getByRole("tab", { name: /^Replies/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Remove agent filter" }),
  ).toContainText(agents[1].name);
  await tabs.getByRole("tab", { name: /^Done/ }).click();
  // A response from a prior selection must never replace a newer one.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let started;
  const pending = new Promise((resolve) => (started = resolve));
  const oldSelection = (url) =>
    /^\/api\/v1\/cards(?:\/changes)?$/.test(url.pathname) &&
    url.searchParams.get("agent") === agents[0].id &&
    url.searchParams.get("read") === "read";
  await page.route(
    oldSelection,
    async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
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

  const teamA = await fixture.api("/teams", {
    name: "Filter team A",
    managerId: agents[0].id,
    members: [agents[2].id],
  });
  const teamB = await fixture.api("/teams", {
    name: "Filter team B",
    managerId: agents[1].id,
    members: [agents[2].id],
  });
  fixture.db
    .prepare("UPDATE conversations SET team_id=? WHERE id=?")
    .run(teamB.id, agents[1].id);
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await picker.click();
  await agentSheet
    .getByRole("button", { name: teamA.name, exact: true })
    .click();
  await agentSheet
    .getByRole("button", { name: teamB.name, exact: true })
    .click();
  await search.fill(agents[0].name);
  await agentSheet
    .getByRole("button", { name: `@${agents[0].name}`, exact: true })
    .click();
  await agentSheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `Remove team filter: ${teamA.name}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove agent filter", exact: true }),
  ).toHaveCount(0);
  await expect(card("Filter result 1-2")).toBeVisible();
  await capture("team-chip-clears-incompatible-agent");
  // Deleting A through management must reconcile the same A+B selection.
  await picker.click();
  await agentSheet
    .getByRole("button", { name: teamA.name, exact: true })
    .click();
  await search.fill(agents[0].name);
  await agentSheet
    .getByRole("button", { name: `@${agents[0].name}`, exact: true })
    .click();
  await agentSheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await picker.click();
  await agentSheet
    .getByRole("button", { name: "Manage teams", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Manage teams", exact: true })
    .locator(".team-option-group")
    .filter({ hasText: teamA.name })
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: `Delete ${teamA.name}?`, exact: true })
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await expect(agentSheet).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove agent filter", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `Remove team filter: ${teamA.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(card("Filter result 1-2")).toBeVisible();
  await capture("team-deletion-clears-incompatible-agent");

  // A saved Overview selection must be reconciled after deleting its team
  // while another project is displayed.
  const rememberedTeam = await fixture.api("/teams", {
    name: "Remembered filter team",
    managerId: agents[0].id,
    members: [agents[2].id],
  });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await picker.click();
  await agentSheet
    .getByRole("button", { name: teamB.name, exact: true })
    .click();
  await agentSheet
    .getByRole("button", { name: rememberedTeam.name, exact: true })
    .click();
  await search.fill(agents[0].name);
  await agentSheet
    .getByRole("button", { name: `@${agents[0].name}`, exact: true })
    .click();
  await agentSheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await workspace.selectOption(fixture.projects[0].id);
  await picker.click();
  await agentSheet
    .getByRole("button", { name: "Manage teams", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Manage teams", exact: true })
    .locator(".team-option-group")
    .filter({ hasText: rememberedTeam.name })
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: `Delete ${rememberedTeam.name}?`,
      exact: true,
    })
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await expect(agentSheet).toHaveCount(0);
  await workspace.selectOption("");
  await expect(
    page.getByRole("button", { name: "Remove agent filter", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `Remove team filter: ${rememberedTeam.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `Remove team filter: ${teamB.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(card("Filter result 1-2")).toBeVisible();
  await capture("remembered-workspace-reconciles-deleted-team");
  const externalTeam = await fixture.api("/teams", {
    name: "External filter team",
    managerId: agents[0].id,
    members: [agents[2].id],
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await picker.click();
  await agentSheet
    .getByRole("button", { name: externalTeam.name, exact: true })
    .click();
  await search.fill(agents[0].name);
  await agentSheet
    .getByRole("button", { name: `@${agents[0].name}`, exact: true })
    .click();
  await agentSheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await fixture.api("/teams/" + externalTeam.id, undefined, "DELETE");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-workspace-change")),
  );
  await expect(
    page.getByRole("button", { name: "Remove agent filter", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `Remove team filter: ${externalTeam.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(card("Filter result 1-2")).toBeVisible();
  await capture("external-team-deletion-reconciles-agent");

  await page
    .getByRole("button", {
      name: `Remove team filter: ${teamB.name}`,
      exact: true,
    })
    .click();
  fixture.db
    .prepare("UPDATE conversations SET team_id=NULL WHERE id=?")
    .run(agents[1].id);
  await fixture.api("/agents/" + agents[1].id, { retired: true }, "PATCH");
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page
      .locator(".agent-strip")
      .getByRole("button", { name: new RegExp(`^@${agents[1].name} ·`) }),
  ).toHaveCount(0);
  await choose(agents[1]);
  await expect(card("Filter result 1-2")).toBeVisible();
  await capture("retired-agent-history");
  await fixture.api("/agents/" + agents[1].id, { retired: false }, "PATCH");

  // A conversation's project need not match its agent's current project.
  fixture.db
    .prepare("UPDATE conversations SET project_id=? WHERE id=?")
    .run(fixture.projects[0].id, agents[1].id);
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await workspace.selectOption(fixture.projects[0].id);
  await expect(
    page.locator(".agent-strip").getByRole("button", {
      name: new RegExp(`^@${agents[1].name} ·`),
    }),
  ).toHaveCount(0);
  await choose(agents[1]);
  await expect(card("Filter result 1-2")).toBeVisible();
  await capture("project-historical-agent");
  await workspace.selectOption("");
  fixture.db
    .prepare("UPDATE conversations SET project_id=NULL WHERE id=?")
    .run(agents[1].id);

  const approvalId = randomUUID(),
    decisionId = randomUUID();
  const actionRun = randomUUID();
  run.run(
    actionRun,
    fixture.owner,
    agents[0].id,
    agents[0].id,
    "Filter action run",
    actionRun,
    Date.now(),
    Date.now(),
  );
  fixture.db
    .prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?")
    .run(actionRun);

  fixture.db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,NULL,?,?)").run(
    approvalId,
    fixture.owner,
    actionRun,
    approvalId,
    JSON.stringify({
      type: "mcp_tool",
      tool: "filter_test",
      server: "Fixture",
      arguments: {},
      message: "Filter approval",
    }),
    "pending",
    Date.now(),
    Date.now() + 3600000,
  );
  fixture.db
    .prepare(
      "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,'fixture',?,?,'pending',?)",
    )
    .run(
      decisionId,
      actionRun,
      agents[0].id,
      decisionId,
      JSON.stringify({
        kind: "approval",
        title: "Filter native decision",
        choices: ["allow", "deny"],
      }),
      Date.now(),
    );
  const failedSend = await fixture.api("/scheduled-sends", {
    agentId: agents[0].id,
    input: "Filter failed scheduled send",
    idempotencyKey: randomUUID(),
    sendAt: Date.now() + 3600000,
  });
  fixture.db
    .prepare(
      "UPDATE scheduled_sends SET state='failed',error='Fixture failure' WHERE id=?",
    )
    .run(failedSend.id);
  const overflowRuns = [],
    overflowSends = [];
  fixture.db.transaction(() => {
    for (let i = 0; i < 201; i++) {
      const overflow = randomUUID();
      overflowRuns.push(overflow);
      run.run(
        overflow,
        fixture.owner,
        agents[2].id,
        agents[2].id,
        "Overflow active run",
        overflow,
        Date.now() + i,
        Date.now() + i,
      );
      fixture.db
        .prepare(
          "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
        )
        .run(overflow);
    }
    for (let i = 0; i < 101; i++) {
      const overflow = randomUUID();
      overflowSends.push(overflow);
      fixture.db
        .prepare(
          "INSERT INTO scheduled_sends(id,owner_id,agent_id,input,idempotency_key,send_at,state,created_at) VALUES(?,?,?,'Other agent failed send',?,?,'failed',?)",
        )
        .run(
          overflow,
          fixture.owner,
          agents[2].id,
          overflow,
          Date.now() + 7200000 + i,
          Date.now(),
        );
    }
  })();
  assert(
    !(await fixture.api("/runs?active=1")).some(
      (item) => item.id === actionRun,
    ),
  );
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await choose(agents[0]);
  const actionNeeds = page.getByRole("region", {
    name: "Needs you",
    exact: true,
  });
  await actionNeeds
    .getByRole("button", { name: "Show all", exact: true })
    .click();
  await expect(actionNeeds.locator(".approval-card")).toHaveCount(1);
  await expect(actionNeeds.locator(".scheduled-summary")).toContainText(
    "1 scheduled message not sent",
  );

  await expect(
    actionNeeds.getByText("Filter native decision", { exact: true }),
  ).toBeVisible();
  await expect(
    actionNeeds.getByText("Filter failed scheduled send", { exact: true }),
  ).toBeVisible();
  await choose(agents[1]);
  await expect(
    actionNeeds.locator(".approval-card, .native-decision, .scheduled-message"),
  ).toHaveCount(0);

  // An old agent's delayed next page cannot replace the new agent's cursor.
  for (let i = 0; i < 100; i++) {
    const overflow = randomUUID();
    overflowSends.push(overflow);
    fixture.db
      .prepare(
        "INSERT INTO scheduled_sends(id,owner_id,agent_id,input,idempotency_key,send_at,state,created_at) VALUES(?,?,?,'Agent A paging failure',?,?,'failed',?)",
      )
      .run(
        overflow,
        fixture.owner,
        agents[0].id,
        overflow,
        Date.now() + 7200000 + i,
        Date.now(),
      );
  }
  await choose(agents[0]);
  await actionNeeds
    .getByRole("button", { name: "Show all", exact: true })
    .click();
  let releaseOlder, olderStarted;
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  const olderReady = new Promise((resolve) => {
    olderStarted = resolve;
  });
  const olderPattern = (url) =>
    url.pathname === "/api/scheduled-sends" &&
    url.searchParams.get("agent") === agents[0].id &&
    url.searchParams.has("failedBefore");
  await page.route(
    olderPattern,
    async (route) => {
      const response = await route.fetch();
      olderStarted();
      await olderGate;
      await route.fulfill({ response }).catch(() => {});
    },
    { times: 1 },
  );
  await actionNeeds
    .getByRole("button", { name: "More not sent", exact: true })
    .click();
  await olderReady;
  await choose(agents[2]);
  await actionNeeds
    .getByRole("button", { name: "Show all", exact: true })
    .click();
  const moreFailures = actionNeeds.getByRole("button", {
    name: "More not sent",
    exact: true,
  });
  await expect(moreFailures).toBeEnabled();
  releaseOlder();
  await page.unrouteAll({ behavior: "wait" });
  await expect(moreFailures).toBeEnabled();
  await moreFailures.click();
  await expect(
    actionNeeds.locator("#scheduled-" + overflowSends[0]),
  ).toBeVisible();
  await expect(moreFailures).toHaveCount(0);

  fixture.db.transaction(() => {
    for (const id of overflowRuns)
      fixture.db.prepare("DELETE FROM runs WHERE id=?").run(id);
    for (const id of overflowSends)
      fixture.db.prepare("DELETE FROM scheduled_sends WHERE id=?").run(id);
  })();

  // A linked-source fixture deliberately reuses local agent and card IDs.
  // Selecting it must address that source without mixing local cached pages.
  let source = "docker:done-filters";
  let prefix = `/api/agent-sources/${encodeURIComponent(source)}/`;
  let sourceKind = "docker";
  let sourceAvailable = true;
  let peerActions = ["feedUnread"];
  const peerReadWrites = [];
  const localSummary = (await fixture.api("/feed?filter=needs")).summary;
  const localAgentSummary = (
    await fixture.api("/feed?filter=needs&agent=" + agents[0].id)
  ).summary;
  const remoteSummary = {
    ...localSummary,
    working: 2,
    queued: 3,
    replies_unread: 4,
    scheduled_failed: 2,
    scheduled_pending: 3,
  };
  let countSource = "all";
  const expectOperationalCounts = async () => {
    const badgeTotal = (summary) =>
      summary.working +
      summary.queued +
      (summary.replies_unread || 0) +
      (summary.done_unread || 0);
    const expectedBadge =
      countSource === "remote"
        ? badgeTotal(remoteSummary)
        : countSource === "local"
          ? badgeTotal(localAgentSummary)
          : badgeTotal(localSummary) + badgeTotal(remoteSummary);
    if (expectedBadge)
      await expect(
        page.locator('[aria-label$=" in Feed"]').first(),
      ).toHaveAttribute(
        "aria-label",
        `${expectedBadge} ${expectedBadge === 1 ? "item" : "items"} in Feed`,
      );
    else await expect(page.locator('[aria-label$=" in Feed"]')).toHaveCount(0);
    for (const [tab, field] of [
      ["working", "working"],
      ["queued", "queued"],
      ["replies", "replies_unread"],
    ]) {
      const count =
        countSource === "remote"
          ? remoteSummary[field]
          : countSource === "local"
            ? localAgentSummary[field] || 0
            : (localSummary[field] || 0) + remoteSummary[field];
      const badge = tabs.locator(`[data-filter="${tab}"] .chip-count`);
      if (count) await expect(badge).toHaveText(String(count));
      else await expect(badge).toHaveCount(0);
    }
  };
  await page.goto("about:blank");
  await page.route(
    (url) => url.pathname === "/api/agent-sources",
    (route) =>
      route.fulfill({
        json: sourceAvailable
          ? [{ id: source, name: "Filter fixture", kind: sourceKind }]
          : [],
      }),
  );
  await page.route(
    (url) => url.pathname.startsWith(prefix),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(prefix.length);
      if (
        sourceKind === "peer" &&
        /\/read$/.test(path) &&
        ["PUT", "DELETE"].includes(route.request().method())
      ) {
        peerReadWrites.push(path);
        return route.fulfill({ status: 409, json: { error: "Read only" } });
      }
      // Model an older linked source: the initial page route is absent,
      // while its legacy destination list remains readable.
      if (path === "feed/threads/page" && sourceKind !== "peer")
        return route.fulfill({ status: 404, json: { error: "Not found" } });
      if (path === "feed/threads" && sourceKind !== "peer")
        return route.fulfill({ json: [] });
      if (path === "feed/agent-threads")
        return route.fulfill({ json: { items: [], next: null } });
      url.pathname = "/api/" + path;
      if (path === "feed") url.searchParams.delete("known");
      const response = await route.fetch({ url: url.href }).catch(() => null);
      if (!response) return route.abort().catch(() => {});
      if (path === "capabilities")
        return route.fulfill({
          response,
          json: {
            ...(await response.json()),
            fleet: {
              version: 1,
              machineId: source.slice(5),
              reads: ["feed", "cardList", "cardChanges", "cardDetail"],
              actions: peerActions,
              files: false,
              events: false,
            },
          },
        });
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
  countSource = "remote";
  await choose(agents[0], "Filter fixture");
  await status("Unread").click();
  await expect(card("Remote Filter result 0-81")).toBeVisible();
  await expect(card("Filter result 0-81")).toHaveCount(0);
  await expectOperationalCounts();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(card("Remote Filter result 0-1")).toHaveCount(1);
  countSource = "local";
  await choose(agents[0]);
  await expect(card("Filter result 0-81")).toBeVisible();
  await expect(card("Remote Filter result 0-81")).toHaveCount(0);
  await expectOperationalCounts();
  // Updates from another source cannot change the selected source counts.
  remoteSummary.working = 5;
  await page.evaluate((source) => {
    window.dispatchEvent(
      new CustomEvent("loop-workspace-change", {
        detail: { sources: [source] },
      }),
    );
  }, source);
  await expectOperationalCounts();
  await page
    .getByRole("button", { name: "Remove agent filter", exact: true })
    .click();
  const needs = page.getByRole("region", { name: "Needs you", exact: true });
  await needs.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(needs.locator(".scheduled-summary")).toContainText(
    `${(localSummary.scheduled_failed || 0) + remoteSummary.scheduled_failed} scheduled messages not sent`,
  );
  await needs.getByRole("button", { name: "Collapse", exact: true }).click();
  countSource = "remote";
  await choose(agents[0], "Filter fixture");
  await expect(card("Remote Filter result 0-1")).toHaveCount(1);
  await expect(card("Filter result 0-81")).toHaveCount(0);
  await expectOperationalCounts();
  await expect(
    needs.locator(".approval-card, .native-decision, .scheduled-message"),
  ).toHaveCount(0);
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

  // This fixture grants individual-result unread but no group-unread action.
  // The menu must respect that destination catalog for both kinds of result.
  await page.goto("about:blank");
  source = "peer:m_" + "b".repeat(64);
  prefix = `/api/agent-sources/${encodeURIComponent(source)}/`;
  sourceKind = "peer";
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  countSource = "remote";
  await choose(agents[0], "Filter fixture");
  await openActions("Mixed agent results");
  const unreadAction = page.getByRole("menuitem", {
    name: "Mark unread",
    exact: true,
  });
  await expect(unreadAction).toBeDisabled();
  await expect(unreadAction).toContainText("does not allow this operation");
  await closeReader();
  await openActions("Remote Filter result 0-83");
  await expect(unreadAction).toBeEnabled();
  await closeReader();
  // A read-only or older peer can still show results without allowing unread.
  peerActions = [];
  await page.reload({ waitUntil: "networkidle" });
  countSource = "remote";
  await choose(agents[0], "Filter fixture");
  await openActions("Remote Filter result 0-83");
  await expect(unreadAction).toBeDisabled();
  await expect(unreadAction).toContainText("does not allow this operation");
  await capture("peer-unread-unavailable");
  await closeReader();
  await card("Remote Filter result 0-83").getByRole("heading").click();
  await expect(page.locator(".feed-reading-sheet")).toContainText(
    "Answer for filter result 0-83",
  );
  await page.waitForTimeout(150);
  assert.deepEqual(peerReadWrites, []);
  await closeReader();
  sourceAvailable = false;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-source-refresh")),
  );
  await expect(
    page.getByRole("button", { name: "Remove agent filter" }),
  ).toContainText("Unavailable agent");
  await expect(page.getByText("No results match these filters.")).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".collection-read-error")).toHaveCount(0);
  sourceAvailable = true;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-source-refresh")),
  );
  await expect(card("Remote Filter result 0-83")).toBeVisible();

  // Team creation navigates to a local team and clears the remote selection.
  await picker.click();
  await agentSheet
    .getByRole("button", { name: "Manage teams", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Manage teams", exact: true })
    .getByRole("button", { name: "New team", exact: true })
    .click();
  const createTeam = page.locator("dialog[open]").last();
  await createTeam
    .getByLabel("Team name", { exact: true })
    .fill("Created from remote filter");
  await createTeam
    .getByRole("combobox", { name: "Manager", exact: true })
    .selectOption(agents[0].id);
  await createTeam
    .getByRole("checkbox", { name: new RegExp(`@${agents[1].name}`) })
    .check();
  await createTeam
    .getByRole("button", { name: "Create team & talk to manager", exact: true })
    .click();
  await expect(page.locator(".conversation-sheet")).toBeVisible();
  await closeReader();
  await expect(
    page.getByRole("button", { name: "Remove agent filter" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Remove team filter: Created from remote filter",
    }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: /^Working/ }).click();
  await expect(page.locator(".feed-loading")).toHaveCount(0);
  await expect(page.locator(".collection-read-error")).toHaveCount(0);
  await tabs.getByRole("tab", { name: /^Done/ }).click();
  await expect(page.locator(".feed-loading")).toHaveCount(0);
  await expect(page.locator(".collection-read-error")).toHaveCount(0);
  await capture("created-team-clears-remote-agent");
  // Finish background projection callbacks before the runner closes the page.
  await page.unrouteAll({ behavior: "wait" });
}
