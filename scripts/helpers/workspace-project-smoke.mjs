import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { tsImport } from "tsx/esm/api";

const { folder: setAgentFolder } = await tsImport(
  "../../src/server/sql/agents.ts",
  import.meta.url,
);
const { seedConversation, seedMessage, seedRun } = await tsImport(
  "../../test/helpers/seed.ts",
  import.meta.url,
);

export async function workspaceProjectSmoke(page, fixture, _engine, capture) {
  const { db, owner, api, agents } = fixture;
  const bootstrap = await api("/bootstrap");
  const project = bootstrap.folders.find((folder) => folder.is_workspace);
  assert(project, "Workspace must be included in the project list");
  const thread = randomUUID(),
    run = randomUUID(),
    message = randomUUID();
  const title = "Organize workspace notes";
  setAgentFolder(db, null, agents[0].id, owner);
  seedConversation(db, {
    id: thread,
    owner_id: owner,
    agent_id: agents[0].id,
    title,
    created_at: Date.now(),
  });
  seedRun(db, {
    id: run,
    owner_id: owner,
    agent_id: agents[0].id,
    conversation_id: thread,
    input: title,
    state: "completed",
    idempotency_key: run,
    created_at: Date.now(),
    updated_at: Date.now(),
    worker_id: "fixture",
  });
  seedMessage(db, {
    id: message,
    owner_id: owner,
    conversation_id: thread,
    run_id: run,
    role: "assistant",
    content: "Workspace notes are ready.",
    created_at: Date.now(),
  });
  const removedReads = [];
  page.on("request", (request) => {
    if (
      /\/api\/projects\/(?:status(?:\?|$)|[^/]+\/(?:brief|status-action))/.test(
        request.url(),
      )
    )
      removedReads.push(request.url());
  });
  const { summary } = await api("/feed?filter=done");
  await page.goto(fixture.base + "/?filter=status");
  const filters = page.getByRole("tablist", { name: "Show", exact: true });
  await expect(filters.getByRole("tab")).toHaveText([
    "Done",
    `Working${summary.working || ""}`,
    `Queued${summary.queued || ""}`,
    `Replies${summary.replies_unread || ""}`,
    "Threads",
  ]);
  await expect(
    filters.getByRole("tab", { name: "Done", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".feed-results .feed-list")).toContainText(
    "Workspace notes are ready.",
  );
  await page.evaluate((project) => {
    sessionStorage.setItem("loop-project-tab", "brief");
    sessionStorage.setItem("loop-project-tab:" + project, "brief");
  }, project.id);
  await page.goto(
    fixture.base +
      "/?page=projects&projectView=" +
      project.id +
      "&projectTab=brief",
  );
  await expect(page.locator(".project-heading h2")).toHaveText("Workspace");
  const tabs = page.locator(".project-tabs");
  await expect(tabs.getByRole("button")).toHaveText([
    "Threads",
    "Agents",
    "Activity",
    "Files",
  ]);
  await expect(
    tabs.getByRole("button", { name: "Threads", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Edit project", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", { name: "Search Workspace", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".feed-results .feed-list")).toContainText(
    "Organize workspace notes",
  );
  await tabs.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".project-agents")).toContainText(agents[0].name);
  await page.reload();
  await expect(
    tabs.getByRole("button", { name: "Agents", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  assert.deepEqual(
    removedReads,
    [],
    "Navigation must not query retired features",
  );
  for (const [path, method] of [
    ["/api/projects/status", "GET"],
    [`/api/projects/${project.id}/status-action?key=old`, "GET"],
    [`/api/projects/${project.id}/brief`, "GET"],
    [`/api/projects/${project.id}/brief/settings`, "PUT"],
  ]) {
    const response = await page.request.fetch(fixture.base + path, {
      method,
      headers: fixture.headers,
      data: method === "PUT" ? {} : undefined,
    });
    expect(response.status(), `${method} ${path}`).toBe(404);
  }
  await capture("workspace-project");
}
