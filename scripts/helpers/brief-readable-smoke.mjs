import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Exercise display and edit behavior against the actual endpoints. Original
// records must survive opening an edit form and saving unchanged wording.
export async function briefReadableSmoke(
  page,
  fixture,
  { project, ids, thread },
  refresh,
) {
  const { db, agents } = fixture;
  const agent = agents[1];
  const payload = "YWJj".repeat(25);
  const text = `Review thread ${thread} with @${agent.id}.`;
  const why = `Check ${payload} with @${agent.id}.`;
  const goal = `Ship the changes reviewed by @${agent.id}.`;
  const original = db
    .prepare("SELECT text,why,decided_by FROM brief_items WHERE id=?")
    .get(ids.decisions[0]);
  const originalGoal = db
    .prepare("SELECT goal FROM brief_state WHERE project_id=?")
    .get(project).goal;
  db.prepare("UPDATE brief_items SET text=?,why=?,decided_by=? WHERE id=?").run(
    text,
    why,
    agent.id,
    ids.decisions[0],
  );
  db.prepare("UPDATE brief_state SET goal=? WHERE project_id=?").run(
    goal,
    project,
  );
  await refresh();
  const record = page.getByRole("region", {
    name: "Project record",
    exact: true,
  });
  const sheet = page.locator("dialog.brief-sheet[open]");
  await record.getByRole("tab", { name: /^Decisions/ }).click();
  await record
    .locator(".brief-item-open")
    .filter({ hasText: `Review the conversation with @${agent.name}.` })
    .click();
  await expect(sheet).toContainText(`Decided by @${agent.name}`);
  for (const token of [agent.id, thread, payload])
    await expect(sheet).not.toContainText(token);
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(sheet.getByLabel("Text", { exact: true })).toHaveValue(
    `Review the conversation with @${agent.name}.`,
  );
  await expect(sheet.getByLabel("Why", { exact: true })).toHaveValue(
    `Check [encoded content omitted] with @${agent.name}.`,
  );
  await sheet.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  assert.deepEqual(
    db
      .prepare("SELECT text,why FROM brief_items WHERE id=?")
      .get(ids.decisions[0]),
    { text, why },
  );

  await record
    .locator(".brief-item-open")
    .filter({ hasText: `Review the conversation with @${agent.name}.` })
    .click();
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet
    .getByLabel("Text", { exact: true })
    .fill("Ship the reviewed layout.");
  await sheet.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  assert.deepEqual(
    db
      .prepare("SELECT text,why FROM brief_items WHERE id=?")
      .get(ids.decisions[0]),
    { text: "Ship the reviewed layout.", why },
  );

  await page.locator(".brief-goal").click();
  await expect(sheet.getByLabel("Goal · you")).toHaveValue(
    `Ship the changes reviewed by @${agent.name}.`,
  );
  await sheet.getByRole("button", { name: "Save goal", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  assert.equal(
    db.prepare("SELECT goal FROM brief_state WHERE project_id=?").get(project)
      .goal,
    goal,
  );
  db.prepare("UPDATE brief_items SET text=?,why=?,decided_by=? WHERE id=?").run(
    original.text,
    original.why,
    original.decided_by,
    ids.decisions[0],
  );
  db.prepare("UPDATE brief_state SET goal=? WHERE project_id=?").run(
    originalGoal,
    project,
  );
  await refresh();
}
