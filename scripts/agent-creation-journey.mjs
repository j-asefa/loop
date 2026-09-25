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
    await button("OpenAI").click();
    await page
      .getByRole("combobox", { name: /^Model/ })
      .selectOption("openai-fixture");
  };
  await open();
  await page.getByLabel("Unique name").fill("creation-idle");
  await page
    .getByLabel("Agent instructions", { exact: true })
    .fill("Keep answers concise.");
  await button("Create agent").click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const idle = (await api("/bootstrap")).agents.find(
    (a) => a.name === "creation-idle",
  );
  assert.equal(idle.instructions, "Keep answers concise.");
  const idleDetails = await api(`/agents/${idle.id}`);
  assert.equal(idleDetails.runs.length, 0);
  assert.equal(idleDetails.conversations.length, 0);

  await open();
  const suggested = await page.getByLabel("Unique name").inputValue();
  const instructions = "Research carefully and cite sources.";
  const prompt = "Find three ideas for my next project.";
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
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .getByLabel("Initial prompt", { exact: true })
      .scrollIntoViewIfNeeded();
    const dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await page.screenshot({
      path: join(tmpdir(), `loop-agent-creation-${width}.png`),
    });
  }
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
