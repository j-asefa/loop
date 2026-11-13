import {
  chooseAgentConnection,
  openAgentModelOptions,
} from "./agent-model-options.mjs";
import assert from "node:assert/strict";
import { mockViewportCoordinates } from "./mock-viewport.mjs";
import { expect } from "@playwright/test";

export async function createAgentLayoutSmoke(page, fixture, capture) {
  await mockViewportCoordinates(page);
  fixture.db
    .prepare(
      "UPDATE connections SET status='disconnected' WHERE provider='anthropic'",
    )
    .run();
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, environmentName: "This computer" },
    });
  });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page
    .getByRole("region", { name: "Your agents", exact: true })
    .getByRole("button", { name: "New agent", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "New chat", exact: true })
    .getByText("Customize", { exact: true })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "New chat",
    exact: true,
  });
  // These attributes opt prose fields into the iPhone keyboard's writing aids.
  // Desktop browser fixtures cannot exercise the native keyboard itself.
  await expect(sheet.locator("form")).toHaveAttribute("autocomplete", "off");
  await expect(
    sheet.getByLabel("Unique name", { exact: true }),
  ).toHaveAttribute("autocomplete", "off");
  for (const name of ["Opening message", "Agent instructions"]) {
    const field = sheet.getByRole("textbox", { name, exact: true });
    await expect(field).toHaveAttribute("autocomplete", "off");
    await expect(field).toHaveAttribute("autocorrect", "on");
    await expect(field).toHaveAttribute("autocapitalize", "sentences");
    await expect(field).toHaveAttribute("spellcheck", "true");
  }
  await openAgentModelOptions(sheet);
  const body = sheet.locator(".sheet-body");
  for (const width of [390, 320, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await capture("form-" + width);
    assert(
      await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "The provider choices must not widen or horizontally pan the form",
    );
    await expect(sheet.getByRole("radio", { name: /^Claude/ })).toHaveCount(0);
    await sheet.locator(".create-agent-more-connections").evaluate((el) => {
      el.open = true;
    });
    await expect(
      sheet.getByRole("button", {
        name: "Connect another account",
        exact: true,
      }),
    ).toHaveCount(1);
    const prompt = sheet.getByRole("textbox", {
      name: "Opening message",
      exact: true,
    });
    await prompt.fill("Keep my draft while changing fields.");
    await prompt.evaluate((el) => el.scrollIntoView({ block: "end" }));
    const submit = sheet.getByRole("button", {
      name: "Start chatting",
      exact: true,
    });
    const inputBounds = await prompt.boundingBox(),
      buttonBounds = await submit.boundingBox();
    assert(
      inputBounds.y + inputBounds.height <= buttonBounds.y + 1,
      "The create action must never cover the prompt",
    );
    for (const offsetTop of [0, 300]) {
      await page.evaluate((offsetTop) => {
        Object.defineProperty(visualViewport, "height", {
          configurable: true,
          value: 400,
        });
        Object.defineProperty(visualViewport, "offsetTop", {
          configurable: true,
          value: offsetTop,
        });
        visualViewport.dispatchEvent(new Event("resize"));
      }, offsetTop);
      await expect(page.locator("html")).toHaveAttribute(
        "data-keyboard",
        "open",
      );
      await expect
        .poll(() =>
          sheet.evaluate((el) => {
            const v = visualViewport,
              r = el.getBoundingClientRect();
            return (
              r.top >= v.offsetTop - 1 &&
              r.top <= v.offsetTop + 10 &&
              r.bottom <= v.offsetTop + v.height + 1
            );
          }),
        )
        .toBe(true);
      // A real keyboard does not scroll the shrunken sheet for us: the
      // focused prompt must already be clear of the pinned create action.
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue("Keep my draft while changing fields.");
      const p = await prompt.boundingBox(),
        b = await submit.boundingBox();
      assert(
        p.y >= offsetTop && p.y + p.height <= b.y + 1,
        "Keyboard and footer must leave the focused prompt visible",
      );
      assert(await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await capture("keyboard-" + width + "-" + offsetTop);
    }
    await prompt.blur();
    await page.evaluate(() => {
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-keyboard",
      "closed",
    );
  }
  // The footer's submit button must still submit the associated form.
  await chooseAgentConnection(sheet, { provider: "codex" });
  await sheet.getByLabel("Unique name").fill("mobilelayout");
  await sheet
    .getByLabel("Opening message", { exact: true })
    .fill("Fixture opening attachment");
  const upload = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/uploads"),
  );
  await sheet.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "creation-attachment.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Fixture creation attachment"),
  });
  const descriptor = await (await upload).json();
  await expect(
    sheet.getByRole("list", { name: "Attached files" }),
  ).toContainText("creation-attachment.txt");
  const creation = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/agents"),
  );
  await sheet
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  assert.deepEqual((await creation).postDataJSON().attachmentIds, [
    descriptor.id,
  ]);
  await expect(sheet).toHaveCount(0);
  assert(
    fixture.db
      .prepare("SELECT id FROM agents WHERE name=?")
      .get("mobilelayout"),
  );
}
