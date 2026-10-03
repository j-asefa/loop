import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

// Continuity journeys: resume unfinished work from the Feed, return to an
// earlier point in a long thread and back, defer with Remind me and Send
// later (with links, Undo and recovery), find saved decisions and project
// history, manage queued messages, and review reported file activity.
// Everything goes through the production routes and persisted state; the
// fixture has no worker, so queued and scheduled work stays put.
export async function continuitySmoke(page, fixture, capture) {
  const dialog = () => page.locator("dialog[open]").last();
  const thread = () => page.locator("dialog.conversation-sheet[open]");
  const nav = (name) =>
    page.locator(".mobile-nav").getByRole("button", { name, exact: true });
  const card = (title) =>
    page.locator(".inbox-card").filter({
      has: page.locator(`.inbox-row[aria-label^="${title}"]`),
    });
  const later = page.getByRole("region", { name: "Later", exact: true });
  // Later's sections are tabs on your profile.
  const laterTab = (name) =>
    page
      .getByRole("region", { name: "Your profile", exact: true })
      .getByRole("tablist", { name: "Show" })
      .getByRole("tab", { name: new RegExp("^" + name) });
  const toast = page.locator(".action-toast");
  // Every caller expects a confirmation, which may arrive after a request.
  const dismissToast = async () => {
    await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(toast).toHaveCount(0);
  };
  const closeThread = async () => {
    await thread()
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const messageIn = (id) => thread().locator(`[id="message-${id}"]`);
  // Closing a sheet steps history back; let that finish before navigating.
  const settled = async () => {
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const db = fixture.db;
  const owner = fixture.owner;
  const now = Date.now();
  const agent = fixture.agents[0];
  const project = fixture.projects[0];
  // Each run (one per viewport) has its own words to find.
  const tag = "zebra" + randomUUID().slice(0, 6);

  // A long thread with a saved reading position partway through.
  const long = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,?,?,?)",
  ).run(long, owner, agent.id, "Mobile continuity review", project.id, now - 90 * 60000);
  const longIds = [];
  for (let i = 0; i < 40; i++) {
    const mid = randomUUID();
    longIds.push(mid);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,'{}',?)",
    ).run(
      mid,
      owner,
      long,
      i % 2 ? "assistant" : "user",
      i === 30
        ? "Decision: keep the four destinations and add Saved labels. " + tag
        : `Step ${i}: ` + "Notes on the mobile flow. ".repeat(6),
      now - (90 - i) * 60000,
    );
  }
  // Reported file activity: two applied edits to one file, one failed edit.
  const source = { transport: "api", origin: "fixture" };
  const fileRecord = (id, path, patch, state) => ({
    v: 1,
    kind: "file_change",
    id,
    source,
    revision: 1,
    fieldSeq: {},
    partial: false,
    replayed: false,
    data: {
      state,
      files: [{ path, operation: "modify", patch, content: "available" }],
    },
  });
  const changeRun = randomUUID(),
    changeConversation = randomUUID(),
    changeAnswer = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
  ).run(changeConversation, owner, agent.id, "Tidy the settings page", now - 5000);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    changeRun,
    owner,
    agent.id,
    changeConversation,
    "Tidy the settings page",
    "completed",
    changeRun,
    JSON.stringify({ agentId: agent.id, folderId: agent.folder_id }),
    now - 5000,
    now - 4000,
  );
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user','Tidy the settings page','{}',?)",
  ).run(randomUUID(), owner, changeConversation, changeRun, now - 5000);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,?,?)",
  ).run(
    changeAnswer,
    owner,
    changeConversation,
    changeRun,
    "Tidied the settings page.",
    JSON.stringify({
      activities: [
        fileRecord("e1", "src/settings.tsx", "+a\n+b\n-c", "applied"),
        fileRecord("e2", "src/settings.tsx", "+d", "applied"),
        fileRecord("e3", "src/theme.css", "+broken", "failed"),
      ],
    }),
    now - 4000,
  );
  // A later run that reuses the activity id "e1" for a different file: the
  // thread review must keep both runs' edits.
  const laterRun = randomUUID();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(laterRun, owner, agent.id, changeConversation, "Now the header", "completed", laterRun,
    JSON.stringify({ agentId: agent.id, folderId: agent.folder_id }), now - 3500, now - 3400);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user','Now the header','{}',?)",
  ).run(randomUUID(), owner, changeConversation, laterRun, now - 3500);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','Updated the header.',?,?)",
  ).run(randomUUID(), owner, changeConversation, laterRun,
    JSON.stringify({ activities: [fileRecord("e1", "src/header.tsx", "+h", "applied")] }), now - 3400);

  // A thread of its own with a running task (earlier smokes change the
  // fixture's shared threads).
  const working = { id: randomUUID(), title: "Audit the mobile layout " + randomUUID().slice(0, 4) };
  const workingRun = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
  ).run(working.id, owner, agent.id, working.title, now - 3000);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,worker_id,heartbeat,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,?,'continuity-fixture',?,?,?)",
  ).run(
    workingRun,
    owner,
    agent.id,
    working.id,
    working.title,
    workingRun,
    JSON.stringify({ agentId: agent.id, connectionId: agent.connection_id, folderId: agent.folder_id }),
    now + 99999999,
    now - 3000,
    now - 3000,
  );
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user',?,'{}',?)",
  ).run(randomUUID(), owner, working.id, workingRun, working.title, now - 3000);

  try {
    await page.goto(fixture.base, { waitUntil: "networkidle" });

    // 1. Resume work from the Feed: each card names one specific action and
    // opens exactly there.
    const done = fixture.conversations.find((c) => c.state === "completed");
    const asking = fixture.conversations.find(
      (c) => c.state === "awaiting_approval",
    );
    const doneAnswer = db
      .prepare(
        "SELECT id FROM messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
      )
      .get(done.run).id;
    await expect(
      card(done.title).getByRole("button", { name: "Review result", exact: true }),
    ).toBeVisible();
    const approve = card(asking.title).getByRole("button", {
      name: "Approve request",
      exact: true,
    });
    // Done holds finished threads; a request waiting on you is in Needs you.
    await expect(approve).toHaveCount(0);
    await capture("continuity-feed-actions");
    await card(done.title)
      .getByRole("button", { name: "Review result", exact: true })
      .click();
    await expect(thread()).toHaveAttribute("aria-label", done.title);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("message"))
      .toBe(doneAnswer);
    await expect(messageIn(doneAnswer)).toHaveClass(/anchored/);
    // Only a small Latest pill, no "Back to where I was".
    await expect(
      thread().getByRole("button", { name: "Jump to latest messages" }),
    ).toBeVisible();
    await expect(thread().getByText("Back to where I was")).toHaveCount(0);
    await closeThread();
    const feedTab = (name) =>
      page.getByRole("tab", { name: new RegExp("^" + name) });
    await feedTab("Needs you").click();
    await expect(approve).toBeVisible();
    await capture("continuity-feed-needs-you");
    await approve.click();
    await expect(thread()).toHaveAttribute("aria-label", asking.title);
    await expect(
      thread().locator(".approval-card, .approval").first(),
    ).toBeInViewport();
    // The approval is never described as made until it is.
    await expect(thread()).not.toContainText(/approved/i);
    await closeThread();
    await feedTab("Done").click();
    // An unsent draft (per signed-in owner) becomes Continue draft.
    await page.evaluate(
      ({ owner, id }) =>
        localStorage.setItem(`loop-draft-text:${owner}:${id}`, "Half-written follow-up"),
      { owner, id: done.id },
    );
    await settled();
    await page.reload({ waitUntil: "networkidle" });
    await card(done.title)
      .getByRole("button", { name: "Continue draft", exact: true })
      .click();
    await expect(thread()).toHaveAttribute("aria-label", done.title);
    await expect(page.locator("#composer")).toHaveValue("Half-written follow-up");
    await page.locator("#composer").fill("");
    await closeThread();

    // 2. Resume reading, jump to a search match, then Latest. The detour
    // never replaces the saved reading position.
    db.prepare(
      "INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,?)",
    ).run(owner, long, longIds[10], now);
    await page.goto(`${fixture.base}/?conversation=${long}`, {
      waitUntil: "networkidle",
    });
    await expect(thread().getByText("Resumed where you left off")).toBeVisible();
    await expect(messageIn(longIds[10])).toBeInViewport();
    await capture("continuity-resumed");
    await thread().getByRole("button", { name: "Jump to…", exact: true }).click();
    await dialog().getByLabel("Search this thread").fill(tag);
    await expect(dialog().locator(".outline-status")).toHaveText(
      new RegExp(`1 match for “${tag}”`),
    );
    await capture("continuity-thread-search");
    await dialog().locator(".outline-list button").first().click();
    await expect(messageIn(longIds[30])).toBeInViewport();
    await expect(messageIn(longIds[30])).toHaveClass(/anchored/);
    await page.waitForTimeout(1500);
    const position = () =>
      db
        .prepare(
          "SELECT position_message_id FROM conversation_positions WHERE owner_id=? AND conversation_id=?",
        )
        .get(owner, long).position_message_id;
    assert.equal(position(), longIds[10], "A jump replaced the reading position");
    await thread()
      .getByRole("button", { name: "Jump to latest messages" })
      .click();
    await expect(messageIn(longIds[39])).toBeInViewport();
    await expect.poll(position).toBe(null);
    await closeThread();

    // 3. Send later from outside a thread: confirm who, where and when,
    // follow the link, edit, then Undo/cancel.
    await nav("Feed").click();
    await page.getByRole("button", { name: "Compose a message" }).click();
    const composer = page.locator(".composer-dock");
    await expect(composer.locator(".composer-destination")).toContainText("To @");
    await page.locator("#composer").fill("Send the weekly summary");
    await composer.getByRole("button", { name: "Send later", exact: true }).click();
    await expect(dialog()).toHaveAttribute("aria-label", "Send options");
    await expect(dialog().locator(".send-destination")).toContainText("New thread");
    await dialog()
      .getByRole("menuitem", { name: /^Send later at a time/ })
      .click();
    await expect(dialog()).toHaveAttribute("aria-label", "Send later");
    await expect(dialog().locator(".send-summary")).toContainText(
      "Send the weekly summary",
    );
    await expect(dialog()).toContainText("This is not a reminder");
    await dialog().getByRole("button", { name: "Tomorrow morning" }).click();
    await capture("continuity-send-later");
    await dialog().getByRole("button", { name: /^Schedule for tomorrow/ }).click();
    await expect(toast).toContainText("Scheduled for @");
    await toast.getByRole("button", { name: "View", exact: true }).click();
    await expect(laterTab("Scheduled")).toHaveAttribute("aria-selected", "true");
    const scheduled = later.locator(".scheduled-message").filter({
      has: page.getByText("Send the weekly summary", { exact: true }),
    });
    await expect(scheduled).toHaveClass(/anchored/);
    await expect(scheduled).toContainText("Waiting to send");
    await scheduled.getByRole("button", { name: "Edit scheduled message" }).click();
    await dialog().getByLabel("Message").fill("Send the weekly summary, short");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await expect(scheduled).toHaveCount(0);
    const edited = later
      .locator(".scheduled-message")
      .filter({ hasText: "Send the weekly summary, short" });
    await expect(edited).toHaveCount(1);
    await edited.getByRole("button", { name: "Cancel scheduled message" }).click();
    await expect(edited).toHaveCount(0);

    // A message refused when due stays in Needs you and Scheduled with its
    // text and reason, and can be copied back to a draft.
    const failing = await fixture.api("/scheduled-sends", {
      agentId: agent.id,
      input: "Post the release notes",
      attachmentIds: [],
      idempotencyKey: "continuity-" + randomUUID(),
      sendAt: Date.now() + 3600000,
    });
    db.prepare(
      "UPDATE scheduled_sends SET state='failed',error=? WHERE id=?",
    ).run(
      "This agent is retired. Restore it from its profile before sending new work.",
      failing.id,
    );
    await nav("Feed").click();
    await page.getByRole("tab", { name: /^Needs you/ }).click();
    await expect(page.locator(".scheduled-summary")).toContainText(
      "1 scheduled message not sent",
    );
    const notSent = page
      .locator(".scheduled-message.not-sent")
      .filter({ hasText: "Post the release notes" });
    await expect(notSent).toContainText("retired");
    await capture("continuity-needs-you-not-sent");
    await page
      .locator(".scheduled-summary")
      .getByRole("button", { name: "Open Scheduled" })
      .click();
    await expect(laterTab("Scheduled")).toHaveAttribute("aria-selected", "true");
    const failedRow = later
      .locator(".scheduled-message.not-sent")
      .filter({ hasText: "Post the release notes" });
    await failedRow.getByRole("button", { name: "Copy to a draft" }).click();
    await expect(page.locator("#composer")).toHaveValue("Post the release notes");
    await page.locator("#composer").fill("");
    await page.getByRole("button", { name: "Collapse composer" }).click();
    await nav("You").click();
    await laterTab("Scheduled").click();
    await later
      .locator(".scheduled-message.not-sent")
      .filter({ hasText: "Post the release notes" })
      .getByRole("button", { name: "Dismiss message" })
      .click();
    await page.getByRole("tab", { name: /^Scheduled/ }).waitFor();

    // 4. Reminders: create from a message, see why it is back, Done, and
    // Snooze again; both survive a reload.
    await page.goto(`${fixture.base}/?conversation=${long}&message=${longIds[30]}`, {
      waitUntil: "networkidle",
    });
    await messageIn(longIds[30])
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
    await dialog()
      .getByRole("group", { name: "Main actions" })
      .getByRole("button", { name: "Remind me", exact: true })
      .click();
    await expect(dialog()).toContainText("Nothing is sent to an agent.");
    await dialog().getByRole("button", { name: /^In an hour/ }).click();
    await expect(toast).toContainText("Reminder set: in an hour.");
    await dismissToast();
    await closeThread();
    await fixture.api("/later", {
      kind: "conversation",
      targetId: done.id,
      condition: "time",
      dueAt: Date.now() + 60000,
    });
    // Both come due.
    db.prepare(
      "UPDATE later_items SET surfaced_at=?,due_at=? WHERE owner_id=? AND done_at IS NULL AND target_id IN (?,?)",
    ).run(Date.now(), Date.now() - 1000, owner, longIds[30], done.id);
    await nav("You").click();
    await laterTab("Reminders").click();
    const messageReminder = later
      .locator(".later-card.due")
      .filter({ hasText: "Mobile continuity review" });
    const threadReminder = later
      .locator(".later-card.due")
      .filter({ hasText: done.title });
    await expect(messageReminder.locator(".eyebrow")).toContainText(/Due today at/);
    await capture("continuity-reminders");
    await messageReminder.getByRole("button", { name: /^Done with/ }).click();
    await expect(messageReminder).toHaveCount(0);
    await dismissToast();
    await threadReminder.getByRole("button", { name: /^Snooze again/ }).click();
    await expect(dialog()).toHaveAttribute("aria-label", "Snooze again");
    await dialog().getByRole("button", { name: /^Tomorrow morning/ }).click();
    await dismissToast();
    await settled();
    await page.reload({ waitUntil: "networkidle" });
    await laterTab("Reminders").click();
    await expect(
      later.locator(".later-card.due").filter({ hasText: "Mobile continuity review" }),
    ).toHaveCount(0);
    const snoozed = later.locator(".later-card").filter({ hasText: done.title });
    await expect(snoozed).not.toHaveClass(/due/);
    await expect(snoozed.locator(".eyebrow")).toContainText("snoozed 1×");
    await expect(snoozed.locator(".subline")).toContainText("Tomorrow at");

    // 5. Saved: a label to recognise a decision, search by it, open and
    // come back to the same search. Cards keep their size.
    await page.goto(`${fixture.base}/?conversation=${long}&message=${longIds[30]}`, {
      waitUntil: "networkidle",
    });
    await messageIn(longIds[30])
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
    await dialog()
      .getByRole("group", { name: "Main actions" })
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await dismissToast();
    await closeThread();
    await nav("You").click();
    await laterTab("Saved").click();
    const savedItem = later
      .locator(".saved-item")
      .filter({ hasText: "Mobile continuity review" });
    const savedCard = savedItem.locator(".feed-card");
    const before = await savedCard.boundingBox();
    await savedItem.getByRole("button", { name: "Add a label" }).click();
    await dialog().getByLabel("Label").fill("Chosen approach");
    await dialog().getByRole("button", { name: "Save label" }).click();
    await expect(savedItem.locator(".saved-label")).toHaveText("Chosen approach");
    const after = await savedCard.boundingBox();
    assert.equal(after.width, before.width, "A label changed the card width");
    assert.equal(after.height, before.height, "A label changed the card height");
    const feedCardWidth = (await page.locator(".feed-card").first().boundingBox())
      .width;
    assert.equal(after.width, feedCardWidth, "Saved cards are not full size");
    await later.getByLabel("Search Saved").fill("chosen");
    await expect(later.locator(".saved-item")).toHaveCount(1);
    await capture("continuity-saved-search");
    await savedCard.getByRole("button", { name: "Open", exact: true }).click();
    await expect(messageIn(longIds[30])).toBeInViewport();
    await closeThread();
    await expect(later.getByLabel("Search Saved")).toHaveValue("chosen");
    await expect(later.locator(".saved-item")).toHaveCount(1);
    // Unsave, then leave the app: leaving commits the unsave, so Undo is
    // withdrawn rather than offered without reversing it.
    await savedCard.getByRole("button", { name: "Remove from Saved", exact: true }).click();
    await expect(toast.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
    const setVisibility = (state) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    await setVisibility("hidden");
    await setVisibility("visible");
    await expect(toast.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect
      .poll(async () =>
        (await fixture.api("/saved")).items.some((item) => item.key === "m:" + longIds[30]),
      )
      .toBe(false);
    await dismissToast();
    // Saved again for the project history step below.
    await fixture.api(`/messages/${longIds[30]}/saved`, {});
    await later.getByLabel("Search Saved").fill("");

    // 6. Project history: search, outcomes, saved decisions and unfinished
    // work, keeping project scope through a thread and back.
    await nav("Projects").click();
    const allProjects = page.getByRole("button", { name: "All projects", exact: true });
    if (await allProjects.isVisible()) await allProjects.click();
    await page.locator(".project-tile").filter({ hasText: project.name }).click();
    await page.getByLabel(`Search ${project.name}`).fill(tag);
    await page.getByLabel(`Search ${project.name}`).press("Enter");
    const projectHit = page.locator(".project-search-results .search-result");
    await expect(projectHit).toHaveCount(1);
    await capture("continuity-project-search");
    await projectHit.locator(".search-hit").first().click();
    await expect(messageIn(longIds[30])).toBeInViewport();
    await closeThread();
    await expect(page.locator(".project-heading h2")).toHaveText(project.name);
    await expect(page.locator(".project-history-head")).toContainText(
      `Results for “${tag}” in ${project.name}`,
    );
    await page.getByRole("button", { name: "Saved decisions" }).click();
    await expect(page.locator(".saved-item")).toHaveCount(1);
    await page.getByRole("button", { name: "Unfinished work" }).click();
    await expect(page.locator(".inbox-card").first()).toBeVisible();
    await page.getByRole("button", { name: "Recent outcomes" }).click();
    await expect(page.locator(".inbox-card").first()).toBeVisible();
    await page.getByRole("button", { name: /^Back to/ }).click();
    await expect(page.locator(".project-history-head")).toHaveCount(0);

    // 7. Steer, queue or send later in a working thread; a queued message
    // can be read, explained and moved back to a draft with its files.
    const form = new FormData();
    form.set("file", new Blob(["Layout notes"], { type: "text/plain" }), "layout-context.txt");
    const upload = await fetch(fixture.base + "/api/uploads", {
      method: "POST",
      headers: { origin: fixture.base },
      body: form,
    });
    assert.equal(upload.status, 201);
    const attached = await upload.json();
    // The thread's unsent draft already holds the file.
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.evaluate(
      ({ owner, id, file }) =>
        localStorage.setItem(`loop-draft-files:${owner}:${id}`, JSON.stringify([file])),
      { owner, id: working.id, file: attached },
    );
    await page.goto(`${fixture.base}/?conversation=${working.id}`, {
      waitUntil: "networkidle",
    });
    const composerFiles = page.locator(".conversation-composer .attachment-list");
    await expect(composerFiles).toContainText("layout-context.txt");
    await page.locator("#composer").fill("Also check the mobile layout");
    await expect(page.locator(".composer-intent")).toContainText(
      "Send steers @",
    );
    await page
      .locator(".conversation-composer")
      .getByRole("button", { name: "Send later", exact: true })
      .click();
    // App-level sheets open above the thread but come first in the page.
    const options = page.getByRole("dialog", { name: "Send options" });
    await expect(options.getByRole("menuitem")).toHaveText([
      /^Steer current task/,
      /^Queue after this task/,
      /^Send later at a time/,
    ]);
    await expect(options.locator(".send-destination")).toContainText(working.title);
    await capture("continuity-send-options");
    await options.getByRole("menuitem", { name: /^Queue after this task/ }).click();
    await expect(toast).toContainText("Queued after the current task.");
    await dismissToast();
    const queued = thread().locator(".queued-controls");
    await expect(queued).toContainText("stays held");
    await expect(composerFiles).toHaveCount(0);
    await queued.getByRole("button", { name: "Move to draft" }).click();
    await expect(page.locator("#composer")).toHaveValue(
      "Also check the mobile layout",
    );
    await expect(composerFiles).toContainText("layout-context.txt");
    await expect(queued).toHaveCount(0);
    // Sending it again sends the same files.
    const resent = [];
    const capture200 = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      resent.push(route.request().postDataJSON());
      await route.fulfill({ json: { id: "continuity-resend" } });
    };
    await page.route("**/api/runs", capture200);
    try {
      await page
        .locator(".conversation-composer")
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await expect.poll(() => resent.length).toBe(1);
    } finally {
      await page.unroute("**/api/runs", capture200);
    }
    assert.deepEqual(resent[0].attachmentIds, [attached.id]);
    assert.equal(resent[0].input, "Also check the mobile layout");
    // Undo on the queued confirmation puts the message back exactly once.
    await page.locator("#composer").fill("One more follow-up");
    await page
      .locator(".conversation-composer")
      .getByRole("button", { name: "Send later", exact: true })
      .click();
    await options.getByRole("menuitem", { name: /^Queue after this task/ }).click();
    await expect(toast).toContainText("Queued after the current task.");
    await expect(page.locator("#composer")).toHaveValue("");
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator("#composer")).toHaveValue("One more follow-up");
    await expect(queued).toHaveCount(0);
    await page.locator("#composer").fill("");
    await closeThread();

    // 8. Reported file activity: two edits to one file, one failed edit.
    await page.goto(`${fixture.base}/?conversation=${changeConversation}`, {
      waitUntil: "networkidle",
    });
    // The thread-wide review counts both runs' files, though they share an id.
    await thread().getByRole("button", { name: "Conversation options", exact: true }).click();
    await expect(
      dialog().getByRole("menuitem", { name: /^Review reported changes/ }),
    ).toContainText("2 files with applied edits");
    await dialog().getByRole("menuitem", { name: /^Review reported changes/ }).click();
    await expect(dialog().locator(".changes-group").first()).toContainText("src/settings.tsx");
    await expect(dialog().locator(".changes-group").first()).toContainText("src/header.tsx");
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    const chip = thread().locator(".changes-chip").first();
    await expect(chip).toContainText("1 file changed");
    await expect(chip).toContainText("1 failed");
    await chip.click();
    await expect(dialog()).toHaveAttribute("aria-label", "Reported file activity");
    await expect(dialog().locator(".changes-group h3")).toHaveText([
      "Applied · 1",
      "Failed · 1",
    ]);
    await expect(dialog()).toContainText("Edit 2 of 2");
    await expect(dialog().locator(".changes-total")).toContainText(
      "1 file with applied edits",
    );
    await capture("continuity-change-review");
    await dialog().getByRole("button", { name: "Ask to commit" }).click();
    const prompt = await page.locator("#composer").inputValue();
    assert.match(prompt, /git diff/);
    assert.match(prompt, /src\/settings\.tsx/);
    assert.doesNotMatch(prompt, /theme\.css/, "A failed edit was offered to commit");
    await page.locator("#composer").fill("");
    await closeThread();

    // 9. Keyboard: the message menu, More and focus return work without a
    // pointer.
    await page.goto(`${fixture.base}/?conversation=${long}&message=${longIds[30]}`, {
      waitUntil: "networkidle",
    });
    const menuButton = messageIn(longIds[30]).getByRole("button", {
      name: "Message actions",
      exact: true,
    });
    await menuButton.focus();
    await page.keyboard.press("Enter");
    await expect(dialog()).toHaveAttribute("aria-label", "Your message");
    await dialog().getByRole("button", { name: "More", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog().getByRole("menuitem").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(menuButton).toBeFocused();
    await closeThread();
  } finally {
    fixture.db.prepare("DELETE FROM request_limits").run();
    db.prepare("UPDATE runs SET state='cancelled',worker_id=NULL WHERE id=?").run(workingRun);
    db.prepare("DELETE FROM later_items WHERE owner_id=?").run(owner);
    db.prepare("DELETE FROM scheduled_sends WHERE owner_id=?").run(owner);
    db.prepare("DELETE FROM saved_labels WHERE owner_id=?").run(owner);
    db.prepare("DELETE FROM message_bookmarks WHERE owner_id=? AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)").run(owner, long);
    await page.evaluate(() => localStorage.clear()).catch(() => {});
  }
}
