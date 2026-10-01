import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import { harnessJourney } from "./harness-journey.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function remoteClaudeJourney(page, api, url) {
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).last();
  await openSettings(page);
  await page.getByRole("button", { name: /Runtime machines/ }).click();
  await page.getByLabel("Connection type").selectOption("native-host");
  await page.getByLabel("Machine name").fill("Native Claude laptop");
  await page.getByLabel("Runtime address").fill(url);
  await page
    .getByLabel("Runtime access token")
    .fill("native-browser-fixture-token-at-least-32-characters");
  await button("Test & add machine").click();
  await page.getByText("Native Claude laptop", { exact: true }).waitFor();
  const host = (await api("/runtime-hosts")).find(
    (h) => h.name === "Native Claude laptop",
  );
  assert.equal(host.kind, "native-host");
  await closeSheets(page);
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await button("Add a provider").click();
  await button("Claude").click();
  await page.getByLabel("Run on", { exact: true }).selectOption(host.id);
  await expect(
    page.getByText(/Claude account already signed in/),
  ).toBeVisible();
  await button("Connect remote Claude").click();
  await page
    .getByRole("heading", { name: "Claude connected", exact: true })
    .waitFor();
  await button("Done").click();
  const connection = (await api("/bootstrap")).connections.find(
    (c) => JSON.parse(c.metadata).runtimeHostId === host.id,
  );
  assert.equal(connection.provider, "anthropic");
  assert.equal(connection.status, "connected");
  const agent = await api("/agents", {
    name: "native-claude-fixture",
    connectionId: connection.id,
    model: "sonnet",
  });
  const run = await api("/runs", {
    agentId: agent.id,
    input: "Use this host",
    idempotencyKey: crypto.randomUUID(),
  });
  await expect
    .poll(async () => (await api("/runs")).find((r) => r.id === run.id)?.state)
    .toBe("completed");
  assert.ok(
    (await api(`/conversations/${run.conversation_id}`)).messages.some(
      (m) => m.content === "Native Claude fixture response.",
    ),
  );
  await harnessJourney(
    page,
    api,
    agent,
    "/fixture-command",
    "Native Claude fixture response.",
  );
  await api(`/connections/${connection.id}`, {}, "DELETE");
  await api(`/runtime-hosts/${host.id}`, {}, "DELETE");
  console.log(
    "PASS: native Claude machine pairing, provider identity, existing account connection, durable worker result and unpairing (protocol fixture).",
  );
}
