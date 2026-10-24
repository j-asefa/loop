import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { seedCheckout } from "./helpers/checkout-fixture.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { selectedEngines } from "./helpers/engines.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { conversationFilesSmoke } from "./helpers/conversation-files-smoke.mjs";

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  let browser, page;
  try {
    const conversation = fixture.conversations.find(
      (c) => c.state === "completed",
    );
    const { db, owner } = fixture;
    const agent = db
      .prepare("SELECT agent_id FROM runs WHERE id=?")
      .get(conversation.run).agent_id;
    const addRun = db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'history','completed',?,?,?)",
    );
    const addMessage = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const addUpdate = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at,update_key) VALUES(?,?,?,?,'assistant',?,'{\"progress\":true}',?,'progress')",
    );
    let lastRun;
    db.transaction(() => {
      for (let i = 0; i < 240; i++) {
        const run = randomUUID(),
          time = Date.now() + i;
        addRun.run(run, owner, agent, conversation.id, run, time, time);
        addMessage.run(
          randomUUID(),
          owner,
          conversation.id,
          run,
          "user",
          `History prompt ${i}`,
          time,
        );
        addUpdate.run(
          randomUUID(),
          owner,
          conversation.id,
          run,
          `History progress ${i}`,
          time,
        );
        addMessage.run(
          randomUUID(),
          owner,
          conversation.id,
          run,
          "assistant",
          `History answer ${i}`,
          time,
        );
        lastRun = run;
      }
    })();
    const gitSummary = seedCheckout(db, lastRun, {
      files: [{ path: "git-review.ts", additions: 1, deletions: 1, binary: false }],
      patch: "diff --git a/git-review.ts b/git-review.ts\n--- a/git-review.ts\n+++ b/git-review.ts\n@@ -1 +1 @@\n-old\n+captured\n",
    });
    const addActivity = db.prepare(
      "INSERT INTO agent_activities(owner_id,scope,activity_key,conversation_id,run_id,kind,record,sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)",
    );
    const record = (kind, id, data) => ({
      v: 1,
      kind,
      id,
      source: { transport: "native", harness: "codex", origin: "fixture" },
      revision: 1,
      fieldSeq: {},
      partial: false,
      replayed: true,
      data,
    });
    db.transaction(() => {
      addActivity.run(
        owner,
        conversation.id,
        "old-file",
        conversation.id,
        lastRun,
        "file_change",
        JSON.stringify(
          record("file_change", "old-file", {
            state: "applied",
            files: [
              {
                path: "old-review.ts",
                operation: "modify",
                patch: "@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
          }),
        ),
        1,
      );
      for (let i = 2; i <= 1201; i++)
        addActivity.run(
          owner,
          conversation.id,
          `tool:${i}`,
          conversation.id,
          lastRun,
          "tool",
          JSON.stringify(
            record("tool", `tool:${i}`, {
              title: `History tool ${i}`,
              status: "completed",
              content: [],
            }),
          ),
          i,
        );
    })();
    browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium
          ? process.env.CHROMIUM_PATH || undefined
          : undefined,
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    const reads = [], transcriptReads = [],
      errors = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/conversations/${conversation.id}` && request.method() === "GET") transcriptReads.push(url);
      if (url.pathname === `/api/conversations/${conversation.id}/activities`)
        reads.push(url);
    });
    page.on("pageerror", (error) => {
      if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
        errors.push(error.message);
    });
    await page.goto(`${fixture.base}/?conversation=${conversation.id}`);
    const transcript = page.locator(".conversation-sheet .messages");
    await expect(
      transcript.getByText("History answer 239", { exact: true }),
    ).toBeVisible();
    // The socket reset can also queue an ordinary latest-page refresh. Keep
    // that invalidation: the initial render itself needs only one resume GET.
    assert.equal(transcriptReads.filter(url => url.searchParams.get("resume") === "1").length, 1);
    assert(transcriptReads.every(url => url.search === "?resume=1" || url.search === ""),
      "Cold opening must not perform a second anchor/cursor fetch");
    assert.equal(transcriptReads[0].searchParams.get("resume"), "1");
    // Holding conversation text leaves selection and the native copy menu
    // to the browser. Message actions remain available through their button.
    for (const text of ["History prompt 239", "History answer 239"]) {
      const content = transcript.getByText(text, { exact: true });
      await content.scrollIntoViewIfNeeded();
      await content.dispatchEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 1,
        button: 0,
        clientX: 100,
        clientY: 300,
      });
      await page.waitForTimeout(650);
      await expect(
        page.getByRole("dialog", { name: /^(Your message|Message)$/ }),
      ).toHaveCount(0);
      await content.dispatchEvent("pointerup", {
        pointerType: "touch",
        pointerId: 1,
      });
      assert(
        await content.evaluate((node) => {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
          const selected = selection.toString() === node.textContent;
          const nativeMenu = node.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
          );
          selection.removeAllRanges();
          return (
            selected &&
            nativeMenu &&
            getComputedStyle(node).userSelect !== "none"
          );
        }),
        "Text must remain selectable without intercepting its native context menu",
      );
      await expect(
        page.getByRole("dialog", { name: /^(Your message|Message)$/ }),
      ).toHaveCount(0);
      await content
        .locator("xpath=ancestor::article[1]")
        .getByRole("button", { name: "Message actions", exact: true })
        .click();
      const actions = page.getByRole("dialog", {
        name: /^(Your message|Message)$/,
      });
      await expect(actions).toBeVisible();
      await actions.getByRole("button", { name: "Close", exact: true }).click();
    }
    const composer = page.locator(".composer-dock.thread-mode");
    await composer.locator("textarea").fill("Draft for holding send");
    const send = composer.getByRole("button", {
      name: "Send reply",
      exact: true,
    });
    await send.dispatchEvent("pointerdown", {
      pointerType: "touch",
      pointerId: 2,
      button: 0,
    });
    await page.waitForTimeout(650);
    await expect(
      page.getByRole("dialog", { name: "Send options", exact: true }),
    ).toHaveCount(0);
    await send.dispatchEvent("pointercancel", {
      pointerType: "touch",
      pointerId: 2,
    });
    await composer
      .getByRole("button", { name: "Send later", exact: true })
      .click();
    const sendOptions = page.getByRole("dialog", {
      name: "Send options",
      exact: true,
    });
    await expect(sendOptions).toBeVisible();
    await sendOptions
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await composer.locator("textarea").fill("");
    // The Git review is available without paging through old tool edits.
    const checkout = page.locator(".conversation-sheet .checkout-chip");
    await expect(checkout).toHaveCount(1);
    await expect(checkout).toContainText("1 file +1 −1");
    await expect(checkout.locator(".diff-add-count")).toHaveText("+1");
    await expect(checkout.locator(".diff-remove-count")).toHaveText("−1");
    assert.equal(await checkout.evaluate((element) => {
      const color = (selector) => getComputedStyle(element.querySelector(selector)).color;
      return color(".diff-add-count") !== color(".diff-remove-count") &&
        color(".diff-add-count") !== getComputedStyle(element).color &&
        color(".diff-remove-count") !== getComputedStyle(element).color;
    }), true, "Conversation additions and deletions must use distinct diff colours");
    await checkout.click();
    const review = page.getByRole("dialog", { name: "Checkout", exact: true });
    await expect(review.locator(".pull-file-path")).toHaveText(["git-review.ts"]);
    await expect(review).not.toContainText("old-review.ts");
    await review.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(
      reads.filter(
        (url) =>
          url.searchParams.get("view") === "recent" &&
          url.searchParams.get("tools") !== "0",
      ).length,
      0,
    );
    assert.equal(
      reads.filter(
        (url) =>
          url.searchParams.get("view") === "recent" &&
          url.searchParams.get("tools") === "0",
      ).length,
      1,
    );
    assert.equal(
      reads.some((url) => url.searchParams.has("before")),
      false,
    );
    assert.equal(
      reads.some((url) => url.searchParams.get("view") === "legacy"),
      false,
    );
    await page
      .getByRole("button", { name: "Conversation options", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    const tools = page.getByRole("dialog", {
      name: "Tool activity",
      exact: true,
    });
    await expect(
      tools.getByText("History tool 1201 · completed", { exact: true }),
    ).toBeVisible();
    await tools
      .getByRole("button", { name: "Load earlier activity", exact: true })
      .click();
    await expect(
      tools.getByText("History tool 1002 · completed", { exact: true }),
    ).toBeVisible();
    assert.equal(
      reads.filter((url) => url.searchParams.has("before")).length,
      1,
    );
    // Loading history must leave the live cursor at the newest snapshot.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect
      .poll(
        () =>
          reads.filter(
            (url) =>
              url.searchParams.get("view") === "updates" &&
              url.searchParams.get("tools") !== "0",
          ).length,
      )
      .toBeGreaterThan(0);
    const update = reads.find(
      (url) =>
        url.searchParams.get("view") === "updates" &&
        url.searchParams.get("tools") !== "0",
    );
    assert.equal(update.searchParams.get("after"), "1201");
    await tools.getByRole("button", { name: "Close", exact: true }).click();
    // A pending or failed capture must never substitute the reported edits.
    for (const [state, label] of [["started", "in progress"], ["failed", "checkout not captured"]]) {
      db.prepare("UPDATE run_checkouts SET state=?,files=NULL,patch=NULL,summary=? WHERE run_id=?")
        .run(state, JSON.stringify({ ...gitSummary, state, files: 0, additions: 0, deletions: 0, ahead: null }), lastRun);
      await page.reload();
      await expect(checkout).toHaveCount(1);
      await expect(checkout).toContainText(label);
      await expect(checkout).not.toContainText("+1");
      await expect(page.locator(".conversation-sheet button.changes-chip:not(.checkout-chip)")).toHaveCount(0);
    }
    // With no Git record, tool edits stay in activity and provide no diff badge.
    db.prepare("DELETE FROM run_checkouts WHERE run_id=?").run(lastRun);
    await page.reload();
    await expect(transcript.getByText("History answer 239", { exact: true })).toBeVisible();
    await expect(page.locator(".conversation-sheet button.changes-chip")).toHaveCount(0);
    // Reopening uses the production notification navigation handler, preserving
    // this document's owner-scoped view cache (a reload would erase it).
    const closeThread = async () => {
      await page.locator("dialog.conversation-sheet[open] > .sheet-inner > .sheet-head")
        .getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("dialog.conversation-sheet[open]")).toHaveCount(0);
      await page.waitForFunction(() => history.state?.loopSheet !== true);
    };
    const openThread = async (id, source = "") => {
      await page.evaluate(({ id, source }) => {
        const url = new URL(location.href);
        url.search = new URLSearchParams({ conversation: id, ...(source ? { source } : {}) }).toString();
        navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
          data: { type: "loop-open", url: url.href },
        }));
      }, { id, source });
    };
    await closeThread();
    const path = `/api/conversations/${conversation.id}`;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let pending = 0, replied = 0;
    const hold = async route => {
      pending++;
      await held;
      replied++;
      await route.continue();
    };
    await page.route(url => url.pathname === path, hold);
    await openThread(conversation.id);
    await expect.poll(() => pending).toBe(1);
    await expect(transcript.getByText("History answer 239", { exact: true })).toBeVisible();
    assert.equal(replied, 0, "Cached transcript must paint before its network response");
    await expect(transcript.getByRole("button", { name: "Load earlier messages", exact: true })).toBeDisabled();
    await expect(transcript.getByText("Loading conversation…", { exact: true })).toHaveCount(0);
    release();
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(transcript.getByRole("button", { name: "Load earlier messages", exact: true })).toBeEnabled();
    await page.unrouteAll({ behavior: "wait" });
    await closeThread();

    let limitedAt = 0, recoveredAt = 0, readsAfterLimit = 0;
    const limitedRoute = async route => {
      if (!limitedAt) {
        limitedAt = Date.now();
        await route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "3" }, body: '{"error":"Too many requests"}' });
      } else {
        readsAfterLimit++;
        recoveredAt = Date.now();
        await route.continue();
      }
    };
    await page.route(url => url.pathname === path, limitedRoute);
    await openThread(conversation.id);
    await expect(transcript.getByText("Updates are paused briefly. Retrying automatically…", { exact: true })).toBeVisible();
    await expect(transcript.getByText("History answer 239", { exact: true })).toBeVisible();
    await expect(transcript.locator('[role="alert"]')).toHaveCount(0);
    await expect(transcript.getByRole("button", { name: "Load earlier messages", exact: true })).toBeDisabled();
    // A push invalidation and the retained fallback must respect the deadline.
    await page.evaluate(() => window.dispatchEvent(new Event("loop-workspace-change")));
    await page.waitForTimeout(1000);
    assert.equal(readsAfterLimit, 0);
    await expect.poll(() => readsAfterLimit).toBeGreaterThan(0);
    assert(recoveredAt - limitedAt >= 2950, "Retry happened before Retry-After");
    await expect(transcript.getByText("Updates are paused briefly. Retrying automatically…", { exact: true })).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
    await closeThread();

    // A saved older page is chosen by the initial GET, not a second client GET.
    const saved = db.prepare("SELECT id FROM messages WHERE conversation_id=? AND content='History answer 20'").get(conversation.id).id;
    db.prepare(`INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,1)
      ON CONFLICT(owner_id,conversation_id) DO UPDATE SET position_message_id=excluded.position_message_id`).run(owner, conversation.id, saved);
    const resumes = [];
    const recordResume = request => {
      const url = new URL(request.url());
      if (url.pathname === path && request.method() === "GET") resumes.push(url);
    };
    page.on("request", recordResume);
    await openThread(conversation.id);
    await expect(page.locator(".conversation-sheet").getByText("Resumed where you left off", { exact: true })).toBeVisible();
    await expect(page.locator(`[id="message-${saved}"]`)).toBeInViewport();
    assert.equal(resumes.filter(url => url.searchParams.get("resume") === "1").length, 1);
    assert.equal(resumes.some(url => url.searchParams.has("message")), false, "Resume must not issue a second anchor request");
    page.off("request", recordResume);
    await closeThread();

    // Same opaque conversation ID on another source must not reuse this page.
    // Route the fixture source over HTTP; the paired gateway's actual header
    // forwarding is separately covered by linked-docker.node.test.ts.
    const source = "docker:history-fixture";
    const prefix = `/api/agent-sources/${encodeURIComponent(source)}/`;
    await fixture.api("/scheduled-sends", {
      agentId: agent, conversationId: conversation.id, input: "Scheduled recovery sentinel",
      sendAt: Date.now() + 3_600_000, idempotencyKey: randomUUID(),
    });
    let legacySource = true;
    const legacyReads = [];
    let linkedHold = false, linkedLimited = false, linkedMetadataFailure = false, linkedReplies = 0;
    let releaseLinked;
    let linkedGate = Promise.resolve();
    await page.route(url => url.pathname.startsWith(prefix), async route => {
      const url = new URL(route.request().url());
      const upstream = new URL("/api/" + url.pathname.slice(prefix.length) + url.search, fixture.base);
      if (linkedHold) await linkedGate;
      if (linkedLimited) {
        await route.fulfill({ status: 429, headers: { "Retry-After": "3" }, contentType: "application/json", body: '{"error":"Too many requests"}' });
        return;
      }
      if (linkedMetadataFailure && upstream.pathname === "/api/bootstrap") {
        await route.fulfill({ status: 503, json: { error: "Metadata fixture unavailable" } });
        return;
      }
      if (upstream.pathname === `/api/reviews/conversation/${conversation.id}`) {
        await route.fulfill({ json: {
          id: "review-fixture", conversationId: conversation.id, scope: "branch", state: "completed",
          fingerprint: "fixture-review", changed: [], omitted: [], current: null, freshnessError: null,
          reviewers: ["correctness", "regressions", "security"].map(agent_id => ({ agent_id, state: "completed", error: null })),
        } });
        return;
      }
      if (legacySource && upstream.pathname === path) {
        legacyReads.push(new URL(upstream));
        upstream.searchParams.delete("resume"); // captured-base server behavior
      }
      const response = await route.fetch({ url: upstream.href });
      if (upstream.pathname === path) {
        const body = await response.json();
        if (legacySource) delete body.resumed;
        body.messages.forEach(message => { message.content = "Linked " + message.content; });
        linkedReplies++;
        await route.fulfill({ response, json: body });
      } else await route.fulfill({ response });
    });
    db.prepare("UPDATE conversation_positions SET position_message_id=? WHERE owner_id=? AND conversation_id=?").run(saved, owner, conversation.id);
    linkedHold = true;
    linkedGate = new Promise(resolve => { releaseLinked = resolve; });
    await openThread(conversation.id, source);
    await expect(page.getByRole("status").filter({ hasText: "Loading conversation" })).toBeVisible();
    await expect(transcript.getByText("History answer 20", { exact: true })).toHaveCount(0);
    releaseLinked();
    linkedHold = false;
    await expect(transcript.getByText("Linked History answer 20", { exact: true })).toBeVisible();
    assert.equal(legacyReads.filter(url => url.searchParams.has("message")).length, 1,
      "Only an older source without the resume marker needs the compatibility anchor read");
    await expect(transcript.getByText("Scheduled recovery sentinel", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Snapshot review status" })).toBeVisible();
    legacySource = false;
    await closeThread();
    linkedHold = true;
    linkedLimited = true;
    linkedGate = new Promise(resolve => { releaseLinked = resolve; });
    const priorReplies = linkedReplies;
    await openThread(conversation.id, source);
    await expect(transcript.getByText("Linked History answer 20", { exact: true })).toBeVisible();
    assert.equal(linkedReplies, priorReplies, "Linked cache must paint before metadata or transcript responses");
    releaseLinked();
    linkedHold = false;
    await expect(transcript.getByText("Updates are paused briefly. Retrying automatically…", { exact: true })).toBeVisible();
    await expect(transcript.getByText("Linked History answer 20", { exact: true })).toBeVisible();
    await expect(transcript.locator('[role="alert"]')).toHaveCount(0);
    linkedLimited = false;
    await expect.poll(() => linkedReplies, { timeout: 10_000 }).toBeGreaterThan(priorReplies);
    await expect(transcript.getByText("Scheduled recovery sentinel", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("complementary", { name: "Snapshot review status" })).toBeVisible({ timeout: 5000 });
    await expect(transcript.getByText("Updates are paused briefly. Retrying automatically…", { exact: true })).toHaveCount(0);
    await closeThread();
    // Cached metadata predates this agent. A metadata-only failure must retain
    // the readable transcript and a visible retry that repairs the composer.
    const template = fixture.agents[0];
    const recoveryAgent = await fixture.api("/agents", {
      name: "metadata-recovery", connectionId: template.connection_id, model: template.model,
    });
    const recoveryConversation = randomUUID(), recoveryRun = randomUUID(), recoveryTime = Date.now();
    db.prepare("INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)")
      .run(recoveryConversation, owner, recoveryAgent.id, "Metadata recovery conversation", recoveryTime);
    addRun.run(recoveryRun, owner, recoveryAgent.id, recoveryConversation, recoveryRun, recoveryTime, recoveryTime);
    addMessage.run(randomUUID(), owner, recoveryConversation, recoveryRun, "assistant", "Metadata recovery transcript", recoveryTime);
    linkedMetadataFailure = true;
    await openThread(recoveryConversation, source);
    await expect(transcript.getByText("Metadata recovery transcript", { exact: true })).toBeVisible();
    await expect(composer).toHaveCount(0); // agent missing from cached metadata
    await expect(page.locator("dialog.conversation-sheet[open]").getByRole("alert").filter({ hasText: "Metadata fixture unavailable" })).toBeVisible();
    linkedMetadataFailure = false;
    await page.locator("dialog.conversation-sheet[open]").getByRole("button", { name: "Retry connection", exact: true }).click();
    await composer.locator("textarea").fill("Draft survives metadata recovery");
    await expect(send).toBeEnabled();
    await closeThread();
    linkedMetadataFailure = true;
    await openThread(recoveryConversation, source);
    await expect(transcript.getByText("Metadata recovery transcript", { exact: true })).toBeVisible();
    await expect(page.locator("dialog.conversation-sheet[open]").getByRole("alert").filter({ hasText: "Metadata fixture unavailable" })).toBeVisible();
    linkedMetadataFailure = false;
    await page.locator("dialog.conversation-sheet[open]").getByRole("button", { name: "Retry connection", exact: true }).click();
    await expect(send).toBeEnabled();
    await expect(composer.locator("textarea")).toHaveValue("Draft survives metadata recovery");
    await expect(transcript.getByText("Metadata recovery transcript", { exact: true })).toBeVisible();
    await expect(page.locator("dialog.conversation-sheet[open]").getByRole("alert")).toHaveCount(0);
    await composer.locator("textarea").fill("");
    await closeThread();
    await page.unrouteAll({ behavior: "wait" });
    // A delayed response from the previous conversation cannot replace a new one.
    let releaseLate, lateStarted = false;
    const lateGate = new Promise(resolve => { releaseLate = resolve; });
    await page.route(url => url.pathname === path, async route => {
      lateStarted = true;
      const response = await route.fetch();
      await lateGate;
      await route.fulfill({ response }).catch(() => {}); // abandoned reads may already be aborted
    });
    await openThread(conversation.id);
    await expect.poll(() => lateStarted).toBe(true);
    const other = fixture.conversations.find(item => item.id !== conversation.id && item.state === "queued");
    await openThread(other.id);
    await expect(page.locator("dialog.conversation-sheet[open]")).toHaveAttribute("aria-label", other.title);
    releaseLate();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.locator("dialog.conversation-sheet[open]")).toHaveAttribute("aria-label", other.title);
    await expect(transcript.getByText("History answer 239", { exact: true })).toHaveCount(0);
    await closeThread();
    // A source cooldown must not leave a false approval failure after reads recover.
    const waiting = fixture.conversations.find(item => item.state === "awaiting_approval");
    let approvalReads = 0, failApprovalRead = false;
    await page.route(url => url.pathname === "/api/approvals", async route => {
      approvalReads++;
      if (failApprovalRead) {
        failApprovalRead = false;
        await route.fulfill({ status: 503, json: { error: "Approval read temporarily unavailable" } });
      } else await route.continue();
    });
    await openThread(waiting.id);
    await expect(transcript.locator(".approval-card").first()).toBeVisible();
    const beforeApprovalReads = approvalReads;
    let approvalLimitedAt = 0;
    await page.route(url => url.pathname === `/api/conversations/${waiting.id}`, async route => {
      if (!approvalLimitedAt) {
        approvalLimitedAt = Date.now();
        await route.fulfill({ status: 429, headers: { "Retry-After": "8" }, json: { error: "Too many requests" } });
      } else await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("loop-workspace-change")));
    await expect.poll(() => approvalLimitedAt).toBeGreaterThan(0);
    // The five-second approval poll falls within the eight-second cooldown.
    await expect(transcript.getByRole("status").filter({ hasText: "Approval updates are paused" })).toBeVisible({ timeout: 7000 });
    await expect(transcript.locator('[role="alert"]')).toHaveCount(0);
    await expect.poll(() => approvalReads, { timeout: 15_000 }).toBeGreaterThan(beforeApprovalReads);
    assert(Date.now() - approvalLimitedAt >= 7950);
    await expect(transcript.getByRole("status").filter({ hasText: "Approval updates are paused" })).toHaveCount(0);
    await expect(transcript.locator('[role="alert"]')).toHaveCount(0);
    await expect(transcript.locator(".approval-card").first()).toBeVisible();
    // A later successful read clears its own error, but not a refused action.
    await page.route(url => url.pathname.startsWith("/api/approvals/"), route => route.fulfill({
      status: 409, json: { error: "Approval action refused for this fixture" },
    }));
    await transcript.locator(".approval-card").first().getByRole("button", { name: "Approve", exact: true }).click();
    await expect(transcript.getByRole("alert").filter({ hasText: "Approval action refused" })).toBeVisible();
    failApprovalRead = true;
    await expect(transcript.getByRole("alert").filter({ hasText: "Approval read temporarily unavailable" })).toBeVisible({ timeout: 7000 });
    await expect(transcript.getByRole("alert").filter({ hasText: "Approval read temporarily unavailable" })).toHaveCount(0, { timeout: 7000 });
    await expect(transcript.getByRole("alert").filter({ hasText: "Approval action refused" })).toBeVisible();
    await closeThread();
    await page.unrouteAll({ behavior: "wait" });
    console.log(`${engine.name()}: local/linked cached first paint, source isolation, resume request, Retry-After and approval recovery passed`);
    await conversationFilesSmoke(page, fixture, conversation.id);
    console.log(`${engine.name()}: separate conversation/file loading, deferred metadata, on-demand previews and cancelled file reads passed`);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: bounded transcript opening, requested older activity and saved Git reviews passed`,
    );
  } finally {
    await page?.unrouteAll({ behavior: "ignoreErrors" });
    await browser?.close();
    await fixture.close();
  }
}
