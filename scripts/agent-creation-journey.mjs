import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function agentCreationJourney(page, api) {
  const project = await api("/folders", {
    name: "First tasks",
    kind: "project",
  });
  await page.reload();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const open = async () => {
    await button("New agent").click();
    await page.getByRole("heading", { name: "Meet your next agent" }).waitFor();
    await button("OpenAI API").click();
    await page
      .getByRole("combobox", { name: /^Model/ })
      .selectOption("openai-fixture");
  };
  // A name suggestion that arrives after the person has entered the field
  // must not merge into what they type (it once produced "otterproject-…").
  let releaseSuggestion;
  const suggestionDone = page.waitForResponse((response) =>
    response.url().endsWith("/api/agents/suggest-name"),
  );
  await page.route(
    "**/api/agents/suggest-name",
    async (route) => {
      await new Promise((resolve) => {
        releaseSuggestion = resolve;
      });
      await route.continue();
    },
    { times: 1 },
  );
  await open();
  await expect.poll(() => typeof releaseSuggestion).toBe("function");
  await page.getByLabel("Unique name").fill("creation-idle");
  releaseSuggestion();
  await suggestionDone;
  await expect(page.getByLabel("Unique name")).toHaveAttribute(
    "placeholder",
    "Choose a name",
  );
  await expect(page.getByLabel("Unique name")).toHaveValue("creation-idle");
  await page
    .getByText("Instructions & advanced options", { exact: true })
    .click();
  await page
    .getByLabel("Agent instructions", { exact: true })
    .fill("Keep answers concise.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await page.locator("dialog[open]").last().waitFor({ state: "hidden" });
  const idle = (await api("/bootstrap")).agents.find(
    (a) => a.name === "creation-idle",
  );
  assert.equal(idle.instructions, "Keep answers concise.");
  const idleDetails = await api(`/agents/${idle.id}`);
  assert.equal(idleDetails.runs.length, 0);
  assert.equal(idleDetails.conversations.length, 0);

  await open();
  await expect(page.getByLabel("Unique name")).toHaveValue(/^[a-z]{3,32}$/);
  const suggested = await page.getByLabel("Unique name").inputValue();
  const instructions = "Research carefully and cite sources.";
  const prompt = "Find three ideas for my next project.";
  await page
    .getByText("Instructions & advanced options", { exact: true })
    .click();
  await page
    .getByLabel("Agent instructions", { exact: true })
    .fill(instructions);
  await page.getByLabel("Initial prompt", { exact: true }).fill(prompt);
  assert.equal(await page.getByLabel("Unique name").inputValue(), suggested);
  await page.getByLabel("Unique name").fill("creation-starter");
  const projectChoice = page
    .getByRole("dialog")
    .getByRole("combobox", { name: /^Project/ });
  await projectChoice.selectOption(project.id);
  const creationSheet = () => page.locator("dialog[open]").first();
  const menu = () => page.locator("dialog[open]").last();
  // Closing the nested file picker must never submit the surrounding create
  // form. Its buttons used to inherit the form's default submit behaviour.
  let createRequests = 0;
  const trackCreation = (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/agents"))
      createRequests++;
  };
  page.on("request", trackCreation);
  await creationSheet()
    .getByRole("button", { name: "Add attachments", exact: true })
    .click();
  await expect(
    menu().getByRole("heading", { name: "Add to message", exact: true }),
  ).toBeVisible();
  await menu().getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  assert.equal(createRequests, 0);
  await creationSheet()
    .getByRole("button", { name: "Add attachments", exact: true })
    .click();
  const choosing = page.waitForEvent("filechooser");
  await menu().getByRole("button", { name: "Files", exact: true }).click();
  let releaseUpload;
  await page.route(
    "**/api/uploads",
    async (route) => {
      await new Promise((resolve) => {
        releaseUpload = resolve;
      });
      await route.continue();
    },
    { times: 1 },
  );
  const brief = {
    name: "initial-brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Brief for the new agent’s first task."),
  };
  const removed = {
    name: "remove-me.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Not part of the task"),
  };
  await (await choosing).setFiles([brief, removed]);
  await expect.poll(() => typeof releaseUpload).toBe("function");
  await expect(button("Create & start")).toBeDisabled();
  releaseUpload();
  await expect(
    creationSheet().getByRole("list", { name: "Attached files" }),
  ).toContainText(removed.name);
  await expect(button("Create & start")).toBeEnabled();
  await creationSheet()
    .getByRole("button", { name: "Remove " + removed.name, exact: true })
    .click();
  await expect(
    creationSheet().getByRole("list", { name: "Attached files" }),
  ).not.toContainText(removed.name);
  await creationSheet()
    .getByRole("button", { name: "Preview " + brief.name, exact: true })
    .click();
  await expect(menu().locator(".file-preview-content pre")).toHaveText(
    brief.buffer.toString(),
  );
  await menu().getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await page.getByLabel("Initial prompt", { exact: true }).fill("");
  await expect(button("Create agent")).toBeDisabled();
  await page.getByLabel("Initial prompt", { exact: true }).fill(prompt);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .getByLabel("Initial prompt", { exact: true })
      .scrollIntoViewIfNeeded();
    const dialog = page.locator("dialog[open]").last();
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await page.screenshot({
      path: join(tmpdir(), `loop-agent-creation-${width}.png`),
    });
  }
  // Typing the prompt on a phone: the keyboard shrinks the sheet, and the
  // field sits just above it. The Create button must not cover the field.
  const promptField = page.getByLabel("Initial prompt", { exact: true });
  await promptField.focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      get: () => innerHeight - 350,
    });
    Object.defineProperty(window.visualViewport, "offsetTop", {
      configurable: true,
      get: () => 0,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
  await promptField.evaluate((el) => el.scrollIntoView({ block: "end" }));
  const field = await promptField.boundingBox();
  const create = await button("Create & start").boundingBox();
  assert.ok(
    create.y >= field.y + field.height || create.y + create.height <= field.y,
    "The Create button does not cover the prompt while typing",
  );
  await page.screenshot({
    path: join(tmpdir(), "loop-agent-creation-keyboard.png"),
  });
  await page.evaluate(() => {
    delete window.visualViewport.height;
    delete window.visualViewport.offsetTop;
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await promptField.blur();
  // Lose the response after the real server commits. The retry must reuse both
  // the new agent and its first run, preserving the entered prompt and project.
  let first;
  await page.route(
    "**/api/agents",
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      first = await response.json();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await button("Create & start").click();
  await page.getByRole("alert").waitFor();
  await expect(button("Create & start")).toBeEnabled();
  await expect(page.getByLabel("Initial prompt", { exact: true })).toHaveValue(
    prompt,
  );
  await expect(
    page.getByLabel("Agent instructions", { exact: true }),
  ).toHaveValue(instructions);
  await expect(projectChoice).toHaveValue(project.id);
  await expect(
    creationSheet().getByRole("list", { name: "Attached files" }),
  ).toContainText(brief.name);
  const retry = page.waitForResponse(
    (r) => r.url().endsWith("/api/agents") && r.request().method() === "POST",
  );
  await button("Create & start").click();
  const created = await (await retry).json();
  assert.equal(created.id, first.id);
  assert.deepEqual(created.initialRun, first.initialRun);
  await page
    .getByRole("dialog")
    .getByRole("paragraph")
    .filter({ hasText: prompt })
    .waitFor();
  await page
    .getByRole("dialog")
    .getByText("Fixture response:", { exact: false })
    .first()
    .waitFor();
  // Streaming text is visible before completion, while Feed publishes only
  // the final answer. Wait for that boundary before inspecting the output.
  await expect
    .poll(async () => {
      const detail = await api(`/agents/${created.id}`);
      return detail.runs[0]?.state;
    })
    .toBe("completed");
  const details = await api(`/agents/${created.id}`);
  assert.equal(details.runs.length, 1);
  assert.equal(details.conversations.length, 1);
  assert.equal(details.agent.instructions, instructions);
  const conversation = await api(
    `/conversations/${created.initialRun.conversation_id}`,
  );
  const initialMessage = conversation.messages.find(
    (message) => message.role === "user",
  );
  const files = JSON.parse(initialMessage.metadata).attachments;
  assert.equal(files.length, 1);
  assert.equal(files[0].name, brief.name);
  assert.equal(files[0].size, brief.buffer.length);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("list", { name: "Attached files" })
      .first(),
  ).toContainText(brief.name);
  page.off("request", trackCreation);
  assert.equal(
    createRequests,
    2,
    "Only the deliberate create and its lost-response retry may submit",
  );
  assert.equal(
    conversation.messages.filter((m) => m.role === "user").length,
    1,
  );
  const feed = (await api(`/feed?agent=${created.id}`)).items;
  assert.equal(feed.length, 1);
  assert.equal(feed[0].folder_id, project.id);
  await button("Close").click();
  console.log(
    "PASS: separate standing instructions and initial prompt, idle creation, immediate first conversation, selected-project output, stable suggested name, lost-response retry with one agent/run/message, and 320/390 layouts.",
  );
}
