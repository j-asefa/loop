import {
  chooseAgentConnection,
  chooseAgentModel,
  openAgentModelOptions,
} from "./agent-model-options.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function markdownDefinitionsSmoke(
  page,
  fixture,
  _engine,
  capture,
) {
  const connection = await fixture.api("/connections", {
    provider: "openai",
    label: "Markdown fixture",
    secret: "fixture-only-not-a-real-key",
  });
  const model = (
    typeof connection.models === "string"
      ? JSON.parse(connection.models)
      : connection.models
  )[0].id;
  const project = await fixture.api("/folders", {
    name: "Markdown project",
    kind: "project",
  });
  const dialog = () => page.locator("dialog[open]").last();
  const openTeams = async () => {
    // Stay in the app so navigation does not cancel the post-creation refresh.
    const sheets = page.locator("dialog[open]");
    for (
      let count = await sheets.count();
      count;
      count = await sheets.count()
    ) {
      await sheets
        .last()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(sheets).toHaveCount(count - 1);
    }
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page
      .locator(".projects-view")
      .getByRole("button", { name: /^Agent teams/ })
      .click();
  };
  const upload = async (kind, text) => {
    await dialog()
      .getByRole("button", { name: `New ${kind} definition`, exact: true })
      .click();
    await dialog()
      .getByLabel("Import Markdown file")
      .setInputFiles({
        name: `${kind}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from(text),
      });
    await expect(
      dialog().getByRole("textbox", {
        name: "Markdown definition",
        exact: true,
      }),
    ).toHaveValue(text);
    await dialog()
      .getByRole("button", { name: "Save definition", exact: true })
      .click();
    await expect(dialog()).toHaveAttribute(
      "aria-label",
      "Markdown definitions",
    );
  };
  let markdown =
    "---\nname: markdown-reviewer\ndescription: A reusable reviewer.\nmodel: unavailable-model\n---\n\nReview the code carefully.\n";
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page
    .getByRole("region", { name: "Your agents", exact: true })
    .getByRole("button", { name: "New agent", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "New chat", exact: true })
    .getByText("Customize", { exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "From Markdown", exact: true })
    .click();
  await upload("agent", markdown);
  await dialog()
    .getByRole("button", { name: "Edit markdown-reviewer", exact: true })
    .click();
  markdown += "Keep findings concise.\n";
  await dialog()
    .getByRole("textbox", { name: "Markdown definition", exact: true })
    .fill(markdown);
  await dialog()
    .getByRole("button", { name: "Save definition", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await dialog()
    .getByRole("button", { name: "Download markdown-reviewer", exact: true })
    .click();
  const download = await downloaded;
  assert.equal(await readFile(await download.path(), "utf8"), markdown);
  await dialog()
    .getByRole("button", { name: "Use markdown-reviewer", exact: true })
    .click();
  await expect(dialog().getByLabel("Unique name")).toHaveValue(
    "markdown-reviewer",
  );
  await expect(
    dialog().getByLabel("Agent instructions", { exact: true }),
  ).toHaveValue("Review the code carefully.\nKeep findings concise.");
  await expect(dialog().getByRole("alert")).toContainText("unavailable-model");
  await expect(
    dialog().getByRole("button", { name: "Start chatting", exact: true }),
  ).toBeDisabled();
  await openAgentModelOptions(dialog());
  await dialog()
    .getByRole("radiogroup", { name: "Model", exact: true })
    .getByRole("radio")
    .first()
    .check();
  await dialog()
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "New chat", exact: true }),
  ).toHaveCount(0);
  const original = (await fixture.api("/bootstrap")).agents.find(
    (a) => a.name === "markdown-reviewer",
  );
  assert.equal(
    original.instructions,
    "Review the code carefully.\nKeep findings concise.",
  );

  await openTeams();
  await dialog().getByRole("button", { name: "New team", exact: true }).click();
  await dialog()
    .getByRole("button", { name: "From Markdown", exact: true })
    .click();
  await upload(
    "team",
    `---\nkind: team\nname: Markdown team\nmanager:\n  name: markdown-lead\n  instructions: Delegate an independent review.\nmembers:\n  - name: markdown-worker\n    instructions: Review the implementation.\n---\n\nCite concrete evidence.\n`,
  );
  await dialog()
    .getByRole("button", { name: "Use Markdown team", exact: true })
    .click();
  await dialog()
    .getByLabel("Project", { exact: true })
    .selectOption(project.id);
  await dialog()
    .getByLabel("Manager connection", { exact: true })
    .selectOption(connection.id);
  await dialog()
    .getByLabel("Worker 1 connection", { exact: true })
    .selectOption(connection.id);
  assert(
    await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    "Markdown creation fits a phone viewport",
  );
  await capture("markdown-team");
  let releaseCreation;
  const creationGate = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  await page.route(
    "**/api/agent-definitions/*/create",
    async (route) => {
      const response = await route.fetch();
      await creationGate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await dialog()
    .getByRole("button", { name: "Create team", exact: true })
    .click();
  try {
    await expect(
      dialog().getByRole("button", { name: "Creating…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog().getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener("popstate", resolve, { once: true });
          history.back();
        }),
    );
    await expect(dialog()).toHaveAttribute(
      "aria-label",
      "Create team from Markdown",
    );
  } finally {
    releaseCreation();
  }
  await expect(
    page.getByRole("dialog", {
      name: "Create team from Markdown",
      exact: true,
    }),
  ).toHaveCount(0);
  const team = (await fixture.api("/teams")).find(
    (t) => t.name === "Markdown team",
  );
  assert.equal(team.members.length, 1);
  assert.equal(team.folder_id, project.id);

  await openTeams();
  await dialog()
    .locator(".team-directory-item")
    .filter({ hasText: "Markdown team" })
    .getByRole("button", { name: "Add worker", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Create worker from Markdown", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Use markdown-reviewer", exact: true })
    .click();
  await expect(dialog().getByLabel("Project", { exact: true })).toHaveValue(
    project.id,
  );
  await dialog()
    .getByLabel("Agent name", { exact: true })
    .fill("markdown-added-worker");
  await dialog()
    .getByLabel("Agent connection", { exact: true })
    .selectOption(connection.id);
  await dialog().getByLabel("Agent model", { exact: true }).selectOption(model);
  await dialog()
    .getByRole("button", { name: "Create worker", exact: true })
    .click();
  await expect(dialog()).toHaveAttribute("aria-label", "Agent teams");
  assert.equal(
    (await fixture.api("/teams")).find((t) => t.id === team.id).members.length,
    2,
  );
  const worker = (await fixture.api("/bootstrap")).agents.find(
    (a) => a.name === "markdown-added-worker",
  );
  assert.equal(worker.instructions, original.instructions);
  assert.equal(worker.folder_id, project.id);

  await dialog()
    .locator(".team-directory-item")
    .filter({ hasText: "Markdown team" })
    .getByRole("button", { name: "Add worker", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Create worker from Markdown", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Edit markdown-reviewer", exact: true })
    .click();
  await dialog()
    .getByRole("textbox", { name: "Markdown definition", exact: true })
    .fill(markdown + "Do not duplicate findings.\n");
  // Save/delete responses are authoritative even if a later list refresh fails.
  // The first failure must remain visible during bounded GET recovery (the
  // two retries take six seconds, longer than this assertion's normal bound).
  await page.route("**/api/agent-definitions", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Fixture library refresh failed" },
    }),
  );
  await dialog()
    .getByRole("button", { name: "Save definition", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Fixture library refresh failed",
  );
  await page.route(
    "**/api/agent-definitions/*",
    async (route) => {
      assert.equal(route.request().method(), "DELETE");
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      // The server committed, but the client only sees a gateway failure.
      await route.fulfill({
        status: 502,
        json: { error: "Fixture deletion response lost" },
      });
    },
    { times: 1 },
  );
  await dialog()
    .getByRole("button", { name: "Delete markdown-reviewer", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Fixture deletion response lost",
  );
  await dialog()
    .getByRole("button", { name: "Delete markdown-reviewer", exact: true })
    .click();
  await expect(
    dialog().getByRole("button", {
      name: "Use markdown-reviewer",
      exact: true,
    }),
  ).toHaveCount(0);
  assert.equal(
    (await fixture.api("/bootstrap")).agents.find((a) => a.id === original.id)
      .instructions,
    original.instructions,
  );
  assert(
    !(await fixture.api("/agent-definitions")).some(
      (item) => item.name === "markdown-reviewer",
    ),
  );
  await capture("markdown-library");
  await page.unrouteAll({ behavior: "wait" });
}

export async function markdownModelsSmoke(page, fixture) {
  const dialog = () => page.locator("dialog[open]").last();
  const openAgent = async () => {
    await page.waitForLoadState("networkidle");
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page
      .getByRole("region", { name: "Your agents", exact: true })
      .getByRole("button", { name: "New agent", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "New chat", exact: true })
      .getByText("Customize", { exact: true })
      .click();
    await chooseAgentConnection(dialog(), { provider: "codex" });
  };
  const openTeams = async () => {
    await page.waitForLoadState("networkidle");
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page
      .locator(".projects-view")
      .getByRole("button", { name: /^Agent teams/ })
      .click();
  };
  const codex = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='codex'")
    .get();
  const levels = [{ value: "high" }];
  fixture.db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    JSON.stringify([
      { id: "model-a", name: "Model A", effortLevels: levels },
      { id: "model-b", name: "Model B", effortLevels: levels },
      { id: "no-effort", name: "No reported effort" },
    ]),
    codex.id,
  );
  for (const [name, model, selected, effort] of [
    ["preserve-omitted", "", "model-b", "high"],
    ["preserve-inherit", "model: inherit\n", "model-b", "high"],
    ["unreported-effort", "model: inherit\n", "no-effort", ""],
  ]) {
    await fixture.api(
      `/agent-definitions/${randomUUID()}`,
      {
        version: 0,
        markdown: `---\nname: ${name}\n${model}effort: low\n---\nReview the implementation.`,
      },
      "PUT",
    );
    await openAgent();
    await chooseAgentModel(dialog(), selected);
    await dialog()
      .getByRole("button", { name: "From Markdown", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: `Use ${name}`, exact: true })
      .click();
    await openAgentModelOptions(dialog());
    await expect(
      dialog()
        .getByRole("radiogroup", { name: "Model", exact: true })
        .locator(`input[value="${selected}"]`),
    ).toBeChecked();
    await expect(dialog().getByLabel("Effort", { exact: true })).toHaveValue(
      "low",
    );
    await expect(dialog().getByRole("alert")).toContainText(
      "does not report low effort",
    );
    const create = dialog().getByRole("button", {
      name: "Start chatting",
      exact: true,
    });
    await expect(create).toBeDisabled();
    await openAgentModelOptions(dialog());
    await dialog().getByLabel("Effort", { exact: true }).selectOption(effort);
    await expect(create).toBeEnabled();
    await create.click();
    await expect(
      page.getByRole("dialog", { name: "New chat", exact: true }),
    ).toHaveCount(0);
    const created = (await fixture.api("/bootstrap")).agents.find(
      (a) => a.name === name,
    );
    assert.equal(created.model, selected);
    assert.equal(created.effort, effort || null);
  }

  // Script discovery at the HTTP boundary: no native provider or inference.
  fixture.db
    .prepare("UPDATE connections SET metadata=?,models=? WHERE id=?")
    .run(
      JSON.stringify({ loop55Harness: "codex", authMode: "subscription" }),
      JSON.stringify([{ id: "retired-native", name: "Old model" }]),
      codex.id,
    );
  const second = fixture.db
    .prepare("SELECT * FROM connections WHERE provider='anthropic'")
    .get();
  fixture.db
    .prepare("UPDATE connections SET metadata=? WHERE id=?")
    .run(
      JSON.stringify({ loop55Harness: "claude", authMode: "subscription" }),
      second.id,
    );
  let secondRequests = 0,
    releaseSecond;
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  await page.route(`**/api/connections/${second.id}/models`, async (route) => {
    secondRequests++;
    await secondGate;
    await route.fulfill({
      json: { models: [{ id: "second-native", name: "Second native model" }] },
    });
  });
  let failDiscovery = true,
    discoveryRequests = 0,
    releaseDiscovery;
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const discovered = [
    { id: "new-native", name: "New native model", effortLevels: levels },
  ];
  await page.route(`**/api/connections/${codex.id}/models`, async (route) => {
    discoveryRequests++;
    if (failDiscovery)
      return route.fulfill({
        status: 503,
        json: { error: "Fixture discovery unavailable" },
      });
    await discoveryGate;
    fixture.db
      .prepare("UPDATE connections SET models=? WHERE id=?")
      .run(JSON.stringify(discovered), codex.id);
    await route.fulfill({ json: { models: discovered } });
  });
  await fixture.api(
    `/agent-definitions/${randomUUID()}`,
    {
      version: 0,
      markdown:
        "---\nkind: team\nname: Native Markdown team\nmanager:\n  name: native-md-lead\n  model: retired-native\n  instructions: Coordinate the review.\nmembers:\n  - name: native-md-worker\n    instructions: Review correctness.\n---\n",
    },
    "PUT",
  );
  await openTeams();
  await dialog().getByRole("button", { name: "New team", exact: true }).click();
  await dialog()
    .getByRole("button", { name: "From Markdown", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Use Native Markdown team", exact: true })
    .click();
  await expect(
    dialog().getByLabel("Manager connection", { exact: true }),
  ).toHaveValue(codex.id);
  await expect(dialog().getByRole("alert").first()).toContainText(
    "Fixture discovery unavailable",
  );
  await expect(
    dialog().getByRole("button", { name: "Create team", exact: true }),
  ).toBeDisabled();
  assert.equal(
    discoveryRequests,
    1,
    "Roles on the same connection share discovery",
  );
  failDiscovery = false;
  await dialog()
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await expect(
    dialog().getByLabel("Manager model", { exact: true }),
  ).toBeDisabled();
  await expect(
    dialog().getByRole("button", { name: "Create team", exact: true }),
  ).toBeDisabled();
  releaseDiscovery();
  await expect(
    dialog().getByLabel("Worker 1 model", { exact: true }),
  ).toHaveValue("new-native");
  await expect(
    dialog().getByLabel("Manager model", { exact: true }),
  ).toHaveValue("retired-native");
  await expect(
    dialog().getByRole("button", { name: "Create team", exact: true }),
  ).toBeDisabled();
  await dialog()
    .getByLabel("Manager model", { exact: true })
    .selectOption("new-native");
  const loadedRequests = discoveryRequests;
  failDiscovery = true;
  await dialog()
    .getByLabel("Worker 1 connection", { exact: true })
    .selectOption(second.id);
  try {
    await expect(
      dialog().getByLabel("Worker 1 model", { exact: true }),
    ).toBeDisabled();
    await expect(
      dialog().getByLabel("Manager model", { exact: true }),
    ).toBeEnabled();
    await expect(
      dialog().getByLabel("Manager model", { exact: true }),
    ).toHaveValue("new-native");
    assert.equal(
      discoveryRequests,
      loadedRequests,
      "Changing a worker connection preserves the manager catalog",
    );
  } finally {
    releaseSecond();
  }
  await expect(
    dialog().getByLabel("Worker 1 model", { exact: true }),
  ).toHaveValue("second-native");
  await dialog()
    .getByLabel("Worker 1 connection", { exact: true })
    .selectOption(codex.id);
  await expect(
    dialog().getByLabel("Worker 1 model", { exact: true }),
  ).toHaveValue("new-native");
  assert.equal(discoveryRequests, loadedRequests);
  assert.equal(secondRequests, 1);
  failDiscovery = false;
  await dialog()
    .getByRole("button", { name: "Create team", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Create team from Markdown",
      exact: true,
    }),
  ).toHaveCount(0);
  const team = (await fixture.api("/teams")).find(
    (t) => t.name === "Native Markdown team",
  );
  const created = (await fixture.api("/bootstrap")).agents.filter((a) =>
    [team.manager_id, ...team.members].includes(a.id),
  );
  assert.equal(created.length, 2);
  assert(
    created.every(
      (a) => a.model === "new-native" && a.connection_id === codex.id,
    ),
  );

  const previousRequests = discoveryRequests;
  // A later native catalog no longer reports effort. The imported preference
  // must be cleared explicitly instead of being sent through to the harness.
  discovered[0] = { id: "new-native", name: "New native model" };
  await openTeams();
  await dialog()
    .locator(".team-directory-item")
    .filter({ hasText: "Native Markdown team" })
    .getByRole("button", { name: "Add worker", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Create worker from Markdown", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Use preserve-inherit", exact: true })
    .click();
  await expect(dialog().getByLabel("Agent model", { exact: true })).toHaveValue(
    "new-native",
  );
  assert(
    discoveryRequests > previousRequests,
    "Adding a worker refreshes native models",
  );
  await dialog()
    .getByLabel("Agent name", { exact: true })
    .fill("native-md-added");
  await expect(
    dialog().getByRole("button", { name: "Create worker", exact: true }),
  ).toBeDisabled();
  await dialog().getByLabel("Agent effort", { exact: true }).selectOption("");
  await dialog()
    .getByRole("button", { name: "Create worker", exact: true })
    .click();
  await expect(dialog()).toHaveAttribute("aria-label", "Agent teams");
  const added = (await fixture.api("/bootstrap")).agents.find(
    (a) => a.name === "native-md-added",
  );
  assert.equal(added.model, "new-native");
  assert.equal(added.effort, null);
  assert(
    (await fixture.api("/teams"))
      .find((t) => t.id === team.id)
      .members.includes(added.id),
  );
}

export async function markdownSourceSmoke(page, fixture, _engine, capture) {
  const source = "docker:markdown-legacy";
  const codex = fixture.db
    .prepare("SELECT id FROM connections WHERE provider='codex'")
    .get();
  let legacy = true,
    missing = false,
    remoteReads = 0,
    localReads = 0;
  const dialog = () => page.locator("dialog[open]").last();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agent-definitions")
      localReads++;
  });
  await page.route("**/api/agent-sources", (route) =>
    route.fulfill({
      json: [{ id: source, name: "Older Docker workspace", kind: "docker" }],
    }),
  );
  // Script the linked-workspace boundary, including an older server's 404.
  await page.route("**/api/agent-sources/*/**", async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/agent-sources\/[^/]+\/(.*)$/.exec(url.pathname);
    if (!match) return route.continue();
    if (match[1] === "agent-definitions") {
      remoteReads++;
      if (missing)
        return route.fulfill({
          status: 404,
          json: {
            error:
              "This Docker workspace is unavailable. Return to the laptop workspace.",
          },
        });
      return legacy
        ? route.fulfill({ status: 404, json: { error: "Endpoint not found" } })
        : route.fulfill({ json: [] });
    }
    return route.continue({
      url: `${fixture.base}/api/${match[1]}${url.search}`,
    });
  });
  const openTeams = async () => {
    await page.waitForLoadState("networkidle");
    await page.goto(`${fixture.base}/?source=${encodeURIComponent(source)}`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page
      .locator(".projects-view")
      .getByRole("button", { name: /^Agent teams/ })
      .click();
  };
  const unavailable = async (kind) => {
    await expect(
      dialog()
        .getByRole("status")
        .filter({ hasText: "Markdown definitions are unavailable" }),
    ).toContainText("Update Loop55 on that computer");
    await expect(
      dialog().getByRole("button", {
        name: `New ${kind} definition`,
        exact: true,
      }),
    ).toHaveCount(0);
  };
  try {
    await page.goto(`${fixture.base}/?source=${encodeURIComponent(source)}`, {
      waitUntil: "networkidle",
    });
    await page
      .getByRole("region", { name: "Your agents", exact: true })
      .getByRole("button", { name: "New agent", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "New chat", exact: true })
      .getByText("Customize", { exact: true })
      .click();
    await chooseAgentConnection(dialog(), { provider: "codex" });
    await chooseAgentConnection(dialog(), { id: codex.id, source });
    await dialog()
      .getByRole("button", { name: "From Markdown", exact: true })
      .click();
    await unavailable("agent");
    await capture("markdown-update-workspace");
    legacy = false;
    await dialog()
      .getByRole("button", { name: "Check again", exact: true })
      .click();
    await expect(
      dialog().getByRole("button", {
        name: "New agent definition",
        exact: true,
      }),
    ).toBeVisible();
    await expect(dialog()).toContainText("No saved agent definitions yet");

    legacy = true;
    await openTeams();
    await dialog()
      .getByRole("button", { name: "New team", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: "From Markdown", exact: true })
      .click();
    await unavailable("team");

    await openTeams();
    await dialog()
      .getByRole("button", { name: "Add worker", exact: true })
      .first()
      .click();
    await dialog()
      .getByRole("button", { name: "Create worker from Markdown", exact: true })
      .click();
    await unavailable("agent");
    missing = true;
    await dialog()
      .getByRole("button", { name: "Check again", exact: true })
      .click();
    await expect(dialog().getByRole("alert")).toContainText(
      "Return to the laptop workspace.",
    );
    await expect(dialog()).not.toContainText("Update Loop55 on that computer");
    await expect(
      dialog().getByRole("button", {
        name: "New agent definition",
        exact: true,
      }),
    ).toBeDisabled();
    missing = legacy = false;
    await dialog()
      .getByRole("button", { name: "Reload definitions", exact: true })
      .click();
    await expect(
      dialog().getByRole("button", {
        name: "New agent definition",
        exact: true,
      }),
    ).toBeEnabled();
    assert.equal(remoteReads, 6);
    assert.equal(
      localReads,
      0,
      "Remote libraries never fall back to the host's definitions",
    );
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
}
