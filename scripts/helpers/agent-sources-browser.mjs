import { sourceConversationBrowser } from "./source-conversation-browser.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Exercises the production Feed and creation form with two independent API
// sources. The browser routes stand in for linked hosts; gateway forwarding is
// covered separately by linked-docker.node.test.ts.
export async function agentSourcesBrowser(page, workspaceUrl) {
  const now = Date.now();
  const sources = [
    { id: `docker:${"a".repeat(64)}`, name: "Docker · Alpha", kind: "docker" },
    { id: "cloud:beta", name: "Cloud · Beta", kind: "cloud" },
  ];
  const records = new Map(
    sources.map((source, index) => {
      const agent = {
        id: `remote-agent-${index}`,
        owner_id: `remote-owner-${index}`,
        name: `remote-${index}`,
        provider: "codex",
        connection_id: `remote-connection-${index}`,
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
        }),
        created_at: now,
      };
      const thread = {
        // Deliberate collision with the laptop: source must qualify identity.
        conversation_id: index === 0 ? "laptop-thread" : `remote-thread-${index}`,
        title: `Remote thread ${index}`,
        agent_id: agent.id,
        agent_name: agent.name,
        provider: agent.provider,
        project_id: null,
        project_name: null,
        team_id: null,
        origin: "direct",
        last_activity_at: now + index,
        last_message: {
          id: `remote-message-${index}`,
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
      id: "laptop-agent",
      owner_id: "laptop-owner",
      name: "laptop-agent",
      provider: "codex",
      connection_id: "laptop-connection",
      model: "gpt-5.5",
      instructions: "",
      folder_id: null,
      origin: "direct",
      retired_at: null,
      created_at: now - 100,
    },
    connection: {
      id: "laptop-connection",
      owner_id: "laptop-owner",
      provider: "codex",
      label: "This laptop · Codex",
      secret: "",
      status: "connected",
      models: JSON.stringify([{ id: "gpt-5.5", name: "GPT-5.5" }]),
      metadata: JSON.stringify({
        authMode: "subscription",
        environmentName: "This laptop",
      }),
      created_at: now,
    },
    thread: {
      conversation_id: "laptop-thread",
      title: "Laptop thread",
      agent_id: "laptop-agent",
      agent_name: "laptop-agent",
      provider: "codex",
      project_id: null,
      project_name: null,
      team_id: null,
      origin: "direct",
      last_activity_at: now - 100,
      last_message: {
        id: "laptop-message",
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
    discoveryHung = false,
    sourceFailed = false;
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
    if (discoveryMissing) return route.fulfill({ status: 404, body: "{}" });
    return discoveryFailed ? unavailable(route) : fulfill(route, sources);
  };
  const visible = (route, thread) =>
    new URL(route.request().url()).searchParams.get("filter") === "needs"
      ? []
      : [thread];
  const localBootstrap = (route) =>
    fulfill(route, {
      agents: [local.agent],
      connections: [local.connection],
      folders: [],
      teams: [],
    });
  let holdNextInbox = null;
  let releaseInbox = () => {};
  const localInbox = async (route) => {
    const hold = holdNextInbox;
    holdNextInbox = null;
    if (hold) await hold();
    return fulfill(route, {
      items: visible(route, local.thread),
      next: null,
      summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
    });
  };
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
        agents: [record.agent],
        connections: [record.connection],
        folders: [],
        teams: [],
      });
    if (match[2] === "uploads") {
      const file = {
        id: `uploaded-${uploads.length}`,
        objectId: `object-${uploads.length}`,
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
      creations.push({ source: decodeURIComponent(match[1]), ...route.request().postDataJSON() });
      // Keep the form open to test retries without dispatching a real run.
      return unavailable(route);
    }
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
  await page.route("**/api/feed?*", localInbox);
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
    ).toContainText("This laptop");
    await expect(
      page.locator(".inbox-row").filter({ hasText: "Laptop thread" }),
    ).toBeVisible();
    await expect(
      page.locator(".inbox-row").filter({ hasText: "Remote thread 0" }),
    ).toBeVisible();
    await expect(
      page.locator(".inbox-row").filter({ hasText: "Remote thread 1" }),
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
      .locator(".inbox-row")
      .filter({ hasText: "Remote thread 0" })
      .evaluate((el) => {
        el.dataset.retained = "yes";
      });
    // Keep an older successful Feed pass in flight while the explicit refresh
    // arrives. Previously the Feed dropped that event and never read the
    // failing source, depending on timing in Chromium CI.
    const inboxStarted = new Promise((started) => {
      holdNextInbox = () => new Promise((release) => {
        releaseInbox = release;
        started();
      });
    });
    const remoteReads = sources.map((source) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname ===
          `/api/agent-sources/${encodeURIComponent(source.id)}/feed` &&
          response.ok();
      }),
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-later-change")),
    );
    await Promise.all([inboxStarted, ...remoteReads]);
    discoveryFailed = true;
    sourceFailed = true;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("loop-source-refresh"));
      window.dispatchEvent(new Event("loop-later-change"));
    });
    await expect(
      page.getByText(
        "Connection check unavailable. Showing your last connected environments.",
      ),
    ).toBeVisible();
    await expect(page.locator('.inbox-row[data-retained="yes"]')).toBeVisible();
    await expect(
      strip.getByRole("button", { name: /@remote-0/ }),
    ).toBeVisible();
    await expect(
      page.getByText(/Some environments could not refresh/),
    ).toBeVisible();
    releaseInbox();
    discoveryFailed = false;
    sourceFailed = false;
    // Retry reloads both the agent sources and the Feed threads it explains.
    await page
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

    // Empty Needs you is loaded content. Observe every DOM mutation across
    // refreshes so even a brief skeleton flash fails this regression.
    await page.getByRole("tab", { name: /^Needs you/ }).click();
    await expect(page.locator(".inbox-row")).toHaveCount(0);
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
      window.__feedObserver.observe(document.querySelector(".inbox"), {
        childList: true,
        subtree: true,
      });
    });
    for (let i = 0; i < 3; i++) {
      const updated = page.waitForResponse((r) =>
        r.url().includes("/api/feed?filter=needs"),
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
    await page.getByRole("tab", { name: "Done", exact: true }).click();
    await strip.getByRole("button", { name: "New agent" }).click();
    const destinations = page
      .getByRole("dialog", { name: "Meet your next agent" })
      .getByLabel("Run on");
    await expect(destinations).toContainText("Docker · Alpha");
    await expect(destinations).toContainText("Cloud · Beta");
    await expect(destinations).toContainText("This laptop");
    const sheet = page.getByRole("dialog", { name: "Meet your next agent" });
    const dockerRunner = `${sources[0].id}:remote-connection-0`;
    await destinations.selectOption(dockerRunner);
    await sheet.getByLabel("Unique name").fill("docker-files");
    await sheet.getByLabel("Initial prompt", { exact: true }).fill("Read these files");
    await expect(sheet.getByRole("button", { name: "Add attachments", exact: true })).toBeEnabled();
    await sheet.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("hello"),
    });
    await expect(sheet.getByRole("list", { name: "Attached files" })).toContainText("attachment-0.txt");
    assert.equal(uploads[0].source, sources[0].id);
    await sheet.getByRole("button", { name: "Preview attachment-0.txt" }).click();
    await expect(page.locator(".file-preview-content pre")).toHaveText("hello");
    await page.locator("dialog[open]").last().getByRole("button", { name: "Close", exact: true }).click();
    await destinations.selectOption("laptop:laptop-connection");
    await expect(sheet.getByRole("button", { name: "Create & start" })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Add attachments", exact: true })).toBeDisabled();
    await destinations.selectOption(dockerRunner);
    await sheet.getByRole("button", { name: "Create & start" }).click();
    await expect(sheet.getByRole("alert")).toContainText("Fixture connection interrupted");
    assert.deepEqual(creations[0].attachmentIds, [uploads[0].file.id]);
    assert.equal(creations[0].source, sources[0].id);
    await sheet.getByRole("button", { name: "Create & start" }).click();
    await expect.poll(() => creations.length).toBe(2);
    assert.equal(creations[0].idempotencyKey, creations[1].idempotencyKey);

    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => history.state?.loopSheet !== true);
    await sourceConversationBrowser(page, workspaceUrl, { sources, records, local, fulfill, unavailable });

    // On a Docker source page, the laptop's empty source id still means the
    // laptop: opening its card leaves the Docker source.
    const dockerPage = new URL(workspaceUrl);
    dockerPage.searchParams.set("source", sources[0].id);
    await page.goto(dockerPage.toString());
    await page
      .locator(".inbox-row")
      .filter({ hasText: "Laptop thread" })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("source"), sources[0].id);
    await page
      .locator(".inbox-row")
      .filter({ hasText: "Laptop thread" })
      .getByRole("button", { name: /Open thread/ })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe("laptop-thread");
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
    // The workspace no longer lists linked sources: stop showing them.
    discoveryMissing = true;
    await expect(async () => {
      await page.evaluate(() =>
        window.dispatchEvent(new Event("loop-source-refresh")),
      );
      await expect(
        strip.getByRole("button", { name: /@remote-0/ }),
      ).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(
      strip.getByRole("button", { name: /@laptop-agent/ }),
    ).toBeVisible();
  } finally {
    releaseInbox();
    for (const release of hung.splice(0)) release();
    await page.unroute("**/api/agent-sources", list);
    await page.unroute("**/api/agent-sources/**", detail);
    await page.unroute("**/api/bootstrap", localBootstrap);
    await page.unroute("**/api/feed?*", localInbox);
  }
}
