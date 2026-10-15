import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";

// Production app and API, in an isolated workspace with no executing worker.
const f = await designFixture();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const [project, working, idle] = f.projects;
  // Give the first two projects recorded headlines without acknowledging them.
  for (const [p, headline] of [
    [project, "Reconnect fixes are ready for review."],
    [working, "Search is ready. The migration guide is next."],
  ]) {
    const t = Date.now() - 8 * 60_000;
    f.db
      .prepare(
        "INSERT INTO brief_state(owner_id,project_id,enabled,current_version) VALUES(?,?,1,1)",
      )
      .run(f.owner, p.id);
    f.db
      .prepare(
        "INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,synth_at,built_on_version,owner_edit_rev,state,idempotency_key,created_at) VALUES(?,?,?,1,?,0,0,?,0,0,'published',?,?)",
      )
      .run(
        randomUUID(),
        f.owner,
        p.id,
        JSON.stringify({
          headline: { text: headline, cite: [] },
          state: [],
          decisions: [],
          open_questions: [],
          unfinished: [],
          changes: [],
          overflow: {
            state: 0,
            decisions: 0,
            open_questions: 0,
            unfinished: 0,
          },
        }),
        t,
        randomUUID(),
        t,
      );
  }
  // The second project is progressing; the third is idle with no brief.
  for (const c of f.db
    .prepare(
      "SELECT c.id FROM conversations c JOIN project_change_folders p ON p.owner_id=c.owner_id AND p.folder_id=c.feed_folder_id WHERE c.owner_id=? AND p.project_id=?",
    )
    .all(f.owner, working.id)) {
    f.db
      .prepare(
        "UPDATE approvals SET state='rejected' WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)",
      )
      .run(c.id);
    f.db
      .prepare(
        "UPDATE runs SET state='completed' WHERE conversation_id=? AND state IN ('awaiting_approval','paused','failed','interrupted')",
      )
      .run(c.id);
  }
  const idleConversations = f.db
    .prepare(
      "SELECT c.id FROM conversations c JOIN project_change_folders p ON p.owner_id=c.owner_id AND p.folder_id=c.feed_folder_id WHERE c.owner_id=? AND p.project_id=?",
    )
    .all(f.owner, idle.id);
  for (const c of idleConversations) {
    f.db
      .prepare(
        "UPDATE approvals SET state='rejected' WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)",
      )
      .run(c.id);
    f.db
      .prepare("UPDATE runs SET state='completed' WHERE conversation_id=?")
      .run(c.id);
  }
  const captured = f.db
    .prepare(
      `SELECT r.* FROM runs r JOIN conversations c ON c.id=r.conversation_id
    JOIN project_change_folders p ON p.owner_id=r.owner_id AND p.folder_id=COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))
    WHERE r.owner_id=? AND p.project_id=? ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(f.owner, project.id);
  const capture = randomUUID(),
    at = Date.now() - 6 * 60_000;
  const summary = {
    id: capture,
    state: "captured",
    branch: "loop/agent-abcd",
    base_ref: "main",
    ahead: 1,
    behind: 0,
    files: 1,
    additions: 84,
    deletions: 19,
    untracked: 0,
    remote: "unknown",
    started_dirty: false,
    overlap: 0,
    late: false,
    error: null,
  };
  f.db
    .prepare(
      `INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state,summary,ended_at)
    VALUES(?,?,?,?,?,'/fixture/work','/fixture/source','loop/agent-abcd','head',0,0,?,'captured',?,?)`,
    )
    .run(
      capture,
      f.owner,
      captured.id,
      captured.agent_id,
      captured.conversation_id,
      at - 60_000,
      JSON.stringify(summary),
      at,
    );
  f.db
    .prepare(
      "INSERT INTO run_verifications(id,owner_id,run_id,kind,tools,command,status,exit_code,observed_at) VALUES(?,?,?,'test','[\"vitest\"]','vitest reconnect.test.ts','passed',0,?)",
    )
    .run(randomUUID(), f.owner, captured.id, at - 20_000);
  for (const [number, conclusion, time] of [
    [120, "failure", at],
    [121, "success", at + 30_000],
  ])
    f.db
      .prepare(
        `INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,head_sha,ci_sha,ci_conclusion,seen_ci_sha,seen_ci_conclusion,read_at,created_at,updated_at)
    VALUES(?,?,?,?,'acme','loop',?,'watching','head','head',?,'head',?,?,?,?)`,
      )
      .run(
        randomUUID(),
        f.owner,
        captured.conversation_id,
        captured.agent_id,
        number,
        conclusion,
        conclusion,
        time,
        time,
        time,
      );
  await page.goto(f.base + "/?filter=status");
  await expect(
    page.getByRole("tab", { name: "Status", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".project-status-card")).toHaveCount(3);
  await expect(page.locator(".your-agents")).toHaveCount(0);
  await expect(page.locator(".needs-stack")).toHaveCount(0);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM brief_acks WHERE owner_id=?")
      .get(f.owner).n,
    0,
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.LOOP_STATUS_SCREENSHOT)
    await page.screenshot({
      path: process.env.LOOP_STATUS_SCREENSHOT,
      fullPage: true,
    });
  const release = page
    .locator(".project-status-card")
    .filter({
      has: page.getByRole("link", { name: project.name, exact: true }),
    });
  await release.getByRole("button", { name: /^Changes:/ }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Checkout", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await release.getByRole("button", { name: /^Verification:/ }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("vitest reconnect.test.ts", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await release.getByRole("button", { name: /All 2 watches/ }).click();
  await expect(
    page.getByRole("dialog").locator(".project-status-pull-detail"),
  ).toHaveCount(2);
  await expect(
    page.getByRole("dialog").locator(".project-status-pull-detail").first(),
  ).toContainText("120");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  // A failed refresh keeps the actual counts and explicitly marks them stale.
  const before = await page.locator(".project-status-counts").allTextContents();
  await page.route("**/api/projects/status?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "offline" }),
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".project-status-counts").first()).toContainText(
    "Last seen",
  );
  const after = await page.locator(".project-status-counts").allTextContents();
  assert.equal(after.length, before.length);
  assert(!after.some((s) => s.startsWith("Live")));
  await page.unroute("**/api/projects/status?*");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".status-live").first()).toHaveText("Live");
  // Enable opens source/model setup in the correct project, without enabling.
  await page
    .locator(".project-status-card")
    .filter({ has: page.getByRole("link", { name: idle.name, exact: true }) })
    .getByRole("link", { name: "Enable brief" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your project, at a glance" }),
  ).toBeVisible();
  assert.equal(
    f.db
      .prepare(
        "SELECT enabled FROM brief_state WHERE owner_id=? AND project_id=?",
      )
      .get(f.owner, idle.id)?.enabled ?? 0,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Status: phone widths, empty evidence, no acknowledgement, stale refresh and setup navigation passed",
  );
} finally {
  await browser?.close();
  await f.close();
}
