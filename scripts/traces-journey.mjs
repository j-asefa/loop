import { closeSheets } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function tracesJourney(page, api, base, dir) {
  const connection = (await api("/bootstrap")).connections.find(
    (c) => c.provider === "openai" && c.status === "connected",
  );
  const project = await api("/folders", {
    name: "Trace project",
    kind: "project",
  });
  const agent = await api("/agents", {
    name: "trace-browser-agent",
    connectionId: connection.id,
    model: JSON.parse(connection.models)[0].id,
    folderId: project.id,
  });
  const db = new Database(join(dir, "loop.db"));
  const conversation = crypto.randomUUID(),
    run = crypto.randomUUID(),
    message = crypto.randomUUID(),
    artifact = crypto.randomUUID(),
    tool = crypto.randomUUID(),
    time = Date.now();
  const owner = db
    .prepare("SELECT owner_id FROM agents WHERE id=?")
    .get(agent.id).owner_id;
  // The fixture runs many independent journeys as one user. Keep this
  // trace-heavy scenario from inheriting earlier journeys' request budget.
  db.prepare("DELETE FROM request_limits WHERE owner_id=?").run(owner);
  const update =
    "Checking **public sources**.\n\n- First source is ready\n- Comparing the next source";
  try {
    // Recipient selection persists across reloads. Explicitly choose this fixture
    // and verify that new messages inherit its project without a project picker.
    await page.goto(base);
    const submitted = [];
    const reject = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submitted.push(route.request().postDataJSON());
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture send unavailable" }),
      });
    };
    await page.route("**/api/runs", reject);
    await page
      .getByRole("button", { name: "Compose a message", exact: true })
      .click();
    await page
      .getByLabel("Agent recipient", { exact: true })
      .selectOption(agent.id);
    await expect(
      page.locator(".composer").getByLabel("Project", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("Message your agent")
      .fill("Fixture project destination");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect.poll(() => submitted.length).toBe(1);
    assert.equal(submitted[0].folderId, project.id);
    const inboxAgent = (await api("/bootstrap")).agents.find(
      (a) => a.connection_id && !a.folder_id,
    );
    assert(inboxAgent, "The fixture has an inbox agent");
    await page
      .getByLabel("Agent recipient", { exact: true })
      .selectOption(inboxAgent.id);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect.poll(() => submitted.length).toBe(2);
    assert.equal(submitted[1].folderId, undefined);
    await page
      .getByLabel("Agent recipient", { exact: true })
      .selectOption(agent.id);
    await page.getByLabel("Message your agent").fill("");
    await page.unroute("**/api/runs", reject);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Trace browser task',?)",
      ).run(conversation, owner, agent.id, time);
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,worker_id,heartbeat,created_at,updated_at) VALUES(?,?,?,?,'Trace browser task','running',?,?,'browser-fixture',?,?,?)",
      ).run(
        run,
        owner,
        agent.id,
        conversation,
        run,
        JSON.stringify({
          name: agent.name,
          model: agent.model,
          provider: agent.provider,
        }),
        time + 600000,
        time,
        time,
      );
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,'{" +
          '"partial":true' +
          "}',?)",
      ).run(message, owner, conversation, run, update, time);
      const insert = db.prepare(
        "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,'markdown',?,?,?,?)",
      );
      insert.run(
        artifact,
        owner,
        agent.id,
        conversation,
        run,
        "Trace browser task",
        update,
        JSON.stringify({ messageId: message, partial: true }),
        time,
        time,
      );
      insert.run(
        tool,
        owner,
        agent.id,
        conversation,
        run,
        "web_fetch_exa result",
        "# Evidence fixture\nURL: https://example.com/evidence\n\nUseful evidence from the source.",
        JSON.stringify({ tool: "web_fetch_exa" }),
        time,
        time,
      );
      db.prepare(
        "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history,output) VALUES(?,?,?,?,?)",
      ).run(run, message, artifact, "[]", update);
      const trace = db.prepare(
        "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      trace.run(
        owner,
        run,
        "turn:0",
        "message",
        "Agent update",
        update,
        "{}",
        null,
        time,
      );
      trace.run(
        owner,
        run,
        "tool:web",
        "tool",
        "web_fetch_exa",
        "",
        '{"state":"completed"}',
        tool,
        time,
      );
      trace.run(
        owner,
        run,
        "tool:review",
        "tool",
        "pull_request_review_write",
        "Review Can not request changes on your own pull request",
        '{"state":"failed","isError":true,"privateFixture":"RAW_METADATA_SENTINEL"}',
        null,
        time,
      );
      // Older native runtimes stored internal envelopes and their receipts.
      // They must stay private even when legacy public tools become activities.
      for (const [key, title, content] of [
        ["native:envelope", "StructuredOutput", "INTERNAL_ENVELOPE_SENTINEL"],
        ["native:envelope:result", "Tool result", "INTERNAL_RECEIPT_SENTINEL"],
      ])
        trace.run(
          owner,
          run,
          key,
          "tool",
          title,
          content,
          '{"native":true}',
          null,
          time,
        );
    })();
    await page.goto(base);
    // Running cards became Feed thread cards under the "Working" filter.
    await page.getByRole("tab", { name: /^Working/ }).click();
    const card = page
      .locator(".inbox-card")
      .filter({ hasText: "Trace browser task" });
    await expect(card.locator(".inbox-row")).toHaveAttribute(
      "aria-label",
      /^Trace browser task.*, Working$/,
    );
    await expect(card.locator(".preview strong")).toHaveText("public sources");
    await expect(card.locator(".preview li")).toHaveCount(2);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(card).toBeVisible();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: join(
          tmpdir(),
          `loop-running-preview-${process.env.LOOP_BROWSER || "chromium"}-${theme}.png`,
        ),
      });
    }
    // The agent's Results only publish final answers.
    await page
      .locator(".agent-strip button")
      .filter({ hasText: "@trace-browser-agent" })
      .click();
    await page.getByRole("tab", { name: "Results", exact: true }).click();
    await expect(page.locator(".feed .feed-loading")).toHaveCount(0);
    const results = page.locator(".feed .feed-card:not(.inbox-card)");
    await expect(results.filter({ hasText: "Trace browser task" })).toHaveCount(
      0,
    );
    await expect(results.filter({ hasText: "web_fetch_exa" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Messages", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Agent messages" }),
    ).toContainText("public sources");
    const updateCard = page
      .getByRole("region", { name: "Agent messages" })
      .locator(".feed-card")
      .first();
    const selectedMessage = (await api(`/agents/${agent.id}/messages`))
      .items[0];
    const replies = [];
    const sendReply = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      replies.push(route.request().postDataJSON());
      await route.fulfill({
        status: replies.length === 1 ? 503 : 202,
        contentType: "application/json",
        body: JSON.stringify(
          replies.length === 1
            ? { error: "Fixture reply unavailable" }
            : { id: "accepted" },
        ),
      });
    };
    await page.route("**/api/runs", sendReply);
    await updateCard
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    // Replying to a message now opens its thread with the quoted message in
    // the thread composer, instead of the global composer over the profile.
    const replySheet = page.locator("dialog.swipe-sheet");
    const replyInput = replySheet.getByRole("textbox", {
      name: "Reply to agent",
      exact: true,
    });
    await expect(replyInput).toBeVisible();
    await replySheet.locator(".composer-reply-chip summary").click();
    await expect(replySheet.locator(".composer-quote")).toContainText(
      "Comparing the next source",
    );
    await expect(replyInput).toBeInViewport({ ratio: 1 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page.screenshot({
        path: join(
          tmpdir(),
          `loop-message-reply-${process.env.LOOP_BROWSER || "chromium"}-${theme}.png`,
        ),
      });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Message replies fit the mobile viewport",
      );
    }
    await replyInput.fill("Why is that source reliable?");
    await replySheet
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(replySheet.getByRole("alert")).toContainText(
      "Fixture reply unavailable",
    );
    await closeSheets(page);
    await updateCard
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await expect(replyInput).toHaveValue("Why is that source reliable?");
    await replySheet
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    // The reply stays in its thread: the thread remains open and clears.
    await expect(replyInput).toHaveValue("");
    await expect(replySheet).toBeVisible();
    await closeSheets(page);
    assert.equal(replies.length, 2);
    assert.equal(replies[0].idempotencyKey, replies[1].idempotencyKey);
    assert.equal(replies[1].replyToMessageId, selectedMessage.id);
    assert.equal(replies[1].agentId, agent.id);
    assert.equal(replies[1].conversationId, conversation);
    assert.equal(replies[1].input, "Why is that source reliable?");
    await page.unroute("**/api/runs", sendReply);
    await page.getByRole("tab", { name: "Traces", exact: true }).click();
    const traces = page.getByRole("region", { name: "Agent traces" });
    await expect(traces).toContainText("public sources");
    const errorTrace = traces
      .locator(".trace-card")
      .filter({ hasText: "pull request review write" });
    await expect(errorTrace.locator("details")).toHaveAttribute("open", "");
    await expect(errorTrace.locator("summary")).toHaveText("Tool error");
    await expect(errorTrace).toContainText(
      "Can not request changes on your own pull request",
    );
    await traces.getByRole("button", { name: "View tool result" }).click();
    await expect(page.locator("dialog[open]").last()).toContainText(
      "Useful evidence from the source.",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.screenshot({
      path: join(
        tmpdir(),
        `loop-agent-traces-${process.env.LOOP_BROWSER || "chromium"}.png`,
      ),
    });
    // Refreshes after a backgrounded phone may jump past whole pages. Preserve
    // access to the gap, including after the user previously reached the end.
    const earlier = traces.getByRole("button", {
      name: "Earlier traces",
      exact: true,
    });
    await expect(earlier).toHaveCount(0);
    const initialTraceCount = await traces.locator(".trace-card").count();
    for (let burst = 0; burst < 2; burst++) {
      db.transaction(() => {
        const insert = db.prepare(
          "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,?,'tool','Tool update',?,'{}',?)",
        );
        for (let i = 0; i < 90; i++)
          insert.run(
            owner,
            run,
            `burst:${burst}:${i}`,
            `Public update ${burst * 90 + i}`,
            Date.now(),
          );
        db.prepare(
          "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'progress','{}',?)",
        ).run(owner, run, Date.now());
      })();
      await expect(traces.locator(".trace-card")).toHaveCount(
        initialTraceCount + burst * 90 + 40,
      );
      await earlier.click();
      await expect(traces.locator(".trace-card")).toHaveCount(
        initialTraceCount + burst * 90 + 80,
      );
      await earlier.click();
      await expect(traces.locator(".trace-card")).toHaveCount(
        initialTraceCount + (burst + 1) * 90,
      );
      // The final partial page may include already-loaded older entries.
      while (await earlier.count()) {
        await earlier.click();
        await expect(
          traces.getByRole("button", { name: "Loading…", exact: true }),
        ).toHaveCount(0);
      }
    }
    await page.getByRole("tab", { name: "Messages", exact: true }).click();
    const messageList = page.getByRole("region", { name: "Agent messages" });
    const earlierMessages = messageList.getByRole("button", {
      name: "Earlier messages",
      exact: true,
    });
    await expect(messageList.locator(".feed-card")).toHaveCount(1);
    for (let burst = 0; burst < 2; burst++) {
      db.transaction(() => {
        const insert = db.prepare(
          "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,?,'message','Agent update',?,'{}',?)",
        );
        for (let i = 0; i < 65; i++)
          insert.run(
            owner,
            run,
            `message:${burst}:${i}`,
            `Progress update ${burst * 65 + i}`,
            Date.now(),
          );
        db.prepare(
          "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'progress','{}',?)",
        ).run(owner, run, Date.now());
      })();
      await expect(messageList.locator(".feed-card")).toHaveCount(
        1 + burst * 65 + 50,
      );
      while (await earlierMessages.count()) {
        await earlierMessages.click();
        await expect(
          messageList.getByRole("button", { name: "Loading…", exact: true }),
        ).toHaveCount(0);
      }
      await expect(messageList.locator(".feed-card")).toHaveCount(
        1 + (burst + 1) * 65,
      );
    }
    await messageList
      .locator(".feed-card")
      .first()
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    const liveConversation = page.locator("dialog[open]").last();
    const loadHistory = async (dialog) => {
      const earlier = dialog.getByRole("button", {
        name: "Load earlier messages",
        exact: true,
      });
      while (await earlier.count()) {
        await earlier.click();
        await expect
          .poll(() =>
            earlier.evaluateAll(
              (buttons) => !buttons.length || !buttons[0].disabled,
            ),
          )
          .toBe(true);
      }
    };
    await expect(liveConversation.locator(".agent-progress")).toHaveCount(49);
    await loadHistory(liveConversation);
    await expect(liveConversation.locator(".agent-progress")).toHaveCount(131);
    db.transaction(() => {
      const insert = db.prepare(
        "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,?,'message','Agent update',?,'{}',?)",
      );
      for (let i = 0; i < 65; i++)
        insert.run(
          owner,
          run,
          `live-message:${i}`,
          `Live conversation update ${i}`,
          Date.now(),
        );
      db.prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'progress','{}',?)",
      ).run(owner, run, Date.now());
    })();
    await expect(
      liveConversation.getByRole("button", {
        name: "Load earlier messages",
        exact: true,
      }),
    ).toBeVisible({ timeout: 10000 });
    await loadHistory(liveConversation);
    await expect(liveConversation.locator(".agent-progress")).toHaveCount(196);
    await liveConversation
      .getByRole("button", { name: "Close", exact: true })
      .click();
    while (await earlierMessages.count()) {
      await earlierMessages.click();
      await expect(
        messageList.getByRole("button", { name: "Loading…", exact: true }),
      ).toHaveCount(0);
    }
    await expect(messageList.locator(".feed-card")).toHaveCount(196);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,'final','message','Final answer','Final heliotrope browser answer','{\"final\":true}',?)",
      ).run(owner, run, Date.now());
      db.prepare(
        "UPDATE messages SET content='Final heliotrope browser answer',metadata='{}' WHERE id=?",
      ).run(message);
      db.prepare(
        "UPDATE artifacts SET content='Final heliotrope browser answer',metadata=?,updated_at=? WHERE id=?",
      ).run(
        JSON.stringify({ messageId: message, partial: false }),
        Date.now(),
        artifact,
      );
      db.prepare(
        "UPDATE runs SET state='completed',result='Final heliotrope browser answer',updated_at=? WHERE id=?",
      ).run(Date.now(), run);
      db.prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'state','{}',?)",
      ).run(owner, run, Date.now());
    })();
    await expect(messageList.locator(".feed-card")).toHaveCount(197);
    await expect(messageList.locator(".feed-card").first()).toContainText(
      "Final heliotrope browser answer",
    );
    await messageList
      .locator(".feed-card")
      .first()
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    const conversationDialog = page.locator("dialog[open].conversation-sheet");
    await expect(conversationDialog.locator(".agent-progress")).toHaveCount(49);
    while (
      await conversationDialog
        .getByRole("button", { name: "Load earlier messages", exact: true })
        .count()
    ) {
      const previous = await conversationDialog.locator(".message").count();
      await conversationDialog
        .getByRole("button", { name: "Load earlier messages", exact: true })
        .click();
      await expect
        .poll(() => conversationDialog.locator(".message").count())
        .toBeGreaterThan(previous);
    }
    await expect(conversationDialog.locator(".agent-progress")).toHaveCount(
      196,
    );
    await expect(conversationDialog.locator(".message").last()).toContainText(
      "Final heliotrope browser answer",
    );
    // Raw calls stay out of the transcript and open in a separate activity
    // sheet. Internal runtime data stays excluded from both views.
    await expect(conversationDialog.locator(".messages")).not.toContainText(
      "pull_request_review_write",
    );
    // Conversation options is now a button opening the "Conversation" menu.
    await conversationDialog
      .getByRole("button", { name: "Conversation options", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Conversation", exact: true })
      .getByRole("menuitem", { name: /^Tool activity/ })
      .click();
    const activityDialog = page.getByRole("dialog", {
      name: "Tool activity",
      exact: true,
    });
    const reviewActivity = activityDialog
      .locator("details.activity-panel")
      .filter({
        has: page.locator("summary", { hasText: "pull_request_review_write" }),
      });
    await expect(reviewActivity).toHaveCount(1);
    await expect(reviewActivity.locator("summary")).toHaveText(
      "pull_request_review_write · failed",
    );
    await expect(reviewActivity).not.toHaveAttribute("open", "");
    await reviewActivity.locator("summary").click();
    await expect(reviewActivity.locator("pre")).toBeVisible();
    await expect(reviewActivity.locator("pre")).toHaveText(
      "Review Can not request changes on your own pull request",
    );
    const messageText = conversationDialog.locator(".message > .markdown");
    await expect(messageText).toHaveCount(197);
    await expect
      .poll(async () => (await messageText.allTextContents()).join("\n"))
      .not.toMatch(/pull_request_review_write|Public update/);
    await expect(conversationDialog.locator(".messages")).not.toContainText(
      /StructuredOutput|INTERNAL_(ENVELOPE|RECEIPT)_SENTINEL|RAW_METADATA_SENTINEL/,
    );
    await expect(activityDialog).not.toContainText(
      /StructuredOutput|INTERNAL_(ENVELOPE|RECEIPT)_SENTINEL|RAW_METADATA_SENTINEL/,
    );
    const activityPage = await api(`/conversations/${conversation}/activities`);
    assert(
      !/INTERNAL_(ENVELOPE|RECEIPT)_SENTINEL|RAW_METADATA_SENTINEL/.test(
        JSON.stringify(activityPage),
      ),
    );
    // The public legacy bursts are intentional activity content, not secrets.
    await expect(activityDialog.locator("details.activity-panel")).toHaveCount(
      182,
    );
    await activityDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await conversationDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("tab", { name: "Results", exact: true }).click();
    await expect(page.locator(".feed-card")).toHaveCount(1);
    await expect(page.locator(".feed-card")).toContainText(
      "Final heliotrope browser answer",
    );
    await expect(page.locator(".feed-card")).not.toContainText(
      "Checking public sources",
    );
    await page.getByRole("button", { name: "Back", exact: true }).click();
    // This scenario intentionally opens hundreds of trace/activity records.
    // Its final publication assertions should test projections, not the
    // shared fixture user's per-minute API rate limit.
    db.prepare("DELETE FROM request_limits WHERE owner_id=?").run(owner);
    const feed = await api("/feed");
    assert.equal(
      feed.items[0].id,
      artifact,
      "Completion publishes the answer at the top of the feed",
    );
    const search = await api("/search?q=heliotrope&agent=" + agent.id);
    assert.equal(search.items.length, 1, "One search result per final answer");
    console.log(
      "PASS: Working Feed previews, final-only agent Results, in-thread message reply with retry, readable tool errors, live trace pagination, tool-result access, final publication and deduplicated search.",
    );
  } finally {
    db.prepare(
      "UPDATE runs SET state='cancelled' WHERE id=? AND state='running'",
    ).run(run);
    db.close();
  }
}
