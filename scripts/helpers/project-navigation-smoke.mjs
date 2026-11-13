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
    let release;
    let arrived = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // Bootstrap callers can supersede one another. Hold all responses until
    // the editor opens so whichever publishes carries the observable marker.
    const refresh = async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      value.folders.find((folder) => folder.id === parent.id).name =
        "Refreshed parent";
      arrived = true;
      await gate;
      await route.fulfill({ response, json: value });
    };
    await page.route("**/api/bootstrap", refresh);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect.poll(() => arrived).toBe(true);
      await page
        .getByRole("button", { name: "Edit project", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
        project.name,
      );
      release();
      await expect(
        dialog
          .getByLabel(/^Location/)
          .locator("option")
          .filter({ hasText: "Refreshed parent" }),
      ).toHaveCount(1);
      await dialog.getByLabel(/^Location/).selectOption(parentId || "");
      const submitted = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" &&
          new URL(request.url()).pathname.startsWith("/api/folders/"),
      );
      await dialog
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      const request = await submitted;
      assert.equal(
        new URL(request.url()).pathname,
        `/api/folders/${project.id}`,
        "A bootstrap refresh must not retarget the open editor",
      );
      await expect(dialog).toHaveCount(0);
      const updated = (await fixture.api("/bootstrap")).folders.find(
        (folder) => folder.id === project.id,
      );
      assert.equal(updated.parent_id, parentId);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
    await page.reload();
    await expect(page.locator(".project-heading h2")).toHaveText(project.name);
  }
  console.log(
    "Project URL navigation, editor identity across bootstrap refresh, parent folder updates and reload passed",
  );
}
