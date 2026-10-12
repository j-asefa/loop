import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function briefSmoke(page, fixture, _engine, capture) {
  const { db, owner, api } = fixture,
    project = fixture.projects[1].id;
  const artifact = fixture.artifacts[0],
    thread = fixture.conversations[0].id;
  const message = JSON.parse(
    db.prepare("SELECT metadata FROM artifacts WHERE id=?").get(artifact)
      .metadata,
  ).messageId;
  const prompt = db
    .prepare(
      "SELECT id FROM messages WHERE owner_id=? AND conversation_id=? AND role='user' ORDER BY created_at LIMIT 1",
    )
    .get(owner, thread).id;
  const connection = await api("/connections", {
    provider: "openai",
    label: "Brief API fixture",
    secret: "fixture-only-not-a-real-key",
  });
  db.prepare("UPDATE folders SET name='Loop release' WHERE id=?").run(project);
  const root = `/projects/${project}/brief`;
  await api(
    root + "/goal",
    { text: "Ship a reliable, evidence-backed project brief." },
    "PUT",
  );
  const ids = { state: [], decisions: [], open_questions: [], unfinished: [] },
    now = Date.now();
  const insert =
    db.prepare(`INSERT INTO brief_items(id,owner_id,project_id,kind,text,why,status,cites,evidence,decided_by,asked_by,thread_id,next,blocker,author,pinned,cite_stale,first_version,last_version,created_at,updated_at)
    VALUES(@id,@owner,@project,@kind,@text,@why,@status,@cites,@evidence,@decided_by,@asked_by,@thread,@next,@blocker,'model',@pinned,@stale,1,1,@at,@at)`);
  function item(kind, text, extra = {}) {
    const id = randomUUID();
    insert.run({
      id,
      owner,
      project,
      kind,
      text,
      why: null,
      status: kind === "state" || kind === "decision" ? "active" : "open",
      cites: JSON.stringify([
        { ref: kind === "decision" ? "msg_" + prompt : "res_" + artifact },
      ]),
      evidence: kind === "decision" ? "owner_message" : null,
      decided_by: kind === "decision" ? "you" : null,
      asked_by: kind === "question" ? fixture.agents[1].id : null,
      thread: kind === "unfinished" ? thread : null,
      next: null,
      blocker: null,
      pinned: 0,
      stale: 0,
      at: now,
      ...extra,
    });
    return id;
  }
  ids.state.push(
    item("state", "Routing and durable publication are verified."),
  );
  for (let n = 0; n < 21; n++)
    ids.decisions.push(
      item(
        "decision",
        n === 0
          ? "Keep every decision in the project ledger"
          : `Release decision ${n + 1}`,
        {
          why:
            n === 0
              ? "A compact view should never lose the record."
              : "Supported by the project discussion.",
          pinned: n === 0 ? 1 : 0,
        },
      ),
    );
  ids.open_questions.push(
    item("question", "Is the project ready for the next release?", {
      stale: 1,
    }),
  );
  ids.unfinished.push(
    item("unfinished", "Finish the phone review", {
      next: "Check the brief on a 390 px screen.",
    }),
  );
  const old = item("decision", "Keep only the most recent decisions", {
    status: "superseded",
  });
  db.prepare("UPDATE brief_items SET supersedes=? WHERE id=?").run(
    old,
    ids.decisions[0],
  );
  const through = db
    .prepare(
      "SELECT max(seq) seq FROM project_changes WHERE owner_id=? AND project_id=?",
    )
    .get(owner, project).seq;
  const view = {
    ...ids,
    decisions: ids.decisions.slice(0, 20),
    headline: {
      text: "The brief is ready for its phone review",
      cite: [{ ref: "res_" + artifact }],
    },
    overflow: { state: 0, decisions: 1, open_questions: 0, unfinished: 0 },
    changes: [
      {
        op: "added",
        field: "state",
        id: ids.state[0],
        since_version: 1,
        pinned: false,
      },
    ],
  };
  db.prepare(
    `INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,synth_at,connection_id,model,built_on_version,owner_edit_rev,state,idempotency_key,created_at)
    VALUES(?,?,?,1,?,0,?,?,?,'openai-fixture',0,1,'published',?,?)`,
  ).run(
    randomUUID(),
    owner,
    project,
    JSON.stringify(view),
    through,
    now,
    connection.id,
    "brief-fixture:" + project,
    now,
  );
  db.prepare(
    "UPDATE brief_state SET current_version=1,basis_through=? WHERE owner_id=? AND project_id=?",
  ).run(through, owner, project);
  const acks = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(root + "/ack"))
      acks.push(request.postDataJSON().version);
  });
  await page.goto(fixture.base);
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Loop release/ })
    .first()
    .click();
  const projectTabs = page.locator(".project-tabs");
  await projectTabs.getByRole("button", { name: "Brief", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your project, at a glance" }),
  ).toBeVisible();
  await page.getByLabel("API connection").selectOption(connection.id);
  await page.getByRole("button", { name: "Enable brief", exact: true }).click();
  await expect(page.locator(".brief-headline h2")).toHaveText(
    "The brief is ready for its phone review",
  );
  await expect.poll(() => acks).toEqual([1]);
  for (let n = 0; n < 2; n++) {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith(root) && response.request().method() === "GET",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
    await response;
  }
  assert.deepEqual(
    acks,
    [1],
    "Refresh must not acknowledge the same version again",
  );
  await page.locator(".brief-goal").scrollIntoViewIfNeeded();
  await capture("brief-390");
  await page
    .getByRole("button", { name: "1 more · Show all", exact: true })
    .click();
  const sheet = page.locator("dialog.brief-sheet[open]");
  await expect(sheet.locator(".brief-item")).toHaveCount(22);
  await expect(sheet.locator(".brief-superseded")).toHaveText(
    "Keep only the most recent decisions",
  );
  await expect(
    sheet.getByText("Replaced by · Keep every decision in the project ledger"),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  // A slow old section must not replace the currently selected ledger page.
  let releaseQuestions;
  const heldQuestions = new Promise((resolve) => {
    releaseQuestions = resolve;
  });
  await page.route("**/brief/items?kind=question", async (route) => {
    await heldQuestions;
    await route.continue();
  });
  await page
    .getByRole("region", { name: "Open questions", exact: true })
    .getByRole("button", { name: "Show all", exact: true })
    .click();
  await expect(sheet.getByText("Loading items…")).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "1 more · Show all", exact: true })
    .click();
  await expect(sheet.locator(".brief-item")).toHaveCount(22);
  const lateQuestions = page.waitForResponse((response) =>
    response.url().endsWith("/brief/items?kind=question"),
  );
  releaseQuestions();
  await lateQuestions;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(sheet.locator(".brief-item")).toHaveCount(22);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .locator(".brief-item-open")
    .filter({ hasText: "Routing and durable publication" })
    .click();
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet
    .getByLabel("Text", { exact: true })
    .fill("The owner verified routing and durable publication.");
  await sheet.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(page.locator(".brief-item-open").first()).toContainText(
    "The owner verified routing",
  );
  await expect(page.locator(".brief-item-open").first()).toContainText(
    "Pinned",
  );
  await expect.poll(() => acks).toEqual([1, 2]);
  await projectTabs
    .getByRole("button", { name: "Threads", exact: true })
    .click();
  await projectTabs.getByRole("button", { name: "Brief", exact: true }).click();
  await expect(page.locator(".brief-item-open").first()).toContainText(
    "The owner verified routing",
  );

  await page.locator(".brief-item-open").first().click();
  await expect(
    sheet.getByRole("heading", { name: "Item history" }),
  ).toBeVisible();
  await expect(sheet.getByText("Version 2", { exact: true })).toBeVisible();
  await capture("brief-item-390");
  await sheet
    .getByRole("link", { name: "Open thread at result", exact: true })
    .click();
  await expect(
    page.locator(`.conversation-sheet #message-${message}`),
  ).toHaveClass(/anchored/);
  await page
    .locator("dialog.conversation-sheet[open]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Goal · you", exact: false }).click();
  await sheet
    .getByLabel("Goal · you")
    .fill("Ship the brief after checks and review.");
  await sheet.getByRole("button", { name: "Save goal", exact: true }).click();
  await expect(page.locator(".brief-goal")).toContainText(
    "Ship the brief after checks and review.",
  );
  assert.equal(
    (await api(root)).version,
    2,
    "A goal change should not create a content version",
  );
  await projectTabs
    .getByRole("button", { name: "Threads", exact: true })
    .click();
  await projectTabs.getByRole("button", { name: "Brief", exact: true }).click();
  await expect(page.locator(".brief-goal")).toContainText(
    "Ship the brief after checks and review.",
  );
  // Forget only this project's deliberate tab selection and prove the enabled default.
  await page.evaluate((project) => {
    sessionStorage.removeItem("loop-project-tab:" + project);
  }, project);
  await page.reload();
  await expect(
    projectTabs.getByRole("button", { name: "Brief", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".project-brief")).toBeVisible();
  assert.deepEqual(
    acks,
    [1, 2],
    "Reopening an acknowledged version must not post again",
  );
  const replacement = await api("/connections", {
    provider: "openai",
    label: "Replacement Brief API",
    secret: "fixture-only-not-a-real-key",
  });
  db.prepare("UPDATE connections SET status='error' WHERE id=?").run(
    connection.id,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Brief settings", exact: true })
    .click();
  await expect(sheet.getByLabel("API connection")).toHaveValue(replacement.id);
  await sheet
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect
    .poll(async () => (await api(root)).settings.connectionId)
    .toBe(replacement.id);
  await page
    .getByRole("button", { name: "Brief settings", exact: true })
    .click();
  await sheet.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(page.locator(".brief-setup")).toBeVisible();
  await page
    .getByRole("button", { name: "View recorded brief", exact: true })
    .click();
  await expect(page.locator(".brief-goal")).toContainText(
    "Ship the brief after checks and review.",
  );
  await expect(page.locator(".brief-item-open").first()).toContainText(
    "The owner verified routing",
  );
  assert.equal((await api(root)).settings.enabled, false);
}
