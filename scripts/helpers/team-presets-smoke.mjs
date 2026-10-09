import assert from "node:assert/strict";
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
  await expect(
    dialog().getByLabel("Default for all roles connection"),
  ).toHaveValue(connection.id);
  await expect(
    dialog().getByLabel("Default for all roles connection").locator("option"),
  ).toHaveCount(2);
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
}
