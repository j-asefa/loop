import { chooseAgentConnection } from "./helpers/agent-model-options.mjs";
// Full paired UI + production WorkspaceHost, SQLite, WS and adapter subprocesses.
// Only the external harness protocols and a server-side network cut are fixtures.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "loop-deterministic-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_TEST_HARNESS = "codex";
const { WorkspaceHost } = await import("../dist/workspace-host.js");
const { nativeSessions } = await import("../dist/server/native-sessions.js");
const { db } = await import("../dist/server/db.js");
const evidence = "test-results/deterministic-browser";
await mkdir(evidence, { recursive: true });
await chmod(resolve("test/harness.mjs"), 0o755);
const options = {
  harness: "codex",
  version: "fixture",
  project: dir,
  executable: resolve("test/harness.mjs"),
  billing: "existing",
};
const host = new WorkspaceHost(dir, options);
const control = join(dir, "progress"),
  audit = join(dir, "audit.jsonl");
const acp = {
  ...options,
  harness: "acp",
  executable: process.execPath,
  args: [resolve("test/fixtures/browser-acp.mjs"), control, audit],
};
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const binding = (id) =>
  db
    .prepare("SELECT * FROM companion_sessions WHERE conversation_id=?")
    .get(id);
const runFor = (name) =>
  db
    .prepare(
      "SELECT r.* FROM runs r JOIN agents a ON a.id=r.agent_id WHERE a.name=? ORDER BY r.created_at DESC,r.rowid DESC",
    )
    .get(name);
