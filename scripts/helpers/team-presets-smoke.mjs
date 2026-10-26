import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function teamPresetsSmoke(page, fixture, _engine, capture) {
  const connection = await fixture.api("/connections", {
    provider: "openai",
    label: "Review API fixture",
    secret: "fixture-only-not-a-real-key",
  });
  const project = await fixture.api("/folders", {
    name: "Preset review project",
    kind: "project",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page
    .locator(".projects-view")
    .getByRole("button", { name: /^Agent teams/ })
    .click();
  const dialog = () => page.locator("dialog[open]").last();
  await dialog().getByRole("button", { name: "New team", exact: true }).click();
  await dialog()
    .getByRole("button", { name: /^Review code changes/ })
    .click();
  await dialog()
    .getByLabel("Team name", { exact: true })
    .fill("Snapshot reviewers");
  await dialog()
    .getByLabel("Project", { exact: true })
    .selectOption(project.id);
  // Subscriptions are offered alongside API connections.
  await expect(
    dialog()
      .getByLabel("Default for all roles connection")
      .locator("option", { hasText: "Personal Claude" }),
  ).toHaveCount(1);
  await dialog()
    .getByLabel("Default for all roles connection")
    .selectOption(connection.id);
  await dialog()
    .getByText("Customize connections by role", { exact: true })
    .click();
  await expect(
    dialog().getByLabel("Security reviewer connection"),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Preset picker fits a phone viewport",
  );
  await capture("team-presets-picker");
  const before = (await fixture.api("/bootstrap")).agents;
  await dialog()
    .getByRole("button", { name: "Create team", exact: true })
    .click();
  await expect(dialog()).toHaveAttribute("aria-label", "Review local changes");
  await expect(dialog().getByText(/Open the laptop workspace/)).toBeVisible();
  await expect(
    dialog().getByRole("button", { name: "Start review", exact: true }),
  ).toBeDisabled();
  const teams = await fixture.api("/teams");
  const created = teams.find((t) => t.name === "Snapshot reviewers");
  assert.equal(created.preset_id, "code-review");
  assert.equal(created.members.length, 3);
  assert.equal(
    (await fixture.api("/bootstrap")).agents.length,
    before.length + 4,
  );
  await expect(dialog().getByLabel("Review team", { exact: true })).toHaveValue(
    created.id,
  );
  await expect(dialog().getByLabel("Project", { exact: true })).toHaveValue(
    project.id,
  );
  await capture("team-presets-review");

  // Stored review fixtures follow review-access.test.ts. Real snapshot capture
  // and request replay are covered by team-route-contracts.test.ts; this server
  // profile exercises the actual status route and browser, without a worker.
  const seedRun = (agentId, conversation = randomUUID()) => {
    const agent = fixture.db
      .prepare("SELECT * FROM agents WHERE id=?")
      .get(agentId);
    fixture.db
      .prepare(
        "INSERT OR IGNORE INTO conversations(id,owner_id,agent_id,title,team_id,execution_connection_id,created_at) VALUES(?,?,?,'Fixture review',?,?,?)",
      )
      .run(
        conversation,
        created.owner_id,
        agentId,
        created.id,
        agent.connection_id,
        Date.now(),
      );
    const run = { id: randomUUID(), conversation_id: conversation };
    const payload = {
      agentId,
      name: agent.name,
      provider: agent.provider,
      connectionId: agent.connection_id,
      model: agent.model,
      effort: agent.effort,
      instructions: agent.instructions,
      folderId: project.id,
      teamId: created.id,
      reviewId,
    };
    fixture.db
      .prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Fixture review','completed',?,?,?,?)",
      )
      .run(
        run.id,
        created.owner_id,
        agentId,
        conversation,
        run.id,
        JSON.stringify(payload),
        Date.now(),
        Date.now(),
      );
    return run;
  };
  const reviewId = randomUUID();
  const lead = seedRun(created.manager_id, created.conversation_id);
  const snapshot = {
    scope: "branch",
    base: "fixture-base",
    head: "fixture-head",
    diff: "+fixture",
    changed: ["fixture.ts"],
    omitted: [],
    files: { "fixture.ts": "fixture" },
    before: { "fixture.ts": "before" },
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  fixture.db
    .prepare(
      "UPDATE runs SET payload=json_set(payload,'$.reviewId',?),state='completed',result='Fixture review complete' WHERE id=?",
    )
    .run(reviewId, lead.id);
  fixture.db
    .prepare(
      "INSERT INTO code_reviews(id,owner_id,team_id,folder_id,request_key,request_hash,snapshot,fingerprint,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      reviewId,
      created.owner_id,
      created.id,
      project.id,
      reviewId,
      "fixture",
      JSON.stringify(snapshot),
      fingerprint,
      lead.id,
      Date.now(),
    );
  for (const [index, agentId] of created.members.entries()) {
    const child = seedRun(agentId);
    fixture.db
      .prepare("UPDATE runs SET state=?,error=? WHERE id=?")
      .run(
        index === 2 ? "failed" : "completed",
        index === 2 ? "Fixture reviewer unavailable" : null,
        child.id,
      );
    fixture.db
      .prepare(
        "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,'{}',0)",
      )
      .run(lead.id, "review:" + index, child.id);
  }
  const response = await fixture.api(
    `/reviews/conversation/${lead.conversation_id}`,
  );
  assert.equal(response.id, reviewId);
  assert.equal(response.fingerprint, fingerprint);
  assert.equal(response.conversationId, lead.conversation_id);
  await page.goto(`${fixture.base}/?conversation=${lead.conversation_id}`, {
    waitUntil: "networkidle",
  });
  const status = page.getByRole("complementary", {
    name: "Snapshot review status",
  });
  await expect(status).toContainText("2/3 reviewers completed");
  await expect(status).toContainText(fingerprint.slice(0, 10));
  await expect(status).toContainText("Fixture reviewer unavailable");
  await status.getByRole("button", { name: "Check for newer edits" }).click();
  await expect(status).toContainText("Freshness unavailable:");
  await expect(status).toContainText(
    "Local snapshot review requires a laptop workspace",
  );
  await capture("team-review-status");
}
