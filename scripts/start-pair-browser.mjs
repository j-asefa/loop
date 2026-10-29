import { openAgentModelOptions } from "./helpers/agent-model-options.mjs";
// Runtime-neutral onboarding through the real mobile-width UI and fixture adapter.
process.env.LOOP_PROFILE = "companion";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import assert from "node:assert/strict";
await mkdir(".tmp", { recursive: true });
const dir = await mkdtemp(resolve(".tmp/start-pair-browser-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_TEST_HARNESS = "codex";
const bin = join(dir, "bin");
await mkdir(bin);
await writeFile(
  join(bin, "codex"),
  `#!/bin/sh\nexec '${process.execPath}' '${resolve("test/harness.mjs")}' "$@"\n`,
  { mode: 0o755 },
);
process.env.PATH = bin + ":" + process.env.PATH;
const { WorkspaceHost } = await import("../dist/workspace-host.js");
const { db } = await import("../dist/server/db.js");
const options = {
  harness: "codex",
  executable: "codex",
  project: dir,
  version: "workspace",
  billing: "existing",
};
const host = new WorkspaceHost(dir, options);
let browser;
try {
  await host.start(options, undefined, undefined, true);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(host.pair().url);
  await page.getByRole("button", { name: "Pair and open Loop" }).click();
  await page
    .getByRole("button", { name: /^(New agent|Start chatting)$/ })
    .click();
  const setup = page.getByRole("region", { name: "Runtime setup" });
  await expect(
    setup.getByRole("button", { name: "Enable Codex", exact: true }),
  ).toBeEnabled();
  await setup
    .getByLabel("Billing policy for new runtime")
    .selectOption("existing");
  await setup
    .getByRole("button", { name: "Enable Codex", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "New chat", exact: true })
    .getByText("Customize", { exact: true })
    .click();
  await openAgentModelOptions(page);
  await expect(
    page.getByRole("radiogroup", { name: "Connection", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Unique name").fill("start-browser");
  await page
    .getByRole("dialog")
    .getByLabel("Project", { exact: true })
    .selectOption({ label: basename(dir) });
  await page.getByLabel("Opening message", { exact: true }).fill("hello");
  await page
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "New chat" }),
  ).not.toBeVisible();
  await expect
    .poll(
      () =>
        db.prepare("SELECT count(*) n FROM runs WHERE state='completed'").get()
          .n,
      { timeout: 30000 },
    )
    .toBe(1);
  const session = db.prepare("SELECT * FROM companion_sessions").get();
  assert.equal(session.harness, "codex");
  assert(session.native_id);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: mobile-width pairing → runtime enablement → project selection → native task completion",
  );
} finally {
  await browser?.close();
  await host.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
}
