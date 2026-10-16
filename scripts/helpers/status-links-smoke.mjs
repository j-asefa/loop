import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function statusLinksSmoke(page, f, _engine, capture) {
  const { db, owner, api, agents } = f;
  const project = (await api("/bootstrap")).folders.find((p) => p.is_workspace);
  const at = Date.now();
  const run = (title, state) => {
    const conversation = randomUUID(),
      run = randomUUID(),
      message = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
    ).run(conversation, owner, agents[0].id, title, at);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at,worker_id) VALUES(?,?,?,?,?,?,?,'{}',?,?,'fixture')",
    ).run(run, owner, agents[0].id, conversation, title, state, run, at, at);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user',?,?)",
    ).run(message, owner, conversation, run, title, at);
    return { conversation, run, message };
  };
  const done = run("Review the evidence", "completed");
  const working = run("Working source task", "running");
  const queued = run("Queued source task", "queued");
  const waiting = run("Release approval", "awaiting_approval");
  const approval = randomUUID(),
    artifact = randomUUID(),
    check = randomUUID(),
    checkout = randomUUID();
  db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,'pending',NULL,?,?)").run(
    approval,
    owner,
    waiting.run,
    "digest",
    "{}",
    at,
    at + 600_000,
  );
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,'Evidence result','markdown','The work is ready for review.',?,?,?)",
  ).run(
    artifact,
    owner,
    done.conversation,
    done.run,
    JSON.stringify({ messageId: done.message }),
    at,
    at,
  );
  db.prepare(
    "INSERT INTO run_verifications(id,owner_id,run_id,kind,tools,command,status,exit_code,observed_at) VALUES(?,?,?,'test','[\"vitest\"]','vitest source-links','passed',0,?)",
  ).run(check, owner, done.run, at);
  const summary = {
    id: checkout,
    state: "captured",
    branch: "main",
    base_ref: "main",
    ahead: 0,
    behind: 0,
    files: 0,
    additions: 0,
    deletions: 0,
    untracked: 0,
    remote: "unknown",
    started_dirty: false,
    overlap: 0,
    late: false,
    error: null,
  };
  db.prepare(
    "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state,summary,ended_at) VALUES(?,?,?,?,?,'/fixture/work','/fixture/source','main','head',0,0,?,'captured',?,?)",
  ).run(
    checkout,
    owner,
    done.run,
    agents[0].id,
    done.conversation,
    at - 1000,
    JSON.stringify(summary),
    at,
  );
  const refs = [{ ref: "res_" + artifact }, { ref: "msg_" + working.message }];
  const items = [
    {
      id: randomUUID(),
      kind: "state",
      text: "Review both source records",
      cite: refs,
    },
    {
      id: randomUUID(),
      kind: "unfinished",
      text: "Review recorded changes",
      next: "Inspect the checkout",
      blocker: "Review is pending",
      cite: [{ ref: "chk_" + checkout }],
    },
    {
      id: randomUUID(),
      kind: "question",
      text: "Did the recorded check pass?",
      cite: [{ ref: "ver_" + check }],
    },
  ];
  for (const item of items)
    db.prepare(
      "INSERT INTO brief_items(id,owner_id,project_id,kind,text,status,cites,next,blocker,author,first_version,last_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'model',1,1,?,?)",
    ).run(
      item.id,
      owner,
      project.id,
      item.kind,
      item.text,
      item.kind === "state" ? "active" : "open",
      JSON.stringify(item.cite),
      item.next ?? null,
      item.blocker ?? null,
      at,
      at,
    );
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,enabled,current_version) VALUES(?,?,1,1)",
  ).run(owner, project.id);
  const view = {
    headline: { text: "Open the original source", cite: [refs[0]] },
    state: [items[0].id],
    unfinished: [items[1].id],
    open_questions: [items[2].id],
    decisions: [],
    changes: [],
    overflow: { state: 0, decisions: 0, open_questions: 0, unfinished: 0 },
  };
  db.prepare(
    "INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,synth_at,built_on_version,owner_edit_rev,state,idempotency_key,created_at) VALUES(?,?,?,1,?,0,0,?,0,0,'published',?,?)",
  ).run(
    randomUUID(),
    owner,
    project.id,
    JSON.stringify(view),
    at,
    randomUUID(),
    at,
  );
  const home = f.base + "/?page=feed&filter=status&project=" + project.id;
  const card = page.locator(".project-status-card");
  const open = async () => {
    await page.goto(home);
    await expect(card).toHaveCount(1);
  };
  await open();
  await card
    .getByRole("link", { name: view.headline.text, exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`conversation=${done.conversation}.*message=${done.message}`),
  );
  await expect(page.locator(".thread-title")).toContainText(
    "Review the evidence",
  );
  await open();
  await card.getByRole("link", { name: items[0].text, exact: true }).focus();
  await page.keyboard.press("Enter");
  const sources = page.getByRole("dialog", { name: "Sources", exact: true });
  await expect(sources.locator(".status-source-link")).toHaveCount(2);
  await expect(sources.locator("a").first()).toHaveAttribute(
    "href",
    new RegExp(`conversation=${done.conversation}.*message=${done.message}`),
  );
  await sources.locator("a").last().click();
  await expect(page).toHaveURL(
    new RegExp(
      `conversation=${working.conversation}.*message=${working.message}`,
    ),
  );
  for (const [item, title] of [
    [items[1], "Checkout"],
    [items[2], "Verification"],
  ]) {
    await open();
    await card.getByRole("link").filter({ hasText: item.text }).click();
    await expect(
      page.getByRole("dialog", { name: title, exact: true }),
    ).toBeVisible();
    if (title === "Verification")
      await expect(
        page.getByRole("dialog", { name: title, exact: true }),
      ).toContainText("vitest source-links");
  }
  await open();
  await card
    .getByRole("button", { name: "1 waiting for you", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Waiting for you" })
    .getByRole("button")
    .filter({ hasText: "Release approval" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`conversation=${waiting.conversation}`),
  );
  assert.equal(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval).state,
    "pending",
  );
  for (const [label, filter, task] of [
    ["1 working", "working", "Working source task"],
    ["1 queued", "queued", "Queued source task"],
  ]) {
    await open();
    await card.getByRole("link", { name: label, exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("project"), project.id);
    assert.equal(new URL(page.url()).searchParams.get("filter"), filter);
    await expect(page.locator(".inbox-list")).toContainText(task);
  }
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(artifact);
  await open();
  await card
    .getByRole("link", { name: view.headline.text, exact: true })
    .click();
  await expect(sources).toContainText(
    "This source is no longer available in this project.",
  );
  await expect(sources.locator(".status-source-link")).toHaveCount(0);
  await sources.getByRole("button", { name: "Close", exact: true }).click();
  db.prepare("UPDATE artifacts SET archived=0 WHERE id=?").run(artifact);
  assert.equal(
    db.prepare("SELECT count(*) n FROM brief_acks WHERE owner_id=?").get(owner)
      .n,
    0,
  );
  // A deep link opened separately still reaches the same evidence.
  await page.goto(
    f.base +
      `/?page=projects&projectView=${project.id}&projectTab=brief&briefEvidence=${items[0].id}`,
  );
  await expect(sources.locator(".status-source-link")).toHaveCount(2);
  assert.equal(
    db.prepare("SELECT count(*) n FROM brief_acks WHERE owner_id=?").get(owner)
      .n,
    0,
  );
  await sources.getByRole("button", { name: "Close", exact: true }).click();
  await open();
  await card.locator(".project-status-details summary").click();
  await card.getByRole("link", { name: "Open questions", exact: true }).click();
  await expect(page.locator("dialog.brief-sheet[open]")).toContainText(
    items[2].text,
  );
  const linked = {
    id: "docker:status-links",
    name: "Linked evidence",
    kind: "docker",
  };
  const evidenceRequests = [];
  await page.route("**/api/agent-sources", (route) =>
    route.fulfill({ json: [linked] }),
  );
  await page.route("**/api/agent-sources/*/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/agent-sources\/[^/]+/, "");
    if (path.endsWith("/brief/evidence")) evidenceRequests.push(url.pathname);
    try {
      await route.fulfill({ json: await api(path + url.search) });
    } catch {
      await route.fulfill({
        status: 404,
        json: { error: "Fixture source unavailable" },
      });
    }
  });
  await page.goto(home + "&source=" + encodeURIComponent(linked.id));
  await expect(card).toHaveCount(1);
  await card.getByRole("link", { name: items[0].text, exact: true }).click();
  await expect(sources.locator(".status-source-link")).toHaveCount(2);
  for (const link of await sources.locator(".status-source-link").all())
    await expect(link).toHaveAttribute("href", /source=docker%3Astatus-links/);
  assert.equal(evidenceRequests.length, 1);
  await sources.getByRole("button", { name: "Close", exact: true }).click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await capture("clickable-status-" + width);
  }
}
