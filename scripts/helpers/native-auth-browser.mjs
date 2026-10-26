import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Uses real paired APIs and a CLI sign-in fixture; never navigates to a provider.
export async function prepareNativeAuthBrowser(dir) {
  const bin = join(dir, "auth-bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=claude\nexport LOOP_TEST_AUTH_DIR='${dir}'\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + ":" + originalPath;
  return () => {
    process.env.PATH = originalPath;
  };
}
export async function nativeAuthBrowser({ browser, host, dir, db }) {
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
    let providerReads = 0;
    const signInIds = [];
    let enables = 0;
    const enableIds = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname.endsWith("/runtimes/claude/auth")
      )
        providerReads++;
      if (request.method() !== "POST") return;
      if (request.url().endsWith("/runtimes/claude/auth/start")) {
        signInsStarted++;
        signInIds.push(request.postDataJSON().commandId);
      }
      if (request.url().endsWith("/runtimes/claude/enable")) {
        enables++;
        enableIds.push(request.postDataJSON().commandId);
      }
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
    const settings = page.getByRole("dialog", {
      name: "Provider connections",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "Sign in to Claude Code", exact: true })
      .click();
    let login = page.getByRole("region", {
      name: "Claude Code account",
      exact: true,
    });
    // A prior authority reserved the start but died before creating an
    // attempt. Ordinary retries must preserve its ID without starting login.
    let oldStart;
    await context.route(
      "**/api/workspace/runtimes/claude/auth/start",
      async (route) => {
        oldStart = route.request().postDataJSON().commandId;
        db.prepare(
          "INSERT INTO execution_commands(owner_id,command_id,method,digest,generation,state,created_at,updated_at) VALUES('local-workspace',?,'auth.start','old-session-digest',?,'started',1,1)",
        ).run(oldStart, randomUUID());
        await route.continue();
      },
      { times: 1 },
    );
    for (let i = 0; i < 2; i++) {
      await login
        .getByRole("button", { name: "Start sign-in", exact: true })
        .click();
      await expect(login.getByRole("alert")).toContainText(
        "outcome is unknown",
      );
    }
    assert.deepEqual(signInIds, [oldStart, oldStart]);
    assert(
      !existsSync(join(dir, "auth-audit")) ||
        !readFileSync(join(dir, "auth-audit"), "utf8").includes("claude:login"),
    );
    // A fresh authority has not loaded providers yet: status() returns this
    // empty view. Recovery must reload the catalog without starting login.
    const catalogsBeforeInspection = providerReads;
    await context.route(
      "**/api/workspace/runtimes/claude/auth/status",
      (route) => route.fulfill({ json: { providers: [] } }),
      { times: 1 },
    );
    await login
      .getByRole("button", { name: "Check sign-in status", exact: true })
      .click();
    await expect(
      login.getByRole("button", { name: "Start new sign-in", exact: true }),
    ).toBeEnabled();
    assert(providerReads > catalogsBeforeInspection);
    assert.equal(signInsStarted, 2);
    await context.route(
      "**/api/workspace/runtimes/claude/auth/start",
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.fulfill({
          status: 503,
          json: {
            error: "Sign-in reply interrupted",
            executionOutcome: "unknown",
          },
        });
      },
      { times: 1 },
    );
    await login
      .getByRole("button", { name: "Start new sign-in", exact: true })
      .click();
    await expect(login.getByRole("alert")).toContainText(
      "Sign-in reply interrupted",
    );
    await login
      .getByRole("button", { name: "Check sign-in status", exact: true })
      .click();
    await expect(
      login.getByRole("link", { name: "Open provider sign-in" }),
    ).toBeVisible();
    await expect(
      login.getByText(/A different sign-in is in progress/),
    ).toHaveCount(0);
    assert.equal(signInsStarted, 3);
    assert.notEqual(signInIds.at(-1), oldStart);
    assert.equal(
      db
        .prepare("SELECT state FROM execution_commands WHERE command_id=?")
        .get(oldStart).state,
      "started",
    );
    assert.equal(
      db
        .prepare("SELECT state FROM execution_commands WHERE command_id=?")
        .get(signInIds.at(-1)).state,
      "completed",
    );
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
    const inputReady = new Promise((resolve) => {
      releaseInput = resolve;
    });
    let holdingInput = true;
    await context.route(
      "**/api/workspace/runtimes/claude/auth/status",
      async (route) => {
        if (!holdingInput) return route.fallback();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary status failure" }),
        });
      },
    );
    await context.route(
      "**/api/workspace/runtimes/claude/auth/input",
      async (route) => {
        const response = await route.fetch();
        await inputReady;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await login.getByLabel("Provider sign-in response").fill("fixture-code");
    await login.getByLabel("Provider sign-in response").press("Enter");
    await expect(login.getByRole("alert")).toHaveText(
      "Couldn’t check sign-in. Reconnecting…",
    );
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
    assert.equal(signInsStarted, 3);

    // A new login clears the old account's verification error without
    // automatically retrying the enable action.
    const previousAttempt = (
      await (
        await page.request.get(
          host.origin + "/api/workspace/runtimes/claude/auth/status",
        )
      ).json()
    ).attempt;
    assert.equal(previousAttempt.state, "complete");
    await login
      .getByRole("button", { name: "Change account", exact: true })
      .click();
    await context.route(
      "**/api/workspace/runtimes/claude/auth/start",
      (route) =>
        route.fulfill({
          status: 503,
          json: {
            error: "Account change was not confirmed",
            executionOutcome: "unknown",
          },
        }),
      { times: 1 },
    );
    await login
      .getByRole("button", { name: "Start sign-in", exact: true })
      .click();
    await expect(login.getByRole("alert")).toContainText(
      "Account change was not confirmed",
    );
    const failedAccountStart = signInIds.at(-1);
    await context.route(
      "**/api/workspace/runtimes/claude/auth/status",
      async (route) => {
        const response = await route.fetch(),
          body = await response.json();
        assert.equal(body.attempt.commandId, previousAttempt.commandId);
        delete body.attempt.commandId;
        await route.fulfill({ response, json: body });
      },
      { times: 1 },
    );
    await login
      .getByRole("button", { name: "Check sign-in status", exact: true })
      .click();
    await expect(
      login.getByRole("button", { name: "Start new sign-in", exact: true }),
    ).toBeEnabled();
    await expect(login.getByRole("status")).toHaveCount(0);
    assert.equal(signInsStarted, 4);
    const inspectedAttempt = (
      await (
        await page.request.get(
          host.origin + "/api/workspace/runtimes/claude/auth/status",
        )
      ).json()
    ).attempt;
    assert.equal(inspectedAttempt.id, previousAttempt.id);
    await login
      .getByRole("button", { name: "Start new sign-in", exact: true })
      .click();
    await expect(login.getByRole("alert")).toHaveCount(0);
    await expect(login.getByLabel("Provider sign-in response")).toBeVisible();
    assert.notEqual(signInIds.at(-1), failedAccountStart);
    await login.getByLabel("Provider sign-in response").fill("fixture-code");
    await login.getByLabel("Provider sign-in response").press("Enter");
    await expect(login.getByRole("status")).toHaveText(/Signed in/);
    await expect(login.getByRole("alert")).toHaveCount(0);
    assert.equal(enables, 1);
    assert.equal(signInsStarted, 5);

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
    await context.unroute(
      "**/api/workspace/runtimes/claude/auth/status",
      fresh,
    );
    await context.unroute(runtimesUrl, discovered);

    assert.equal(enables, 1);
    assert.equal(signInsStarted, 5);
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
    assert.equal(signInsStarted, 5);
    assert.equal(
      JSON.parse(
        db.prepare("SELECT options FROM harnesses WHERE name='claude'").get()
          .options,
      ).billing,
      "subscription",
    );
    // Model a prior authority that lost confirmation after reserving the
    // command. The real API must refuse its replay, including after inspection.
    let unknownId;
    const updatedAt = db
      .prepare("SELECT updated_at FROM harnesses WHERE name='claude'")
      .get().updated_at;
    await context.route(
      "**/api/workspace/runtimes/claude/enable",
      async (route) => {
        const input = route.request().postDataJSON();
        unknownId = input.commandId;
        const digest = createHash("sha256")
          .update(
            JSON.stringify([
              "runtime.enable",
              {
                name: "claude",
                projectId: input.projectId,
                billing: input.billing,
              },
            ]),
          )
          .digest("hex");
        db.prepare(
          "INSERT INTO execution_commands(owner_id,command_id,method,digest,generation,state,created_at,updated_at) VALUES('local-workspace',?,'runtime.enable',?,?,'unknown',1,1)",
        ).run(unknownId, digest, randomUUID());
        await route.continue();
      },
      { times: 1 },
    );
    await login
      .getByRole("button", { name: "Refresh Claude Code", exact: true })
      .click();
    await expect(login.getByRole("alert")).toContainText("outcome is unknown");
    await login
      .getByRole("button", { name: "Refresh Claude Code", exact: true })
      .click();
    await expect(login.getByRole("alert")).toContainText("outcome is unknown");
    assert.deepEqual(enableIds.slice(-2), [unknownId, unknownId]);
    assert.equal(
      db.prepare("SELECT updated_at FROM harnesses WHERE name='claude'").get()
        .updated_at,
      updatedAt,
    );
    const beforeInspection = enables;
    await login
      .getByRole("button", { name: "Check runtime status", exact: true })
      .click();
    await expect(
      login.getByRole("button", {
        name: "Start new verification",
        exact: true,
      }),
    ).toBeEnabled();
    assert.equal(enables, beforeInspection);
    await login
      .getByRole("button", { name: "Start new verification", exact: true })
      .click();
    await expect(
      login.getByRole("button", { name: "Refresh Claude Code", exact: true }),
    ).toBeEnabled();
    await expect(login.getByRole("alert")).toHaveCount(0);
    assert.equal(enables, beforeInspection + 1);
    assert.notEqual(enableIds.at(-1), unknownId);
    assert.equal(
      db
        .prepare("SELECT state FROM execution_commands WHERE command_id=?")
        .get(unknownId).state,
      "unknown",
    );
    assert.equal(
      db
        .prepare("SELECT state FROM execution_commands WHERE command_id=?")
        .get(enableIds.at(-1)).state,
      "completed",
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
