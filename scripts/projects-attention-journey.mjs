import "../deployment/environment.mjs";
import {
  closeSheets,
  inboxRowAction,
  openSettings,
} from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";

// What needs you stacks above the Feed filters; show every card.
async function openNeeds(page) {
  const stack = page.getByRole("region", { name: "Needs you" });
  await expect(stack).toBeVisible();
  const all = stack.getByRole("button", { name: "Show all" });
  if (await all.isVisible()) await all.click();
}

export async function projectsAttentionJourney(page, api, base, dir) {
  // The fixture runs many independent journeys as one user. Keep this one
  // from inheriting earlier journeys' per-minute request budget.
  {
    const limits = new Database(join(dir, "loop55.db"));
    limits.pragma("busy_timeout = 10000");
    limits.prepare("DELETE FROM request_limits").run();
    limits.close();
  }
  const bootstrap = await api("/bootstrap");
  const connection = bootstrap.connections.find(
    (c) => c.provider === "openai" && c.status === "connected",
  );
  const other = await api("/folders", {
    name: "Other fixture project",
    kind: "project",
  });
  const outsider = await api("/agents", {
    name: "project-outsider",
    connectionId: connection.id,
    model: JSON.parse(connection.models)[0].id,
    folderId: other.id,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  let dialog = page.locator("dialog[open]").last();
  await dialog.getByLabel("Name", { exact: true }).fill("Field notes");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Field notes", exact: true }),
  ).toBeVisible();
  const project = (await api("/bootstrap")).folders.find(
    (f) => f.name === "Field notes",
  );
  // Project agents moved under the project's Agents view.
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".project-agents .project-agent")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  dialog = page.locator("dialog[open]").last();
  await dialog.getByText("Customize", { exact: true }).click();
  await expect(dialog.getByLabel("Project", { exact: true })).toHaveValue(
    project.id,
  );
  await dialog.getByLabel("Unique name").fill("project-resident");
  await expect(dialog.getByLabel("Unique name")).toHaveValue(
    "project-resident",
  );
  await dialog
    .getByRole("button", { name: "Start chatting", exact: true })
    .click();
  await expect(page.locator(".projects-view .project-agent")).toHaveCount(1);
  await expect(page.locator(".projects-view")).not.toContainText(
    "project-outsider",
  );
  await page.getByRole("button", { name: "Add existing agent" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /@project-outsider/ })
    .click();
  await expect(page.locator(".projects-view .project-agent")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toBeEnabled();
  const fresh = await api("/bootstrap");
  const resident = fresh.agents.find((a) => a.name === "project-resident");
  assert.equal(resident.folder_id, project.id);
  assert.equal(
    fresh.agents.find((a) => a.id === outsider.id).folder_id,
    project.id,
  );
  await page.reload();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Field notes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All projects", exact: true }).click();
  await page
    .locator("button.project-tile")
    .filter({ hasText: "Field notes" })
    .filter({ hasText: "2 agents" })
    .click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".projects-view .project-agent")).toHaveCount(2);
  await page.getByRole("button", { name: /@project-resident/ }).click();
  // Edit agent moved into the profile's "Agent actions" menu.
  await page
    .getByRole("button", { name: "Agent actions", exact: true })
    .click();
  await page
    .locator("dialog[open]")
    .last()
    .getByRole("menuitem", { name: /^Edit agent/ })
    .click();
  await expect(
    page.locator("dialog[open]").last().getByLabel("Project", { exact: true }),
  ).toHaveValue(project.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Field notes", exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      localStorage.setItem("loop55-theme", theme);
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: join(
          tmpdir(),
          `loop55-projects-${process.env.LOOP55_BROWSER || "chromium"}-${theme}-${width}.png`,
        ),
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // These are isolated fixture records, not tasks executed by real providers.
  const db = new Database(join(dir, "loop55.db"));
  const failed = crypto.randomUUID(),
    paused = crypto.randomUUID(),
    queued = crypto.randomUUID(),
    queuedNext = crypto.randomUUID(),
    approvalRun = crypto.randomUUID(),
    approval = crypto.randomUUID(),
    conversation = crypto.randomUUID();
  // The Feed lists one row per conversation, so each fixture run gets its
  // own thread (the failed run keeps the "Dismissal fixture history").
  const threads = {
    [paused]: crypto.randomUUID(),
    [queued]: crypto.randomUUID(),
    [queuedNext]: crypto.randomUUID(),
    [failed]: conversation,
    [approvalRun]: crypto.randomUUID(),
  };
  try {
    db.transaction(() => {
      const thread = db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
      );
      const insert = db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const [id, state, input, title, age] of [
        [
          paused,
          "paused",
          "Fixture queue barrier",
          "Fixture queue barrier",
          5000,
        ],
        [
          approvalRun,
          "awaiting_approval",
          "Unwanted permission request",
          "Unwanted permission request",
          4000,
        ],
        [
          failed,
          "failed",
          "Dismissible failure",
          "Dismissal fixture history",
          3000,
        ],
        [
          queued,
          "queued",
          "Unwanted queued idea",
          "Unwanted queued idea",
          2000,
        ],
        [
          queuedNext,
          "queued",
          "Second queued idea",
          "Second queued idea",
          1000,
        ],
      ]) {
        thread.run(
          threads[id],
          resident.owner_id,
          resident.id,
          title,
          Date.now() - age,
        );
        insert.run(
          id,
          resident.owner_id,
          resident.id,
          threads[id],
          input,
          state,
          id,
          JSON.stringify({
            model: resident.model,
            provider: resident.provider,
          }),
          state === "failed" ? "Fixture failure" : null,
          Date.now() - age,
          Date.now(),
        );
      }
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        crypto.randomUUID(),
        resident.owner_id,
        conversation,
        failed,
        "user",
        "Dismissible failure",
        Date.now(),
      );
      db.prepare(
        "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)",
      ).run(
        approval,
        resident.owner_id,
        approvalRun,
        approval,
        JSON.stringify({
          type: "mcp_tool",
          tool: "project_attention_fixture",
          server: "Fixture",
          arguments: { query: "No real action" },
        }),
        Date.now(),
        Date.now() + 60000,
      );
    })();
    await page.goto(base);
    // What needs you stacks above the filters, shown only while needed.
    const needs = page.getByRole("region", { name: "Needs you" });
    await expect(needs).toBeVisible();
    await page.screenshot({
      path: join(
        tmpdir(),
        `loop55-attention-${process.env.LOOP55_BROWSER || "chromium"}.png`,
      ),
    });
    await openNeeds(page);
    const row = (title) =>
      page.locator(".inbox-row").filter({ hasText: title }).first();
    // A dismissed failure leaves the stack; its history stays in Done. Its
    // card is headed by the failed run's prompt, not the thread title.
    const needsRow = (title) =>
      needs.locator(".inbox-row").filter({ hasText: title }).first();
    // Dismiss moved from a Running card button to the row's action menu.
    await expect(needsRow("Dismissible failure")).toBeVisible();
    await page.route(
      `**/api/runs/${failed}/dismiss`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Fixture dismissal unavailable" }),
        }),
      { times: 1 },
    );
    await inboxRowAction(page, "Dismissible failure", "Dismiss from Needs you");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Fixture dismissal unavailable" }),
    ).toBeVisible();
    await expect(needsRow("Dismissible failure")).toBeVisible();
    await inboxRowAction(page, "Dismissible failure", "Dismiss from Needs you");
    await expect(needsRow("Dismissible failure")).toBeHidden();
    await page
      .getByRole("button", {
        name: "Cancel task: Project attention fixture",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Review approval: Project attention fixture",
        exact: true,
      }),
    ).toBeHidden();
    assert.equal(
      db.prepare("SELECT state FROM approvals WHERE id=?").get(approval).state,
      "rejected",
    );
    // Queue management from the Queued filter's row menu.
    await page.getByRole("tab", { name: /^Queued/ }).click();
    await expect(row("Second queued idea")).toContainText("Second queued idea");
    const position = async (id) =>
      (await api("/feed?filter=queued")).items.find((i) => i.run?.id === id)
        ?.run.queue_position;
    const before = [await position(queued), await position(queuedNext)];
    assert.ok(before[0] < before[1], "older queued work runs first");
    await inboxRowAction(page, "Second queued idea", "Move up in queue");
    await expect
      .poll(async () => [await position(queued), await position(queuedNext)])
      .toEqual([before[1], before[0]]);
    await expect(row("Second queued idea")).toContainText(
      `#${before[0]} in queue`,
    );
    await inboxRowAction(page, "Second queued idea", "Move down in queue");
    await expect
      .poll(async () => [await position(queued), await position(queuedNext)])
      .toEqual(before);
    await expect(row("Second queued idea")).toContainText(
      `#${before[1]} in queue`,
    );
    await inboxRowAction(page, "Unwanted queued idea", "Edit queued message");
    const edit = page.getByRole("dialog", {
      name: "Edit queued message",
      exact: true,
    });
    await expect(edit.getByLabel("Queued message")).toHaveValue(
      "Unwanted queued idea",
    );
    await edit
      .getByLabel("Queued message")
      .fill("Unwanted queued idea, revised");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit).toBeHidden();
    await expect
      .poll(
        async () => (await api("/runs")).find((r) => r.id === queued)?.input,
      )
      .toBe("Unwanted queued idea, revised");
    // Reopening the editor shows the saved input; the Thread actions button
    // opens the same menu as the context menu.
    await row("Unwanted queued idea")
      .locator("xpath=ancestor::article[1]")
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await page
      .locator("dialog[open]")
      .last()
      .getByRole("menuitem", { name: "Edit queued message" })
      .click();
    await expect(edit.getByLabel("Queued message")).toHaveValue(
      "Unwanted queued idea, revised",
    );
    await closeSheets(page);
    // Cancel moved from a Running card button to the row menu.
    for (const title of ["Unwanted queued idea", "Second queued idea"]) {
      const sheet = await inboxRowAction(page, title);
      await expect(
        sheet.getByRole("menuitem", { name: "Pause" }),
      ).toBeVisible();
      await sheet.getByRole("menuitem", { name: "Cancel task" }).click();
      await expect(row(title)).toBeHidden();
    }
    // The paused barrier offers Resume (not Pause) in its menu.
    await openNeeds(page);
    const barrier = await inboxRowAction(page, "Fixture queue barrier");
    await expect(
      barrier.getByRole("menuitem", { name: "Resume" }),
    ).toBeVisible();
    await expect(barrier.getByRole("menuitem", { name: "Pause" })).toHaveCount(
      0,
    );
    await closeSheets(page);
    // Dismissal refreshes bootstrap/feed/runs after removing the card. Let that
    // refresh settle before navigation, then wait for the reloaded app as well.
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.ok(
      !(await api("/runs?active=1")).some((r) =>
        [failed, approvalRun, queued, queuedNext].includes(r.id),
      ),
    );
    assert.equal(
      (await api(`/conversations/${conversation}`)).messages[0].run_state,
      "failed",
    );
    await page.goto(`${base}/?conversation=${conversation}`);
    await expect(page.locator("dialog[open]").last()).toContainText(
      "Dismissible failure",
    );
    const reading = await page
      .locator("dialog[open]")
      .last()
      .evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        viewport: innerHeight,
        font: parseFloat(
          getComputedStyle(el.querySelector(".message .markdown")).fontSize,
        ),
      }));
    assert.ok(reading.height >= reading.viewport * 0.94);
    assert.ok(reading.font >= 16);
    await page
      .locator("dialog[open]")
      .last()
      .evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path: join(
        tmpdir(),
        `loop55-conversation-reading-${process.env.LOOP55_BROWSER || "chromium"}.png`,
      ),
    });
    await expect(
      page.getByText("Continue with selected messages", { exact: false }),
    ).toHaveCount(0);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await api(`/runs/${paused}/dismiss`, {});
    // Saved into the project so they appear in its Activity view.
    const tool = await api("/artifacts", {
      folder: project.id,
      title: "browser_run_code_unsafe result",
      content:
        "### Result\n" +
        JSON.stringify([
          {
            title: "Archive fixture",
            url: "https://example.com/archive",
            details: "68 points · 25 comments",
          },
          { title: "Second fixture", url: "https://example.com/second" },
        ]) +
        "\n\n### Ran Playwright code\n```js\nawait page.evaluate();\n```",
    });
    // This manually saved file exercises preview rendering; it is not a run trace.
    await api("/artifacts", {
      folder: project.id,
      title: "Complete Markdown preview",
      content:
        "Clear context. ".repeat(46) +
        "[Original source](https://example.com/source?first=yes&second=true) and **complete emphasis**.\n\n```js\nconst code = true;\n```\n\nFull original ending.",
    });
    await api("/artifacts", {
      folder: project.id,
      title: "Native table preview",
      kind: "table",
      content: JSON.stringify({
        columns: ["Item", "Count"],
        rows: [["Apples", 3]],
      }),
    });
    const web = await api("/artifacts", {
      folder: project.id,
      title: "web_fetch_exa result",
      content:
        "# Substrate fixture\nURL: https://github.com/fixture/substrate\n\n# Substrate fixture\n\n- Stars: 1593\n- Forks: 264\n\n## README\n\nA useful system for running agents on shared infrastructure, with suspended sessions that keep their working state.",
    });
    // This manually saved file exercises preview rendering; it is not a run trace.
    // Result cards live on project pages (and agent profiles), not the Feed.
    await page.goto(`${base}/?page=projects&projectView=${project.id}`);
    await page
      .locator(".project-tabs")
      .getByRole("button", { name: "Activity", exact: true })
      .click();
    const toolCard = page
      .locator(".feed-card")
      .filter({ hasText: "Archive fixture" });
    await expect(
      toolCard.getByRole("link", { name: "Archive fixture" }),
    ).toHaveAttribute("href", "https://example.com/archive");
    await expect(toolCard).not.toContainText('"title":');
    const webCard = page.locator(".feed-card").filter({
      has: page.getByRole("heading", {
        name: "Substrate fixture",
        exact: true,
      }),
    });
    await expect(webCard).toContainText("A useful system for running agents");
    await expect(webCard).not.toContainText("Stars:");
    await expect(webCard).not.toContainText("URL:");
    await expect(webCard).not.toContainText("web_fetch_exa");
    await webCard.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(
        tmpdir(),
        `loop55-web-preview-${process.env.LOOP55_BROWSER || "chromium"}.png`,
      ),
    });
    const markdown = page.locator(".feed-card").filter({
      has: page.getByRole("heading", { name: "Complete Markdown preview" }),
    });
    await expect(
      markdown.getByRole("link", { name: "Original source" }),
    ).toHaveAttribute(
      "href",
      "https://example.com/source?first=yes&second=true",
    );
    await expect(
      page.locator(".preview-table td").getByText("Apples", { exact: true }),
    ).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await toolCard.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(
            tmpdir(),
            `loop55-previews-${process.env.LOOP55_BROWSER || "chromium"}-${theme}-${width}.png`,
          ),
        });
      }
    }
    await markdown
      .getByRole("button", { name: "View full result", exact: true })
      .click();
    await expect(page.locator("dialog[open]").last()).toContainText(
      "Full original ending.",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  } finally {
    db.close();
  }
  await page.goto(base);
  await openSettings(page);
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  const tools = page.getByRole("dialog", {
    name: "Tools & integrations",
    exact: true,
  });
  await tools
    .getByLabel("Tool approvals", { exact: true })
    .selectOption("allow");
  await expect(
    tools
      .getByRole("status")
      .filter({ hasText: "Connected tools can run automatically" }),
  ).toBeVisible();
  await expect(
    tools.getByLabel("Tool approvals", { exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: join(
      tmpdir(),
      `loop55-tool-approvals-${process.env.LOOP55_BROWSER || "chromium"}.png`,
    ),
  });
  await page.waitForLoadState("networkidle");
  await page.reload();
  await openSettings(page);
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(tools.getByLabel("Tool approvals", { exact: true })).toHaveValue(
    "allow",
  );
  await tools.getByLabel("Tool approvals", { exact: true }).selectOption("ask");
  await expect(
    tools.getByRole("status").filter({ hasText: "New tool calls will ask" }),
  ).toBeVisible();
  await expect(
    tools.getByLabel("Tool approvals", { exact: true }),
  ).toBeEnabled();
  await closeSheets(page);
  await page.waitForLoadState("networkidle");
  console.log(
    "PASS: project creation, idle agent membership, move existing agent, project-only agent lists after reload, Needs you stack, row-menu dismiss/retry/persistence, rejected approvals, queue reorder/edit/cancel from the row menu, paused Resume, uncluttered conversation, complete Markdown links and structured previews at mobile widths in both themes.",
  );
}
