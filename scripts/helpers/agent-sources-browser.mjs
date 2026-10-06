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
          backend: "hapi",
          environmentName: source.name,
        }),
        created_at: now,
      };
      const thread = {
        conversation_id: `remote-thread-${index}`,
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
        backend: "hapi",
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
  const list = (route) => fulfill(route, sources);
  const localBootstrap = (route) =>
    fulfill(route, {
      agents: [local.agent],
      connections: [local.connection],
      folders: [],
      teams: [],
    });
  const localInbox = (route) =>
    fulfill(route, {
      items: [local.thread],
      next: null,
      summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
    });
  const detail = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = /^\/api\/agent-sources\/([^/]+)\/(.+)$/.exec(path);
    const record = match && records.get(decodeURIComponent(match[1]));
    if (!record) return route.fulfill({ status: 404, body: "{}" });
    // A source page checks its own capabilities and session; the fixture
    // sources answer as the paired owner.
    if (/^(capabilities|auth\/get-session|me\/profile)/.test(match[2])) {
      const url = new URL(route.request().url());
      url.pathname = "/api/" + match[2].split("?")[0];
      return route.fulfill({ response: await route.fetch({ url: url.toString() }) });
    }
    if (match[2] === "bootstrap")
      return fulfill(route, {
        agents: [record.agent],
        connections: [record.connection],
        folders: [],
        teams: [],
      });
    if (match[2] === "runs") return fulfill(route, []);
    if (match[2] === "inbox")
      return fulfill(route, {
        items: [record.thread],
        next: null,
        summary: { needs: 0, working: 0, queued: 0, later_due: 0 },
      });
    return route.fulfill({ status: 404, body: "{}" });
  };
  await page.route("**/api/agent-sources", list);
  await page.route("**/api/agent-sources/**", detail);
  await page.route("**/api/bootstrap", localBootstrap);
  await page.route("**/api/inbox?*", localInbox);
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
    await strip.getByRole("button", { name: "New agent" }).click();
    const destinations = page
      .getByRole("dialog", { name: "Meet your next agent" })
      .getByLabel("Run on");
    await expect(destinations).toContainText("Docker · Alpha");
    await expect(destinations).toContainText("Cloud · Beta");
    await expect(destinations).toContainText("This laptop");
    // On a Docker source page, the laptop's empty source id still means the
    // laptop: opening its card leaves the Docker source.
    const dockerPage = new URL(workspaceUrl);
    dockerPage.searchParams.set("source", sources[0].id);
    await page.goto(dockerPage.toString());
    await page.locator(".inbox-row").filter({ hasText: "Laptop thread" }).waitFor();
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
  } finally {
    await page.unroute("**/api/agent-sources", list);
    await page.unroute("**/api/agent-sources/**", detail);
    await page.unroute("**/api/bootstrap", localBootstrap);
    await page.unroute("**/api/inbox?*", localInbox);
  }
}
