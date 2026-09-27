import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function profileNavigationSmoke(page, fixture, engine, capture) {
  const dialog = () => page.locator("dialog[open]").last();
  const close = () =>
    dialog().getByRole("button", { name: "Close", exact: true }).click();
  const nav = (name) =>
    page.locator(".mobile-nav").getByRole("button", { name, exact: true });
  const connection = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='anthropic'")
    .get();
  const models = JSON.parse(connection.models).map((model) => ({
    ...model,
    resolvedModel: model.id === "opus" ? "claude-opus-5-5" : "claude-sonnet-5",
  }));
  fixture.db
    .prepare("UPDATE connections SET models=? WHERE id=?")
    .run(JSON.stringify(models), connection.id);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    const shortcut = page
      .locator(".your-agents .agent-strip button")
      .filter({ hasText: "design-reviewer" });
    await expect(shortcut.locator(".agent-shortcut-model")).toHaveText(
      "Sonnet 5",
    );
    const label = await shortcut.locator(".agent-shortcut-model").boundingBox();
    const avatar = await shortcut.locator(".agent-portrait").boundingBox();
    assert(
      label.y + label.height <= avatar.y,
      "Model belongs above the avatar",
    );
    await capture("specific-model-shortcuts");
    await shortcut.click();
    await expect(page.locator(".profile-model")).toHaveText("Claude Sonnet 5");
    await capture("specific-model-profile");
    await page.waitForLoadState("networkidle");

    const conversation = fixture.conversations[0];
    await page.goto(fixture.base + "/?conversation=" + conversation.id, {
      waitUntil: "networkidle",
    });
    const header = dialog().locator(".conversation-agent");
    await expect(header.locator(".avatar")).toBeVisible();
    const name = (await header.locator("strong").textContent()).trim();
    await dialog()
      .getByLabel("Reply to agent", { exact: true })
      .fill("Keep this draft when opening the profile.");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const before = await header.boundingBox();
        await dialog()
          .locator(".messages")
          .evaluate((el) => (el.scrollTop = el.scrollHeight));
        await expect(header).toBeInViewport({ ratio: 1 });
        assert(
          Math.abs((await header.boundingBox()).y - before.y) < 1,
          "Agent header moved with the messages",
        );
        await capture(`visible-conversation-profile-${theme}-${width}`);
      }
    }
    await header.click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator(".profile-head h1")).toHaveText(name);
    await expect(page.locator(".profile-head h1")).toBeInViewport({ ratio: 1 });
    await page.waitForLoadState("networkidle");
    await page.goto(fixture.base + "/?conversation=" + conversation.id, {
      waitUntil: "networkidle",
    });
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toHaveValue("Keep this draft when opening the profile.");
    await dialog().getByLabel("Reply to agent", { exact: true }).fill("");
    await close();

    for (const reducedMotion of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      for (const tab of ["Feed", "Running"]) {
        await page.goto(fixture.base, { waitUntil: "networkidle" });
        await page.setViewportSize({ width: 390, height: 600 });
        if (tab === "Running") await nav(tab).tap();
        await page.locator(".feed-card").first().waitFor();
        await page.waitForTimeout(400);
        await page.evaluate(() =>
          window.scrollTo({
            top: document.body.scrollHeight,
            behavior: "instant",
          }),
        );
        assert(
          await page.evaluate(() => scrollY > 80),
          `${tab} must be scrolled before testing`,
        );
        await nav(tab).tap();
        assert(
          await page.evaluate(() => scrollY > 80),
          "One tap should preserve the scroll position",
        );
        await nav(tab).tap();
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      }
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    const input = dialog().getByLabel("Unique name");
    await expect(input).toHaveValue(/^[a-z]{3,32}$/);
    const suggestion = await input.inputValue();
    assert(
      !fixture.db.prepare("SELECT 1 FROM handles WHERE name=?").get(suggestion),
    );
    await dialog().getByRole("button", { name: "Claude", exact: true }).click();
    await dialog()
      .getByLabel("Initial prompt", { exact: true })
      .fill("A first task");
    await expect(input).toHaveValue(suggestion);
    await input.scrollIntoViewIfNeeded();
    await capture("single-word-agent-name");
    await close();

    // A slow suggestion must not clobber an explicitly entered (or cleared) name.
    let release;
    const ready = new Promise((resolve) => (release = resolve));
    await page.route("**/api/agents/suggest-name", async (route) => {
      await ready;
      await route.fulfill({ json: { name: "willow" } });
    });
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await input.fill("mychosenname");
    await input.fill("");
    const response = page.waitForResponse("**/api/agents/suggest-name");
    release();
    await response;
    await expect(input).toHaveAttribute("placeholder", "Choose a name");
    await expect(input).toHaveValue("");
    await input.fill("mychosenname");
    await close();
    await page.unroute("**/api/agents/suggest-name");
  } finally {
    fixture.db
      .prepare("UPDATE connections SET models=? WHERE id=?")
      .run(connection.models, connection.id);
  }
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  console.log(
    `${engine}: visible agent headers, exact model labels, double-tap navigation and single-word name suggestions passed`,
  );
}
