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
    await page.goto(host.pair().url);
    await page.getByRole("button", { name: "Pair and open Loop" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /Provider connections/ }).click();
    const settings = page.getByRole("dialog", { name: "Connected harnesses" });
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
      fullPage: true,
    });
    await login.getByLabel("Provider sign-in response").fill("fixture-code");
    await login.getByLabel("Provider sign-in response").press("Enter");
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
      fullPage: true,
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
    await expect(login.getByRole("alert")).toHaveText(
      "Could not load models. Try enabling again.",
    );
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await expect(
      login.getByRole("button", { name: "Enable Claude Code", exact: true }),
    ).toBeEnabled();
    assert.equal(enables, 1);
    assert.equal(signInsStarted, 1);

    // Closing the whole setup screen and reopening preserves the success state.
    await login.getByRole("button", { name: "Done", exact: true }).click();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /Provider connections/ }).click();
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
    assert.equal(enables, 1);
    assert.equal(signInsStarted, 1);
    await login
      .getByRole("button", { name: "Enable Claude Code", exact: true })
      .click();
    await expect(
      settings.getByRole("button", {
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
    assert.equal(signInsStarted, 1);
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
