import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { designFixture } from "./design-fixture.mjs";
import { workspaceRecoverySmoke } from "./workspace-recovery-smoke.mjs";

// A separate fixture keeps submission and steering checks away from both real
// providers and the shared design fixture's navigation/count assertions.
export async function profileWorkSmoke(page, capture) {
  const fixture = await designFixture();
  const pendingReads = [];
  const runPattern = /\/api\/runs\?active=1(?:&|$)/;
  const dialog = () => page.locator("dialog[open]").last();
  const close = async () => {
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  try {
    await workspaceRecoverySmoke(page, fixture);
    // This scenario verifies API steering and receipts, independently of native
    // lifecycle. Retired direct harness connections cannot accept new work.
    const connection = await fixture.api("/connections", {
      provider: "openai",
      label: "Profile work API",
      secret: "fixture-only",
    });
    const agent = await fixture.api(
      `/agents/${fixture.agents[0].id}`,
      {
        connectionId: connection.id,
        model: connection.models[0].id,
      },
      "PATCH",
    );
    const team = (await fixture.api("/teams")).find((team) =>
      team.members.includes(agent.id),
    );
    const previous = fixture.db
      .prepare("SELECT * FROM conversations WHERE agent_id=?")
      .get(agent.id);
    const work = page.getByRole("region", {
      name: "Current work",
      exact: true,
    });
    const head = page.locator(".profile-head");
    const nav = (name) =>
      page.locator(".mobile-nav").getByRole("button", { name, exact: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.base}/?teams=${team.id}`, {
      waitUntil: "networkidle",
    });
    // A direct thread is correctly absent from the team Feed.
    await expect(
      page.locator(".inbox-row").filter({ hasText: previous.title }),
    ).toHaveCount(0);
    await page
      .getByRole("region", { name: "Your agents", exact: true })
      .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) })
      .click();
    await expect(head.locator("h1")).toHaveText(agent.name);
    // The same agent's profile must include personal results and threads.
    await page.getByRole("tab", { name: "Results", exact: true }).click();
    await expect(page.locator(".feed-card")).toContainText(previous.title);
    // "Open conversation" became the profile's Threads tab.
    const threads = async () => {
      await page.getByRole("tab", { name: "Threads", exact: true }).click();
      return page.locator(".inbox-row");
    };
    const openThread = async (title) =>
      (await threads()).filter({ hasText: title }).first().click();
    await openThread(previous.title);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(previous.id);
    await expect(dialog().locator(".message").first()).toContainText(
      previous.title,
    );
    const messages = await fixture.api(`/conversations/${previous.id}`);
    for (const message of messages.messages) {
      await expect(
        page.locator(`[id="message-${message.id}"] .message-meta time`),
      ).toHaveAttribute("datetime", new Date(message.created_at).toISOString());
    }
    // Drafts belong to their thread; the global composer keeps its own.
    const savedReply = "A draft for the member, not the team manager.";
    await dialog()
      .getByLabel("Reply to agent", { exact: true })
      .fill(savedReply);
    await close();
    await page.getByRole("button", { name: "Compose a message" }).click();
    await expect(page.getByLabel("Agent recipient")).toHaveValue(agent.id);
    await expect(page.locator(".composer textarea")).toHaveValue("");
    await page.getByLabel("Collapse composer").click();
    await openThread(previous.title);
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toHaveValue(savedReply);
    await dialog().getByLabel("Reply to agent", { exact: true }).fill("");
    await close();
    await page.getByRole("button", { name: "Compose a message" }).click();
    await page.getByLabel("Agent recipient").selectOption(team.manager_id);
    await page.getByLabel("Agent recipient").selectOption(agent.id);
    await page.getByLabel("Collapse composer").click();

    // Hold an older read, and every post-send refresh. The POST receipt itself
    // must immediately put the task in Current work and confirm the send.
    await page.route(runPattern, async (route) => {
      const response = await route.fetch();
      pendingReads.push(() => route.fulfill({ response }));
    });
    await page.getByRole("tab", { name: "Messages", exact: true }).click();
    await expect.poll(() => pendingReads.length).toBeGreaterThan(0);
    await head.getByRole("button", { name: "Message", exact: true }).click();
    const input = page.locator(".composer textarea");
    const prompt = "Check this direct task even with the team filter selected.";
    await input.fill(prompt);
    const fail = (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Fixture send unavailable" },
      });
    await page.route("**/api/runs", fail);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".composer-error")).toContainText(
      "Fixture send unavailable",
    );
    await expect(input).toHaveValue(prompt);
    await expect(page.locator(".send-confirmation")).toHaveCount(0);
    await page.unroute("**/api/runs", fail);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".send-confirmation")).toContainText(
      `Queued for @${agent.name}`,
    );
    await expect(work).toContainText("1 queued");
    await expect(work).toContainText(prompt);
    await expect.poll(() => pendingReads.length).toBeGreaterThan(1);
    await pendingReads.shift()();
    await expect(work).toContainText(prompt);
    while (pendingReads.length) await pendingReads.shift()();
    await page.unroute(runPattern);
    const accepted = fixture.db
      .prepare("SELECT * FROM runs WHERE input=?")
      .get(prompt);
    assert(accepted);
    assert.equal(JSON.parse(accepted.payload).teamId, undefined);
    await expect(
      page
        .locator(".send-confirmation")
        .getByRole("button", { name: "View conversation" }),
    ).toBeInViewport({ ratio: 1 });
    await capture("profile-send-confirmation");
    await page
      .locator(".send-confirmation")
      .getByRole("button", { name: "View conversation" })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(accepted.conversation_id);
    await expect(dialog().locator(".message").first()).toContainText(prompt);
    await close();

    // Simulate the worker claiming this run. Profile and conversation access
    // stay unfiltered, while the team Running tab still excludes personal work.
    fixture.db
      .prepare(
        "UPDATE runs SET state='running',worker_id='audit-fixture',heartbeat=?,updated_at=? WHERE id=?",
      )
      .run(Date.now() + 99999999, Date.now(), accepted.id);
    await page.getByRole("tab", { name: "Results", exact: true }).click();
    await expect(work).toContainText("1 running");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await work.scrollIntoViewIfNeeded();
        await capture(`profile-current-work-${theme}-${width}`);
      }
    }
    const agentThreads = await threads();
    await expect(agentThreads).toHaveCount(2);
    await expect(agentThreads.first()).toContainText(prompt);
    await agentThreads.first().click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(accepted.conversation_id);
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(dialog().locator(".message").first()).toContainText(prompt);
    await close();

    // Follow-ups to a running task are acknowledged as steering, never shown
    // as a second queued task.
    await head.getByRole("button", { name: "Message", exact: true }).click();
    await input.fill("Prioritize the most recent changes.");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".send-confirmation")).toContainText(
      `Follow-up accepted for @${agent.name}`,
    );
    await expect(work).toContainText("1 running");
    await expect(work.locator("li")).toHaveCount(1);
    assert.equal(
      fixture.db
        .prepare("SELECT count(*) count FROM run_steering WHERE run_id=?")
        .get(accepted.id).count,
      1,
    );
    await page
      .getByRole("button", { name: "Dismiss send confirmation" })
      .click();
    // The team-scoped Feed still excludes personal work from Working/Queued.
    await nav("Feed").click();
    await expect(page.locator(".profile-head")).toHaveCount(0);
    for (const filter of [/^Working/, /^Queued/]) {
      await page.getByRole("tab", { name: filter }).click();
      await expect(page.locator(".inbox-empty")).toBeVisible();
      await expect(
        page.locator(".inbox-row").filter({ hasText: prompt }),
      ).toHaveCount(0);
    }
    await page.goto(fixture.base + "/?filter=working", {
      waitUntil: "networkidle",
    });
    await expect(
      page.locator(".inbox-row").filter({ hasText: prompt }),
    ).toHaveCount(1);
    console.log(
      "Profile scope, conversation access, send receipt and steering passed",
    );
  } finally {
    while (pendingReads.length)
      await pendingReads
        .shift()()
        .catch(() => {});
    await page.unroute(runPattern);
    await page.goto("about:blank");
    await fixture.close();
  }
}
