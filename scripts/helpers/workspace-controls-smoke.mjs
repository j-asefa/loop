import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function workspaceControlsSmoke(page, fixture, engine, capture) {
  const dialog = () => page.locator("dialog[open]").last();
  const settled = async () => {
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const close = async () => {
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await settled();
  };
  // Model changes apply to future runs. Use an idle agent here; replies to an
  // active agent now steer its existing run with that run's original settings.
  const recipient = fixture.agents.find(
    (agent) =>
      ["claude", "anthropic"].includes(agent.provider) &&
      !fixture.db
        .prepare(
          "SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','awaiting_approval')",
        )
        .get(agent.id),
  );
  assert(recipient, "Fixture needs an idle Claude agent for model selection");
  const connection = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='codex'")
    .get();
  const models = JSON.parse(connection.models);
  models[1].effortLevels = [
    { value: "low" },
    { value: "xhigh", description: "Take more time to check difficult work." },
  ];
  models[1].defaultEffort = "low";
  fixture.db
    .prepare("UPDATE connections SET models=? WHERE id=?")
    .run(JSON.stringify(models), connection.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.base);
  const runningNav = page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Running", exact: true });
  await expect(runningNav.locator("small")).toHaveCount(1);
  await expect(runningNav.locator("small")).toHaveAttribute(
    "aria-label",
    "1 agent running",
  );
  const icon = await runningNav.locator("svg").boundingBox();
  const badge = await runningNav.locator("small").boundingBox();
  assert(badge.x > icon.x + icon.width / 2 && badge.y < icon.y);
  const runs = await fixture.api("/runs?active=1");
  const running = runs.find((run) => run.state === "running");
  let navRuns = [
    ...runs,
    { ...running, id: "duplicate-active-run" },
    {
      ...running,
      id: "still-pausing",
      agent_id: fixture.agents[0].id,
      state: "pausing",
    },
    {
      ...running,
      id: "waiting-for-children",
      agent_id: fixture.agents[2].id,
      state: "waiting_children",
    },
  ];
  const runPattern = /\/api\/runs\?active=1&teams=/;
  const counts = (route) => route.fulfill({ json: navRuns });
  await page.route(runPattern, counts);
  try {
    await page.reload();
    await expect(runningNav.locator("small")).toHaveCount(1);
    await expect(runningNav.locator("small")).toHaveText("2");
    await capture("single-running-badge");
    navRuns = navRuns.filter(
      (run) => !["running", "pausing"].includes(run.state),
    );
    await page.reload();
    await expect(page.locator(".attention-banner")).toBeVisible();
    await expect(runningNav.locator("small")).toHaveCount(0);
  } finally {
    await page.unroute(runPattern, counts);
  }
  await page.reload();
  await page.locator(".composer-launch").click();
  await page
    .getByLabel("Agent recipient", { exact: true })
    .selectOption(recipient.id);
  const composer = page.locator(".composer");
  await expect(composer.getByLabel("Project", { exact: true })).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: /Create an agent|Workflows/ }),
  ).toHaveCount(0);
  await expect(page.locator(".mobile-nav .running-count")).toHaveCSS(
    "background-color",
    "rgb(201, 162, 39)",
  );
  await composer
    .getByRole("button", { name: "Select model and effort", exact: true })
    .click();
  await expect(
    dialog().getByRole("heading", { name: "Select model", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  assert(
    await dialog()
      .locator(".sheet-body")
      .evaluate((el) => el.clientHeight > 100),
    "The model sheet must show its content, not only the drag handle",
  );
  const modelsGroup = dialog().getByRole("radiogroup", {
    name: "Models",
    exact: true,
  });
  const astra = modelsGroup.getByRole("radio", {
    name: "GPT-6 Astra · Codex · Personal ChatGPT",
    exact: true,
  });
  const sonnet = modelsGroup.getByRole("radio", {
    name: "Claude Sonnet · Claude Code · Personal Claude",
    exact: true,
  });
  await expect(astra).toBeVisible();
  await expect(sonnet).toHaveAttribute("aria-checked", "true");
  await expect(
    dialog().getByRole("button", { name: /^Effort/ }),
  ).toBeDisabled();
  await expect(dialog().getByRole("combobox")).toHaveCount(0);
  await page.route(`**/api/agents/${recipient.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic model failure" }),
        })
      : route.continue(),
  );
  await astra.click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Synthetic model failure",
  );
  await expect(sonnet).toHaveAttribute("aria-checked", "true");
  await expect(astra).toHaveAttribute("aria-checked", "false");
  await page.unroute(`**/api/agents/${recipient.id}`);
  let releaseBootstrap;
  let bootstrapRequests = 0;
  await page.route("**/api/bootstrap", async (route) => {
    if (++bootstrapRequests !== 1) return route.continue();
    const response = await route.fetch();
    releaseBootstrap = () => route.fulfill({ response });
  });
  await astra.click();
  await expect(astra).toHaveAttribute("aria-checked", "true");
  await expect(dialog().getByRole("button", { name: /^Effort/ })).toContainText(
    "Low (default)",
  );
  await expect.poll(() => typeof releaseBootstrap).toBe("function");
  await dialog()
    .getByRole("button", { name: /^Effort/ })
    .click();
  const effort = dialog().getByRole("radiogroup", {
    name: "Effort",
    exact: true,
  });
  await expect(effort.getByRole("radio")).toHaveCount(3);
  await effort.getByRole("radio", { name: /^Extra high/ }).click();
  await expect(
    effort.getByRole("radio", { name: /^Extra high/ }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(dialog()).toContainText(
    "Take more time to check difficult work.",
  );
  await expect.poll(() => bootstrapRequests).toBeGreaterThan(1);
  // An older model-only refresh must not overwrite the newer effort selection.
  await releaseBootstrap();
  await page.unroute("**/api/bootstrap");
  await capture("composer-model-options");
  assert.deepEqual(
    fixture.db
      .prepare("SELECT connection_id,model,effort FROM agents WHERE id=?")
      .get(recipient.id),
    { connection_id: connection.id, model: "gpt-6-astra", effort: "xhigh" },
  );
  await dialog().getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(
    composer.getByRole("button", {
      name: "Select model and effort",
      exact: true,
    }),
  ).toContainText("GPT-6 Astra");
  await expect(
    composer.getByRole("button", {
      name: "Select model and effort",
      exact: true,
    }),
  ).toContainText("Extra high effort");
  // Attachment choices open the native file picker with the right media hints.
  await composer
    .getByRole("button", { name: "Add attachments", exact: true })
    .click();
  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(
      dialog().getByRole("heading", { name: "Add to message", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    for (const name of ["Camera", "Photos", "Files"])
      await expect(
        dialog().getByRole("button", { name, exact: true }),
      ).toBeInViewport({ ratio: 1 });
  }
  await expect(
    composer.getByLabel("Take a photo", { exact: true }),
  ).toHaveAttribute("capture", "environment");
  await expect(
    composer.getByLabel("Choose photos", { exact: true }),
  ).toHaveAttribute("accept", "image/*");
  await capture("attachment-options");
  const name = `brief-${engine}.txt`;
  const chooser = page.waitForEvent("filechooser");
  await dialog().getByRole("button", { name: "Files", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("Review these project notes."),
  });
  await expect(page.locator(".composer .attachment-list")).toContainText(name);
  await page.reload();
  await page.locator(".composer-launch").click();
  await expect(page.locator(".composer .attachment-list")).toContainText(name);
  await page.locator(".composer textarea").fill("Read the attached brief.");
  await page.route("**/api/runs", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic send failure" }),
        })
      : route.continue(),
  );
  await page
    .locator(".composer")
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(page.locator(".composer .attachment-list")).toContainText(name);
  await expect(page.locator(".composer textarea")).toHaveValue(
    "Read the attached brief.",
  );
  await page.unroute("**/api/runs");
  await capture("composer-upload");
  await page
    .locator(".composer")
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(page.locator(".composer")).not.toBeVisible();
  const sent = fixture.db
    .prepare("SELECT * FROM runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 1")
    .get(recipient.id);
  const fileId = JSON.parse(sent.payload).attachmentIds[0];
  const userMessage = fixture.db
    .prepare("SELECT metadata FROM messages WHERE run_id=? AND role='user'")
    .get(sent.id);
  assert.equal(JSON.parse(userMessage.metadata).attachments[0].id, fileId);
  assert.equal(JSON.parse(sent.payload).effort, "xhigh");
  await page.goto(fixture.base + "/?conversation=" + sent.conversation_id);
  await expect(dialog().locator(".message .attachment-list")).toContainText(
    name,
  );
  await expect(
    dialog().locator(".conversation-composer .attachment-list"),
  ).toHaveCount(0);
  // A short attachment sheet must also size correctly over a full-height chat.
  await dialog()
    .getByRole("button", { name: "Add attachments", exact: true })
    .click();
  await expect(
    dialog().getByRole("heading", { name: "Add to message", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    dialog().getByRole("button", { name: "Files", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await dialog().getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await dialog()
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({
      name: "follow-up.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("More context"),
    });
  await expect(
    dialog().locator(".conversation-composer .attachment-list"),
  ).toContainText("follow-up.txt");
  await dialog()
    .getByLabel("Reply to agent", { exact: true })
    .fill("Read this too.");
  await dialog()
    .getByRole("button", { name: "Send reply", exact: true })
    .click();
  await settled();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("conversation"))
    .toBe(null);
  const team = await fixture.api("/teams", {
    name: `Disposable ${engine}`,
    managerId: fixture.agents[4].id,
    members: [fixture.agents[5].id],
  });
  await page.reload();
  await page.getByRole("button", { name: /Filter by team:/ }).click();
  await dialog().getByLabel(team.name, { exact: true }).check();
  await dialog()
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Keep team", exact: true })
    .click();
  assert((await fixture.api("/teams")).some((item) => item.id === team.id));
  await dialog()
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await capture("delete-team");
  await dialog()
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Filter by team: All teams",
      exact: true,
    }),
  ).toBeVisible();
  assert(!(await fixture.api("/teams")).some((item) => item.id === team.id));
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: /^Loop 4 agents/ }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: `project-${engine}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("A project file"),
  });
  await expect(
    page.locator(".file-row").filter({ hasText: `project-${engine}.txt` }),
  ).toBeVisible();
  await capture("project-upload");
  // Restore shared fixture settings before the other browser's design checks.
  await fixture.api(
    `/agents/${recipient.id}`,
    {
      connectionId: recipient.connection_id,
      model: recipient.model,
      effort: null,
    },
    "PATCH",
  );
  fixture.db
    .prepare("UPDATE connections SET models=? WHERE id=?")
    .run(connection.models, connection.id);
  fixture.db
    .prepare(
      "UPDATE runs SET state='cancelled' WHERE agent_id=? AND state='queued'",
    )
    .run(recipient.id);
}
