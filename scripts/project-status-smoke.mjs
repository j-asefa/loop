import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, webkit, expect } from "@playwright/test";
import { designFixture } from "./helpers/design-fixture.mjs";

// Production app and API, in an isolated workspace with no executing worker.
const f = await designFixture();
let browser;
try {
  const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
  browser = await engine.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
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
  const release = page.locator(".project-status-card").filter({
    has: page.getByRole("link", { name: project.name, exact: true }),
  });
  const details = release.locator(".project-status-details");
  await expect(release.getByRole("button", { name: /^Changes:/ })).toBeHidden();
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  assert(
    page.url().includes("filter=status"),
    "Details must not navigate away",
  );
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
  await release.getByRole("button", { name: /View all 2/ }).click();
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
  await page.route(/\/api\/projects\/status(?:\?.*)?$/, (route) =>
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
  assert(!after.some((s) => s.startsWith("Now")));
  await page.unroute(/\/api\/projects\/status(?:\?.*)?$/);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".status-live").first()).toHaveText("Now");
  // A keyboard activation freezes its target until key-up, then applies both
  // refreshed counts and the requested ordering without requiring a blur.
  const idleRun = f.db
    .prepare(
      `SELECT r.* FROM runs r JOIN conversations c ON c.id=r.conversation_id
    JOIN project_change_folders p ON p.owner_id=c.owner_id AND p.folder_id=c.feed_folder_id
    WHERE c.owner_id=? AND p.project_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`,
    )
    .get(f.owner, idle.id);
  const idleApproval = randomUUID(),
    changedAt = Date.now();
  f.db
    .prepare(
      "UPDATE runs SET state='awaiting_approval',updated_at=? WHERE id=?",
    )
    .run(changedAt, idleRun.id);
  f.db
    .prepare("INSERT INTO approvals VALUES(?,?,?,?,?,'pending',NULL,?,?)")
    .run(
      idleApproval,
      f.owner,
      idleRun.id,
      randomUUID(),
      "{}",
      changedAt,
      changedAt + 60_000,
    );
  const idleCard = page
    .locator(".project-status-card")
    .filter({ has: page.getByRole("link", { name: idle.name, exact: true }) });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.focus();
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects/status",
  );
  await page.keyboard.down("Enter");
  await refreshed;
  await expect(idleCard.locator(".project-status-counts")).toContainText(
    "Last seen",
  );
  await expect(idleCard.locator(".project-status-counts")).toContainText(
    "No agents working",
  );
  await page.keyboard.up("Enter");
  await expect(idleCard.locator(".project-status-counts")).toContainText(
    "1 waiting for you",
  );
  await expect(page.locator(".project-status-card").first()).toContainText(
    idle.name,
  );
  await expect(refresh).toBeFocused();
  f.db
    .prepare("UPDATE approvals SET state='rejected' WHERE id=?")
    .run(idleApproval);
  f.db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(idleRun.id);
  await refresh.press("Enter");
  await expect(idleCard.locator(".project-status-counts")).toContainText(
    "No agents working",
  );
  await expect(idleCard.locator(".status-live")).toHaveText("Now");

  // A revalidated review request selects the PR, even with two watches in the
  // same conversation. All GitHub reads still use the fixture's offline URL.
  for (const c of f.db
    .prepare(
      `SELECT c.id FROM conversations c JOIN project_change_folders p
    ON p.owner_id=c.owner_id AND p.folder_id=c.feed_folder_id WHERE c.owner_id=? AND p.project_id=?`,
    )
    .all(f.owner, project.id)) {
    f.db
      .prepare(
        "UPDATE approvals SET state='rejected' WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=?)",
      )
      .run(c.id);
    f.db
      .prepare("UPDATE runs SET state='completed' WHERE conversation_id=?")
      .run(c.id);
  }
  f.db
    .prepare(
      "UPDATE pr_watches SET login='james' WHERE owner_id=? AND number=120",
    )
    .run(f.owner);
  const reviewArtifact = randomUUID();
  f.db
    .prepare(
      `INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at)
    VALUES(?,?,?,?,?,'Review reconnect','github_pr',?,?,?)`,
    )
    .run(
      reviewArtifact,
      f.owner,
      captured.agent_id,
      captured.conversation_id,
      captured.id,
      JSON.stringify({
        type: "github_pull_requests",
        pulls: [
          {
            owner: "acme",
            repo: "loop",
            number: 120,
            state: "open",
            headSha: "head",
            reviewers: ["james"],
          },
        ],
      }),
      Date.now(),
      Date.now(),
    );
  f.db
    .prepare(
      "INSERT OR IGNORE INTO artifact_publications(artifact_id) VALUES(?)",
    )
    .run(reviewArtifact);
  await refresh.press("Enter");
  await release
    .getByRole("button", { name: "Review pull request", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("pull"))
    .toBe("acme/loop/120");
  assert.equal(new URL(page.url()).searchParams.get("page"), "pulls");
  assert.equal(new URL(page.url()).searchParams.has("conversation"), false);
  await page.goto(f.base + "/?filter=status");
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
  await page
    .locator(".project-tabs")
    .getByRole("button", { name: "Threads", exact: true })
    .click();
  await page.reload();
  await expect(
    page
      .locator(".project-tabs")
      .getByRole("button", { name: "Threads", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  assert.equal(new URL(page.url()).searchParams.has("projectTab"), false);
  // Two workspace APIs, with colliding project IDs, exercise production source
  // routing. Filters belong to the source whose selectors supplied those IDs.
  const source = {
    id: "cloud:status-fixture",
    name: "Linked fixture",
    kind: "cloud",
  };
  let linkedFailed = false;
  const statusRequests = [];
  await page.route("**/api/agent-sources", (route) =>
    route.fulfill({ json: [source] }),
  );
  await page.route("**/api/agent-sources/*/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/agent-sources\/[^/]+/, "/api");
    if (path === "/api/projects/status") {
      statusRequests.push({
        source: source.id,
        project: url.searchParams.get("project"),
        teams: url.searchParams.get("teams"),
      });
      if (linkedFailed)
        return route.fulfill({
          status: 503,
          json: { error: "Fixture disconnected" },
        });
    }
    const response = await route.fetch({ url: f.base + path + url.search });
    if (path !== "/api/projects/status") return route.fulfill({ response });
    const data = await response.json();
    data.items = data.items.map((p) => ({ ...p, name: "Linked " + p.name }));
    return route.fulfill({ response, json: data });
  });
  await page.route(/\/api\/projects\/status(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    statusRequests.push({
      source: "",
      project: url.searchParams.get("project"),
      teams: url.searchParams.get("teams"),
    });
    return route.continue();
  });
  const linkedUrl =
    f.base + "/?source=" + encodeURIComponent(source.id) + "&filter=status";
  await page.goto(linkedUrl);
  await expect(page.locator(".project-status-card")).toHaveCount(6);
  const linkedCard = page.locator(".project-status-card").filter({
    has: page.getByRole("link", {
      name: "Linked " + project.name,
      exact: true,
    }),
  });
  const localCard = page.locator(".project-status-card").filter({
    has: page.getByRole("link", { name: project.name, exact: true }),
  });
  linkedFailed = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(linkedCard.locator(".project-status-counts")).toContainText(
    "Last seen",
  );
  await expect(localCard.locator(".status-live")).toHaveText("Now");
  await expect(page.locator(".project-status-card")).toHaveCount(6);
  linkedFailed = false;
  await page.getByLabel("Filter by project").selectOption(project.id);
  await expect(page.locator(".project-status-card")).toHaveCount(1);
  await expect(linkedCard).toBeVisible();
  await expect(page.locator(".project-status .field-hint")).toContainText(
    "Activity and evidence: Linked fixture",
  );
  assert(
    statusRequests.some(
      (r) => r.source === source.id && r.project === project.id,
    ),
  );
  assert(!statusRequests.some((r) => !r.source && r.project === project.id));
  const team = f.db
    .prepare("SELECT id FROM teams WHERE owner_id=? LIMIT 1")
    .get(f.owner);
  await page.goto(linkedUrl + "&teams=" + encodeURIComponent(team.id));
  await expect(page.locator(".project-status-card")).toHaveCount(3);
  await expect(page.locator(".project-status .field-hint")).toContainText(
    "Selected teams; briefs and recorded blockers describe the whole project",
  );
  assert(
    statusRequests.some((r) => r.source === source.id && r.teams === team.id),
  );
  assert(!statusRequests.some((r) => !r.source && r.teams === team.id));
  // A dense recorded brief stays readable without promoting historical totals
  // into current requests. Use the same long wording as the reported card.
  const densePage = await f.api("/projects/status");
  const dense = structuredClone(densePage.items[0]);
  await page.route("**/api/agent-sources", (route) =>
    route.fulfill({ json: [] }),
  );
  dense.name = "loop";
  dense.status = "blocked";
  dense.counts = { needs: 0, working: 0, queued: 0 };
  dense.actions = [];
  dense.pulls = [];
  dense.brief = {
    state: "ready",
    headline:
      "c96cd311 consolidation confirms P2 tab persistence; reported P1 filtering loss is unsubstantiated. Repair and validation pending.",
    synthesized_at: Date.now() - 3 * 60 * 60_000,
    pending: 0,
    highlights: {
      updated_at: Date.now() - 3 * 60 * 60_000,
      progress: [
        {
          id: "state-tabs",
          text: "Review confirms the selected tab is still lost when the app reopens.",
        },
        {
          id: "state-filters",
          text: "The reported filtering problem has not been reproduced.",
        },
      ],
      task: {
        id: "task-tabs",
        text: "Keep the selected tab after reopening",
        blocker: "The fix and validation are still pending.",
        next: "Save the tab selection, then test reopening and navigation.",
      },
      question: {
        id: "question-filters",
        text: "What steps reproduce the filtering problem?",
      },
    },
    blockers: 141,
    unfinished: 145,
    questions: 97,
  };
  await page.route(/\/api\/projects\/status(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { ...densePage, items: [dense] },
    }),
  );
  await page.goto(f.base + "/?filter=status");
  const denseCard = page.locator(".project-status-card").first();
  await expect(denseCard).toContainText(
    "consolidation confirms P2 tab persistence",
  );
  await expect(denseCard).not.toContainText("c96cd311");
  await expect(denseCard.getByText("141 recorded blockers")).toBeHidden();
  await expect(
    denseCard.getByRole("link", { name: "Review blockers" }),
  ).toBeVisible();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    for (const text of [
      "Where things stand",
      "Next up",
      dense.brief.highlights.task.next,
      dense.brief.highlights.question.text,
    ]) {
      await expect(denseCard.getByText(text, { exact: false })).toBeVisible();
    }
  }
  // Cached briefs can contain internal identities and uploaded payloads. They
  // are readable immediately, without regenerating the brief or changing IDs.
  const readableTask = { ...dense.brief.highlights.task };
  const displayAgent = densePage.agents[0];
  const encoded = "YWJj".repeat(100);
  dense.brief.highlights.task.next = `Ask @${displayAgent.id} to review thread ${project.id}.`;
  dense.brief.highlights.task.blocker = `Check the attachment: ${encoded}`;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(denseCard).toContainText(
    `Ask @${displayAgent.name} to review the conversation.`,
  );
  for (const token of [displayAgent.id, project.id, encoded])
    await expect(denseCard).not.toContainText(token);
  await expect(
    denseCard.getByRole("link", { name: "Review blockers" }),
  ).toHaveAttribute("href", new RegExp("projectView=" + dense.id));
  dense.brief.highlights.task = readableTask;
  // Illustrative brief content for the design preview, not a live project read.
  dense.brief.headline =
    "Tabs still reset after reopening. The fix is next; the filtering issue remains unconfirmed.";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(denseCard).toContainText(dense.brief.headline);
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.LOOP_STATUS_SCREENSHOT) {
    // Keep fixed app navigation outside the card-only design capture.
    await page.setViewportSize({ width: 390, height: 1400 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await denseCard.screenshot({
        path: process.env.LOOP_STATUS_SCREENSHOT.replace(
          /\.png$/,
          `-${theme}-card.png`,
        ),
      });
    }
  }
  const denseDetails = denseCard.locator(".project-status-details");
  await denseDetails.locator("summary").click();
  await expect(denseCard.getByText("141 recorded blockers")).toBeVisible();
  await expect(denseCard.locator(".project-status-ledger")).toContainText(
    "145",
  );
  await expect(denseCard.locator(".project-status-ledger")).toContainText("97");
  await denseDetails.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(denseCard.getByText("141 recorded blockers")).toBeHidden();
  assert(page.url().includes("filter=status"));
  assert.deepEqual(errors, []);
  console.log(
    "Status: phone widths, empty evidence, no acknowledgement, stale refresh and setup navigation passed",
  );
} finally {
  await browser?.close();
  await f.close();
}
