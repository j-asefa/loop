import {
  chooseAgentConnection,
  openAgentModelOptions,
} from "./agent-model-options.mjs";
import { sourceConversationBrowser } from "./source-conversation-browser.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

// Exercises the production Feed and creation form with two independent API
// sources. Fixture adapter IDs do not claim enrolled fleet capabilities.
// Browser routes simulate source responses; fleet-agent-source.test.ts
// covers paired gateway forwarding.
export async function agentSourcesBrowser(page, workspaceUrl) {
  const now = Date.now();
  const computer = "Alex’s MacBook Pro";
  const localIds = {
    agent: randomUUID(),
    owner: randomUUID(),
    connection: randomUUID(),
    conversation: randomUUID(),
    message: randomUUID(),
  };
  const sources = [
    {
      id: `fixture:${"a".repeat(64)}`,
      name: "Docker · Alpha",
      kind: "fixture",
    },
    { id: "fixture:beta", name: "Cloud · Beta", kind: "fixture" },
  ];
  const records = new Map(
    sources.map((source, index) => {
      const agent = {
        id: randomUUID(),
        owner_id: randomUUID(),
        name: `remote-${index}`,
        provider: "codex",
        connection_id: randomUUID(),
        model: "gpt-5.5",
        instructions: "",
        folder_id: null,
        origin: "direct",
        retired_at: null,
        created_at: now - index,
      };
      const connection = {
        id: agent.connection_id,
        owner_id: agent.owner_id,
        provider: "codex",
        label: `Account ${index}`,
        secret: "",
        status: "connected",
        models: JSON.stringify([{ id: "gpt-5.5", name: "GPT-5.5" }]),
        metadata: JSON.stringify({
          authMode: "subscription",
          environmentName: source.name,
          location: index === 0 ? "docker" : "cloud",
        }),
        created_at: now,
      };
      const thread = {
        // Deliberate collision with the laptop: source must qualify identity.
        conversation_id: index === 0 ? localIds.conversation : randomUUID(),
        title: `Remote thread ${index}`,
        agent_id: agent.id,
        connection_id: agent.connection_id,
        agent_name: agent.name,
        provider: agent.provider,
        project_id: null,
        project_name: null,
        team_id: null,
        origin: "direct",
        last_activity_at: now + index,
        last_message: {
          id: randomUUID(),
          role: "assistant",
          preview: `Answer from ${source.name}`,
          created_at: now + index,
        },
        run: null,
        pending_approvals: 0,
        position_message_id: null,
        later: null,
      };
      return [source.id, { agent, connection, thread }];
    }),
  );
  const local = {
    agent: {
      id: localIds.agent,
      owner_id: localIds.owner,
      name: "laptop-agent",
      provider: "codex",
      connection_id: localIds.connection,
      model: "gpt-5.5",
      instructions: "",
      folder_id: null,
      origin: "direct",
      retired_at: null,
      created_at: now - 100,
    },
    connection: {
      id: localIds.connection,
      owner_id: localIds.owner,
      provider: "codex",
      label: "Codex",
      secret: "",
      status: "connected",
      models: JSON.stringify([{ id: "gpt-5.5", name: "GPT-5.5" }]),
      metadata: JSON.stringify({
        authMode: "subscription",
        environmentName: "This computer",
        location: "laptop",
      }),
      created_at: now,
    },
    thread: {
      conversation_id: localIds.conversation,
      title: "Laptop thread",
      agent_id: localIds.agent,
      connection_id: localIds.connection,
      agent_name: "laptop-agent",
      provider: "codex",
      project_id: null,
      project_name: null,
      team_id: null,
      origin: "direct",
      last_activity_at: now - 100,
      last_message: {
        id: localIds.message,
        role: "assistant",
        preview: "Answer from laptop",
        created_at: now - 100,
      },
      run: null,
      pending_approvals: 0,
      position_message_id: null,
      later: null,
    },
  };
  const fulfill = (route, value) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  let discoveryFailed = false,
    discoveryMissing = false,
    discoveryEmpty = false,
    discoveryHung = false,
    sourceFailed = false;
  let failedDiscoveryReads = 0;
  let missingDiscoveryReads = 0;
  const hung = [];
  const unavailable = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture connection interrupted" }),
    });
  const list = (route) => {
    // A black-holed tunnel: the request stays open until the fixture ends.
    if (discoveryHung) return new Promise((resolve) => hung.push(resolve));
    if (discoveryMissing) {
      missingDiscoveryReads++;
      return route.fulfill({ status: 404, body: "{}" });
    }
    if (discoveryFailed) {
      failedDiscoveryReads++;
      return unavailable(route);
    }
    return fulfill(route, discoveryEmpty ? [] : sources);
  };
  const visible = (route, thread) =>
    ["needs", "queued"].includes(
      new URL(route.request().url()).searchParams.get("filter"),
    )
      ? []
      : [thread];
  const localBootstrap = (route) =>
    fulfill(route, {
      environmentName: computer,
      agents: [local.agent],
      connections: [local.connection],
      folders: [],
      teams: [],
    });
  let holdNextFeed = null;
  let releaseFeed = () => {};
  const localFeed = async (route) => {
    const hold = holdNextFeed;
    holdNextFeed = null;
    if (hold) await hold();
    return fulfill(route, {
      items: visible(route, local.thread),
      next: null,
      summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
    });
  };
  const cards = (route, record) => {
    const { thread, agent } = record;
    const id = "d:message:" + thread.last_message.id;
    const entry = {
      card: {
        type: "done",
        id,
        display: {
          ...thread,
          done_card_key: "message:" + thread.last_message.id,
          last_message: {
            ...thread.last_message,
            content: `Full reading view for ${agent.name}`,
            saved: false,
          },
          pull: null,
          next_action: null,
        },
        content: `Full reading view for ${agent.name}`,
        format: "markdown",
        created_at: thread.last_activity_at,
        updated_at: null,
        saved: false,
        attachments: [],
        href: "/?conversation=" + thread.conversation_id,
        author: {
          kind: "agent",
          id: agent.id,
          name: agent.name,
          provider: agent.provider,
        },
        recipient: null,
        source: {
          artifact_id: null,
          message_id: thread.last_message.id,
          conversation_id: thread.conversation_id,
          run_id: null,
          agent_id: agent.id,
        },
        context: {
          conversation_title: thread.title,
          folder_id: null,
          project_id: null,
          project_name: null,
          team_id: null,
        },
      },
      order: [thread.last_activity_at, id],
      saved: null,
    };
    return fulfill(route, {
      revision: "source-fixture",
      items: [entry],
      ...(new URL(route.request().url()).pathname.endsWith("/changes")
        ? { removed: [], more: false }
        : { next: null }),
    });
  };
  const localCards = (route) => cards(route, local);
  const uploads = [];
  const creations = [];
  const detail = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = /^\/api\/agent-sources\/([^/]+)\/(.+)$/.exec(path);
    const record = match && records.get(decodeURIComponent(match[1]));
    if (!record) return route.fulfill({ status: 404, body: "{}" });
    if (sourceFailed && decodeURIComponent(match[1]) === sources[0].id)
      return unavailable(route);
    // A source page checks its own capabilities and session; the fixture
    // sources answer as the paired owner.
    if (/^(capabilities|auth\/get-session|me\/profile)/.test(match[2])) {
      const url = new URL(route.request().url());
      url.pathname = "/api/" + match[2].split("?")[0];
      return route.fulfill({
        response: await route.fetch({ url: url.toString() }),
      });
    }
    if (match[2] === "bootstrap")
      return fulfill(route, {
        environmentName: JSON.parse(record.connection.metadata).environmentName,
        agents: [record.agent],
        connections: [record.connection],
        folders: [],
        teams: [],
      });
    if (match[2] === "uploads") {
      const file = {
        id: randomUUID(),
        objectId: randomUUID(),
        name: `attachment-${uploads.length}.txt`,
        mime: "text/plain",
        size: 5,
      };
      uploads.push({ source: decodeURIComponent(match[1]), file });
      return fulfill(route, file);
    }
    if (match[2].startsWith("objects/"))
      return route.fulfill({ contentType: "text/plain", body: "hello" });
    if (match[2] === "agents" && route.request().method() === "POST") {
      creations.push({
        source: decodeURIComponent(match[1]),
        ...route.request().postDataJSON(),
      });
      // Keep the form open to test retries without dispatching a real run.
      return unavailable(route);
    }
    if (match[2] === "v1/cards" || match[2] === "v1/cards/changes")
      return cards(route, record);
    if (match[2] === "feed/agent-threads")
      return fulfill(route, { items: [], next: null });
    if (match[2] === "runs") return fulfill(route, []);
    if (match[2] === "feed")
      return fulfill(route, {
        items: visible(route, record.thread),
        next: null,
        summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
      });
    return route.fulfill({ status: 404, body: "{}" });
  };
  await page.route("**/api/agent-sources", list);
  await page.route("**/api/agent-sources/**", detail);
  await page.route("**/api/bootstrap", localBootstrap);
  await page.route("**/api/feed?*", localFeed);
  await page.route("**/api/v1/cards?*", localCards);
  await page.route("**/api/v1/cards/changes?*", localCards);
  try {
    await page.goto(workspaceUrl);
    const strip = page.getByRole("region", {
      name: "Your agents",
      exact: true,
    });
    await expect(
      strip.getByRole("button", { name: /@remote-0/ }),
    ).toContainText("Docker · Alpha");
    await expect(
      strip.getByRole("button", { name: /@remote-1/ }),
    ).toContainText("Cloud · Beta");
    await expect(
      strip.getByRole("button", { name: /@laptop-agent/ }),
    ).toContainText(computer);
    await expect(
      page
        .locator(".feed-item-card")
        .filter({ hasText: "Laptop thread" })
        .locator(".card-environment"),
    ).toHaveText(computer);
    await expect(
      page.locator(".feed-row").filter({ hasText: "Laptop thread" }),
    ).toBeVisible();
    await expect(
      page.locator(".feed-row").filter({ hasText: "Remote thread 0" }),
    ).toBeVisible();
    await expect(
      page.locator(".feed-row").filter({ hasText: "Remote thread 1" }),
    ).toBeVisible();
    await expect(
      page.locator(".card-environment").filter({ hasText: "Docker · Alpha" }),
    ).toBeVisible();
    await expect(
      page.locator(".card-environment").filter({ hasText: "Cloud · Beta" }),
    ).toBeVisible();
    assert.equal(
      await page.getByLabel("Workspace", { exact: true }).count(),
      0,
    );
    // A transient discovery/read failure retains both agent and thread DOM.
    await page
      .locator(".feed-row")
      .filter({ hasText: "Remote thread 0" })
      .evaluate((el) => {
        el.dataset.retained = "yes";
      });
    // Keep an older successful Feed pass in flight while the explicit refresh
    // arrives. Previously the Feed dropped that event and never read the
    // failing source, depending on timing in Chromium CI.
    const feedStarted = new Promise((started) => {
      holdNextFeed = () =>
        new Promise((release) => {
          releaseFeed = release;
          started();
        });
    });
    const remoteReads = sources.map((source) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname ===
            `/api/agent-sources/${encodeURIComponent(source.id)}/feed` &&
          response.ok()
        );
      }),
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-later-change")),
    );
    await Promise.all([feedStarted, ...remoteReads]);
    discoveryFailed = true;
    sourceFailed = true;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("loop-source-refresh"));
      window.dispatchEvent(new Event("loop-later-change"));
    });
    // Discovery and then source metadata each exhaust the existing 2s/4s
    // transient retries before the combined projection publishes its warning.
    await expect(
      page.getByText(
        "Connection check unavailable. Showing your last connected environments.",
      ),
    ).toBeVisible({ timeout: 20_000 });
    assert.equal(failedDiscoveryReads, 3);
    await expect(page.locator('.feed-row[data-retained="yes"]')).toBeVisible();
    await expect(
      strip.getByRole("button", { name: /@remote-0/ }),
    ).toBeVisible();
    await expect(
      page.getByText(/Some environments could not refresh/),
    ).toBeVisible();
    releaseFeed();
    discoveryFailed = false;
    sourceFailed = false;
    // Retry reloads both the agent sources and the Feed threads it explains.
    await page
      .getByRole("status")
      .filter({ hasText: "Connection check unavailable" })
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect(
      page.getByText(
        "Connection check unavailable. Showing your last connected environments.",
      ),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Some environments could not refresh/),
    ).toHaveCount(0);

    // Empty Queued is loaded content. Observe every DOM mutation across
    // refreshes so even a brief skeleton flash fails this regression.
    await page.getByRole("tab", { name: /^Queued/ }).click();
    await expect(page.locator(".feed-row")).toHaveCount(0);
    await expect(page.locator(".feed-loading")).toHaveCount(0);
    await page.evaluate(() => {
      window.__feedFlashes = 0;
      window.__feedObserver = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (
              node.nodeType === 1 &&
              (node.matches(".feed-loading") ||
                node.querySelector(".feed-loading"))
            )
              window.__feedFlashes++;
      });
      window.__feedObserver.observe(document.querySelector(".feed-view"), {
        childList: true,
        subtree: true,
      });
    });
    for (let i = 0; i < 3; i++) {
      const updated = page.waitForResponse((r) =>
        r.url().includes("/api/feed?filter=queued"),
      );
      await page.evaluate(() =>
        window.dispatchEvent(new Event("loop-later-change")),
      );
      await updated;
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    }
    assert.equal(
      await page.evaluate(() => {
        window.__feedObserver.disconnect();
        return window.__feedFlashes;
      }),
      0,
    );
    await page.getByRole("tab", { name: /^Done\b/ }).click();
    await strip.getByRole("button", { name: "New agent" }).click();
    await page
      .getByRole("dialog", { name: "New chat", exact: true })
      .getByText("Customize", { exact: true })
      .click();
    await openAgentModelOptions(page);
    const destinations = page.getByRole("radiogroup", {
      name: "Connection",
      exact: true,
    });
    await expect(destinations).toContainText("Docker · Alpha");
    await expect(destinations).toContainText("Cloud · Beta");
    await expect(destinations).toContainText(computer);
    const sheet = page.getByRole("dialog", { name: "New chat" });
    const dockerRunner = {
      source: sources[0].id,
      id: records.get(sources[0].id).connection.id,
    };
    await chooseAgentConnection(sheet, dockerRunner);
    await sheet.getByLabel("Unique name").fill("docker-files");
    await sheet
      .getByLabel("Opening message", { exact: true })
      .fill("Read these files");
    await expect(
      sheet.getByRole("button", { name: "Add attachments", exact: true }),
    ).toBeEnabled();
    await sheet.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "brief.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(
      sheet.getByRole("list", { name: "Attached files" }),
    ).toContainText("attachment-0.txt");
    assert.equal(uploads[0].source, sources[0].id);
    await sheet
      .getByRole("button", { name: "Preview attachment-0.txt" })
      .click();
    await expect(page.locator(".file-preview-content pre")).toHaveText("hello");
    await page
      .locator("dialog[open]")
      .last()
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await chooseAgentConnection(sheet, { source: "", id: local.connection.id });
    await expect(sheet.locator(".connection-details")).toContainText(computer);
    await expect(sheet).not.toContainText("This computer");
    await expect(
      sheet.getByRole("button", { name: "Start chatting" }),
    ).toBeDisabled();
    await expect(
      sheet.getByRole("button", { name: "Add attachments", exact: true }),
    ).toBeDisabled();
    await chooseAgentConnection(sheet, dockerRunner);
    await sheet.getByRole("button", { name: "Start chatting" }).click();
    await expect(sheet.getByRole("alert")).toContainText(
      "Fixture connection interrupted",
    );
    assert.deepEqual(creations[0].attachmentIds, [uploads[0].file.id]);
    assert.equal(creations[0].source, sources[0].id);
    await sheet.getByRole("button", { name: "Start chatting" }).click();
    await expect.poll(() => creations.length).toBe(2);
    assert.equal(creations[0].idempotencyKey, creations[1].idempotencyKey);

    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => history.state?.loopSheet !== true);

    // A connected Codex account must not hide setup for another provider on
    // that same remote source. Follow the real navigation and return to creation.
    await strip.getByRole("button", { name: "New agent" }).click();
    await openAgentModelOptions(sheet);
    await sheet.getByText("More connection options", { exact: true }).click();
    for (const source of sources)
      await expect(
        sheet.getByRole("button", {
          name: `Connect on ${source.name}`,
          exact: true,
        }),
      ).toBeVisible();
    const setupNavigation = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        request.isNavigationRequest() &&
        url.searchParams.get("source") === sources[0].id &&
        url.searchParams.get("connect") === "1"
      );
    });
    await sheet
      .getByRole("button", {
        name: `Connect on ${sources[0].name}`,
        exact: true,
      })
      .click();
    await setupNavigation;
    const settings = page.getByRole("dialog", {
      name: "Provider connections",
      exact: true,
    });
    await expect(settings).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("source"), sources[0].id);
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toBeVisible();
    await openAgentModelOptions(sheet);
    await expect(
      sheet.getByRole("radiogroup", {
        name: "Connection",
        exact: true,
      }),
    ).toContainText(sources[0].name);
    await page.goto(workspaceUrl);

    await sourceConversationBrowser(page, workspaceUrl, {
      sources,
      records,
      local,
      fulfill,
      unavailable,
    });

    // On a Docker source page, the laptop's empty source id still means the
    // laptop: opening its card leaves the Docker source.
    const dockerPage = new URL(workspaceUrl);
    dockerPage.searchParams.set("source", sources[0].id);
    await page.goto(dockerPage.toString());
    await page
      .locator(".feed-row")
      .filter({ hasText: "Laptop thread" })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("source"), sources[0].id);
    await page
      .locator(".feed-item-card")
      .filter({ hasText: "Laptop thread" })
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(local.thread.conversation_id);
    assert.equal(new URL(page.url()).searchParams.get("source"), null);

    // A hung discovery request times out instead of blocking later refreshes.
    await page.goto(workspaceUrl);
    await expect(
      strip.getByRole("button", { name: /@remote-0/ }),
    ).toBeVisible();
    discoveryHung = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect.poll(() => hung.length).toBe(1);
    discoveryHung = false;
    // A missing discovery endpoint is an error, not an empty source list.
    discoveryMissing = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-source-refresh")),
    );
    await expect
      .poll(() => missingDiscoveryReads, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(
      page.getByText(
        "Connection check unavailable. Showing your last connected environments.",
      ),
    ).toBeVisible();
    await expect(
      strip.getByRole("button", { name: /@remote-0/ }),
    ).toBeVisible();
    // Only a successful empty discovery response removes known sources.
    discoveryMissing = false;
    discoveryEmpty = true;
    await page
      .getByRole("status")
      .filter({ hasText: "Connection check unavailable" })
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await expect(strip.getByRole("button", { name: /@remote-0/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByText(
        "Connection check unavailable. Showing your last connected environments.",
      ),
    ).toHaveCount(0);
    await expect(
      strip.getByRole("button", { name: /@laptop-agent/ }),
    ).toBeVisible();
  } finally {
    releaseFeed();
    for (const release of hung.splice(0)) release();
    await page.unroute("**/api/agent-sources", list);
    await page.unroute("**/api/agent-sources/**", detail);
    await page.unroute("**/api/bootstrap", localBootstrap);
    await page.unroute("**/api/feed?*", localFeed);
    await page.unroute("**/api/v1/cards?*", localCards);
    await page.unroute("**/api/v1/cards/changes?*", localCards);
  }
}
