import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { designFixture } from "./design-fixture.mjs";

export async function conversationLiveSmoke(page, capture) {
  const fixture = await designFixture();
  let release;
  try {
    const conversation = fixture.conversations.find(
      (c) => c.state === "running",
    );
    const answer = fixture.db
      .prepare("SELECT id FROM messages WHERE run_id=? AND role='assistant'")
      .get(conversation.run);
    const agent = fixture.db
      .prepare("SELECT agent_id FROM runs WHERE id=?")
      .get(conversation.run).agent_id;
    fixture.db
      .prepare("UPDATE messages SET content='' WHERE id=?")
      .run(answer.id);
    const changed = () =>
      fixture.db
        .prepare(
          "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'message.delta','{}',?)",
        )
        .run(fixture.owner, conversation.run, Date.now());
    const update = (key, content) => {
      fixture.db
        .prepare(
          `INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at)
         VALUES(?,?,?,'message','Agent update',?,'{}',?)
         ON CONFLICT(run_id,trace_key) DO UPDATE SET content=excluded.content`,
        )
        .run(fixture.owner, conversation.run, key, content, Date.now());
      changed();
      return fixture.db
        .prepare("SELECT id FROM run_traces WHERE run_id=? AND trace_key=?")
        .get(conversation.run, key).id;
    };
    const message = (id) => page.locator(`[id="message-trace:${id}"]`);
    // Thread replies have no recipient select; the thread's agent receives them.
    const agentName = fixture.agents.find((item) => item.id === agent).name;
    const expectRecipient = async () => {
      await expect(
        page
          .locator(".conversation-sheet .thread-head")
          .getByRole("button", { name: `Open @${agentName} profile` }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Reply to agent" }),
      ).toHaveAttribute("placeholder", `Reply to @${agentName}…`);
      await expect(
        page.getByRole("combobox", { name: "Agent recipient" }),
      ).toHaveCount(0);
    };
    await page.setViewportSize({ width: 390, height: 844 });
    // A working thread's Feed card shows what the agent has written so far,
    // as the old Running cards did: its in-progress result.
    const feedPreview = fixture.db
      .prepare(
        "SELECT a.content FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id WHERE cp.run_id=?",
      )
      .get(conversation.run).content;
    assert.ok(feedPreview.trim(), "The running fixture has a result preview");
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await expect(
      page
        .locator(".inbox-card")
        .filter({ hasText: conversation.title })
        .locator(".live-preview"),
    ).toContainText(feedPreview.replaceAll("**", ""));
    await page.goto(`${fixture.base}/?conversation=${conversation.id}`);
    const transcript = page.locator(".conversation-sheet .messages");
    await expect(
      transcript.getByText("Working…", { exact: true }),
    ).toBeVisible();
    await expectRecipient();
    const firstText = "I found the relevant files and am checking the changes.";
    fixture.db
      .prepare("UPDATE messages SET content=? WHERE id=?")
      .run(firstText, answer.id);
    changed();
    await expect(
      transcript.getByText(firstText, { exact: true }),
    ).toBeVisible();
    const first = update("live-first", firstText);
    // The conversation stays open while the worker publishes progress. A fresh
    // message must appear above the composer, not behind an empty answer card.
    await expect(message(first).locator(".markdown")).toHaveText(firstText);
    // WebKit can report a subpixel clip at the scrollport boundary.
    await expect(message(first).locator(".markdown")).toBeInViewport({
      ratio: 0.99,
    });
    await expect(transcript.getByText(firstText, { exact: true })).toHaveCount(
      1,
    );
    await expect(transcript).not.toContainText("npm test");
    const second = update("live-second", "The first check passed.");
    await expect(message(second).locator(".markdown")).toBeInViewport({
      ratio: 0.99,
    });
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `Check ${i + 1}: the saved changes are available for review.`,
    );
    update("live-second", paragraphs.join("\n\n"));
    await expect(message(second).locator(".markdown p").last()).toHaveText(
      paragraphs.at(-1),
    );
    await expect(message(second).locator(".markdown p").last()).toBeInViewport({
      ratio: 0.99,
    });
    await expect(message(second)).toHaveCount(1);
    await expectRecipient();
    await capture("conversation-live-progress");

    // Reading an older update must not be interrupted by a new token/message.
    await transcript.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(
      page.getByRole("button", { name: "Jump to latest messages" }),
    ).toBeVisible();
    const latestText =
      "All checks are complete; I’m preparing the final answer.";
    const latest = update("live-final", latestText);
    await expect(message(latest).locator(".markdown")).toHaveText(latestText);
    assert.equal(await transcript.evaluate((el) => el.scrollTop), 0);
    await page.getByRole("button", { name: "Jump to latest messages" }).click();
    await expect(message(latest).locator(".markdown")).toBeInViewport({
      ratio: 0.99,
    });

    // A slow read must still render while changes keep arriving. The next read
    // catches up, rather than discarding every in-flight response indefinitely.
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let captured = false,
      handled = false,
      intercepted = false;
    const path = `**/api/conversations/${conversation.id}`;
    const holdFirst = async (route) => {
      if (intercepted) return route.continue();
      intercepted = true;
      const response = await route.fetch();
      captured = true;
      await held;
      await route.fulfill({ response });
      handled = true;
    };
    await page.route(path, holdFirst);
    update("live-final", latestText + " The build passed.");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect.poll(() => captured).toBe(true);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() =>
        window.dispatchEvent(new Event("loop-workspace-change")),
      );
    }
    release();
    await expect.poll(() => handled).toBe(true);
    await page.unroute(path, holdFirst);
    await expect(message(latest).locator(".markdown")).toContainText(
      "The build passed.",
    );

    // Saving the final answer replaces its streamed trace exactly once, keeping
    // earlier updates, timestamps, reply targets, and tool exclusion intact.
    const finalText = "The implementation and verification are complete.";
    fixture.db
      .prepare("UPDATE run_traces SET content=?,metadata=? WHERE id=?")
      .run(finalText, JSON.stringify({ final: true }), latest);
    fixture.db
      .prepare("UPDATE messages SET content=?,metadata='{}' WHERE id=?")
      .run(finalText, answer.id);
    fixture.db
      .prepare("UPDATE runs SET state='completed' WHERE id=?")
      .run(conversation.run);
    changed();
    await expect(transcript.getByText(finalText, { exact: true })).toHaveCount(
      1,
    );
    await expect(message(latest)).toHaveCount(0);
    await expect(message(first).locator(".markdown")).toHaveText(firstText);
    await expect(message(second)).toHaveCount(1);
    await expect(message(first).locator("time")).toHaveAttribute(
      "datetime",
      /T/,
    );
    await expect(
      message(first).getByRole("button", { name: "Reply", exact: true }),
    ).toBeAttached();
    await expect(transcript).not.toContainText("Working…");
    await expect(transcript).not.toContainText("npm test");
    await capture("conversation-live-complete");
    await page.reload();
    await expect(transcript.getByText(finalText, { exact: true })).toHaveCount(
      1,
    );
    await expect(message(first).locator(".markdown")).toHaveText(firstText);
    await expect(message(second)).toHaveCount(1);
    await expectRecipient();
    console.log(
      "Live conversation updates, scrolling, final deduplication and tool exclusion passed",
    );
  } finally {
    release?.();
    await page.goto("about:blank");
    await fixture.close();
  }
}
