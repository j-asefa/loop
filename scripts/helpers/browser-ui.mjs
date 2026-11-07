// Close the whole modal stack when a journey returns to the workspace.
export async function closeSheets(page) {
  // React can mount a dialog's controls before its effect calls showModal().
  // Include mounted dialogs so the click waits for that effect instead of
  // incorrectly treating the page as already closed on slower WebKit runners.
  while (await page.locator("dialog").count()) {
    await page
      .locator("dialog")
      .last()
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.waitForTimeout(100);
  }
  // Closing the last sheet pops its history entry asynchronously. Let that
  // Back settle so a following reload or navigation cannot receive it late.
  await page
    .waitForFunction(() => !history.state?.loopSheet, null, { timeout: 2000 })
    .catch(() => {});
}

// Browser journeys always use temporary databases and fresh test-only keys.
// Avoid inheriting a developer's deployment credentials through .env.
export async function isolatedBrowserEnv() {
  const { randomBytes } = await import("node:crypto");
  return {
    ...process.env,
    NODE_ENV: "test",
    LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
}

export async function openChatOptions(page) {
  const options = page.getByRole("button", {
    name: "Chat options",
    exact: true,
  });
  if ((await options.getAttribute("aria-expanded")) !== "true")
    await options.click();
}

// The header gear opens the settings drawer.
export async function openSettings(page) {
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("heading", { name: "Settings", exact: true })
    .waitFor();
}

// Choose a primary destination from the bottom (mobile) or sidebar nav.
export async function openTab(page, name) {
  await page
    .getByRole("navigation")
    .last()
    .getByRole("button", { name, exact: true })
    .click();
}

// Result cards live on agent profiles and project pages, not the Feed. Open
// an agent's profile from the Feed's agent strip and show its Results (a
// profile otherwise restores the tab it was last left on).
export async function openAgentProfile(page, name) {
  await openTab(page, "Feed");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page
    .locator(".your-agents")
    .getByRole("button", { name: new RegExp(`^@${escaped} · `) })
    .click();
  await page.locator(".profile-head h1", { hasText: name }).waitFor();
  await page.getByRole("tab", { name: "Results", exact: true }).click();
}
