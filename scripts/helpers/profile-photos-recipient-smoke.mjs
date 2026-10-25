import { expect } from "@playwright/test";
import { openAgentProfile, openTab } from "./browser-ui.mjs";

export async function profilePhotosRecipientSmoke(page, fixture) {
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  const [first, second] = fixture.agents;
  await openAgentProfile(page, first.name);
  for (const selector of [
    ".profile-head > .avatar",
    ".profile-head .profile-cover",
  ]) {
    const trigger = page.locator(selector);
    await trigger.click();
    const viewer = page.locator(".profile-photo-viewer[open]");
    await expect(viewer).toBeVisible();
    await expect
      .poll(() => viewer.locator("img").evaluate((img) => img.naturalWidth))
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await openTab(page, "Your profile");
  for (const selector of [".my-profile-avatar", ".my-profile .profile-cover"]) {
    await page.locator(selector).click();
    await expect(page.locator(".profile-photo-viewer[open]")).toBeVisible();
    await page
      .getByRole("button", { name: "Close photo", exact: true })
      .click();
  }
  await openTab(page, "Feed");
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await page.getByLabel("Agent recipient").selectOption(second.id);
  await page
    .getByLabel("Message your agent", { exact: true })
    .fill("Remember this recipient");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compose a message", exact: true }),
  ).toBeVisible();
  await openAgentProfile(page, first.name);
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await expect(page.getByLabel("Agent recipient")).toHaveValue(second.id);
  // Selecting another agent for an unsent draft must keep that draft's destination.
  await page.getByLabel("Agent recipient").selectOption(first.id);
  await page
    .getByLabel("Message your agent", { exact: true })
    .fill("Unsent draft");
  await page
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await expect(page.getByLabel("Agent recipient")).toHaveValue(first.id);
  await page.getByLabel("Message your agent", { exact: true }).fill("");
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await expect(page.getByLabel("Agent recipient")).toHaveValue(second.id);
}
