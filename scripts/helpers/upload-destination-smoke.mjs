import { expect } from "@playwright/test";

export async function uploadDestinationSmoke(page, fixture) {
  const [first, second] = fixture.agents;
  let release;
  let arrived;
  const started = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/uploads", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => {
      release = resolve;
      arrived();
    });
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.goto(fixture.base);
    await page
      .getByRole("button", { name: "Compose a message", exact: true })
      .click();
    await page.getByLabel("Agent recipient").selectOption(first.id);
    await page
      .getByLabel("Message your agent", { exact: true })
      .fill("Keep this unsent text");
    await page
      .locator(".composer-dock")
      .getByLabel("Attach files", { exact: true })
      .setInputFiles({
        name: "old-destination.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("private brief"),
      });
    await started;
    await page
      .getByRole("button", { name: "Collapse composer", exact: true })
      .click();
    await page
      .locator(".your-agents .agent-strip button")
      .filter({ hasText: second.name })
      .click();
    await page
      .locator(".profile-actions")
      .getByRole("button", { name: "Message", exact: true })
      .click();
    await expect(page.getByLabel("Agent recipient")).toHaveValue(second.id);
    await expect(page.getByLabel("Agent recipient")).toBeEnabled();
    release();
    await expect(
      page.getByLabel("Message your agent", { exact: true }),
    ).toHaveValue("Keep this unsent text");
    await expect(
      page
        .locator(".composer-dock")
        .getByRole("list", { name: "Attached files" }),
    ).toHaveCount(0);
    await expect(page.locator(".upload-error")).toHaveCount(0);
  } finally {
    release?.();
  }
}
