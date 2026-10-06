// Production routers and SQLite, with a deterministic in-process native adapter.
// No route interception or canned conversation/activity/settings/catalog responses.
import { createServer } from "vite";
import express from "express";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-ui-db-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "companion";
const { db, now } = await import("../src/server/db.ts");
const { core } = await import("../src/server/core-routes.ts");
const { companion } = await import("../src/server/companion-routes.ts");
const { activityRoutes } = await import("../src/server/activities.ts");
const { nativeSessions, OWNER } =
  await import("../src/server/native-sessions.ts");
const { capabilities } = await import("../src/server/profile.ts");
const { DirectControls } = await import("../src/adapters/direct-controls.ts");
const { recordTrace } = await import("../src/server/traces.ts");
const { enqueue } = await import("../src/server/queue.ts");
const conversation = randomUUID(),
  agent = randomUUID(),
  connection = randomUUID();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,'codex','Fixture','','connected',?,?)",
).run(connection, OWNER, JSON.stringify({ loopHarness: "codex" }), now());
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,'Fixture','fixture','codex',?,'a',?)",
).run(agent, OWNER, connection, now());
db.prepare(
  "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Integrated activities','native',?)",
).run(conversation, OWNER, agent, now());
const run = enqueue(OWNER, "Inspect fixture", randomUUID(), {
  agent,
  conversation,
});
db.prepare(
  "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Working fixture',?)",
).run(randomUUID(), OWNER, conversation, run.id, now());
db.prepare(
  "INSERT INTO companion_sessions(conversation_id,harness,project,generation,state,updated_at) VALUES(?,'codex',?,'g','idle',?)",
).run(conversation, dir, now());
db.prepare("INSERT INTO harnesses VALUES('codex',?,'{}','{}','[]',?)").run(
  JSON.stringify({
    harness: "codex",
    project: dir,
    billing: "existing",
    executable: "fixture",
    version: "fixture",
  }),
  now(),
);
for (const body of [
  { type: "ready" },
  { type: "loop-turn", status: "completed", output: "Working fixture" },
]) {
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'tool',?,?)",
  ).run(randomUUID(), OWNER, conversation, JSON.stringify(body), now());
}
const attack = '<img src=x onerror="globalThis.pwned=true">';
const source = { transport: "native", harness: "codex", origin: "fixture" };
function activity(kind, id, patch) {
  nativeSessions.event(live, {
    type: "activity",
    activity: {
      v: 1,
      source,
      kind,
      id,
      generation: "untrusted-adapter-generation",
      patch,
    },
  });
}
let model = "a",
  reject = false,
  writes = 0,
  controls;
