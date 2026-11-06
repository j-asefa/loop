import { expect } from "@playwright/test";
import { openSettings } from "./browser-ui.mjs";

// Browser-only discovery fixtures; the paired-host test covers actual dispatch.
export async function geminiSmoke(page, fixture, _engine, capture) {
  let enabled = false;
  let enableRequest;
  let startRequest;
  let answered;
  const providers = [
    {
      id: "google",
      name: "Google",
      methods: [{ id: "oauth", type: "oauth", label: "Sign in with Google" }],
    },
  ];
  let attempt;
  const view = () => ({ providers, ...(attempt ? { attempt } : {}) });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        harnesses: [],
        nativeProcesses: 0,
        concurrency: 1,
        hostLifetime: "foreground",
        tunnelOrigin: "",
        projectPaths: [
          { folder_id: "first", path: "/projects/first" },
          { folder_id: "second", path: "/projects/second" },
        ],
      },
    }),
  );
  await page.route("**/api/workspace/runtimes?*", (route) =>
    route.fulfill({
      json: {
        computer: "Fixture computer",
        online: true,
        setup: "ready",
        runtimes: [
          {
            name: "gemini",
            backend: "direct",
            installed: true,
            available: true,
            enabled,
            version: "0.64.0",
            help: "",
            authentication: "unknown",
            ...(enabled
              ? {
                  project: "/projects/second",
                  billing: "existing",
                  authentication: "previously_verified",
                }
              : {}),
          },
        ],
      },
    }),
  );
  await page.route("**/api/workspace/runtimes/gemini/upgrade", (route) =>
    route.fulfill({
      json: {
        upgrade: null,
        canUpgrade: false,
        upgradeHelp: "Fixture installation",
      },
    }),
  );
  // Gemini signs in through the same native sign-in routes as other harnesses.
  await page.route("**/api/workspace/runtimes/gemini/auth?*", (route) =>
    route.fulfill({ json: view() }),
  );
  await page.route("**/api/workspace/runtimes/gemini/auth/status", (route) =>
    route.fulfill({ json: view() }),
  );
  await page.route("**/api/workspace/runtimes/gemini/auth/start", (route) => {
    startRequest = route.request().postDataJSON();
    attempt = {
      id: "11111111-1111-4111-8111-111111111111",
      commandId: startRequest.commandId,
      provider: "google",
      method: "oauth",
      state: "waiting",
      expiresAt: Date.now() + 600000,
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
      prompt: {
        id: "22222222-2222-4222-8222-222222222222",
        type: "manual_code",
        message: "Paste the authorization code from Google",
      },
    };
    return route.fulfill({ json: view() });
  });
  await page.route("**/api/workspace/runtimes/gemini/auth/input", (route) => {
    answered = route.request().postDataJSON();
    // The server drops the link and prompt when an attempt ends.
    const { prompt: _prompt, url: _url, ...rest } = attempt;
    attempt = { ...rest, state: "complete" };
    return route.fulfill({ json: view() });
  });
  await page.route("**/api/workspace/runtimes/gemini/enable", (route) => {
    enableRequest = route.request().postDataJSON();
    enabled = true;
    return route.fulfill({
      json: {
        name: "gemini",
        billing: {
          mode: "existing",
          description: "Existing Gemini CLI sign-in",
        },
        models: [],
        capabilities: {},
      },
    });
  });
  await page.goto(fixture.base);
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await page
    .getByRole("button", { name: "Sign in to Gemini CLI", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Gemini CLI", exact: true });
  await expect(sheet.getByLabel("Sign-in method")).toHaveValue("oauth");
  // A sign-in made outside Loop can still enable directly.
  await sheet.getByText("Already signed in on Fixture computer?").click();
  await expect(
    sheet.getByRole("button", { name: "Enable Gemini CLI", exact: true }),
  ).toBeVisible();
  await capture("gemini-cli-already-signed-in");
  await sheet.getByText("Already signed in on Fixture computer?").click();
  await sheet
    .getByRole("button", { name: "Start sign-in", exact: true })
    .click();
  await expect(
    sheet.getByRole("link", { name: "Open provider sign-in" }),
  ).toHaveAttribute("href", /^https:\/\/accounts\.google\.com\//);
  await sheet.getByLabel("Provider sign-in response").fill("fixture-code");
  await capture("gemini-cli-sign-in");
  await sheet
    .getByRole("button", { name: "Continue sign-in", exact: true })
    .click();
  await expect(sheet.getByText("Signed in to Gemini CLI")).toBeVisible();
  expect(startRequest).toMatchObject({ provider: "google", method: "oauth" });
  expect(answered).toMatchObject({ value: "fixture-code" });
  await sheet
    .getByLabel("Project directory for new runtimes")
    .selectOption("second");
  await expect(sheet.getByLabel("Billing policy for new runtimes")).toHaveCount(
    0,
  );
  await capture("gemini-cli-setup");
  await sheet
    .getByRole("button", { name: "Enable Gemini CLI", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Refresh Gemini CLI", exact: true }),
  ).toBeEnabled();
  expect(enableRequest).toMatchObject({
    projectId: "second",
    billing: "existing",
  });
  // Reopening an enabled runtime, with no sign-in in memory, offers Refresh.
  attempt = undefined;
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage Gemini CLI account", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Refresh Gemini CLI", exact: true }),
  ).toBeVisible();
  await expect(sheet.getByText(/Already signed in/)).toHaveCount(0);
}
