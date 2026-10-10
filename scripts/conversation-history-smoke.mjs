import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";
import { selectedEngines } from "./helpers/engines.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  let browser;
  try {
    const conversation = fixture.conversations.find(
      (c) => c.state === "completed",
    );
    const { db, owner } = fixture;
    const agent = db
      .prepare("SELECT agent_id FROM runs WHERE id=?")
      .get(conversation.run).agent_id;
    const addRun = db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'history','completed',?,?,?)",
    );
    const addMessage = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const addUpdate = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at,update_key) VALUES(?,?,?,?,'assistant',?,'{\"progress\":true}',?,'progress')",
    );
    let lastRun;
    db.transaction(() => {
      for (let i = 0; i < 240; i++) {
        const run = randomUUID(),
          time = Date.now() + i;
        addRun.run(run, owner, agent, conversation.id, run, time, time);
        addMessage.run(
          randomUUID(),
          owner,
          conversation.id,
          run,
          "user",
          `History prompt ${i}`,
          time,
        );
        addUpdate.run(
          randomUUID(),
          owner,
          conversation.id,
          run,
          `History progress ${i}`,
          time,
        );
        addMessage.run(
          randomUUID(),
          owner,
          conversation.id,
          run,
          "assistant",
          `History answer ${i}`,
          time,
        );
        lastRun = run;
      }
    })();
    const addActivity = db.prepare(
      "INSERT INTO agent_activities(owner_id,scope,activity_key,conversation_id,run_id,kind,record,sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)",
    );
    const record = (kind, id, data) => ({
      v: 1,
      kind,
      id,
      source: { transport: "native", harness: "codex", origin: "fixture" },
      revision: 1,
      fieldSeq: {},
      partial: false,
      replayed: true,
      data,
    });
    db.transaction(() => {
      addActivity.run(
        owner,
        conversation.id,
        "old-file",
        conversation.id,
        lastRun,
        "file_change",
        JSON.stringify(
          record("file_change", "old-file", {
            state: "applied",
            files: [
              {
                path: "old-review.ts",
                operation: "modify",
                patch: "@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
          }),
        ),
        1,
      );
      for (let i = 2; i <= 1201; i++)
        addActivity.run(
          owner,
          conversation.id,
          `tool:${i}`,
          conversation.id,
          lastRun,
          "tool",
          JSON.stringify(
            record("tool", `tool:${i}`, {
              title: `History tool ${i}`,
              status: "completed",
              content: [],
            }),
          ),
          i,
        );
    })();
    browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium
          ? process.env.CHROMIUM_PATH || undefined
          : undefined,
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const reads = [],
      errors = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/conversations/${conversation.id}/activities`)
        reads.push(url);
    });
    page.on("pageerror", (error) => {
      if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
        errors.push(error.message);
    });
    await page.goto(`${fixture.base}/?conversation=${conversation.id}`);
    const transcript = page.locator(".conversation-sheet .messages");
    await expect(
      transcript.getByText("History answer 239", { exact: true }),
    ).toBeVisible();
    // The older file record is below the recent snapshot but belongs to a
    // displayed result; its review chip must still be available immediately.
    await expect(
      page
        .locator(".conversation-sheet")
        .getByRole("button", {
          name: /file.*changed|reported.*change|file.*edit/i,
        })
        .first(),
    ).toBeVisible();
    assert.equal(
      reads.filter(
        (url) =>
          url.searchParams.get("view") === "recent" &&
          url.searchParams.get("tools") !== "0",
      ).length,
      0,
    );
    assert.equal(
      reads.filter(
        (url) =>
          url.searchParams.get("view") === "recent" &&
          url.searchParams.get("tools") === "0",
      ).length,
      1,
    );
    assert.equal(
      reads.some((url) => url.searchParams.has("before")),
      false,
    );
    assert.equal(
      reads.some((url) => url.searchParams.get("view") === "legacy"),
      false,
    );
    await page
      .getByRole("button", { name: "Conversation options", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    const tools = page.getByRole("dialog", {
      name: "Tool activity",
      exact: true,
    });
    await expect(
      tools.getByText("History tool 1201 · completed", { exact: true }),
    ).toBeVisible();
    await tools
      .getByRole("button", { name: "Load earlier activity", exact: true })
      .click();
    await expect(
      tools.getByText("History tool 1002 · completed", { exact: true }),
    ).toBeVisible();
    assert.equal(
      reads.filter((url) => url.searchParams.has("before")).length,
      1,
    );
    // Loading history must leave the live cursor at the newest snapshot.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect
      .poll(
        () =>
          reads.filter(
            (url) =>
              url.searchParams.get("view") === "updates" &&
              url.searchParams.get("tools") !== "0",
          ).length,
      )
      .toBeGreaterThan(0);
    const update = reads.find(
      (url) =>
        url.searchParams.get("view") === "updates" &&
        url.searchParams.get("tools") !== "0",
    );
    assert.equal(update.searchParams.get("after"), "1201");
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: bounded transcript opening, requested older activity and historical file reviews passed`,
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