const auditRows = async () =>
  (await readFile(audit, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
let browser,
  page,
  blocked = false;
const sockets = new Set();
const connect = host.gateway.workspace.connect;
host.gateway.workspace.connect = (socket, url) => {
  if (blocked) {
    socket.close(1013, "Deterministic network outage");
    return () => {};
  }
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  return connect(socket, url);
};
async function cut() {
  blocked = true;
  for (const socket of sockets) socket.terminate();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("status")
      .filter({ hasText: /reconnecting/i }),
  ).toBeVisible();
}
async function createAgent(name, provider, connection, prompt, beforeCreate) {
  await page
    .getByRole("button", { name: /^(New agent|Start chatting)$/ })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "New chat", exact: true })
    .getByText("Customize", { exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New chat" });
  await expect(
    await chooseAgentConnection(dialog, { id: connection, source: "" }),
  ).toBeChecked();
  await dialog.getByLabel("Unique name").fill(name);
  await dialog.getByLabel("Opening message", { exact: true }).fill(prompt);
  if (/^(direct|acp)-/.test(name))
    await page.screenshot({
      path: `${evidence}/selection-${name}.png`,
      fullPage: true,
    });
  const create = dialog.getByRole("button", {
    name: "Start chatting",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await beforeCreate?.();
  await create.click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => runFor(name)?.conversation_id).toBeTruthy();
  const run = runFor(name);
  assert.equal(
    db.prepare("SELECT connection_id FROM agents WHERE id=?").get(run.agent_id)
      .connection_id,
    connection,
  );
  assert.equal(JSON.parse(run.payload).connectionId, connection);
  return run;
}
async function closeConversation() {
  const close = page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true });
  if (await close.isVisible()) await close.click();
}
const results = [];
try {
  await host.start(options);
  await nativeSessions.enable(acp);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  for (const width of [1280, 390]) {
    await rm(control, { force: true });
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [],
      frames = [],
      requests = [];
    let navigations = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigations++;
    });
    page.on("websocket", (ws) => {
      requests.push(ws.url());
      ws.on("framereceived", ({ payload }) => {
        try {
          frames.push(JSON.parse(String(payload)));
        } catch {}
      });
    });
    await page.goto(host.pair().url);
    await page.getByRole("button", { name: "Pair and open Loop" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Connected to workspace" }),
    ).toBeVisible();
    // The two connection identities are deliberately present at the same time.
    const direct = await createAgent(
      `direct-${width}`,
      "ChatGPT",
      "native-codex",
      "finish",
    );
    await expect.poll(() => runFor(`direct-${width}`)?.state).toBe("completed");
    const original = binding(direct.conversation_id);
    assert.equal(original.harness, "codex");
    await page.getByLabel("Reply to agent").fill("second direct turn");
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect
      .poll(
        () =>
          rows(
            "SELECT * FROM runs WHERE conversation_id=?",
            direct.conversation_id,
          ).length,
      )
      .toBe(2);
    await expect.poll(() => runFor(`direct-${width}`)?.state).toBe("completed");
    assert.equal(binding(direct.conversation_id).native_id, original.native_id);
    assert.equal(
      binding(direct.conversation_id).generation,
      original.generation,
    );
    await closeConversation();
    const run = await createAgent(
      `acp-${width}`,
      "ACP agent",
      "native-acp",
      "approval fixture",
    );
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Approve browser fixture",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() => binding(run.conversation_id)?.native_id)
      .toMatch(/^browser-fixture-/);
    const before = binding(run.conversation_id);
    // Output projection is debounced independently of the approval record.
    // Capture identities after the first public update has been persisted.
    await expect
      .poll(
        () =>
          rows(
            "SELECT id FROM messages WHERE conversation_id=? AND update_key LIKE 'native-message:%' AND content='Browser fixture working'",
            run.conversation_id,
          ).length,
      )
      .toBe(1);
    const messageIds = rows(
      "SELECT id FROM messages WHERE conversation_id=? ORDER BY id",
      run.conversation_id,
    );
    assert.equal(before.harness, "acp");
    const decision = db
      .prepare("SELECT * FROM native_decisions WHERE conversation_id=?")
      .get(run.conversation_id);
    assert.equal(decision.state, "pending");
    await page
      .getByLabel("Reply to agent")
      .fill("Draft survives socket reconnect");
    // Synchronize the browser's durable cursor before cutting the transport.
    const eventMax = rows("SELECT max(id) id FROM events")[0].id;
    await expect.poll(() => frames.at(-1)?.cursor).toBe(eventMax);
    const cursor = frames.at(-1).cursor,
      epoch = frames.at(-1).epoch;
    const navigationCount = navigations;
    const marker = await page.evaluate(
      () => (window.__documentMarker = crypto.randomUUID()),
    );
    const framesBefore = frames.length;
    await cut();
    const missedText = `Missed progress ${width}`;
    await writeFile(control, missedText);
    await expect
      .poll(async () => (await auditRows()).some((r) => r.text === missedText))
      .toBe(true);
    await expect
      .poll(() =>
        rows(
          "SELECT record FROM agent_activities WHERE conversation_id=?",
          run.conversation_id,
        ).some((r) => r.record.includes(missedText)),
      )
      .toBe(true);
    const missedIds = rows("SELECT id FROM events WHERE id>?", cursor).map(
      (r) => r.id,
    );
    assert(missedIds.length > 0);
    assert.equal(
      frames.length,
      framesBefore,
      "No frames delivered during outage",
    );
    assert.equal(runFor(`acp-${width}`).state, "awaiting_approval");
    blocked = false;
    await expect(
      page.getByRole("status").filter({ hasText: "Connected to workspace" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        frames
          .slice(framesBefore)
          .flatMap((f) => f.events || [])
          .map((e) => e.id),
      )
      .toEqual(expect.arrayContaining(missedIds));
    const recoveredIds = frames
      .slice(framesBefore)
      .flatMap((f) => f.events || [])
      .map((e) => e.id);
    assert.equal(
      new Set(recoveredIds).size,
      recoveredIds.length,
      "No duplicate replay events",
    );
    const resume = new URL(requests.at(-1));
    assert.equal(resume.searchParams.get("cursor"), String(cursor));
    assert.equal(resume.searchParams.get("epoch"), epoch);
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Plan", exact: true }),
    ).toHaveCount(1);
    await expect(
      page
        .getByRole("region", { name: "Plan", exact: true })
        .getByText(missedText, { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("summary").filter({ hasText: missedText }),
    ).toHaveCount(1);
    await page
      .getByRole("dialog", { name: "Tool activity", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Approve browser fixture",
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(page.getByLabel("Reply to agent")).toHaveValue(
      "Draft survives socket reconnect",
    );
    assert.equal(await page.evaluate(() => window.__documentMarker), marker);
    assert.equal(
      navigations,
      navigationCount,
      "No navigation or reload during recovery",
    );
    assert.equal(binding(run.conversation_id).generation, before.generation);
    assert.equal(binding(run.conversation_id).native_id, before.native_id);
    assert.equal(
      rows(
        "SELECT * FROM native_decisions WHERE conversation_id=?",
        run.conversation_id,
      ).length,
      1,
    );
    const activitiesBefore = rows(
      "SELECT activity_key FROM agent_activities WHERE conversation_id=?",
      run.conversation_id,
    );
    await page.screenshot({
      path: `${evidence}/pending-recovered-${width}.png`,
      fullPage: true,
    });
    // One browser click followed by a transport retry of the exact receipt.
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/native/decisions/${decision.id}`) &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const receipt = response.request().postDataJSON();
    const retry = await page.evaluate(
      async ({ id, receipt }) => {
        const { csrf } = await (await fetch("/session")).json();
        const response = await fetch(`/api/native/decisions/${id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-loop-csrf": csrf,
          },
          body: JSON.stringify(receipt),
        });
        return { status: response.status, body: await response.json() };
      },
      { id: decision.id, receipt },
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.state, "resolved");
    await expect.poll(() => runFor(`acp-${width}`).state).toBe("completed");
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Approve browser fixture",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    await expect(
      page.getByText("1 of 1 complete", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Tool activity", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    // A second connection cycle must not resurrect decisions or append records.
    await cut();
    blocked = false;
    await expect(
      page.getByRole("status").filter({ hasText: "Connected to workspace" }),
    ).toBeVisible();
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    await expect(
      page.getByText("1 of 1 complete", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Plan", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.locator("summary").filter({ hasText: "Recovered work complete" }),
    ).toHaveCount(1);
    await page
      .getByRole("dialog", { name: "Tool activity", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    assert.deepEqual(
      rows(
        "SELECT activity_key FROM agent_activities WHERE conversation_id=?",
        run.conversation_id,
      ),
      activitiesBefore,
    );
    assert.equal(
      rows(
        "SELECT * FROM native_decisions WHERE conversation_id=?",
        run.conversation_id,
      ).length,
      1,
    );
    assert.equal(
      (await auditRows()).filter((r) => r.event === "decision").length,
      results.length + 1,
    );
    assert.equal(
      (await auditRows()).filter((r) => r.event === "prompt").length,
      results.length + 1,
    );
    assert.equal(await page.evaluate(() => window.__documentMarker), marker);
    assert.equal(navigations, navigationCount);
    const recoveryNavigations = navigations - navigationCount;
    assert.deepEqual(
      rows(
        "SELECT id FROM messages WHERE conversation_id=? ORDER BY id",
        run.conversation_id,
      ),
      messageIds,
    );
    assert.equal(
      rows("SELECT id FROM runs WHERE conversation_id=?", run.conversation_id)
        .length,
      1,
    );
    assert.equal(
      rows("SELECT run_id FROM native_dispatch WHERE run_id=?", run.id).length,
      1,
    );
    await page.screenshot({
      path: `${evidence}/completed-${width}.png`,
      fullPage: true,
    });
    await closeConversation();
    // Lose registration after model discovery, before dispatch. The creation UI
    // now blocks an already-missing harness before a user can start any work.
    await createAgent(
      `missing-${width}`,
      "ACP agent",
      "native-acp",
      "missing setup",
      () => db.prepare("DELETE FROM harnesses WHERE name='acp'").run(),
    );
    await expect(
      page.getByRole("dialog").getByRole("status").filter({
        hasText: "Run loop acp on the desktop to enable this harness.",
      }),
    ).toBeVisible();
    await expect.poll(() => runFor(`missing-${width}`)?.state).toBe("failed");
    assert.equal(
      binding(runFor(`missing-${width}`).conversation_id),
      undefined,
    );
    await page.screenshot({
      path: `${evidence}/setup-error-${width}.png`,
      fullPage: true,
    });
    await nativeSessions.enable(acp);
    await closeConversation();
    const savedOptions = db
      .prepare("SELECT options FROM harnesses WHERE name='acp'")
      .get().options;
    await createAgent(
      `broken-${width}`,
      "ACP agent",
      "native-acp",
      "broken executable",
      () =>
        db.prepare("UPDATE harnesses SET options=? WHERE name='acp'").run(
          JSON.stringify({
            ...JSON.parse(savedOptions),
            executable: join(dir, "missing-acp-executable"),
          }),
        ),
    );
    await expect.poll(() => runFor(`broken-${width}`)?.state).toBe("failed");
    const setupError = runFor(`broken-${width}`).error;
    assert.match(setupError, /ENOENT|not found|executable/i);
    await expect(
      page
        .getByRole("dialog")
        .getByRole("status")
        .filter({ hasText: setupError }),
    ).toBeVisible();
    await page.screenshot({
      path: `${evidence}/executable-error-${width}.png`,
      fullPage: true,
    });
    db.prepare("UPDATE harnesses SET options=? WHERE name='acp'").run(
      savedOptions,
    );
    assert.deepEqual(errors, []);
    results.push({
      width,
      height: 844,
      directBinding: original.harness,
      acpBinding: before.harness,
      missedEvents: missedIds.length,
      missedIds,
      recoveredIds,
      resumeCursor: Number(resume.searchParams.get("cursor")),
      cursor,
      documentNavigationsDuringRecovery: recoveryNavigations,
      messages: messageIds.length,
      dispatches: 1,
      noReload: true,
      activityRecords: activitiesBefore.length,
      adapterPrompts: 1,
      adapterDecisions: 1,
      receiptRetryStatus: retry.status,
      setupErrors: ["missing registration", "missing executable"],
    });
    await context.close();
    console.log(
      `PASS ${width}x844: UI direct/ACP selection, stable bindings, setup error, mid-approval WS replay without reload, draft, one decision/receipt and no duplicate activity records`,
    );
  }
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      { browser: browser.version(), base: "0d460bb", results },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => ""),
  );
  await page
    ?.screenshot({ path: `${evidence}/failure.png`, fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  blocked = false;
  await browser?.close();
  await host.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
}
