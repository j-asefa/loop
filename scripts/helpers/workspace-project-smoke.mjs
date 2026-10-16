import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function workspaceProjectSmoke(page, fixture, _engine, capture) {
  const { db, owner, api, agents } = fixture;
  const connection = await api("/connections", {
    provider: "openai",
    label: "Workspace brief fixture",
    secret: "fixture-only-not-a-real-key",
  });
  const bootstrap = await api("/bootstrap");
  const project = bootstrap.folders.find((folder) => folder.is_workspace);
  assert(project, "Workspace must be included in the project list");
  const root = `/projects/${project.id}/brief`;
  const thread = randomUUID(),
    run = randomUUID(),
    message = randomUUID(),
    result = randomUUID();
  db.prepare("UPDATE agents SET folder_id=NULL WHERE id=?").run(agents[0].id);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Organize workspace notes',?)",
  ).run(thread, owner, agents[0].id, Date.now());
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at,worker_id) VALUES(?,?,?,?,'Organize workspace notes','running',?,'{}',?,?,'fixture')",
  ).run(run, owner, agents[0].id, thread, run, Date.now(), Date.now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Organize workspace notes',?)",
  ).run(message, owner, thread, run, Date.now());
  await page.goto(fixture.base + "/?filter=status");
  const card = page
    .locator(".project-status-card")
    .filter({
      has: page.getByRole("link", { name: "Workspace", exact: true }),
    });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("1 working");
  await card.getByRole("link", { name: "Enable brief", exact: true }).click();
  await expect(page.locator(".project-heading h2")).toHaveText("Workspace");
  await expect(
    page.getByRole("button", { name: "Edit project", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Connection", exact: true })
    .selectOption(connection.id);
  await page.getByRole("button", { name: "Enable brief", exact: true }).click();
  await expect.poll(async () => (await api(root)).settings.enabled).toBe(true);
  // Simulate the worker's published record. The integration test runs actual
  // generation through a fixture provider; this journey exercises the UI.
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run);
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'Workspace notes','markdown','The workspace notes are organized.',?,?,?)",
  ).run(
    result,
    owner,
    agents[0].id,
    thread,
    run,
    JSON.stringify({ messageId: message }),
    Date.now(),
    Date.now(),
  );
  const state = randomUUID(),
    at = Date.now();
  const cite = [{ ref: "res_" + result }];
  db.prepare(
    "INSERT INTO brief_items(id,owner_id,project_id,kind,text,status,cites,author,first_version,last_version,created_at,updated_at) VALUES(?,?,?,'state','The workspace notes are organized.','active',?,'model',1,1,?,?)",
  ).run(state, owner, project.id, JSON.stringify(cite), at, at);
  const through = db
    .prepare(
      "SELECT max(seq) n FROM project_changes WHERE owner_id=? AND project_id=?",
    )
    .get(owner, project.id).n;
  db.prepare(
    "INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,synth_at,built_on_version,owner_edit_rev,state,idempotency_key,created_at) VALUES(?,?,?,1,?,0,?,?,0,0,'published',?,?)",
  ).run(
    randomUUID(),
    owner,
    project.id,
    JSON.stringify({
      headline: { text: "Workspace notes are ready to review", cite },
      state: [state],
      decisions: [],
      open_questions: [],
      unfinished: [],
      overflow: { state: 0, decisions: 0, open_questions: 0, unfinished: 0 },
      changes: [],
    }),
    through,
    at,
    randomUUID(),
    at,
  );
  db.prepare(
    "UPDATE brief_state SET current_version=1,basis_through=?,due_at=NULL WHERE owner_id=? AND project_id=?",
  ).run(through, owner, project.id);
  await page.reload();
  await expect(page.locator(".brief-headline h2")).toHaveText(
    "Workspace notes are ready to review",
  );
  await page
    .locator(".brief-item-open")
    .filter({ hasText: "The workspace notes are organized." })
    .click();
  const sheet = page.locator("dialog.brief-sheet[open]");
  await expect(
    sheet.getByRole("link", {
      name: "Open thread at original message",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    new RegExp(`conversation=${thread}.*message=${message}`),
  );
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .locator(".project-tabs")
    .getByRole("button", { name: "Threads", exact: true })
    .click();
  await expect(page.locator(".inbox-list")).toContainText(
    "Organize workspace notes",
  );
  await page
    .locator(".project-tabs")
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(page.locator(".project-agents")).toContainText(agents[0].name);
  await page.goto(fixture.base + "/?filter=status");
  await expect(card).toContainText("Workspace notes are ready to review");
  await expect(card).toContainText("The workspace notes are organized.");
  await page.getByLabel("Filter by project").selectOption(project.id);
  await expect(page.locator(".project-status-card")).toHaveCount(1);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("workspace-status");
  await card.getByRole("link", { name: "Read brief", exact: true }).click();
  await expect(page.locator(".brief-headline h2")).toHaveText(
    "Workspace notes are ready to review",
  );
  await capture("workspace-brief");
}
