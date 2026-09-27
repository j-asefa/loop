import { closeSheets } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function projectsAttentionJourney(page, api, base, dir) {
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
  await expect(page.locator(".project-agents .project-agent")).toHaveCount(0);
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  dialog = page.locator("dialog[open]").last();
  await expect(dialog.getByLabel("Project", { exact: true })).toHaveValue(
    project.id,
  );
  await dialog.getByLabel("Unique name").fill("project-resident");
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
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
  await page.getByRole("button", { name: /Field notes.*2 agents/ }).click();
  await expect(page.locator(".projects-view .project-agent")).toHaveCount(2);
  await page.getByRole("button", { name: /@project-resident/ }).click();
  await page.getByRole("button", { name: "Edit agent", exact: true }).click();
  await expect(
    page.locator("dialog[open]").last().getByLabel("Project", { exact: true }),
  ).toHaveValue(project.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to project" }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      localStorage.setItem("loop-theme", theme);
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
          `loop-projects-${process.env.LOOP_BROWSER || "chromium"}-${theme}-${width}.png`,
        ),
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // These are isolated fixture records, not tasks executed by real providers.
  const db = new Database(join(dir, "loop.db"));
  const failed = crypto.randomUUID(),
    paused = crypto.randomUUID(),
    queued = crypto.randomUUID(),
    approvalRun = crypto.randomUUID(),
    approval = crypto.randomUUID(),
    conversation = crypto.randomUUID();
  try {
    db.transaction(() => {
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
      ).run(
        conversation,
        resident.owner_id,
        resident.id,
        "Dismissal fixture history",
        Date.now(),
      );
      const insert = db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const [id, state, input] of [
        [paused, "paused", "Fixture queue barrier"],
        [queued, "queued", "Unwanted queued idea"],
        [failed, "failed", "Dismissible failure"],
        [approvalRun, "awaiting_approval", "Unwanted permission request"],
      ])
        insert.run(
          id,
          resident.owner_id,
          resident.id,
          conversation,
          input,
          state,
          id,
          JSON.stringify({
            model: resident.model,
            provider: resident.provider,
          }),
          state === "failed" ? "Fixture failure" : null,
          Date.now() - (id === paused ? 5000 : 0),
          Date.now(),
        );
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
    const banner = page.getByRole("button", { name: /need attention/ });
    await expect(banner).toBeVisible();
    assert.ok((await banner.boundingBox()).height >= 44);
    await page.screenshot({
      path: join(
        tmpdir(),
        `loop-attention-${process.env.LOOP_BROWSER || "chromium"}.png`,
      ),
    });
    await banner.click();
    const dismiss = page.getByRole("button", {
      name: "Dismiss task: Dismissible failure",
      exact: true,
    });
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
    await dismiss.click();
    await expect(
      page.getByText("Fixture dismissal unavailable", { exact: true }),
    ).toBeVisible();
    await expect(dismiss).toBeEnabled();
    await dismiss.click();
    await expect(dismiss).toBeHidden();
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
    await page.getByRole("button", { name: "Queued", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Cancel task: Unwanted queued idea",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Cancel task: Unwanted queued idea",
        exact: true,
      }),
    ).toBeHidden();
    // Dismissal refreshes bootstrap/feed/runs after removing the card. Let that
    // refresh settle before navigation, then wait for the reloaded app as well.
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.ok(
      !(await api("/runs?active=1")).some((r) =>
        [failed, approvalRun, queued].includes(r.id),
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
        `loop-conversation-reading-${process.env.LOOP_BROWSER || "chromium"}.png`,
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
    const tool = await api("/artifacts", {
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
      title: "Complete Markdown preview",
      content:
        "Clear context. ".repeat(46) +
        "[Original source](https://example.com/source?first=yes&second=true) and **complete emphasis**.\n\n```js\nconst code = true;\n```\n\nFull original ending.",
    });
    await api("/artifacts", {
      title: "Native table preview",
      kind: "table",
      content: JSON.stringify({
        columns: ["Item", "Count"],
        rows: [["Apples", 3]],
      }),
    });
    const web = await api("/artifacts", {
      title: "web_fetch_exa result",
      content:
        "# Substrate fixture\nURL: https://github.com/fixture/substrate\n\n# Substrate fixture\n\n- Stars: 1593\n- Forks: 264\n\n## README\n\nA useful system for running agents on shared infrastructure, with suspended sessions that keep their working state.",
    });
    // This manually saved file exercises preview rendering; it is not a run trace.
    await page.goto(base);
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
        `loop-web-preview-${process.env.LOOP_BROWSER || "chromium"}.png`,
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
            `loop-previews-${process.env.LOOP_BROWSER || "chromium"}-${theme}-${width}.png`,
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
      `loop-tool-approvals-${process.env.LOOP_BROWSER || "chromium"}.png`,
    ),
  });
  await page.waitForLoadState("networkidle");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
    "PASS: project creation, idle agent membership, move existing agent, project-only agent lists after reload, prominent attention, dismiss/retry/persistence, rejected approvals, queued cancellation, uncluttered conversation, complete Markdown links and structured previews at mobile widths in both themes.",
  );
}
