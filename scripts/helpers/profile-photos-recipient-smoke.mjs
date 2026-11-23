import { expect } from "@playwright/test";
import { openAgentProfile, openTab } from "./browser-ui.mjs";
import { chooseAgent } from "./agent-picker.mjs";

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
  // Tapping the already-selected recipient pill must preserve reply context;
  // tapping a different pill clears it like the recipient dropdown does.
  await page.evaluate(
    ({ owner, agentId }) => {
      sessionStorage.setItem(
        `loop-workspace-draft:${JSON.stringify([owner, "", "composer", ""])}`,
        JSON.stringify({
          selected: agentId,
          replyContext: {
            agentId,
            conversationId: "",
            messageId: "fixture-reply",
            content: "Preserve this reply context",
            mine: false,
          },
          folderChoice: "",
        }),
      );
    },
    { owner: fixture.owner, agentId: first.id },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  const replyChip = page.locator(".composer-reply-chip");
  await expect(replyChip).toContainText("Preserve this reply context");
  const pills = page.getByRole("group", {
    name: "Quick recipient",
    exact: true,
  });
  await expect(
    pills.getByRole("button", { name: `@${first.name}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await pills
    .getByRole("button", { name: `@${first.name}`, exact: true })
    .click();
  await expect(replyChip).toContainText("Preserve this reply context");
  // Quick recipient pills mirror the recipient picker with one tap and clear
  // reply context only when switching to a different recipient.
  await pills
    .getByRole("button", { name: `@${second.name}`, exact: true })
    .click();
  await expect(replyChip).toHaveCount(0);
  await expect(page.getByLabel("Agent recipient")).toHaveAttribute(
    "value",
    second.id,
  );
  await expect(
    pills.getByRole("button", { name: `@${second.name}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
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
  // A fresh composer on a profile addresses that agent, ahead of the last send.
  await expect(page.getByLabel("Agent recipient")).toHaveAttribute(
    "value",
    first.id,
  );
  // An unsent draft keeps its chosen destination when reopened on that profile.
  await chooseAgent(page.getByLabel("Agent recipient"), second.id);
  await page
    .getByLabel("Message your agent", { exact: true })
    .fill("Unsent draft");
  await page
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await expect(page.getByLabel("Agent recipient")).toHaveAttribute(
    "value",
    second.id,
  );
  // Changing an unsent selection must not replace the last sent recipient.
  await chooseAgent(page.getByLabel("Agent recipient"), first.id);
  await page.getByLabel("Message your agent", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
  await openTab(page, "Feed");
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await expect(page.getByLabel("Agent recipient")).toHaveAttribute(
    "value",
    second.id,
  );
}
