import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function teamNavigationSmoke(page, fixture, engine, capture) {
  const teams = await fixture.api("/teams");
  const product = teams.find((team) => team.name === "Product and engineering");
  const manager = fixture.agents.find(
    (agent) => agent.id === product.manager_id,
  );
  const member = fixture.agents[1];
  const second = await fixture.api("/teams", {
    name: `Release readiness and compatibility review ${engine}`,
    managerId: manager.id,
    members: [member.id],
  });
  const dialog = () => page.locator("dialog[open]").last();
  const settled = async () => {
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    // Closing the last sheet schedules history.back(). Wait for its popstate
    // before starting another document navigation, which it would otherwise abort.
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const close = async () => {
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await settled();
  };
  const shortcut = () =>
    page
      .locator(".team-manager-shortcut")
      .getByRole("button", { name: "Message manager", exact: true });
  const checkConversation = async (team) => {
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(team.conversation_id);
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + manager.name,
    );
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toBeVisible();
  };
  const profile = async (agent) => {
    await settled();
    await page.goto(fixture.base);
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/feed" &&
        url.searchParams.get("agent") === agent.id
      );
    });
    await page
      .getByRole("region", { name: "Your agents", exact: true })
      .getByRole("button", { name: new RegExp(`^@${agent.name} ·`) })
      .click();
    await expect(page.locator(".profile-head h1")).toHaveText("@" + agent.name);
    await loaded;
    await expect(
      page.locator(".trace-list [role=status], .feed [role=status]"),
    ).toHaveCount(0);
    // The profile restores its last tab. Messages and Traces load separately
    // from /feed; finish those reads before a later hard navigation cancels them.
    await page.waitForLoadState("networkidle");
  };
  // Sending from a thread keeps it open; the draft clears once accepted.
  const sentInThread = async () => {
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toHaveValue("");
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await close();
  };
  const requests = [];
  const send = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ id: "accepted" }),
    });
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.base);
    await expect(
      page.getByRole("button", { name: "Filter by team: All teams" }),
    ).toBeVisible();
    await expect(shortcut()).toHaveCount(0);
    await page.getByRole("tab", { name: /^Working/ }).click();
    await expect(page).toHaveURL(/filter=working/);
    await expect(shortcut()).toHaveCount(0);
    await page.goto(`${fixture.base}/?teams=${product.id},${second.id}`);
    await shortcut().click();
    await expect(dialog()).toHaveAttribute(
      "aria-label",
      "Message a team manager",
    );
    await expect(dialog().locator(".team-manager-option")).toHaveCount(2);
    await capture("team-managers");
    await dialog()
      .getByRole("button", {
        name: `Message manager of ${product.name}`,
        exact: true,
      })
      .click();
    await checkConversation(product);
    await close();

    // One selected team goes straight to its conversation, including when the
    // same manager is also responsible for another team's conversation.
    await page.goto(`${fixture.base}/?teams=${second.id}`);
    await expect(shortcut()).toContainText("@" + manager.name);
    await capture("team-manager-shortcut");
    await shortcut().click();
    await checkConversation(second);
    await page.route("**/api/runs", send);
    await dialog()
      .getByLabel("Reply to agent", { exact: true })
      .fill("Coordinate this team's next review.");
    await dialog()
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await sentInThread();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].agentId, manager.id);
    assert.equal(requests[0].conversationId, second.conversation_id);

    await page.goto(`${fixture.base}/?teams=${product.id},${second.id}`);
    await shortcut().click();
    await expect(dialog().locator(".team-manager-option")).toHaveCount(2);
    await close();
    await page.getByRole("button", { name: /^Filter by team:/ }).click();
    await dialog()
      .getByRole("button", { name: /^All teams/ })
      .click();
    await dialog().getByRole("button", { name: "Done", exact: true }).click();
    await settled();
    await expect(shortcut()).toHaveCount(0);

    await profile(member);
    const memberships = page.getByRole("group", {
      name: "Agent teams",
      exact: true,
    });
    await expect(memberships.locator(".profile-team")).toHaveCount(2);
    await expect(memberships.locator("small")).toHaveText(["Member", "Member"]);
    await expect(memberships).toContainText(product.name);
    await expect(memberships).toContainText(second.name);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await capture(`profile-teams-${theme}-${width}`);
      }
    }
    await memberships
      .getByRole("button", {
        name: `Message manager of ${product.name}`,
        exact: true,
      })
      .click();
    await checkConversation(product);
    await dialog()
      .getByLabel("Reply to agent", { exact: true })
      .fill("Follow up on product work.");
    await dialog()
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await sentInThread();
    assert.equal(requests[1].agentId, manager.id);
    assert.equal(requests[1].conversationId, product.conversation_id);

    await memberships
      .getByRole("link", { name: `Open team ${product.name}`, exact: true })
      .click();
    await expect(page.locator(".profile-head")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: `Filter by team: ${product.name}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(shortcut()).toContainText("@" + manager.name);
    assert.equal(new URL(page.url()).searchParams.get("teams"), product.id);
    await capture("profile-team-link-destination");

    await profile(manager);
    await expect(page.locator(".profile-teams small")).toHaveText([
      "Manager",
      "Manager",
    ]);
    await profile(fixture.agents[10]);
    await expect(page.getByRole("group", { name: "Agent teams" })).toHaveCount(
      0,
    );
  } finally {
    await page.unroute("**/api/runs", send);
    await fixture.api(`/teams/${second.id}`, undefined, "DELETE");
  }
  await profile(member);
  await expect(page.locator(".profile-team")).toHaveCount(1);
  await expect(page.locator(".profile-team")).toContainText(product.name);
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  console.log(`${engine}: team memberships and direct manager routing passed`);
}
