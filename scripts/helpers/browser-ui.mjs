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
}

// Browser journeys always use temporary databases and fresh test-only keys.
// Avoid inheriting a developer's deployment credentials through .env.
export async function isolatedBrowserEnv() {
  const { randomBytes } = await import("node:crypto");
  return {
    ...process.env,
    NODE_ENV: "test",
    LOOP_PROFILE: "server",
    LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    LOOP_BEHIND_PROXY: "0",
    LOOP_GATEWAY_TOKEN: "",
    LOOP_SINGLE_USER_EMAIL: "",
    LOOP_RUNTIME_URL: "",
    LOOP_RUNTIME_TOKEN: "",
  };
}
