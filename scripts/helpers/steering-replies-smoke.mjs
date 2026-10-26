import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function steeringRepliesSmoke(page, fixture, _engine, capture) {
  const target = fixture.conversations.find(conversation => conversation.state === "running");
  const run = fixture.db.prepare("SELECT * FROM runs WHERE id=?").get(target.run);
  const question = "What did you find while the long task was running?";
  await fixture.api("/runs", {
    agentId: run.agent_id, conversationId: target.id, input: question, idempotencyKey: randomUUID(),
  });
  const steering = fixture.db.prepare("SELECT * FROM run_steering WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get(run.id);
  assert(steering, "The question must steer the existing task");
  fixture.db.prepare("UPDATE run_steering SET state='delivered' WHERE id=?").run(steering.id);
  // A harness publishes through loop_reply in the domain regression; here the
  // fixture supplies two committed publications for the browser to read.
  const publish = (body) => {
    const message = randomUUID(), at = Date.now();
    fixture.db.transaction(() => {
      fixture.db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at,update_key) VALUES(?,?,?,?,'assistant',?,?,?,?)")
        .run(message, run.owner_id, target.id, run.id, body,
          JSON.stringify({ progress: true, reply: { to: steering.message_id, published: true } }), at, `reply:${message}`);
      fixture.db.prepare("INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at) VALUES(?,?,?,?)")
        .run(message, run.owner_id, steering.id, at);
    })();
    return message;
  };
  const first = publish("The reconnect race is isolated.\n\n" + "The task continues. ".repeat(85) + "\n\nFull reply ending.");
  const second = publish("The second reply adds a finding without replacing the first.");
  await page.goto(fixture.base + "/?filter=replies");
  const feed = page.getByRole("region", { name: "Feed", exact: true });
  const rows = feed.locator(":scope > .inbox-results .inbox-card");
  await expect(rows).toHaveCount(2);
  await expect(feed.getByRole("tab", { name: "Replies 2", exact: true })).toBeVisible();
  const filters = feed.getByRole("tablist", { name: "Show", exact: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await filters.evaluate(el => el.scrollWidth <= el.clientWidth),
      `Feed tabs and unread counts fit a ${width}px viewport`);
    await capture(`reply-tabs-${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const firstRow = rows.filter({ hasText: "The reconnect race is isolated." });
  await firstRow.getByRole("button", { name: "Read reply", exact: true }).click();
  const sheet = page.locator("dialog.feed-reading-sheet[open]");
  await expect(sheet.getByText("Full reply ending.", { exact: false })).toBeVisible();
  await expect(sheet.getByText("In reply to your message", { exact: true })).toBeVisible();
  await expect.poll(() => fixture.db.prepare("SELECT read_at FROM steering_replies WHERE message_id=?").get(first).read_at).not.toBeNull();
  await capture("reply-reading");
  await sheet.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.locator("dialog.conversation-sheet[open]");
  await expect(thread).toBeVisible();
  await expect(thread.locator(".composer-reply-chip")).toContainText("The reconnect race is isolated");
  const input = thread.locator("textarea").last();
  await input.fill("Please explain the reconnect race.");
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect.poll(() => fixture.db.prepare("SELECT count(*) n FROM run_steering WHERE run_id=?").get(run.id).n).toBe(2);
  assert.equal(fixture.db.prepare("SELECT count(*) n FROM runs WHERE conversation_id=?").get(target.id).n, 1);
  await thread.getByRole("button", { name: "Close", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(feed.getByRole("tab", { name: "Replies 1", exact: true })).toBeVisible();
  await firstRow.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive reply", exact: true }).click();
  await expect(rows).toHaveCount(1);
  const toast = page.getByRole("status").filter({ hasText: "Reply archived." });
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await firstRow.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive reply", exact: true }).click();
  await expect(rows).toHaveCount(1);
  // A new reply to an already-answered question gets its own card and unread state.
  publish("A third reply remains visible after the first was archived.");
  await expect(rows).toHaveCount(2);
  fixture.db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(Date.now(), run.id);
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(firstRow).toHaveCount(0);
  await expect(rows.filter({ hasText: "The second reply adds a finding" })).toHaveCount(1);
  await expect(feed.getByRole("tab", { name: "Replies 2", exact: true })).toBeVisible();
  assert.equal(fixture.db.prepare("SELECT read_at FROM steering_replies WHERE message_id=?").get(second).read_at, null);
  await capture("replies-retained");
  await replyCompatibilitySmoke(page, fixture, capture);
}

async function replyCompatibilitySmoke(page, fixture, capture) {
  const sources = [
    { id: "cloud:old", name: "Older environment" },
    { id: "cloud:updated", name: "Updated environment" },
  ];
  const replies = await fixture.api("/feed?filter=replies");
  const operational = await fixture.api("/feed?filter=needs");
  const bootstrap = await fixture.api("/bootstrap");
  const capabilities = await fixture.api("/capabilities");
  const { replies_unread, ...legacySummary } = operational.summary;
  const legacy = { ...operational, items: [], next: null, summary: legacySummary };
  let updated = true, denied = false;
  const unsupported = route => route.fulfill({ status: 400, json: { error: "Invalid filter" } });
  const localFeed = route => new URL(route.request().url()).searchParams.get("filter") === "replies"
    ? unsupported(route) : route.fulfill({ json: legacy });
  const remote = async route => {
    const url = new URL(route.request().url());
    const match = /^\/api\/agent-sources\/([^/]+)\/(.*)$/.exec(url.pathname);
    const current = decodeURIComponent(match[1]) === sources[1].id;
    if (match[2] === "feed") {
      if (current && denied) return route.fulfill({ status: 403, json: { error: "Fixture access denied" } });
      if (url.searchParams.get("filter") === "replies")
        return current && updated ? route.fulfill({ json: replies }) : unsupported(route);
      return route.fulfill({ json: current && updated ? { ...operational, items: [], next: null } : legacy });
    }
    if (match[2] === "bootstrap") return route.fulfill({ json: bootstrap });
    if (match[2].startsWith("v1/cards")) return route.fulfill({ status: 404, body: "{}" });
    url.pathname = "/api/" + match[2];
    return route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  };
  const routes = [
    ["**/api/capabilities", route => route.fulfill({ json: { ...capabilities, pairedDevices: true } })],
    ["**/session", route => route.fulfill({ json: { csrf: "fixture" } })],
    ["**/api/feed?*", localFeed],
    ["**/api/agent-sources", route => route.fulfill({ json: sources })],
    ["**/api/agent-sources/**", remote],
  ];
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  try {
    const rows = page.locator(".inbox-results .inbox-card");
    const notice = page.getByRole("status").filter({ hasText: "Update Loop in" });
    const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await page.goto(fixture.base + "/?filter=replies");
    await expect(rows).toHaveCount(replies.items.length);
    await expect(notice).toContainText("Older environment");
    await expect(notice).not.toContainText("Updated environment");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await capture("mixed-version-replies");

    // An entirely older installation is an explicit empty view, not a failed Feed.
    updated = false;
    await page.reload();
    await expect(notice).toContainText("Updated environment");
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Loading feed", exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // A source upgrade is recognized on refresh without reloading the app.
    updated = true;
    await refresh();
    await expect(rows).toHaveCount(replies.items.length);
    await expect(notice).not.toContainText("Updated environment");
    denied = true;
    await refresh();
    await expect(page.getByRole("alert")).toContainText("Some environments could not refresh");
    await expect(rows).toHaveCount(replies.items.length);
    denied = false;
    await refresh();
    await expect(page.getByRole("alert")).toHaveCount(0);
    updated = false;
    await refresh();
    await expect(notice).toContainText("Updated environment");
    await expect(rows).toHaveCount(replies.items.length);
  } finally {
    await page.goto("about:blank");
    for (const [pattern, handler] of routes) await page.unroute(pattern, handler);
  }
}
