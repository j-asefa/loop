import "../runtime/environment.mjs";
// Run through heavy-command.mjs after building. Uses native protocol fixtures,
// the paired API and the real settings UI; never contacts a model provider.
import { chromium, webkit, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { testEnvironment } from "./test-runner.mjs";

const browserName = process.env.LOOP55_BROWSER;
const clean = testEnvironment(process.env, "native");
for (const name of Object.keys(process.env))
  if (!(name in clean)) delete process.env[name];
const dir = await mkdtemp(join(tmpdir(), "loop55-provider-settings-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_PROFILE = "companion";
const bin = join(dir, "bin");
await mkdir(bin);
for (const name of ["pi", "opencode"])
  await writeFile(
    join(bin, name),
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=${name}\nexport LOOP55_TEST_PROVIDER_DIR='${dir}'\nexec '${process.execPath}' '${resolve("test/fixtures/provider-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
process.env.PATH = bin + ":" + process.env.PATH;
const { WorkspaceHost } = await import("../dist/workspace-host.js");
const options = {
  harness: "codex",
  executable: resolve("test/harness.mjs"),
  project: dir,
  version: "fixture",
  billing: "existing",
};
const host = new WorkspaceHost(dir, options);
let browser;
try {
  await host.start(options, undefined, undefined, true);
  const engine = browserName === "webkit" ? webkit : chromium;
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let keyWrites = 0;
  const keyProjects = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/providers/key")) {
      keyWrites++;
      keyProjects.push(r.postDataJSON().projectId);
    }
  });
  await page.goto(host.pair().url);
  await page.getByRole("button", { name: "Pair and open Loop55" }).click();
  await expect(
    page.getByRole("button", { name: "Open settings", exact: true }),
  ).toBeVisible();
  const { csrf } = await (
    await page.request.get(host.origin + "/session")
  ).json();
  const post = async (path, data) => {
    const response = await page.request.post(host.origin + "/api" + path, {
      headers: { Origin: host.origin, "x-loop55-csrf": csrf },
      data,
    });
    assert(response.ok(), await response.text());
    return response.json();
  };
  const workspace = await (
    await page.request.get(host.origin + "/api/workspace")
  ).json();
  const defaultProject = workspace.projectPaths.find(
    (project) => project.path === dir,
  ).folder_id;
  // OpenCode is bound to a different project from the new-harness default.
  // A failed credential write disconnects it without changing that binding.
  const boundPath = join(dir, "second-project");
  await mkdir(boundPath);
  const boundProject = await post("/workspace/projects", { path: boundPath });
  await post("/workspace/runtimes/opencode/enable", {
    projectId: boundProject.id,
    billing: "existing",
    commandId: randomUUID(),
  });
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: /Provider connections/ })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Provider connections",
    exact: true,
  });
  await settings
    .getByText("Defaults for new harnesses", { exact: true })
    .click();
  await settings
    .getByLabel("Project directory for new runtimes")
    .selectOption(defaultProject);
  await settings
    .getByRole("button", { name: "Manage OpenCode providers" })
    .click();
  const oc = page.getByRole("region", {
    name: "OpenCode providers",
    exact: true,
  });
  await expect(
    oc.getByText("No model provider credentials are configured."),
  ).toBeVisible();
  await oc.getByRole("button", { name: "Add provider", exact: true }).click();
  await oc
    .getByLabel("Model provider", { exact: true })
    .selectOption("openrouter");
  await oc
    .getByLabel("API key", { exact: true })
    .fill("super-secret-browser-key");
  await oc.getByRole("checkbox", { name: /Also save this key in Pi/ }).check();
  // The first native store saves the key, then loses its reply. Discovery
  // reports OpenCode disconnected; both outcomes and the inspection gate must
  // survive that refresh, without remounting under the default project.
  await writeFile(join(dir, "lose-opencode-reply"), "yes");
  await oc.getByRole("button", { name: "Save key and refresh models" }).click();
  await expect(
    oc.getByRole("button", { name: "Refresh provider status", exact: true }),
  ).toBeEnabled();
  await expect(oc.getByRole("status")).toContainText(
    "OpenCode: change unconfirmed.",
  );
  await expect(oc.getByRole("status")).toContainText(
    "Pi: key saved. Models refreshed.",
  );
  await expect(
    oc.getByText(/Refresh provider status before starting/),
  ).toBeVisible();
  await expect(
    oc.getByRole("button", { name: "Save key and refresh models" }),
  ).toBeDisabled();
  assert.deepEqual(keyProjects, [boundProject.id, defaultProject]);
  await rm(join(dir, "lose-opencode-reply"));
  await expect(oc.getByLabel("API key", { exact: true })).toHaveValue("");
  assert.equal(keyWrites, 2);
  for (const name of ["pi", "opencode"])
    assert.equal(
      JSON.parse(await readFile(join(dir, name + "-auth.json"), "utf8"))
        .openrouter.key,
      "super-secret-browser-key",
    );
  await oc
    .getByRole("button", { name: "Refresh provider status", exact: true })
    .click();
  await expect(
    oc.getByText(/Refresh provider status before starting/),
  ).toHaveCount(0);
  assert.equal(keyWrites, 2);
  await oc.getByRole("button", { name: "Cancel", exact: true }).click();
  await oc.getByText("1 models", { exact: true }).click();
  await expect(
    oc.getByText("openrouter/vendor/model", { exact: true }),
  ).toBeVisible();
  await expect(oc).not.toContainText("super-secret");
  await page
    .getByRole("dialog", { name: "OpenCode", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await settings.getByRole("button", { name: "Manage Pi providers" }).click();
  const pi = page.getByRole("region", { name: "Pi providers", exact: true });
  await expect(
    pi.getByRole("region", { name: "OpenRouter provider" }),
  ).toBeVisible();
  await pi.getByRole("button", { name: "Add provider", exact: true }).click();
  await pi
    .getByLabel("Model provider", { exact: true })
    .selectOption("anthropic");
  await pi.getByRole("button", { name: "Continue provider sign-in" }).click();
  const login = page.getByRole("region", { name: "Pi account", exact: true });
  await login
    .getByRole("button", { name: "Start sign-in", exact: true })
    .click();
  await login
    .getByLabel("Provider sign-in response")
    .fill("oauth-secret-browser");
  await writeFile(join(dir, "hold-login"), "yes");
  await login.getByLabel("Provider sign-in response").press("Enter");
  await page
    .getByRole("dialog", { name: "Pi", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await rm(join(dir, "hold-login"));
  await expect
    .poll(async () => {
      const state = await page.request.get(
        host.origin + "/api/workspace/runtimes/pi/auth/status",
      );
      return (await state.json()).attempt?.state;
    })
    .toBe("complete");
  await settings.getByRole("button", { name: "Manage Pi providers" }).click();
  await expect(
    pi.getByRole("region", { name: "Anthropic provider" }),
  ).toBeVisible();
  await expect(pi.getByText(/Enabled in Loop55/)).toBeVisible();
  // Reopening a different provider must not mistake the prior successful
  // sign-in for completion of this new provider selection.
  await pi.getByRole("button", { name: "Add provider", exact: true }).click();
  await pi
    .getByLabel("Model provider", { exact: true })
    .selectOption("anthropic");
  await pi.getByRole("button", { name: "Continue provider sign-in" }).click();
  await expect(
    login.getByRole("button", { name: "Start sign-in", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to providers", exact: true })
    .click();
  await pi
    .getByRole("region", { name: "OpenRouter provider" })
    .getByRole("button", { name: "Remove saved credential", exact: true })
    .click();
  await pi
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(
    pi.getByRole("region", { name: "OpenRouter provider" }),
  ).toHaveCount(0);
  await expect(pi.getByText(/Not enabled in Loop55/)).toBeVisible();
  assert(
    JSON.parse(await readFile(join(dir, "opencode-auth.json"), "utf8"))
      .openrouter,
  );
  assert.equal(keyWrites, 2);
  assert.doesNotMatch(
    await readFile(join(dir, "provider-audit"), "utf8"),
    /UNEXPECTED/,
  );
  assert.deepEqual(errors, []);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: `test-results/provider-settings-${engine.name()}.png`,
  });
  console.log(
    `provider settings (${engine.name()}): paired UI, saved project binding, independent stores, uncertain outcomes, models, OAuth and removal passed`,
  );
} finally {
  await browser?.close();
  await host.close();
  await rm(dir, { recursive: true, force: true });
}
