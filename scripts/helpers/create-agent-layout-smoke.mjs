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
      json: { ...data, environmentName: "This laptop" },
    });
  });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page
    .getByRole("region", { name: "Your agents", exact: true })
    .getByRole("button", { name: "New agent", exact: true })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Meet your next agent",
    exact: true,
  });
  const body = sheet.locator(".sheet-body");
  for (const width of [390, 320, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await capture("form-" + width);
    assert(
      await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "The provider choices must not widen or horizontally pan the form",
    );
    await sheet
      .locator(".provider-picker")
      .getByRole("button", { name: "Claude", exact: true })
      .click();
    await expect(
      sheet.getByRole("button", {
        name: "Connect on This laptop",
        exact: true,
      }),
    ).toHaveCount(1);
    const prompt = sheet.getByRole("textbox", {
      name: "Initial prompt",
      exact: true,
    });
    await prompt.fill("Keep my draft while changing fields.");
    await prompt.evaluate((el) => el.scrollIntoView({ block: "end" }));
    const submit = sheet.getByRole("button", {
      name: "Create & start",
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
  await sheet.getByRole("button", { name: "ChatGPT", exact: true }).click();
  await sheet.getByLabel("Unique name").fill("mobilelayout");
  await sheet.getByLabel("Initial prompt", { exact: true }).fill("");
  await sheet
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
  assert(
    fixture.db
      .prepare("SELECT id FROM agents WHERE name=?")
      .get("mobilelayout"),
  );
}
