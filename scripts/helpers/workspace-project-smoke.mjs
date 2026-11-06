import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function workspaceProjectSmoke(page, fixture, _engine, capture) {
  const { db, owner, api, agents } = fixture;
  const bootstrap = await api("/bootstrap");
  const project = bootstrap.folders.find((folder) => folder.is_workspace);
  assert(project, "Workspace must be included in the project list");
  const thread = randomUUID(),
    run = randomUUID(),
    message = randomUUID();
  db.prepare("UPDATE agents SET folder_id=NULL WHERE id=?").run(agents[0].id);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Organize workspace notes',?)",
  ).run(thread, owner, agents[0].id, Date.now());
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at,worker_id) VALUES(?,?,?,?,'Organize workspace notes','completed',?,'{}',?,?,'fixture')",
  ).run(run, owner, agents[0].id, thread, run, Date.now(), Date.now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Workspace notes are ready.',?)",
  ).run(message, owner, thread, run, Date.now());
  const removedReads = [];
  page.on("request", (request) => {
    if (
      /\/api\/projects\/(?:status(?:\?|$)|[^/]+\/(?:brief|status-action))/.test(
        request.url(),
      )
    )
      removedReads.push(request.url());
  });
  const { summary } = await api("/feed?filter=done&expand=results");
  await page.goto(fixture.base + "/?filter=status");
  const filters = page.getByRole("tablist", { name: "Show", exact: true });
  await expect(filters.getByRole("tab")).toHaveText([
    `Done${summary.done_unread || ""}`,
    `Working${summary.working || ""}`,
    `Queued${summary.queued || ""}`,
    `Replies${summary.replies_unread || ""}`,
    "Threads",
  ]);
  await expect(filters.getByRole("tab", { name: /^Done/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".inbox-results .inbox-list")).toContainText(
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
  await expect(page.locator(".inbox-results .inbox-list")).toContainText(
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
