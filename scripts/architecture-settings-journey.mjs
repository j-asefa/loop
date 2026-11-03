import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
export async function architectureSettingsJourney(page) {
  await openSettings(page);
  await page.getByRole("button", { name: /Execution environments/ }).click();
  await expect(page.getByText("No machines added")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Runtime machines", exact: true }),
  ).toBeVisible();
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  await closeSheets(page);
  await openSettings(page);
  await page.getByRole("button", { name: /Shared memory/ }).click();
  // Readiness is a note beside the toggle rather than a status sentence.
  await expect(page.getByText(/Keyword matching for now/)).toBeVisible();
  await expect(page.getByText(/semantic index is unavailable/)).toBeVisible();
  // Pinning a note is a focused sub-form, not three fields on the page.
  await page.getByRole("button", { name: "Pin a note" }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Synthetic mobile decision");
  await page
    .getByLabel("Note", { exact: true })
    .fill("User chose SQLite WAL for durable queue state.");
  await page.getByRole("button", { name: "Pin note", exact: true }).click();
  await page
    .getByRole("button", { name: "Synthetic mobile decision", exact: true })
    .click();
  await page
    .getByLabel("Note content", { exact: true })
    .fill("User reaffirmed SQLite WAL after the outage review.");
  await page.getByRole("button", { name: "Save note revision" }).click();
  await expect(page.getByText(/Revision 2/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(tmpdir(), "loop-architecture-memory-mobile.png"),
  });
  await page
    .getByRole("button", { name: "Remove from shared memory" })
    .last()
    .click();
  await expect(page.getByText(/Removed/)).toBeVisible();
  await closeSheets(page);
  console.log(
    "PASS: setup-required state, 320/390/1024 layout, memory readiness, note creation/revision/tombstone through the real application API.",
  );
}
