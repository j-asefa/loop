import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { runReceipt } from "./run-receipt.mjs";

// The real app, with independent source APIs (no provider calls). Request
// destinations and document identity are observed across actual user actions.
export async function sourceConversationBrowser(
  page,
  workspaceUrl,
  { sources, records, local, fulfill, unavailable },
) {
  // Exercise the mobile compatibility path throughout this scenario.
  await page.addInitScript(() => {
    AbortSignal.any = undefined;
  });
  await page.evaluate(() => {
    AbortSignal.any = undefined;
  });
  const remote = records.get(sources[0].id);
  const requests = [];
  let offline = false,
    refuseSend = false;
  let holdRead, releaseRead, holdSend, releaseSend, holdUpload, releaseUpload;
  let slowUploads = false,
    uploadNumber = 0;
  const snapshot = (record) => ({
    conversation: {
      id: record.thread.conversation_id,
      owner_id: record.agent.owner_id,
      agent_id: record.agent.id,
      title: record.thread.title,
      origin: "loop55",
      external_id: null,
      created_at: record.thread.last_activity_at,
      team_id: null,
      execution_backend: "native",
      execution_connection_id: record.agent.connection_id,
      project_id: null,
    },
    messages: [
      {
        id: record.thread.last_message.id,
        owner_id: record.agent.owner_id,
        conversation_id: record.thread.conversation_id,
        role: "assistant",
        content: record.thread.last_message.preview,
        metadata: "{}",
        created_at: Date.now(),
        run_id: null,
        cursor: [1, 1, 1],
      },
    ],
    next: null,
    position_message_id: null,
    saved: [],
  });
  const handle = async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/agent-sources\/([^/]+)\/(.+)$/.exec(url.pathname);
    const source = match ? decodeURIComponent(match[1]) : "";
    const path = match ? match[2] : url.pathname.slice(5);
    const record = source ? records.get(source) : local;
    if (!record) return route.fallback();
    if (source === sources[0].id && offline) return unavailable(route);
    const method = route.request().method();
    if (method !== "GET")
      requests.push({
        source,
        path,
        method,
        body: route
          .request()
          .headers()
          ["content-type"]?.includes("application/json")
          ? route.request().postDataJSON()
          : null,
      });
    if (path === `conversations/${record.thread.conversation_id}`) {
      if (holdRead) {
        const held = holdRead;
        holdRead = null;
        await held();
      }
      return fulfill(route, snapshot(record));
    }
    if (path === `messages/${record.thread.last_message.id}`)
      return fulfill(route, {
        ...snapshot(record).messages[0],
        content: `Full reading view for ${record.agent.name}`,
      });
    if (path.endsWith("/activities"))
      return fulfill(route, { version: 1, items: [], cursor: 0, more: false });
    if (path.endsWith("/usage")) return fulfill(route, {});
    if (path.endsWith("/position")) return fulfill(route, {});
    if (path.endsWith("/harness"))
      return fulfill(route, { commands: [], skills: [] });
    if (
      path === "snippets" ||
      path === "native/decisions" ||
      path === "approvals"
    )
      return fulfill(route, []);
    if (path === "uploads" && slowUploads) {
      const number = ++uploadNumber;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fulfill(route, {
        id: randomUUID(),
        objectId: randomUUID(),
        name: `batch-${number}.txt`,
        mime: "text/plain",
        size: 5,
      });
    }
    if (path === "uploads" && holdUpload) {
      const held = holdUpload;
      holdUpload = null;
      await held();
      return fulfill(route, {
        id: randomUUID(),
        objectId: randomUUID(),
        name: "late.txt",
        mime: "text/plain",
        size: 4,
      });
    }
    if (path === "runs" && method === "POST") {
      if (refuseSend) return unavailable(route);
      if (holdSend) {
        const held = holdSend;
        holdSend = null;
        await held();
      }
      return fulfill(route, {
        ...runReceipt(route.request(), `accepted-${source}`),
        agent_id: record.agent.id,
        conversation_id: record.thread.conversation_id,
        state: "queued",
      });
    }
    return route.fallback();
  };
  await page.route("**/api/**", handle);
  const dialog = () => page.locator("dialog[open]").last();
  const reply = () => dialog().getByLabel("Reply to agent", { exact: true });
  const open = async (record) => {
    const minimize = page.getByRole("button", {
      name: "Collapse composer",
      exact: true,
    });
    if (await minimize.isVisible()) await minimize.click();
    await page
      .locator(".inbox-card")
      .filter({ hasText: record.thread.title })
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + record.agent.name,
    );
    await expect(reply()).toBeVisible();
  };
  const close = async () => {
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loop55Sheet !== true);
  };
  try {
    // Reading a linked host's card fetches its message from that same host,
    // and Reply keeps the source even when conversation ids collide.
    await page
      .locator(".inbox-row")
      .filter({ hasText: remote.thread.title })
      .click();
    const reading = page.locator("dialog.feed-reading-sheet[open]");
    await expect(reading.locator(".artifact-body")).toHaveText(
      `Full reading view for ${remote.agent.name}`,
    );
    await reading
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + remote.agent.name,
    );
    await close();
    await page.evaluate(() => {
      window.__sourceDocument = "retained";
      document.querySelector(".inbox").dataset.sourceRetained = "yes";
    });
    const waitingForThread = new Promise((started) => {
      holdRead = () =>
        new Promise((resolve) => {
          releaseRead = resolve;
          started();
        });
    });
    await page
      .locator(".inbox-card")
      .filter({ hasText: local.thread.title })
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await waitingForThread;
    await expect(
      dialog().locator('button[aria-label="Send reply"]:enabled'),
    ).toHaveCount(0);
    releaseRead();
    await reply().fill("Wait for thread context");
    await expect(
      dialog().getByRole("button", { name: "Send reply", exact: true }),
    ).toBeEnabled();
    // A batched away-and-back update retains the Conversation instance but
    // must re-announce its already-loaded context for the new view generation.
    const away = new URL(workspaceUrl),
      back = new URL(workspaceUrl);
    away.searchParams.set("source", sources[0].id);
    away.searchParams.set("conversation", remote.thread.conversation_id);
    back.searchParams.set("conversation", local.thread.conversation_id);
    await page.evaluate(
      ([away, back]) => {
        for (const url of [away, back])
          navigator.serviceWorker.dispatchEvent(
            new MessageEvent("message", { data: { type: "loop55-open", url } }),
          );
      },
      [away.toString(), back.toString()],
    );
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + local.agent.name,
    );
    await expect(
      dialog().getByRole("button", { name: "Send reply", exact: true }),
    ).toBeEnabled();
    await reply().fill("");
    await close();
    await page
      .locator(".inbox-card")
      .filter({ hasText: remote.thread.title })
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await expect(reply()).toBeFocused();
    // Each upload gets its own deadline; two successful requests can together
    // exceed one request's budget. Scale only that timer, not the app clock.
    await page.evaluate(() => {
      window.__uploadTimer = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) =>
        window.__uploadTimer(fn, ms === 120000 ? 1500 : ms, ...args);
    });
    slowUploads = true;
    await dialog()
      .getByLabel("Attach files", { exact: true })
      .setInputFiles([
        {
          name: "one.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("hello"),
        },
        {
          name: "two.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("hello"),
        },
      ]);
    await expect(
      dialog().getByRole("button", { name: "Remove batch-2.txt", exact: true }),
    ).toBeVisible();
    await dialog()
      .getByRole("button", { name: "Remove batch-1.txt", exact: true })
      .click();
    await dialog()
      .getByRole("button", { name: "Remove batch-2.txt", exact: true })
      .click();
    slowUploads = false;
    await page.evaluate(() => {
      window.setTimeout = window.__uploadTimer;
    });
    await close();
    await page
      .getByRole("button", { name: "Compose a message", exact: true })
      .click();
    await page
      .getByLabel("Message your agent", { exact: true })
      .fill("Workspace draft");
    const uploadStarted = new Promise((started) => {
      holdUpload = () =>
        new Promise((release) => {
          releaseUpload = release;
          started();
        });
    });
    await page
      .locator(".composer-dock")
      .getByLabel("Attach files", { exact: true })
      .setInputFiles({
        name: "late.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("late"),
      });
    await uploadStarted;
    await open(remote);
    await close();
    await page
      .getByRole("button", { name: "Compose a message", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    releaseUpload();
    await open(remote);
    await expect(dialog()).toContainText(remote.thread.last_message.preview);
    assert.equal(new URL(page.url()).searchParams.get("source"), sources[0].id);
    await reply().fill("Docker draft");
    await close();
    await page
      .getByRole("button", { name: "Compose a message", exact: true })
      .click();
    await expect(
      page.getByLabel("Message your agent", { exact: true }),
    ).toHaveValue("Workspace draft");
    await expect(page.locator(".composer-dock")).toContainText("laptop-agent");
    await open(local);
    await expect(reply()).toHaveValue("");
    await reply().fill("Laptop draft");
    await close();
    await open(remote);
    await expect(reply()).toHaveValue("Docker draft");
    await expect(dialog()).not.toContainText(local.thread.last_message.preview);
    // The uploader and its preview must retain the thread's destination.
    await dialog()
      .getByLabel("Attach files", { exact: true })
      .setInputFiles({
        name: "thread.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello"),
      });
    await expect(
      dialog().getByRole("list", { name: "Attached files" }),
    ).toBeVisible();
    const uploaded = await dialog()
      .getByRole("button", { name: /^Preview attachment-/ })
      .getAttribute("aria-label");
    await dialog().getByRole("button", { name: uploaded }).click();
    await expect(page.locator(".file-preview-content pre")).toHaveText("hello");
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    // An uncertain submission keeps its durable identity on explicit retry.
    refuseSend = true;
    await dialog()
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(dialog().locator(".composer-error")).toContainText(
      "Fixture connection interrupted",
    );
    refuseSend = false;
    const sendStarted = new Promise((started) => {
      holdSend = () =>
        new Promise((release) => {
          releaseSend = release;
          started();
        });
    });
    await dialog()
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await sendStarted;
    const sends = requests.filter((r) => r.path === "runs");
    assert.equal(sends.length, 2);
    assert.equal(sends[0].source, sources[0].id);
    assert.equal(sends[0].body.conversationId, remote.thread.conversation_id);
    assert.equal(sends[0].body.idempotencyKey, sends[1].body.idempotencyKey);
    assert.equal(sends[0].body.attachmentIds.length, 1);
    await close();
    await open(local);
    await expect(reply()).toHaveValue("Laptop draft");
    releaseSend();
    await expect(reply()).toHaveValue("Laptop draft");
    await close();
    // Back closes the thread without leaving or recreating the Feed.
    await open(remote);
    await expect(reply()).toHaveValue("");
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(
      page.locator('.inbox[data-source-retained="yes"]'),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(() => window.__sourceDocument),
      "retained",
    );
    // Returning to the originating thread before its acknowledgement clears
    // the sent composer, but never a new draft typed while it was in flight.
    for (const edited of [false, true]) {
      await open(remote);
      await reply().fill("Returning send");
      const started = new Promise((resolve) => {
        holdSend = () =>
          new Promise((release) => {
            releaseSend = release;
            resolve();
          });
      });
      await dialog()
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await started;
      await close();
      await open(local);
      await close();
      await open(remote);
      await expect(reply()).toHaveValue("Returning send");
      if (edited) await reply().fill("New unsent draft");
      releaseSend();
      await expect(reply()).toHaveValue(edited ? "New unsent draft" : "");
      if (edited) {
        await expect(
          page.getByText(
            `Sent to @${remote.agent.name}. Your current draft has been kept.`,
            { exact: true },
          ),
        ).toBeVisible();
        await reply().fill("");
      }
      await close();
    }
    // A notification switches sources in the already open sheet, even when
    // both servers use the same conversation ID.
    await open(local);
    await expect(reply()).toHaveValue("Laptop draft");
    const notification = new URL(workspaceUrl);
    notification.searchParams.set("source", sources[0].id);
    notification.searchParams.set(
      "conversation",
      remote.thread.conversation_id,
    );
    await page.evaluate(
      (url) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", { data: { type: "loop55-open", url } }),
        ),
      notification.toString(),
    );
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + remote.agent.name,
    );
    await expect(reply()).toHaveValue("");
    assert.equal(
      await page.evaluate(() => window.__sourceDocument),
      "retained",
    );
    await close();
    // A delayed source read cannot paint into a different source's thread.
    const readStarted = new Promise((started) => {
      holdRead = () =>
        new Promise((release) => {
          releaseRead = release;
          started();
        });
    });
    await page
      .locator(".inbox-card")
      .filter({ hasText: remote.thread.title })
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await readStarted;
    await close();
    await open(local);
    releaseRead();
    await expect(dialog()).toContainText(local.thread.last_message.preview);
    await expect(dialog()).not.toContainText(
      remote.thread.last_message.preview,
    );
    await close();
    offline = true;
    await page
      .locator(".inbox-card")
      .filter({ hasText: remote.thread.title })
      .getByRole("button", { name: /^(Reply|Continue draft)$/ })
      .click();
    await expect(
      dialog()
        .getByRole("alert")
        .filter({
          has: page.getByRole("button", { name: "Try again", exact: true }),
        }),
    ).toContainText("Fixture connection interrupted", { timeout: 10_000 });
    offline = false;
    await dialog()
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + remote.agent.name,
    );
    await close();
    assert.equal(
      await page.evaluate(() => window.__sourceDocument),
      "retained",
    );
    // Cold links and legacy links preserve the source even while it is offline.
    for (const key of ["source", "workspace"]) {
      const url = new URL(workspaceUrl);
      url.searchParams.set(key, sources[0].id);
      url.searchParams.set("conversation", remote.thread.conversation_id);
      offline = true;
      await page.goto(url.toString());
      await expect(dialog().getByRole("alert")).toContainText(
        "Fixture connection interrupted",
        { timeout: 10_000 },
      );
      assert.equal(new URL(page.url()).searchParams.get(key), sources[0].id);
      offline = false;
      await dialog().getByRole("button", { name: "Retry connection" }).click();
      await expect(dialog().locator(".thread-head")).toContainText(
        "@" + remote.agent.name,
      );
      await close();
      await expect(
        page.locator(".inbox-row").filter({ hasText: local.thread.title }),
      ).toBeVisible();
    }
    const dockerShell = new URL(workspaceUrl);
    dockerShell.searchParams.set("source", sources[0].id);
    await page.goto(dockerShell.toString());
    await open(local);
    await page.reload();
    await expect(dialog().locator(".thread-head")).toContainText(
      "@" + local.agent.name,
    );
    assert.equal(
      await page.evaluate(() => history.state.loop55ShellSource),
      sources[0].id,
    );
    await close();
    assert.equal(new URL(page.url()).searchParams.get("source"), sources[0].id);
  } finally {
    releaseUpload?.();
    releaseRead?.();
    releaseSend?.();
    await page.unroute("**/api/**", handle);
  }
}
