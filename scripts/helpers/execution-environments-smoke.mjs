import {
  chooseAgentConnection,
  openAgentModelOptions,
} from "./agent-model-options.mjs";
import { expect } from "@playwright/test";

// Exercise the production Feed and creation form with legacy metadata, named
// Docker destinations and an agent that has since changed connections.
export async function executionEnvironmentsSmoke(
  page,
  fixture,
  _engine,
  capture,
) {
  let computer = "Alex’s MacBook Pro";
  const thread = fixture.conversations.find((item) => item.state === "running");
  const connection = fixture.db
    .prepare(
      "SELECT c.*,a.id AS agent_id FROM runs r JOIN agents a ON a.id=r.agent_id JOIN connections c ON c.id=a.connection_id WHERE r.id=?",
    )
    .get(thread.run);
  const setEnvironment = (location, name) =>
    fixture.db
      .prepare(
        "UPDATE connections SET metadata=json_set(metadata,'$.location',?,'$.environmentName',?) WHERE id=?",
      )
      .run(location, name, connection.id);
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, environmentName: computer },
    });
  });
  try {
    setEnvironment("laptop", "This laptop");
    await page.goto(fixture.base + "/?filter=working");
    const card = page.locator(".inbox-card").filter({ hasText: thread.title });
    const strip = page.getByRole("region", {
      name: "Your agents",
      exact: true,
    });
    await expect(card.locator(".agent-environment.laptop")).toHaveText(
      computer,
    );
    await expect(
      strip.locator(".agent-shortcut-environment").first(),
    ).toHaveText(computer);
    const checkDestinations = async (names) => {
      await strip
        .getByRole("button", { name: "New agent", exact: true })
        .click();
      const sheet = page.getByRole("dialog", { name: "New chat" });
      await sheet.getByText("Customize", { exact: true }).click();
      await openAgentModelOptions(sheet);
      for (const [id, name] of names) {
        await expect(
          sheet.getByRole("radiogroup", { name: "Connection", exact: true }),
        ).toContainText(name);
        await chooseAgentConnection(sheet, { id });
        await expect(sheet.locator(".connection-details")).toContainText(name);
      }
      await expect(sheet).not.toContainText("This laptop");
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
    };
    await checkDestinations([[connection.id, computer]]);

    computer = "Docker · research/loop";
    setEnvironment("docker", computer);
    const secondName = "Docker · research/app";
    const secondId = "second-docker";
    fixture.db
      .prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,'connected',?,?,?)",
      )
      .run(
        secondId,
        fixture.owner,
        connection.provider,
        secondName + " · Codex",
        "",
        connection.models,
        JSON.stringify({ location: "docker", environmentName: secondName }),
        Date.now(),
      );
    // The current run still belongs to the first destination.
    fixture.db
      .prepare("UPDATE agents SET connection_id=? WHERE id=?")
      .run(secondId, connection.agent_id);
    await page.reload();
    await expect(card.locator(".agent-environment.docker")).toHaveText(
      computer,
    );
    await expect(
      strip.locator(".agent-shortcut-environment").first(),
    ).toHaveText(secondName);
    await checkDestinations([
      [connection.id, computer],
      [secondId, secondName],
    ]);
    await capture("named-docker-environments");
  } finally {
    // Complete bootstrap interceptions before the browser context is disposed.
    await page.unrouteAll({ behavior: "wait" });
  }
}
