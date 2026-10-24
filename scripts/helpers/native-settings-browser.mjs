import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Real paired API and native session. Seed an uncertain receipt, never a
// successful settings response, to exercise recovery with an unchanged revision.
export async function nativeSettingsBrowser({ page, host, dir, db }) {
  const api = (path, body) =>
    page.evaluate(
      async ({ path, body }) => {
        const { csrf } = await fetch("/session").then((r) => r.json());
        const response = await fetch("/api" + path, {
          method: body ? "POST" : "GET",
          headers: { "Content-Type": "application/json", "x-loop-csrf": csrf },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            JSON.stringify({ path, status: response.status, data }),
          );
        return data;
      },
      { path, body },
    );
  const projectId = (await api("/workspace")).projectPaths.find(
    (p) => p.path === process.cwd(),
  ).folder_id;
  const agent = await api("/agents", {
    name: "setting-recovery",
    connectionId: "native-claude",
    model: "native-default",
    folderId: projectId,
    instructions: "Fixture",
  });
  const run = await api("/runs", {
    agentId: agent.id,
    input: "fixture",
    idempotencyKey: randomUUID(),
  });
  await expect
    .poll(
      () => db.prepare("SELECT state FROM runs WHERE id=?").get(run.id).state,
    )
    .toBe("completed");
  const path = `/conversations/${run.conversation_id}/settings`;
  const before = await api(path);
  const mode = before.settings.options.find((option) => option.id === "mode");
  assert(
    mode.mutable && mode.choices.some((choice) => choice.value === "plan"),
  );
  assert.notEqual(mode.confirmed, "plan");
  const ids = [];
  const observe = (request) => {
    if (request.method() === "PATCH" && request.url().endsWith(path + "/mode"))
      ids.push(request.postDataJSON().commandId);
  };
  page.on("request", observe);
  const seed = async (route) => {
    const input = route.request().postDataJSON();
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "native.setting",
          {
            conversationId: run.conversation_id,
            setting: "mode",
            value: input.value,
            revision: input.revision,
            generation: input.generation,
          },
        ]),
      )
      .digest("hex");
    db.prepare(
      "INSERT INTO execution_commands(owner_id,command_id,method,digest,generation,state,created_at,updated_at) VALUES('local-workspace',?,'native.setting',?,?,'unknown',1,1)",
    ).run(input.commandId, digest, randomUUID());
    await route.continue();
  };
  await page.route("**/api" + path + "/mode", seed, { times: 1 });
  try {
    await page.goto(host.origin + "/?conversation=" + run.conversation_id);
    await page.getByRole("button", { name: "Conversation options", exact: true }).click();
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Session settings",
      exact: true,
    });
    const select = settings.getByLabel(mode.label || "mode", { exact: true });
    for (let i = 0; i < 2; i++) {
      await select.selectOption("plan");
      await expect(settings.getByRole("alert")).toContainText(
        "outcome is unknown",
      );
      await expect(select).toHaveValue(mode.confirmed);
    }
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    const unchanged = await api(path);
    assert.equal(unchanged.generation, before.generation);
    assert.equal(unchanged.settings.revision, before.settings.revision);
    await settings
      .getByRole("button", { name: "Refresh session", exact: true })
      .click();
    await expect(
      settings.getByRole("button", {
        name: "Apply setting again",
        exact: true,
      }),
    ).toBeEnabled();
    assert.equal(ids.length, 2);
    await settings
      .getByRole("button", { name: "Apply setting again", exact: true })
      .click();
    await expect(select).toHaveValue("plan");
    await expect(select).toBeEnabled();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    assert.equal(ids.length, 3);
    assert.notEqual(ids[2], ids[0]);
    assert.equal(
      db
        .prepare("SELECT state FROM execution_commands WHERE command_id=?")
        .get(ids[0]).state,
      "unknown",
    );
    assert.equal(
      db
        .prepare("SELECT state FROM execution_commands WHERE command_id=?")
        .get(ids[2]).state,
      "completed",
    );
    assert.equal(
      readFileSync(process.env.LOOP_TEST_SETTING_AUDIT, "utf8"),
      "plan\n",
    );
    await settings.getByRole("button", { name: "Close", exact: true }).click();
  } finally {
    page.off("request", observe);
    await page.unroute("**/api" + path + "/mode", seed);
    delete process.env.LOOP_TEST_SETTING_AUDIT;
  }
}
