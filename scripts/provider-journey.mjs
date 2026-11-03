import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function providerJourney(page, api) {
  const open = async () => {
    await openSettings(page);
    await page.getByRole("button", { name: /Provider connections/ }).click();
  };
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).last();
  const heading = (name) => page.getByRole("heading", { name, exact: true });
  const dialog = page.locator("dialog[open]").last();
  const snapshot = async (name) =>
    page.screenshot({ path: join(tmpdir(), `loop-provider-${name}.png`) });
  const noOverflow = async () => {
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
  };
  await open();
  // Existing accounts are management-only, never above a new provider's form.
  await page
    .getByRole("region", {
      name: "ChatGPT: Deterministic fixture account",
      exact: true,
    })
    .getByRole("button", { name: "Update API key", exact: true })
    .click();
  await heading("Reconnect ChatGPT").waitFor();
  assert.equal(
    await page.getByLabel("OpenAI API key", { exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.getByRole("radio").count(), 0);
  await button("Your connections").click();
  await button("Add a provider").click();
  await snapshot("choices");
  const theme = await page.locator("html").getAttribute("data-theme");
  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const color of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, color);
      for (const name of ["ChatGPT", "Claude"]) {
        await button(name).tap();
        await expect(heading("Connect " + name)).toBeFocused();
        assert.equal(
          await page
            .getByRole("radio", { name: "Subscription", exact: true })
            .isChecked(),
          true,
        );
        if (name === "Claude")
          assert.doesNotMatch(
            await dialog.innerText(),
            /OpenAI|ChatGPT|Deterministic fixture account/,
          );
        await noOverflow();
        if (width === 390 && name === "Claude")
          await snapshot(`claude-setup-${color}`);
        await page.getByRole("radio", { name: "API key", exact: true }).check();
        const key = page.getByLabel(
          name === "Claude" ? "Anthropic API key" : "OpenAI API key",
          { exact: true },
        );
        await key.fill("test-only-clear-on-change");
        await button("Show key").click();
        assert.equal(await key.getAttribute("type"), "text");
        await page
          .getByRole("radio", { name: "Subscription", exact: true })
          .check();
        await page.getByRole("radio", { name: "API key", exact: true }).check();
        assert.equal(await key.inputValue(), "");
        assert.equal(await key.getAttribute("type"), "password");
        await noOverflow();
        if (
          name === "Claude" &&
          (width === 390 || (width === 320 && color === "dark"))
        )
          await snapshot(`claude-api-${width}-${color}`);
        await button("Change provider").click();
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await button("Claude").click();
  const key = page.getByLabel("Anthropic API key", { exact: true });
  await page.getByRole("radio", { name: "API key", exact: true }).check();
  // API validation errors keep the same provider, entered key and billing method.
  await page.route(
    "**/api/connections",
    (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture: invalid API key" }),
      }),
    { times: 1 },
  );
  await key.fill("test-only-invalid-key");
  await button("Connect Claude").click();
  await page.getByRole("alert").getByText("Fixture: invalid API key").waitFor();
  await heading("Connect Claude").waitFor();
  assert.equal(await key.inputValue(), "test-only-invalid-key");
  assert.doesNotMatch(await dialog.innerText(), /OpenAI|ChatGPT/);
  await key.fill("test-only-anthropic-key");
  const apiRequest = page.waitForRequest(
    (r) => r.url().endsWith("/api/connections") && r.method() === "POST",
  );
  await button("Connect Claude").click();
  assert.equal((await apiRequest).postDataJSON().provider, "anthropic");
  await heading("Claude connected").waitFor();
  await expect(button("Done")).toBeEnabled();
  await snapshot("claude-success-dark");
  // The optional name has a useful default; no name/key prompts are added to subscription sign-in.
  const added = (await api("/bootstrap")).connections.find(
    (c) => c.label === "Anthropic API",
  );
  assert.equal(added.provider, "anthropic");
  assert.equal(added.status, "connected");
  assert.equal(added.secret, undefined);
  await button("Your connections").click();
  await page
    .getByRole("region", { name: "Claude: Anthropic API", exact: true })
    .getByRole("button", { name: "Update API key", exact: true })
    .click();
  await heading("Reconnect Claude").waitFor();
  assert.equal(await key.inputValue(), "");
  await key.fill("test-only-updated-anthropic-key");
  await button("Save API key").click();
  await heading("Claude connected").waitFor();
  assert.equal(
    (await api("/bootstrap")).connections.filter(
      (c) => c.label === "Anthropic API",
    ).length,
    1,
  );
  await button("Your connections").click();
  await button("Add a provider").click();
  await button("Claude").click();
  await page.locator(".connection-options summary").click();
  await page
    .getByLabel("Account name", { exact: true })
    .fill("Claude UX regression");
  const before = (await api("/bootstrap")).connections.length;
  // Hold the first bootstrap after creation: the Claude identity must already be
  // visible before a record exists in the parent's asynchronously refreshed props.
  const bootstrapSeen = deferred(),
    releaseBootstrap = deferred();
  await page.route(
    "**/api/bootstrap",
    async (route) => {
      const response = await route.fetch();
      bootstrapSeen.resolve();
      await releaseBootstrap.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  let loginRequests = 0;
  const loginListener = (r) => {
    if (/\/api\/subscriptions\/[^/]+\/login$/.test(r.url())) loginRequests++;
  };
  page.on("request", loginListener);
  await page.route(
    "**/api/subscriptions/*/login",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture: sign-in could not start" }),
      }),
    { times: 1 },
  );
  const subscriptionRequest = page.waitForRequest(
    (r) => r.url().endsWith("/api/subscriptions") && r.method() === "POST",
  );
  await button("Continue with Claude").click();
  assert.equal((await subscriptionRequest).postDataJSON().provider, "claude");
  await bootstrapSeen.promise;
  try {
    await expect(heading("Sign in to Claude")).toBeFocused();
    assert.doesNotMatch(await dialog.innerText(), /ChatGPT|OpenAI/);
  } finally {
    releaseBootstrap.resolve();
  }
  await page
    .getByRole("alert")
    .getByText("Fixture: sign-in could not start")
    .waitFor();
  const record = (await api("/bootstrap")).connections.find(
    (c) => c.label === "Claude UX regression",
  );
  assert.equal(record.provider, "anthropic");
  // Retry reuses the created record. Simulate a lost response after login starts;
  // the next retry must resume the running sign-in instead of opening a duplicate.
  const releaseRetryRefresh = deferred();
  await page.route(
    "**/api/bootstrap",
    async (route) => {
      const response = await route.fetch();
      await releaseRetryRefresh.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.route(
    "**/api/subscriptions/*/login",
    async (route) => {
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture: sign-in response lost" }),
      });
    },
    { times: 1 },
  );
  await button("Try sign-in again").click();
  try {
    await page
      .getByRole("alert")
      .getByText("Fixture: sign-in response lost")
      .waitFor();
    await expect(button("Try sign-in again")).toBeEnabled();
  } finally {
    releaseRetryRefresh.resolve();
  }
  await button("Try sign-in again").click();
  await page
    .getByRole("link", { name: "Open Claude sign-in", exact: true })
    .waitFor();
  assert.equal(
    loginRequests,
    2,
    "A lost login response resumes via status; it does not start another login",
  );
  assert.equal((await api("/bootstrap")).connections.length, before + 1);
  await snapshot("claude-signin-dark");
  // A runtime deadline must stop the spinner, preserve the Claude context, and
  // make the same account retryable. Cancel the fixture's pending native login.
  await page.route(
    `**/api/subscriptions/${record.id}/status`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "failed",
          error:
            "The provider did not return a sign-in link within 45 seconds. Try sign-in again.",
        }),
      }),
    { times: 1 },
  );
  await api(`/subscriptions/${record.id}/cancel`, {});
  await page
    .getByRole("alert")
    .getByText(/sign-in link within 45 seconds/)
    .waitFor();
  await expect(button("Try sign-in again")).toBeEnabled();
  assert.equal(
    await page
      .getByRole("link", { name: "Open Claude sign-in", exact: true })
      .count(),
    0,
  );
  await button("Try sign-in again").click();
  await page
    .getByRole("link", { name: "Open Claude sign-in", exact: true })
    .waitFor();
  assert.equal((await api("/bootstrap")).connections.length, before + 1);
  await page.getByLabel("One-time sign-in code").fill("wrong-fixture-code");
  await button("Complete sign-in").click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByLabel("One-time sign-in code").inputValue(),
    "wrong-fixture-code",
  );
  await heading("Sign in to Claude").waitFor();
  // Closing and reopening exposes an explicit resume action on the saved account.
  await closeSheets(page);
  await open();
  const account = page.getByRole("region", {
    name: "Claude: Claude UX regression",
    exact: true,
  });
  await account
    .getByRole("button", { name: "Continue sign-in", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Open Claude sign-in", exact: true })
    .waitFor();
  const statusSeen = deferred(),
    releaseStatus = deferred(),
    statusSent = deferred();
  await page.route(
    `**/api/subscriptions/${record.id}/status`,
    async (route) => {
      statusSeen.resolve();
      await releaseStatus.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true, authMode: "subscription" }),
      });
      statusSent.resolve();
    },
    { times: 1 },
  );
  await statusSeen.promise;
  await button("Your connections").click();
  await button("Add a provider").click();
  await button("ChatGPT").click();
  releaseStatus.resolve();
  await statusSent.promise;
  await expect(heading("Connect ChatGPT")).toBeVisible();
  // Give the stale response a render turn, then actively switch the new form.
  await page.getByRole("radio", { name: "API key", exact: true }).check();
  await expect(
    page.getByLabel("OpenAI API key", { exact: true }),
  ).toBeVisible();
  assert.equal(
    await page
      .getByRole("link", { name: "Open Claude sign-in", exact: true })
      .count(),
    0,
  );
  await button("Change provider").click();
  await button("Your connections").click();
  await account
    .getByRole("button", { name: "Continue sign-in", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Open Claude sign-in", exact: true })
    .waitFor();
  await button("Cancel sign-in").click();
  await account.getByText("Sign-in needed", { exact: true }).waitFor();
  await account.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("link", { name: "Open Claude sign-in", exact: true })
    .waitFor();
  await page.getByLabel("One-time sign-in code").fill("fixture-code");
  await button("Complete sign-in").click();
  await heading("Claude connected").waitFor();
  assert.equal((await api("/bootstrap")).connections.length, before + 1);
  await button("Your connections").click();
  await account.getByText("Connected", { exact: true }).waitFor();
  await account.scrollIntoViewIfNeeded();
  await expect(heading("Provider connections")).toBeInViewport();
  await expect(button("Close")).toBeInViewport();
  await snapshot("accounts-dark");
  await closeSheets(page);
  await open();
  await account.getByText("Connected", { exact: true }).waitFor();
  await closeSheets(page);
  page.off("request", loginListener);
  await page.evaluate((value) => {
    if (value === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }, theme);
  console.log(
    "PASS: provider-first setup; saved-account separation; Claude identity before bootstrap; method/key isolation; API validation/update; failed, timed-out and lost login responses; duplicate-free retry; pending sign-in resume/cancel; stale-status isolation; both themes and 320/390/430/768 layouts.",
  );
}