const options = () => [
  {
    id: "label",
    label: "Session label",
    type: "text",
    confirmed: "Original",
    mutable: true,
    application: "live",
  },
  {
    id: "model",
    label: "Session model",
    type: "select",
    choices: [
      { value: "a", label: "Model A" },
      { value: "b", label: "Model B" },
    ],
    confirmed: model,
    mutable: true,
    application: "live",
  },
  ...(model === "a"
    ? [
        {
          id: "effort",
          label: "Dependent effort",
          type: "select",
          choices: [{ value: "high", label: "High" }],
          confirmed: "high",
          mutable: true,
          application: "next-turn",
        },
      ]
    : []),
];
const adapter = {
  commands: [],
  get settings() {
    // ACP uses null to clear requested values after a rejected write.
    return {
      ...controls.settings,
      options: controls.settings.options.map((option) =>
        option.rejected ? { ...option, requested: null } : option,
      ),
    };
  },
  get commandCatalog() {
    return controls.commands;
  },
  get activityCapabilities() {
    return controls.capabilities;
  },
  async setSetting(id, value, revision) {
    writes++;
    return controls.change(id, value, revision, async () => {
      await new Promise((r) => setTimeout(r, 250));
      if (reject) throw new Error("Fixture runtime rejected model");
      model = value;
      return options();
    });
  },
};
const live = {
  adapter,
  generation: "g",
  binding: { conversation_id: conversation, harness: "codex" },
  bootstrapRun: run,
  requests: new Map(),
  bridgeWaiting: 0,
  ready: Promise.resolve(),
  closed: false,
};
nativeSessions.live.set(conversation, live);
function reset() {
  live.generation = "g";
  db.prepare(
    "UPDATE companion_sessions SET generation='g' WHERE conversation_id=?",
  ).run(conversation);
  db.prepare("DELETE FROM agent_activities").run();
  db.prepare("DELETE FROM run_traces").run();
  recordTrace(run, "tool:broker", {
    kind: "tool",
    title: "Broker fixture",
    content: "Waiting",
    metadata: { state: "waiting" },
  });
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  db.prepare("DELETE FROM native_decisions").run();
  live.run = run;
  live.requests.clear();
  nativeSessions.event(live, {
    type: "request",
    request: {
      id: "permission",
      kind: "approval",
      title: "Approve fixture command",
      detail: "echo safe",
      choices: ["allow", "deny"],
    },
  });
  model = "a";
  reject = false;
  writes = 0;
  controls = new DirectControls("codex", (event) =>
    nativeSessions.event(live, event),
  );
  adapter.commands = [
    {
      name: "inspect",
      token: "/inspect",
      kind: "command",
      description: "Inspect fixture",
    },
  ];
  // Synthetic trusted harness bindings stress pagination through capability ingress.
  for (let i = 0; i < 501; i++) {
    live.binding.harness = `pagination-${i}`;
    nativeSessions.event(live, {
      type: "activity_capabilities",
      capabilities: controls.capabilities,
    });
  }
  live.binding.harness = "codex";
  controls.publish(options(), adapter.commands);
  activity("plan", "p", {
    steps: [{ id: "one", title: "Inspect " + attack, status: "in_progress" }],
  });
  activity("file_change", "f", {
    state: "proposed",
    files: [
      {
        path: "../../" + attack,
        operation: "rename",
        oldPath: "old.ts",
        patch: "-old\n+new " + attack,
      },
    ],
  });
  activity("output", "o", {
    replace: [
      {
        stream: "combined",
        text:
          Array.from({ length: 5000 }, (_, i) => `${i} output\n`).join("") +
          attack,
      },
    ],
    status: "running",
  });
}
let settingsFailure = false;
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.locals.owner = OWNER;
  next();
});
app.get("/session", (_req, res) => res.json({ csrf: "fixture" }));
app.get("/api/capabilities", (_req, res) => res.json(capabilities));
app.use((req, _res, next) => {
  if (settingsFailure && req.method === "GET" && req.path.endsWith("/settings"))
    return next(new Error("Fixture session connection failed"));
  next();
});
app.use("/api", activityRoutes, companion, core);
// Test driver mutates real persisted state, never substitutes API responses.
app.post("/api/fixture", (req, res) => {
  if (req.body.reject !== undefined) reject = req.body.reject;
  if (req.body.removed) {
    adapter.commands = [];
    controls.publish(options(), []);
  }
  if (req.body.complete) {
    activity("tool", "broker", {
      title: "Broker fixture",
      status: "completed",
      links: { broker: "broker", trace: "tool:broker" },
    });
    activity("plan", "p", {
      steps: [{ id: "one", title: "Inspect " + attack, status: "completed" }],
    });
    activity("output", "o", {
      replace: [{ stream: "combined", text: "final " + attack }],
      status: "exited",
      exitCode: 0,
    });
    live.run = undefined;
    db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(run.id);
    db.prepare("UPDATE native_decisions SET state='answered'").run();
  }
  res.json({ ok: true });
});
app.use((error, _req, res, _next) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "real-activity-routes",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url.startsWith("/activity-integration")) {
            res.setHeader("content-type", "text/html");
            res.end(readFileSync("test/fixtures/activity-ui/index.html"));
            return;
          }
          if (req.url.startsWith("/api/") || req.url === "/session")
            return app(req, res, next);
          next();
        });
      },
    },
  ],
});
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  });
  mkdirSync(".tmp", { recursive: true });
  for (const width of [390, 1280]) {
    reset();
    let page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("BROWSER ERROR", e.message);
    });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    await page.goto(
      `${base}/activity-integration?conversation=${conversation}&agent=${agent}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(
      page.getByText("Working fixture", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".messages .activity-panel")).toHaveCount(0);
    await expect(page.locator(".messages")).not.toContainText('"type":"ready"');
    await expect(page.locator(".messages")).not.toContainText(
      '"type":"loop-turn"',
    );
    await expect(page.locator(".messages")).not.toContainText(
      "Recorded commands",
    );
    await expect(page.locator(".messages")).not.toContainText(
      "Recorded session settings",
    );
    await expect(page.getByText(/of 1 complete/)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /Command output/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Approve fixture command", { exact: true }),
    ).toBeVisible();
    assert.equal(
      db.prepare("SELECT state FROM runs WHERE id=?").get(run.id).state,
      "awaiting_approval",
    );
    const ingressRecords = db
      .prepare("SELECT record FROM agent_activities")
      .all()
      .map((r) => JSON.parse(r.record));
    assert(ingressRecords.length > 500);
    assert(ingressRecords.every((r) => r.generation === "g"));
    const signals = db
      .prepare("SELECT payload FROM events WHERE type='activity.updated'")
      .all();
    assert(signals.length > 500);
    assert(
      signals.every(
        (r) =>
          Object.keys(JSON.parse(r.payload)).sort().join() ===
          "key,kind,sequence",
      ),
    );
    await page.reload();
    await expect(
      page.getByText("Approve fixture command", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Command output/ }),
    ).toHaveCount(0);
    assert.equal(await page.locator("img[src=x]").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    // The transcript contains output messages; raw tool details stay in Traces.
    await expect(page.locator(".messages")).not.toContainText("Broker fixture");
    const tracePage = await browser.newPage({
      viewport: { width, height: 844 },
    });
    await tracePage.goto(`${base}/activity-integration?traces&agent=${agent}`);
    await expect(
      tracePage
        .getByLabel("Agent traces")
        .getByText("Broker fixture", { exact: true }),
    ).toBeVisible();
    await tracePage.close();
    // Command output stays inspectable outside the transcript.
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    const toolSheet = page.getByRole("dialog", {
      name: "Tool activity",
      exact: true,
    });
    const output = toolSheet.getByLabel("Scrollable command output");
    await expect(output).toBeVisible();
    await output.evaluate((e) => {
      e.scrollTop = 0;
      e.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await toolSheet
      .getByRole("button", { name: "Follow latest output" })
      .click();
    await toolSheet.getByRole("button", { name: "Close", exact: true }).click();
    const activeRejection = await page.request.patch(
      `${base}/api/conversations/${conversation}/settings/model`,
      {
        data: {
          value: "b",
          revision: controls.settings.revision,
          generation: live.generation,
        },
      },
    );
    assert.equal(activeRejection.status(), 409);
    assert.equal(writes, 0);
    // A server-side rejection does not advance the adapter's settings revision.
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await page.getByLabel("Session label").fill("Unconfirmed");
    await page.getByLabel("Session label").press("Tab");
    await expect(
      page.getByRole("alert").filter({ hasText: "Wait for the native turn" }),
    ).toBeVisible();
    await expect(page.getByLabel("Session label")).toHaveValue("Original");
    assert.equal(writes, 0);
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Conversation", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.request.post(base + "/api/fixture", {
      data: { complete: true },
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await expect(page.getByLabel("Session model")).toHaveValue("a");
    await page.getByLabel("Session model").selectOption("b");
    await expect(page.getByText(/Requested: b/)).toBeVisible();
    await expect(page.getByText("Confirmed: a", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Session model")).toHaveValue("b");
    await expect(page.getByLabel("Dependent effort")).toHaveCount(0);
    await page.request.post(base + "/api/fixture", { data: { reject: true } });
    await page.getByLabel("Session model").selectOption("a");
    await expect(
      page.getByText("Fixture runtime rejected model", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Session model")).toHaveValue("b");
    await expect(
      page.getByText(/Requested:.*awaiting confirmation/),
    ).toHaveCount(0);
    assert.equal(writes, 2);
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Conversation", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Commands & skills", exact: true })
      .click();
    await expect(page.getByRole("button", { name: /\/inspect/ })).toBeVisible();
    await page.request.post(base + "/api/fixture", { data: { removed: true } });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect(page.getByRole("button", { name: /\/inspect/ })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect(page.locator(".messages .activity-panel")).toHaveCount(0);
    await expect(
      page.locator("summary").filter({ hasText: "Broker fixture" }),
    ).toHaveCount(0);
    await expect(page.getByText("Exit code: 0")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".messages .activity-panel")).toHaveCount(0);
    await expect(
      page.locator("summary").filter({ hasText: "Broker fixture" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `.tmp/activity-database-${width}.png`,
      fullPage: true,
    });
    await page.goto(
      `${base}/activity-integration?history&conversation=${conversation}&agent=${agent}`,
    );
    await page.getByRole("button", { name: /Integrated activities/ }).click();
    await expect(page.locator(".messages .activity-panel")).toHaveCount(0);
    await expect(page.locator(".messages")).not.toContainText("Broker fixture");
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("menuitem", { name: "Tool activity", exact: true })
      .click();
    const historySheet = page.getByRole("dialog", {
      name: "Tool activity",
      exact: true,
    });
    await expect(
      historySheet.locator("summary").filter({ hasText: "Broker fixture" }),
    ).toHaveCount(1);
    await expect(historySheet.getByText("Exit code: 0")).toBeVisible();
    await expect(historySheet.getByText("1 of 1 complete")).toBeVisible();
    await historySheet
      .getByRole("button", { name: "Close", exact: true })
      .click();
    nativeSessions.live.delete(conversation);
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await expect(page.getByLabel("Session model")).toHaveValue("b");
    await expect(page.getByLabel("Session model")).toBeDisabled();
    // A connection failure retains only the recorded, disabled controls.
    settingsFailure = true;
    await page
      .getByRole("button", { name: "Refresh session", exact: true })
      .click();
    await expect(page.getByLabel("Session model")).toBeDisabled();
    settingsFailure = false;
    // Replacement process revisions restart. An old browser generation must not write.
    nativeSessions.live.set(conversation, live);
    live.generation = "replacement";
    db.prepare(
      "UPDATE companion_sessions SET generation=? WHERE conversation_id=?",
    ).run(live.generation, conversation);
    model = "a";
    reject = false;
    controls = new DirectControls("codex", (event) =>
      nativeSessions.event(live, event),
    );
    controls.publish(options(), []);
    const beforeWrites = writes;
    const staleWrite = await page.request.patch(
      `${base}/api/conversations/${conversation}/settings/model`,
      {
        data: { value: "b", revision: 1, generation: "g" },
      },
    );
    assert.equal(staleWrite.status(), 409);
    assert.equal(writes, beforeWrites);
    await page
      .getByRole("button", { name: "Refresh session", exact: true })
      .click();
    await expect(page.getByLabel("Session model")).toHaveValue("a");
    await expect(page.getByLabel("Session model")).toBeEnabled();
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await expect(page.getByLabel("Session model")).toHaveValue("a");
    // Release the navigation-heavy context before checking initial setup errors.
    await page.close();
    page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    // A never-started session surfaces its production 404; a connection failure is explicit.
    const emptyConversation = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Not started','native',?)",
    ).run(emptyConversation, OWNER, agent, now());
    await page.goto(
      `${base}/activity-integration?conversation=${emptyConversation}&agent=${agent}`,
    );
    await page
      .getByLabel("Conversation options")
      .click()
      .catch(async (error) => {
        console.error(await page.locator("body").innerText());
        throw error;
      });
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Native session has not started" }),
    ).toBeVisible();
    settingsFailure = true;
    await page
      .getByRole("button", { name: "Refresh session", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Fixture session connection failed" }),
    ).toBeVisible();
    await expect(page.getByLabel("Session model")).toHaveCount(0);
    settingsFailure = false;
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PASS NativeSessions.event + SQLite + production routers + Conversation/NativeHistory at 390/1280: live, reload, pending decisions, settings requested/confirmed/rejection/dependent removal, catalog removal, managed history, hostile text, scrolling, generation replacement/stale writes, unstarted session and connection errors. Deterministic adapter; no paid calls or full auth-stack gate.",
  );
} finally {
  nativeSessions.live.delete(conversation);
  await browser?.close();
  await vite.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
