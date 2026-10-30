import { openAgentProfile } from "./browser-ui.mjs";
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
  const author = fixture.db
    .prepare("SELECT name FROM agents WHERE id=?")
    .get(artifact.agent_id).name;
  // Result cards live on the author's profile.
  const results = async () => {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await openAgentProfile(page, author);
  };
  try {
    // The preceding profile check can leave a Messages read in flight. Let
    // WebKit finish it before replacing the document for this fixture.
    await page.waitForLoadState("networkidle");
    await results();
    await expect(card().locator(".card-model")).toHaveText("Claude Opus 5.5");
    await card().getByRole("button", { name: "View full result" }).click();
    const result = page.locator(".result-sheet[open]");
    await expect(result.locator(".result-author-details > span")).toHaveText(
      "Claude Opus 5.5",
    );
    await capture("resolved-default-result");
    await result.locator(".result-identity").click();
    // The agent currently uses Sonnet, but the saved result used default/Opus.
    await expect(page.locator(".profile-model")).toHaveText("Claude Sonnet");
    await page.getByRole("tab", { name: "Results", exact: true }).click();
    await expect(card().locator(".card-model")).toHaveText("Claude Opus 5.5");
    await capture("resolved-default-profile-result");
    await page.waitForFunction(() => history.state?.loop55Sheet !== true);
    // Running cards (with a per-run model label) were replaced by Feed rows;
    // the run on the default model still appears under Working.
    await page.goto(fixture.base + "/?filter=working", {
      waitUntil: "networkidle",
    });
    await expect(
      page.locator(".inbox-row").filter({ hasText: run.input }),
    ).toHaveAttribute("aria-label", /, Working$/);
    await capture("resolved-default-running");

    fixture.db
      .prepare("UPDATE artifacts SET metadata=? WHERE id=?")
      .run(
        JSON.stringify({ ...metadata, model: "claude-opus-4-8" }),
        artifact.id,
      );
    await results();
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
