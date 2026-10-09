import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Uses real paired APIs and a CLI sign-in fixture; never navigates to a provider.
export async function nativeAuthBrowser({ browser, host, dir, db }) {
  const bin = join(dir, "auth-bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=claude\nexport LOOP_TEST_AUTH_DIR='${dir}'\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + ":" + originalPath;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    let providerOpened = false;
    await context.route("https://claude.com/**", async (route) => {
      assert(!route.request().headers().authorization);
      providerOpened = true;
      await route.fulfill({
        contentType: "text/html",
        body: "<p>Fixture provider code: fixture-code</p>",
      });
    });
    const page = await context.newPage();
    const errors = [];
    let signInsStarted = 0;
    let enables = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url().endsWith("/runtimes/claude/auth/start"))
        signInsStarted++;
      if (request.url().endsWith("/runtimes/claude/enable")) enables++;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    // The header gear opens the settings drawer.
    const openProviderConnections = async () => {
      await page
        .getByRole("button", { name: "Open settings", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: /Provider connections/ })
        .click();
    };
    await page.goto(host.pair().url);
    await page.getByRole("button", { name: "Pair and open Loop" }).click();
    await openProviderConnections();
    const settings = page.getByRole("dialog", { name: "Provider connections", exact: true });
    await settings
      .getByRole("button", { name: "Sign in to Claude Code", exact: true })
      .click();
    let login = page.getByRole("region", {
      name: "Claude Code account",
      exact: true,
    });
    await login
      .getByRole("button", { name: "Start sign-in", exact: true })
      .click();
    await expect(
      login.getByRole("link", { name: "Open provider sign-in" }),
    ).toBeVisible();
    const popup = page.waitForEvent("popup");
    await login.getByRole("link", { name: "Open provider sign-in" }).click();
    const provider = await popup;
    await expect(
      provider.getByText("Fixture provider code: fixture-code"),
    ).toBeVisible();
    assert(providerOpened);
    await provider.close();
    await login.getByRole("button", { name: "Close", exact: true }).click();
    await settings
      .getByRole("button", { name: "Sign in to Claude Code", exact: true })
      .click();
    login = page.getByRole("region", {
      name: "Claude Code account",
      exact: true,
    });
    await expect(login.getByLabel("Provider sign-in response")).toBeVisible();
    await page.screenshot({
      path: "test-results/native-provider-sign-in.png",
      fullPage: false,
    });
    // A status check can fail while the submitted input is still in flight.
    // The successful input response must clear that older sign-in error.
    let releaseInput;
    const inputReady = new Promise((resolve) => { releaseInput = resolve; });
    let holdingInput = true;
    await context.route("**/api/workspace/runtimes/claude/auth/status", async (route) => {
      if (!holdingInput) return route.fallback();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary status failure" }),
      });
    });
    await context.route("**/api/workspace/runtimes/claude/auth/input", async (route) => {
      const response = await route.fetch();
      await inputReady;
      await route.fulfill({ response });
    }, { times: 1 });
    await login.getByLabel("Provider sign-in response").fill("fixture-code");
    await login.getByLabel("Provider sign-in response").press("Enter");
    await expect(login.getByRole("alert")).toHaveText("Couldn’t check sign-in. Reconnecting…");
    releaseInput();
    await expect(login.getByLabel("Provider sign-in response")).toHaveCount(0);
    await expect(login.getByRole("alert")).toHaveCount(0);
    holdingInput = false;
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await expect(login.getByLabel("Provider sign-in response")).toHaveCount(0);
    await expect(
      settings.getByText("authentication unknown", { exact: false }),
    ).toHaveCount(0);
    await expect(
      login.getByText(/Complete the provider’s sign-in/),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("button", {
        name: "Sign in to Claude Code",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      login.getByRole("button", { name: "Enable Claude Code", exact: true }),
    ).toBeEnabled();
    await expect(
      login.getByRole("button", { name: "Sign in again", exact: true }),
    ).toHaveCount(0);
    await login.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/native-provider-signed-in.png",
      fullPage: false,
    });

    // An enable failure must not ask for a second login or replay the action.
    await context.route(
      "**/api/workspace/runtimes/claude/enable",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Could not load models. Try enabling again.",
          }),
        }),
      { times: 1 },
    );
    await login
      .getByRole("button", { name: "Enable Claude Code", exact: true })
      .click();
    await expect(login.getByRole("alert")).toContainText(
      "Could not load models. Try enabling again.",
    );
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await expect(
      login.getByRole("button", { name: "Enable Claude Code", exact: true }),
    ).toBeEnabled();
    assert.equal(enables, 1);
    assert.equal(signInsStarted, 1);

    // A new login clears the old account's verification error without
    // automatically retrying the enable action.
    await login.getByRole("button", { name: "Change account", exact: true }).click();
    await login.getByRole("button", { name: "Start sign-in", exact: true }).click();
    await expect(login.getByRole("alert")).toHaveCount(0);
    await expect(login.getByLabel("Provider sign-in response")).toBeVisible();
    await login.getByLabel("Provider sign-in response").fill("fixture-code");
    await login.getByLabel("Provider sign-in response").press("Enter");
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await expect(login.getByRole("alert")).toHaveCount(0);
    assert.equal(enables, 1);
    assert.equal(signInsStarted, 2);

    // Closing the whole setup screen and reopening preserves the success state.
    await login.getByRole("button", { name: "Done", exact: true }).click();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await openProviderConnections();
    await expect(
      settings.getByRole("button", {
        name: "Manage Claude Code account",
        exact: true,
      }),
    ).toBeVisible();
    await settings
      .getByRole("button", { name: "Manage Claude Code account", exact: true })
      .click();
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await login
      .getByRole("button", { name: "Change account", exact: true })
      .click();
    await expect(login.getByLabel("Sign-in method")).toBeVisible();
    // Inspecting another account does not initiate sign-in or discard credentials.
    await login.getByRole("button", { name: "Close", exact: true }).click();
    await settings
      .getByRole("button", { name: "Manage Claude Code account", exact: true })
      .click();
    await expect(login.getByRole("status")).toHaveText(/Signed in/);

    // After a restart (or a sign-in outside Loop) the auth manager has no
    // attempt and the CLI catalog reports no `configured` provider; the
    // runtime's own signed-in status must still offer Enable, not a new login.
    const fresh = async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.attempt;
      for (const provider of body.providers || []) delete provider.configured;
      await route.fulfill({ response, json: body });
    };
    const discovered = async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const runtime of body.runtimes)
        if (runtime.name === "claude") runtime.authentication = "signed_in";
      await route.fulfill({ response, json: body });
    };
    await context.route("**/api/workspace/runtimes/claude/auth?*", fresh);
    await context.route("**/api/workspace/runtimes/claude/auth/status", fresh);
    const runtimesUrl = /\/api\/workspace\/runtimes(\?.*)?$/;
    await context.route(runtimesUrl, discovered);
    await login.getByRole("button", { name: "Done", exact: true }).click();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await openProviderConnections();
    await settings
      .getByRole("button", { name: "Manage Claude Code account", exact: true })
      .click();
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await expect(
      login.getByRole("button", { name: "Enable Claude Code", exact: true }),
    ).toBeEnabled();
    await expect(
      login.getByRole("button", { name: "Start sign-in", exact: true }),
    ).toHaveCount(0);
    await context.unroute("**/api/workspace/runtimes/claude/auth?*", fresh);
    await context.unroute("**/api/workspace/runtimes/claude/auth/status", fresh);
    await context.unroute(runtimesUrl, discovered);

    assert.equal(enables, 1);
    assert.equal(signInsStarted, 2);
    await login
      .getByRole("button", { name: "Enable Claude Code", exact: true })
      .click();
    await expect(
      login.getByRole("button", {
        name: "Refresh Claude Code",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      settings
        .locator(".native-runtime")
        .filter({ has: page.getByText("Claude Code", { exact: true }) })
        .getByText("Enabled in Loop", { exact: true }),
    ).toBeVisible();
    assert.equal(enables, 2);
    assert.equal(signInsStarted, 2);
    assert.equal(
      JSON.parse(
        db.prepare("SELECT options FROM harnesses WHERE name='claude'").get()
          .options,
      ).billing,
      "subscription",
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    process.env.PATH = originalPath;
  }
}
