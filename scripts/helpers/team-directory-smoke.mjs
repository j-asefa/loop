import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openAgentProfile, openChatOptions } from "./browser-ui.mjs";

export async function teamDirectorySmoke(page, fixture, team) {
  const projects = [];
  const directory = () => page.locator("dialog[open]").last();
  const teams = () =>
    page
      .locator(".sidebar")
      .getByRole("button", { name: "Teams", exact: true });
  const composer = () => page.locator(".main-column > .composer-dock");
  const expand = () =>
    composer().getByRole("button", { name: "Compose a message" }).click();
  const open = async (target = team) => {
    await teams().click();
    await directory()
      .locator(".team-directory-item")
      .filter({ has: page.getByText(target.name, { exact: true }) })
      .locator(".team-manager-option")
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
    await expect(page.locator(".profile-head")).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("teams"))
      .toBe(target.id);
  };
  try {
    for (let i = 0; i < 16; i++)
      projects.push(
        await fixture.api("/folders", {
          name: `Directory regression ${i}`,
          kind: "project",
        }),
      );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    // Check the hit target before Playwright can scroll the button into view.
    assert(
      await teams().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          el.contains(
            document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            ),
          )
        );
      }),
      "Teams remains reachable with many projects",
    );

    const sidebar = page.locator(".sidebar");
    assert.match(
      await sidebar.evaluate((el) => getComputedStyle(el).overflowY),
      /auto|scroll/,
      "The sidebar scrolls to projects below the viewport",
    );
    await sidebar.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const lastProject = sidebar.getByRole("button", {
      name: projects.at(-1).name,
      exact: true,
    });
    assert(
      await lastProject.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          el.contains(
            document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            ),
          )
        );
      }),
      "The last project is a reachable hit target after scrolling",
    );
    await lastProject.click();
    await expect(page.locator(".project-heading h2")).toHaveText(
      projects.at(-1).name,
    );
    await sidebar.evaluate((el) => {
      el.scrollTop = 0;
    });

    await openAgentProfile(page, fixture.agents[1].name);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.waitForLoadState("networkidle");
    // A long page behind the sheet must not restore its old offset on close.
    await page.evaluate(() => window.scrollTo(0, 300));
    assert(await page.evaluate(() => scrollY > 0));
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/cards" &&
        url.searchParams.get("view") === "done" &&
        url.searchParams.get("teams") === team.id
      );
    });
    await open();
    assert.equal(
      new URL((await loaded).url()).searchParams.get("view"),
      "done",
    );
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await expand();
    await expect(composer().getByLabel("Agent recipient")).toHaveValue(
      team.manager_id,
    );

    for (const recipient of [fixture.agents[2].id, "__route__"]) {
      await openChatOptions(page);
      await composer().getByLabel("Agent recipient").selectOption(recipient);
      await composer()
        .getByLabel("Message your agent", { exact: true })
        .fill("Please re-run the lint fix");
      await open();
      await expand();
      await expect(composer().getByLabel("Agent recipient")).toHaveValue(
        recipient,
      );
      await expect(
        composer().getByLabel("Message your agent", { exact: true }),
      ).toHaveValue("Please re-run the lint fix");
    }
    // An attachment-only draft also owns its recipient, including when the
    // team filter changes and the automatic recipient-selection effect runs.
    await composer().getByLabel("Message your agent", { exact: true }).fill("");
    await composer()
      .getByLabel("Agent recipient")
      .selectOption(fixture.agents[10].id);
    await composer()
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "review.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Review this file"),
      });
    await expect(
      composer().getByRole("button", { name: "Remove review.txt" }),
    ).toBeVisible();
    const otherTeam = (await fixture.api("/teams")).find(
      (item) => item.id !== team.id,
    );
    await open(otherTeam);
    await expand();
    await expect(composer().getByLabel("Agent recipient")).toHaveValue(
      fixture.agents[10].id,
    );
    await expect(
      composer().getByRole("button", { name: "Remove review.txt" }),
    ).toBeVisible();
    await composer().getByRole("button", { name: "Remove review.txt" }).click();
    await teamEditingSmoke(page, fixture);
  } finally {
    for (const project of projects)
      fixture.db.prepare("DELETE FROM folders WHERE id=?").run(project.id);
    await page.goto(fixture.base, { waitUntil: "networkidle" });
  }
}

