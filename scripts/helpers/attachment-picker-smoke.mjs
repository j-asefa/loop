import assert from "node:assert/strict";
import { expect } from "@playwright/test";

const photo = {
  name: "picker-photo.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
};
const document = {
  name: "picker-document.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Attachment picker fixture"),
};

async function openComposer(page, fixture, thread) {
  await page.goto(
    fixture.base +
      (thread ? "/?conversation=" + fixture.conversations[0].id : ""),
  );
  if (thread) return page.locator("dialog.conversation-sheet[open] .composer");
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  return page.locator(".composer-dock:not(.thread-mode)");
}

export async function attachmentPickerSmoke(page, fixture) {
  // Desktop/Android retain the separate source controls. Drive clicks, not
  // setInputFiles on a hidden input, to catch a control opening the wrong picker.
  for (const thread of [false, true]) {
    const composer = await openComposer(page, fixture, thread);
    for (const [source, accept, capture, multiple, file] of [
      ["Camera", "image/*", "environment", false, photo],
      ["Photos", "image/*", null, true, photo],
      ["Files", "", null, true, document],
    ]) {
      await composer
        .getByRole("button", { name: "Add attachments", exact: true })
        .click();
      const sheet = page.getByRole("dialog", {
        name: "Add to message",
        exact: true,
      });
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        sheet.getByRole("button", { name: source, exact: true }).click(),
      ]);
      assert.deepEqual(
        await chooser.element().evaluate((input) => ({
          accept: input.accept,
          capture: input.getAttribute("capture"),
          multiple: input.multiple,
        })),
        { accept, capture, multiple },
      );
      await chooser.setFiles(file);
      await expect(sheet).toHaveCount(0);
      await expect(
        composer.getByRole("list", { name: "Attached files" }),
      ).toContainText(file.name);
      await composer
        .getByRole("button", { name: "Remove " + file.name, exact: true })
        .click();
    }
  }

  // Playwright cannot render UIKit's native source menu. Emulate iOS identity
  // to verify that both production composers hand off directly to one picker,
  // without mounting Loop55's duplicate sheet, and still upload selected files.
  for (const device of [
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  ]) {
    const context = await page
      .context()
      .browser()
      .newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
        userAgent: device.userAgent,
      });
    try {
      await context.addInitScript(({ platform, maxTouchPoints }) => {
        Object.defineProperty(navigator, "platform", { value: platform });
        Object.defineProperty(navigator, "maxTouchPoints", {
          value: maxTouchPoints,
        });
      }, device);
      const mobile = await context.newPage();
      mobile.setDefaultTimeout(8000);
      for (const thread of [false, true]) {
        const composer = await openComposer(mobile, fixture, thread);
        const trigger = composer.getByRole("button", {
          name: "Add attachments",
          exact: true,
        });
        const pick = async () => {
          const [chooser] = await Promise.all([
            mobile.waitForEvent("filechooser"),
            trigger.tap(),
          ]);
          await expect(
            mobile.getByRole("dialog", { name: "Add to message", exact: true }),
          ).toHaveCount(0);
          return chooser;
        };
        // Cancelling the native picker leaves the draft intact and allows retry.
        const prompt = composer.getByRole("textbox").last();
        await prompt.fill("Keep this attachment draft");
        await (await pick()).setFiles([]);
        await expect(prompt).toHaveValue("Keep this attachment draft");
        const chooser = await pick();
        assert(
          chooser.isMultiple(),
          "The native picker supports multiple files",
        );
        assert.equal(await chooser.element().getAttribute("accept"), null);
        assert.equal(await chooser.element().getAttribute("capture"), null);
        await chooser.setFiles([photo, document]);
        const attachments = composer.getByRole("list", {
          name: "Attached files",
        });
        await expect(attachments).toContainText(photo.name);
        await expect(attachments).toContainText(document.name);
        await expect(prompt).toHaveValue("Keep this attachment draft");
      }
    } finally {
      await context.close();
    }
  }
}
