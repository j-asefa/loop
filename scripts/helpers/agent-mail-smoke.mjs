import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

export async function agentMailSmoke(page, fixture, _engine, capture) {
  const { db, owner, agents } = fixture;
  const a = agents[0],
    b = agents[1];
  const senderConversation = db
    .prepare(
      "SELECT id FROM conversations WHERE agent_id=? ORDER BY created_at LIMIT 1",
    )
    .get(a.id).id;
  const recipientConversation = db
    .prepare(
      "SELECT id FROM conversations WHERE agent_id=? ORDER BY created_at LIMIT 1",
    )
    .get(b.id).id;
  const thread = randomUUID(),
    pending = randomUUID();
  const time = Date.now();
  for (const [tid, subject, paused] of [
    [thread, "Direct question", time],
    [pending, "Waiting question", null],
  ]) {
    db.prepare(
      "INSERT INTO agent_threads(id,owner_id,scope,subject,created_by,paused_at,paused_reason,created_at,updated_at) VALUES(?,?,'direct',?,?,?,'Message limit',?,?)",
    ).run(tid, owner, subject, a.id, paused, time, time);
    db.prepare("INSERT INTO agent_thread_members VALUES(?,?,?),(?,?,?)").run(
      tid,
      a.id,
      senderConversation,
      tid,
      b.id,
      tid === thread ? recipientConversation : null,
    );
    db.prepare(
      "INSERT INTO agent_mail(id,owner_id,thread_id,kind,sender_agent_id,sender_conversation_id,recipient_agent_id,body,idempotency_key,request,state,created_at) VALUES(?,?,?,'message',?,?,?,?,?,'{}',?,?)",
    ).run(
      randomUUID(),
      owner,
      tid,
      a.id,
      senderConversation,
      b.id,
      tid === thread
        ? "Please check the interface"
        : "Waiting without a recipient turn",
      randomUUID(),
      tid === thread ? "held" : "pending",
      time,
    );
  }
  const open = async () => {
    await page.goto(`${fixture.base}/?agent=${a.id}`);
    await page.getByRole("tab", { name: "Agent mail", exact: true }).click();
  };
  await open();
  const region = page.getByRole("region", { name: "Agent mail", exact: true });
  const direct = region.getByRole("region", { name: "Thread Direct question" });
  const waiting = region.getByRole("region", {
    name: "Thread Waiting question",
  });
  await expect(direct).toContainText(`@${a.name} · @${b.name}`);
  await expect(waiting).toContainText("No recipient turn has started");
  await expect(waiting.getByRole("button", { name: /Open in/ })).toHaveCount(0);
  await expect(region.locator("time")).toHaveCount(2);
  await direct.scrollIntoViewIfNeeded();
  await capture("mail-pending-held");
  // A transient obstruction reports the partial outcome and keeps Resume.
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    b.connection_id,
  );
  const resume = direct.getByRole("button", { name: "Resume", exact: true });
  await resume.focus();
  await expect(resume).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(region).toContainText("0 released, 0 refused, 1 still held.");
  await expect(direct).toContainText("Resume again to retry");
  db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
    b.connection_id,
  );
  const resumeUrl = `${fixture.base}/api/agents/${a.id}/mail/${thread}/resume`;
  let release, captured;
  const gate = new Promise((r) => (release = r)),
    ready = new Promise((r) => (captured = r));
  await page.route(
    resumeUrl,
    async (route) => {
      captured();
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  await direct.getByRole("button", { name: "Resume", exact: true }).click();
  await ready;
  await expect(
    direct.getByRole("button", { name: "Resuming…" }),
  ).toBeDisabled();
  release();
  await expect(region).toContainText("1 released, 0 refused, 0 still held.");
  await expect(direct).toContainText("Queued");
  const destination = direct.getByRole("button", { name: /Open in/ });
  await destination.focus();
  await expect(destination).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("dialog.conversation-sheet[open]")).toBeVisible();
  await expect(page.locator("dialog.conversation-sheet[open]")).toContainText(
    `Message from @${a.name}`,
  );
  await page
    .locator("dialog.conversation-sheet[open]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(destination).toBeFocused();
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Agent messages", exact: true }),
  ).toContainText("Intermediate updates and final answers");
  await page.getByRole("tab", { name: "Agent mail", exact: true }).click();
  await expect(direct).toBeVisible();
  // Explicit error/retry and loading states.
  const endpoint = `${fixture.base}/api/agents/${a.id}/mail`;
  // Keep the outage through the bounded GET retries before testing manual recovery.
  let failedReads = 0;
  const unavailable = (route) => {
    failedReads++;
    return route.fulfill({
      status: 503,
      json: { error: "Fixture source temporarily unavailable" },
    });
  };
  await page.route(endpoint, unavailable);
  await region.getByRole("button", { name: "Refresh mail" }).click();
  await expect(region.getByRole("alert")).toContainText(
    "temporarily unavailable",
    { timeout: 10_000 },
  );
  expect(failedReads).toBeGreaterThanOrEqual(3);
  await page.unroute(endpoint, unavailable);
  await region.getByRole("button", { name: "Refresh mail" }).click();
  await expect(region.getByRole("alert")).toHaveCount(0);
  // Older team-mail producers lacked scope and recipient navigation. Derive
  // their payload from the production route, without inventing a second DTO.
  let legacyReads = 0;
  const legacyMail = async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const body = await response.json();
    for (const item of body.threads) {
      delete item.scope;
      for (const message of item.messages) delete message.conversation_id;
    }
    legacyReads++;
    await route.fulfill({ response, json: body });
  };
  await page.route(endpoint, legacyMail);
  try {
    await region.getByRole("button", { name: "Refresh mail" }).click();
    await expect(direct.locator("header small")).toHaveText(
      `@${a.name} · @${b.name}`,
    );
    await expect(direct).toContainText("Queued");
    await expect(direct).toContainText("Please check the interface");
    await expect(region.getByRole("button", { name: /Open in/ })).toHaveCount(
      0,
    );
    await expect(region.getByRole("alert")).toHaveCount(0);
    expect(legacyReads).toBeGreaterThan(0);
    await capture("mail-older-response");
  } finally {
    await page.unroute(endpoint, legacyMail);
  }
  // A late read from the previous profile is discarded on navigation.
  let releaseRead, readStarted;
  const readGate = new Promise((r) => (releaseRead = r)),
    readReady = new Promise((r) => (readStarted = r));
  await page.route(
    endpoint,
    async (route) => {
      const response = await route.fetch();
      readStarted();
      await readGate;
      await route.fulfill({ response }).catch(() => {});
    },
    { times: 1 },
  );
  await region.getByRole("button", { name: "Refresh mail" }).click();
  await readReady;
  await expect(region).toContainText("Loading agent mail");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  releaseRead();
  await expect(region).toHaveCount(0);
  await page.goto(`${fixture.base}/?agent=${agents[10].id}`);
  await page.getByRole("tab", { name: "Agent mail", exact: true }).click();
  await expect(region).toContainText("No agent mail yet");
  await expect(region).not.toContainText("Direct question");
  // A source-qualified profile uses only its own endpoint and destination link.
  const source = "docker:mail-fixture";
  const scoped = [];
  const production = (await fixture.api(`/agents/${a.id}/mail`)).threads.find(
    (item) => item.id === thread,
  );
  const remote = {
    ...production,
    id: "remote",
    scope: "direct",
    subject: "Remote source mail",
    paused_at: null,
    paused_reason: null,
    messages: [
      {
        ...production.messages[0],
        id: "remote-message",
        from: a.id,
        to: b.id,
        preview: "Only this source",
        status: "queued",
        files: 0,
        conversation_id: recipientConversation,
      },
    ],
  };
  await page.route("**/api/agent-sources/*/**", async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/agent-sources\/[^/]+\/(.*)$/.exec(url.pathname);
    if (!match) return route.continue();
    scoped.push(match[1]);
    if (match[1] === `agents/${a.id}/mail`)
      return route.fulfill({ json: { threads: [remote] } });
    await route.continue({
      url: fixture.base + "/api/" + match[1] + url.search,
    });
  });
  try {
    await page.goto(
      `${fixture.base}/?source=${encodeURIComponent(source)}&agent=${a.id}`,
    );
    await page.getByRole("tab", { name: "Agent mail", exact: true }).click();
    await expect(region).toContainText("Remote source mail");
    await expect(region).not.toContainText("Direct question");
    await region.getByRole("button", { name: /Open in/ }).click();
    await expect(page).toHaveURL(
      new RegExp("source=docker%3Amail-fixture.*conversation="),
    );
    expect(scoped).toContain(`agents/${a.id}/mail`);
    await capture("mail-source-navigation");
  } finally {
    // The conversation starts several reads. Finish intercepted requests
    // before the scenario closes WebKit's context.
    await page.unrouteAll({ behavior: "wait" });
  }
}