async function teamEditingSmoke(page, fixture) {
  const connection = await fixture.api("/connections", {
    provider: "openai",
    label: "Disconnected team fixture",
    secret: "fixture-only-not-a-real-key",
  });
  const disconnected = fixture.agents[10];
  fixture.db
    .prepare("UPDATE agents SET connection_id=? WHERE id=?")
    .run(connection.id, disconnected.id);
  const team = await fixture.api("/teams", {
    name: "Worker replacement regression",
    managerId: fixture.agents[8].id,
    members: fixture.agents.slice(0, 8).map((agent) => agent.id),
  });
  const dialog = () => page.locator("dialog[open]").last();
  const row = () =>
    dialog()
      .locator(".team-directory-item")
      .filter({
        has: page.getByText(team.name, { exact: true }),
      });
  const close = () =>
    dialog().getByRole("button", { name: "Close", exact: true }).click();
  try {
    await fixture.api(`/connections/${connection.id}`, undefined, "DELETE");
    fixture.db
      .prepare("UPDATE agents SET retired_at=? WHERE id=?")
      .run(Date.now(), fixture.agents[0].id);
    // Check the same sheet journeys on a phone and a desktop viewport.
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      if (width === 390) {
        await page
          .getByRole("button", { name: "Projects", exact: true })
          .click();
        await page
          .locator(".projects-view")
          .getByRole("button", { name: /^Agent teams/ })
          .click();
      } else {
        await page
          .locator(".sidebar")
          .getByRole("button", { name: "Teams", exact: true })
          .click();
      }
      await expect(row()).toContainText("7 workers");
      await expect(
        row().getByRole("button", { name: "Add worker" }),
      ).toBeEnabled();
      for (const exit of [
        close,
        () => page.keyboard.press("Escape"),
        () => page.goBack(),
      ]) {
        await row().getByRole("button", { name: "Add worker" }).click();
        await expect(dialog()).toHaveAttribute(
          "aria-label",
          `Add a worker to ${team.name}`,
        );
        await expect(
          dialog().getByRole("button", {
            name: `@${disconnected.name}`,
          }),
        ).toHaveCount(0);
        await expect(
          dialog().getByRole("button", {
            name: `@${fixture.agents[9].name}`,
          }),
        ).toBeVisible();
        await exit();
        await expect(dialog()).toHaveAttribute("aria-label", "Agent teams");
      }
      for (const exit of [
        close,
        () => page.keyboard.press("Escape"),
        () => page.goBack(),
      ]) {
        await dialog()
          .getByRole("button", { name: "New team", exact: true })
          .click();
        await expect(dialog()).toHaveAttribute(
          "aria-label",
          "Create an agent team",
        );
        await expect(
          dialog()
            .getByLabel("Manager", { exact: true })
            .locator(`option[value="${disconnected.id}"]`),
        ).toHaveCount(0);
        await expect(
          dialog().getByRole("checkbox", {
            name: `@${disconnected.name}`,
          }),
        ).toHaveCount(0);
        // Agent names alone don't say which model each agent runs.
        await expect(
          dialog()
            .getByLabel("Manager", { exact: true })
            .locator(`option[value="${fixture.agents[9].id}"]`),
        ).toHaveText(new RegExp(`^@${fixture.agents[9].name} · \\S`));
        await exit();
        await expect(dialog()).toHaveAttribute("aria-label", "Agent teams");
      }
      await dialog()
        .getByRole("button", { name: "New team", exact: true })
        .click();
      await dialog()
        .getByRole("button", { name: "Create another agent", exact: true })
        .click();
      await expect(dialog()).not.toHaveAttribute(
        "aria-label",
        "Create an agent team",
      );
      await close();
      await expect(dialog()).toHaveAttribute(
        "aria-label",
        "Create an agent team",
      );
      await close();
      await expect(dialog()).toHaveAttribute("aria-label", "Agent teams");
      if (width === 1280) {
        await row().getByRole("button", { name: "Add worker" }).click();
        await dialog()
          .getByRole("button", {
            name: `@${fixture.agents[9].name}`,
          })
          .click();
        await expect(row()).toContainText("8 workers");
        await expect(
          row().getByRole("button", { name: "Add worker" }),
        ).toBeDisabled();
        const updated = (await fixture.api("/teams")).find(
          (item) => item.id === team.id,
        );
        assert.equal(
          updated.members.length,
          9,
          "Retired membership history is preserved",
        );
        assert(updated.members.includes(fixture.agents[9].id));
      }
      await close();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await page.waitForFunction(() => history.state?.loopSheet !== true);
    }
  } finally {
    fixture.db
      .prepare("UPDATE agents SET retired_at=NULL WHERE id=?")
      .run(fixture.agents[0].id);
    await fixture.api(`/teams/${team.id}`, undefined, "DELETE");
    fixture.db
      .prepare("UPDATE agents SET connection_id=? WHERE id=?")
      .run(disconnected.connection_id, disconnected.id);
    fixture.db.prepare("DELETE FROM connections WHERE id=?").run(connection.id);
  }
}
