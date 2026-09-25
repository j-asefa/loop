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
  const update =
    "Checking **public sources**.\n\n- First source is ready\n- Comparing the next source";
  try {
    // The implicit first recipient must inherit its project; an explicit inbox
    // choice must still be sent as null. Inspect requests without running a model.
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
    await expect(
      page.getByLabel("Agent recipient", { exact: true }),
    ).toHaveValue(agent.id);
    await expect(page.getByLabel("Project", { exact: true })).toHaveValue(
      project.id,
    );
    await page
      .getByLabel("Message your agent")
      .fill("Fixture project destination");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect.poll(() => submitted.length).toBe(1);
    assert.equal(submitted[0].folderId, project.id);
    await page.getByLabel("Project", { exact: true }).selectOption("");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect.poll(() => submitted.length).toBe(2);
    assert.equal(submitted[1].folderId, null);
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
        '{"state":"failed","isError":true}',
        null,
        time,
      );
    })();
    await page.goto(base);
    await page
      .getByRole("button", { name: "Running", exact: true })
      .last()
      .click();
    const card = page
      .locator(".run-card")
      .filter({ hasText: "Trace browser task" });
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
    await page
      .getByRole("button", { name: "Feed", exact: true })
      .last()
      .click();
    await expect(
      page.locator(".feed-card").filter({ hasText: "Trace browser task" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".feed-card").filter({ hasText: "web_fetch_exa" }),
    ).toHaveCount(0);
    await page
      .locator(".agent-strip button")
      .filter({ hasText: "@trace-browser-agent" })
      .click();
    await page.getByRole("button", { name: "Traces", exact: true }).click();
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
    await expect(page.getByRole("dialog")).toContainText(
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
    for (let burst = 0; burst < 2; burst++) {
      db.transaction(() => {
        const insert = db.prepare(
          "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES(?,?,?,'message','Agent update',?,'{}',?)",
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
        3 + burst * 90 + 40,
      );
      await earlier.click();
      await expect(traces.locator(".trace-card")).toHaveCount(
        3 + burst * 90 + 80,
      );
      await earlier.click();
      await expect(traces.locator(".trace-card")).toHaveCount(
        3 + (burst + 1) * 90,
      );
      // The final partial page may include already-loaded older entries.
      while (await earlier.count()) {
        await earlier.click();
        await expect(
          traces.getByRole("button", { name: "Loading…", exact: true }),
        ).toHaveCount(0);
      }
    }
    db.transaction(() => {
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
    await page.getByRole("button", { name: "Outputs", exact: true }).click();
    await expect(page.locator(".feed-card")).toHaveCount(1);
    await expect(page.locator(".feed-card")).toContainText(
      "Final heliotrope browser answer",
    );
    await expect(page.locator(".feed-card")).not.toContainText(
      "Checking public sources",
    );
    await page
      .getByRole("button", { name: "Back to feed", exact: true })
      .click();
    const feed = await api("/feed");
    assert.equal(
      feed.items[0].id,
      artifact,
      "Completion publishes the answer at the top of the feed",
    );
    const search = await api("/search?q=heliotrope&agent=" + agent.id);
    assert.equal(search.items.length, 1, "One search result per final answer");
    console.log(
      "PASS: Running previews, final-only Feed, readable tool errors, live trace pagination, tool-result access, final publication and deduplicated search.",
    );
  } finally {
    db.prepare(
      "UPDATE runs SET state='cancelled' WHERE id=? AND state='running'",
    ).run(run);
    db.close();
  }
}
