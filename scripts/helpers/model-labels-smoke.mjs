import { expect } from "@playwright/test";

export async function modelLabelsSmoke(page, fixture, capture) {
  const connection = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='anthropic'")
    .get();
  const artifact = fixture.db
    .prepare("SELECT * FROM artifacts WHERE id=?")
    .get(fixture.artifacts[0]);
  const run = fixture.db
    .prepare("SELECT * FROM runs WHERE state='running' LIMIT 1")
    .get();
  const metadata = {
    ...JSON.parse(artifact.metadata),
    connectionId: connection.id,
    provider: connection.provider,
    model: "default",
  };
  fixture.db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    JSON.stringify([
      ...JSON.parse(connection.models),
      {
        id: "default",
        name: "Default (recommended)",
        resolvedModel: "claude-opus-5-5",
      },
    ]),
    connection.id,
  );
  fixture.db
    .prepare("UPDATE artifacts SET metadata=? WHERE id=?")
    .run(JSON.stringify(metadata), artifact.id);
  fixture.db.prepare("UPDATE runs SET payload=? WHERE id=?").run(
    JSON.stringify({
      ...JSON.parse(run.payload),
      connectionId: connection.id,
      provider: connection.provider,
      model: "default",
    }),
    run.id,
  );
  const card = () =>
    page.locator(".feed-card").filter({
      has: page.getByRole("heading", { name: artifact.title, exact: true }),
    });
  try {
    // The preceding profile check can leave a Messages read in flight. Let
    // WebKit finish it before replacing the document for this fixture.
    await page.waitForLoadState("networkidle");
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await expect(card().locator(".card-model")).toHaveText("Claude Opus 5.5");
    await card().getByRole("button", { name: "Open output" }).click();
    const result = page.locator(".result-sheet[open]");
    await expect(result.locator(".result-author-details > span")).toHaveText(
      "Claude Opus 5.5",
    );
    await capture("resolved-default-result");
    await result.locator(".result-identity").click();
    // The agent currently uses Sonnet, but the saved result used default/Opus.
    await expect(page.locator(".profile-model")).toHaveText("Claude Sonnet");
    await page.getByRole("button", { name: "Results", exact: true }).click();
    await expect(card().locator(".card-model")).toHaveText("Claude Opus 5.5");
    await capture("resolved-default-profile-result");
    await page.waitForFunction(() => history.state?.loopSheet !== true);
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Running", exact: true })
      .click();
    const runningCard = page.locator(".run-card").filter({ hasText: run.input });
    await expect(runningCard.locator(".card-model")).toHaveText(
      "Claude Opus 5.5",
    );
    await capture("resolved-default-running");

    fixture.db
      .prepare("UPDATE artifacts SET metadata=? WHERE id=?")
      .run(
        JSON.stringify({ ...metadata, model: "claude-opus-4-8" }),
        artifact.id,
      );
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await expect(card().locator(".card-model")).toHaveText("Claude Opus 4.8");
  } finally {
    fixture.db
      .prepare("UPDATE connections SET models=? WHERE id=?")
      .run(connection.models, connection.id);
    fixture.db
      .prepare("UPDATE artifacts SET metadata=? WHERE id=?")
      .run(artifact.metadata, artifact.id);
    fixture.db
      .prepare("UPDATE runs SET payload=? WHERE id=?")
      .run(run.payload, run.id);
  }
  console.log("Default model labels and historical result versions passed");
}
