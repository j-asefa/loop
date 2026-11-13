import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function projectNavigationSmoke(page, fixture) {
  const { folders } = await fixture.api("/bootstrap");
  const project = folders.find(
    (folder) => folder.kind === "project" && !folder.is_workspace,
  );
  assert(project, "The fixture has an editable project");
  const parent = await fixture.api("/folders", {
    name: "Navigation parent",
    kind: "folder",
  });
  await page.goto(`${fixture.base}/?page=projects&projectView=${project.id}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator(".project-heading h2")).toHaveText(project.name);
  for (const parentId of [parent.id, null]) {
    await page
      .getByRole("button", { name: "Edit project", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      project.name,
    );
    await dialog.getByLabel(/^Location/).selectOption(parentId || "");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const updated = (await fixture.api("/bootstrap")).folders.find(
      (folder) => folder.id === project.id,
    );
    assert.equal(updated.parent_id, parentId);
    await page.reload();
    await expect(page.locator(".project-heading h2")).toHaveText(project.name);
  }
  console.log(
    "Project URL navigation, parent folder updates and reload passed",
  );
}
