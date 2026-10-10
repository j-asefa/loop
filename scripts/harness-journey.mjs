import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";

// What needs you stacks above the Feed filters; show every card.
async function openNeeds(page) {
  const stack = page.getByRole("region", { name: "Needs you" });
  await expect(stack).toBeVisible();
  const all = stack.getByRole("button", { name: "Show all" });
  if (await all.isVisible()) await all.click();
}
export async function harnessJourney(page, api, agent, token, expected) {
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  const compose = page.getByRole("button", {
    name: "Compose a message",
    exact: true,
  });
  await compose.click();
  await page.getByLabel("Agent recipient").selectOption(agent.id);
  await page.getByLabel("Message your agent").fill(token[0]);
  let picker = page.getByRole("dialog", {
    name: "Commands & skills",
    exact: true,
  });
  await picker
    .getByRole("button", {
      name: new RegExp("^\\" + token[0] + token.slice(1) + " "),
    })
    .waitFor();
  await picker.getByLabel("Search commands and skills").fill("fixture");
  assert.equal(
    await picker.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(tmpdir(), `loop-harness-${agent.provider}.png`),
  });
  await picker.locator(".harness-option").filter({ hasText: token }).click();
  await expect(page.getByLabel("Message your agent")).toHaveValue(token + " ");
  await expect(page.getByLabel("Message your agent")).toBeFocused();
  const prompt = token + " inspect the project";
  await page.getByLabel("Message your agent").fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  let run;
  await expect
    .poll(
      async () => {
        run = (await api("/runs")).find(
          (r) => r.agent_id === agent.id && r.input === prompt,
        );
        return run?.state;
      },
      { timeout: 15000 },
    )
    .toBe("completed");
  const url = new URL(page.url());
  url.search = "?conversation=" + run.conversation_id;
  await page.goto(url.href);
  const conversation = page.locator("dialog[open]").last().first();
  await expect(conversation.locator(".message.assistant")).toContainText(
    expected,
  );
  await conversation
    .getByLabel("Reply to agent")
    .fill("Keep these reply instructions");
  await conversation
    .getByRole("button", { name: "Commands & skills", exact: true })
    .click();
  picker = page.getByRole("dialog", { name: "Commands & skills", exact: true });
  await picker.locator(".harness-option").filter({ hasText: token }).click();
  await expect(conversation.getByLabel("Reply to agent")).toHaveValue(
    token + " Keep these reply instructions",
  );
  await expect(conversation.getByLabel("Reply to agent")).toBeFocused();
  await conversation
    .getByRole("button", { name: "Close", exact: true })
    .click();
  console.log(
    "PASS: " +
      agent.provider +
      " runtime command discovery, search, slash shortcut, mobile picker, native dispatch, nested conversation picker and draft focus.",
  );
}
export async function failureJourney(page, api, dir) {
  // This case has its own request budget, independent of how quickly the
  // preceding provider/setup journeys ran on this machine.
  const limits = new Database(join(dir, "loop.db"));
  try {
    limits.pragma("busy_timeout = 10000");
    limits.prepare("DELETE FROM request_limits").run();
  } finally {
    limits.close();
  }
  const agent = (await api("/bootstrap")).agents.find(
    (a) => a.name === "creation-idle",
  );
  const run = await api("/runs", {
    agentId: agent.id,
    input: "failure-visibility-fixture",
    idempotencyKey: crypto.randomUUID(),
  });
  await expect
    .poll(async () => (await api("/runs")).find((r) => r.id === run.id)?.state)
    .toBe("failed");
  await page.goto(new URL("/", page.url()).href);
  // Failures surface in the Feed's "Needs you" bar.
  const nav = page.getByRole("navigation").last();
  await nav.getByRole("button", { name: "Feed", exact: true }).click();
  await openNeeds(page);
  const failedRow = page
    .locator(".inbox-row")
    .filter({ hasText: "failure-visibility-fixture" });
  await expect(failedRow).toHaveAttribute("aria-label", /, Failed$/);
  // A failed run leaves no result card on its agent's profile; failure
  // details moved from the Running card to the agent's Traces tab.
  await page
    .locator(".agent-strip button")
    .filter({ hasText: "@" + agent.name })
    .click();
  await page.getByRole("tab", { name: "Results", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(
    page.locator(".feed-card").filter({
      has: page.getByRole("heading", { name: "failure-visibility-fixture" }),
    }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Traces", exact: true }).click();
  await expect(
    page
      .locator(".trace-card")
      .filter({ hasText: "Run failure" })
      .filter({ hasText: "Tool input schema is unsupported" })
      .first(),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Feed", exact: true }).click();
  const url = new URL(page.url());
  url.search = "?conversation=" + run.conversation_id;
  await page.goto(url.href);
  const dialog = page.locator("dialog[open]").last().first();
  await expect(dialog.locator(".message.assistant")).toContainText(
    "Run failed",
  );
  await expect(dialog).not.toContainText("Working…");
  await expect(
    dialog.getByRole("button", { name: "Retry as a new run" }),
  ).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), "loop-failed-response.png") });
  await dialog.getByRole("button", { name: "Retry as a new run" }).click();
  await expect
    .poll(
      async () =>
        (await api("/runs")).filter(
          (r) =>
            r.agent_id === agent.id && r.input === "failure-visibility-fixture",
        ).length,
    )
    .toBe(2);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  console.log(
    "PASS: failed empty response kept out of results and shown in the Needs you stack, agent traces and conversation, and explicit retry.",
  );
}
