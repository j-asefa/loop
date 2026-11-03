import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import { harnessJourney } from "./harness-journey.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function remoteCodexJourney(page, api, fixture) {
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).last();
  await openSettings(page);
  await page.getByRole("button", { name: /Runtime machines/ }).click();
  await page.getByLabel("Connection type").selectOption("codex-app-server");
  await page.getByLabel("Machine name").fill("Existing remote Codex");
  await page.getByLabel("Runtime address").fill(fixture.url);
  await page
    .getByLabel("Runtime access token")
    .fill("invalid-token-at-least-32-characters");
  await button("Test & add machine").click();
  await expect(page.getByRole("alert")).toContainText("Could not reach Codex");
  await page.getByLabel("Runtime access token").fill(fixture.token);
  await page.screenshot({
    path: join(tmpdir(), "loop-remote-codex-setup.png"),
  });
  await button("Test & add machine").click();
  await page.getByText("Existing remote Codex", { exact: true }).waitFor();
  await expect(page.getByLabel("Runtime access token")).toHaveValue("");
  const host = (await api("/runtime-hosts")).find(
    (h) => h.name === "Existing remote Codex",
  );
  assert.equal(host.kind, "codex-app-server");
  await closeSheets(page);
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await button("Add a provider").click();
  await button("Claude").click();
  await expect(page.getByLabel("Run on", { exact: true })).toBeVisible();
  assert.equal(
    await page
      .getByLabel("Run on", { exact: true })
      .locator(`option[value="${host.id}"]`)
      .count(),
    0,
  );
  await button("Change provider").click();
  await button("ChatGPT").click();
  await page.getByLabel("Run on", { exact: true }).selectOption(host.id);
  await expect(
    page.getByText(/account already signed in on your remote/),
  ).toBeVisible();
  await page.locator(".connection-options summary").click();
  await page
    .getByLabel("Account name", { exact: true })
    .fill("Existing Codex account");
  assert.equal(
    await page
      .locator("dialog[open]")
      .last()
      .evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(tmpdir(), "loop-remote-codex-provider.png"),
  });
  await button("Connect remote ChatGPT").click();
  await page
    .getByRole("heading", { name: "ChatGPT connected", exact: true })
    .waitFor();
  await button("Done").click();
  const connection = (await api("/bootstrap")).connections.find(
    (c) => c.label === "Existing Codex account",
  );
  assert.equal(connection.status, "connected");
  const agent = await api("/agents", {
    name: "remote-codex-fixture",
    connectionId: connection.id,
    model: "fixture",
  });
  const run = await api("/runs", {
    agentId: agent.id,
    input: "Answer from the remote machine",
    idempotencyKey: crypto.randomUUID(),
  });
  await expect
    .poll(
      async () => (await api("/runs")).find((r) => r.id === run.id)?.state,
      { timeout: 15000 },
    )
    .toBe("completed");
  const conversation = await api("/conversations/" + run.conversation_id);
  assert.ok(
    conversation.messages.some(
      (m) => m.content === "Remote Codex fixture response.",
    ),
  );
  await harnessJourney(
    page,
    api,
    agent,
    "$fixture-skill",
    "Remote Codex fixture response.",
  );
  await openSettings(page);
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  await button("Custom").click();
  // App-server speaks the Codex protocol, never the broker's MCP endpoints.
  assert.equal(await page.locator(`option[value="${host.id}"]`).count(), 0);
  await closeSheets(page);
  await api("/connections/" + connection.id, {}, "DELETE");
  await api("/runtime-hosts/" + host.id, {}, "DELETE");
  assert.equal(
    fixture.calls.some((c) =>
      ["account/login/start", "account/logout"].includes(c.method),
    ),
    false,
  );
  console.log(
    "PASS: remote Codex pairing error/retry, existing-account setup, provider/MCP machine filtering, durable worker response and account-preserving disconnect (WebSocket fixture).",
  );
}
