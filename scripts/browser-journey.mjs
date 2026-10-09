import {
  closeSheets,
  inboxRowAction,
  isolatedBrowserEnv,
  openSettings,
  openTab,
} from "./helpers/browser-ui.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { tracesJourney } from "./traces-journey.mjs";
import { failureJourney } from "./harness-journey.mjs";
import { projectsAttentionJourney } from "./projects-attention-journey.mjs";
import {
  approvalJourney,
  chatDismissJourney,
  semanticStatusJourney,
} from "./approval-journey.mjs";
import { createServer as reservePort } from "node:net";
async function freePort() {
  const server = reservePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const port = await freePort(),
  brokerPort = await freePort(),
  base = "http://localhost:" + port;
import { spawn } from "node:child_process";
import { feedbackJourney } from "./feedback-journey.mjs";
import { catalogJourney } from "./catalog-journey.mjs";
import { providerJourney } from "./provider-journey.mjs";
import { remoteCodexJourney } from "./remote-codex-journey.mjs";
import { remoteClaudeJourney } from "./remote-claude-journey.mjs";
import { agentCreationJourney } from "./agent-creation-journey.mjs";
import {
  composerJourney,
  scheduledSendJourney,
  sendCollapseJourney,
} from "./composer-journey.mjs";
import { codexFixture } from "../test/helpers/codex-server.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit, expect } from "@playwright/test";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "loop-journey-"));
const remoteCodex = await codexFixture();
const env = {
    ...(await isolatedBrowserEnv()),
    NODE_ENV: "test",
    LOOP_AUTH_MODE: "multi-user",
    LOOP_RUNTIME_URL: "http://127.0.0.1:" + brokerPort,
    LOOP_FIXTURE_BROKER_PORT: String(brokerPort),
    LOOP_ALLOWED_RUNTIME_ORIGINS: `${remoteCodex.url},http://127.0.0.1:${brokerPort}`,
    PORT: String(port),
    LOOP_URL: base,
    LOOP_RUNTIME_TOKEN: "fixture-broker-authentication-only-32chars",
    LOOP_DATA_DIR: dir,
  },
  children = ["server", "worker"].map((name) =>
    spawn(process.execPath, ["--import", "tsx", `scripts/fixture-${name}.ts`], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
children.push(
  spawn(process.execPath, ["test/helpers/subscription-broker.mjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
let logs = "";
children.forEach((c) => c.stderr.on("data", (b) => (logs += b)));
let browser, page;
const errors = [];
const recordPageError = (error) => {
  if (!isWebKitNavigationFetchError(process.env.LOOP_BROWSER, error, base))
    errors.push(error.message);
};
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser =
    process.env.LOOP_BROWSER === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({
          executablePath: process.env.CHROMIUM_PATH || undefined,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
          headless: true,
        });
  const workspaceContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  page = await workspaceContext.newPage();
  page.on("pageerror", recordPageError);
  await page.goto(base);
  await page.getByText("New here? Create an account").click();
  await page.getByLabel("Your name").fill("Fixture journey");
  await page
    .getByLabel("Email", { exact: true })
    .fill("journey-" + crypto.randomUUID() + "@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill(crypto.randomUUID() + "Ab1!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("heading", { name: "Feed", exact: true }).waitFor();
  await openSettings(page);
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await page.getByRole("heading", { name: "Choose a provider" }).waitFor();
  await page.getByRole("button", { name: "ChatGPT", exact: true }).click();
  await page.getByRole("radio", { name: "API key", exact: true }).check();
  await page.locator(".connection-options summary").click();
  await page
    .getByLabel("Account name", { exact: true })
    .fill("Deterministic fixture account");
  await page
    .getByLabel("OpenAI API key", { exact: true })
    .fill("test-only-do-not-use");
  await page
    .getByRole("button", { name: "Connect ChatGPT", exact: true })
    .click();
  await page.getByRole("heading", { name: "ChatGPT connected" }).waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await closeSheets(page);
  await page
    .getByRole("button", { name: "Create your first agent", exact: true })
    .click();
  const agentName = page.getByLabel("Unique name");
  // Wait for the asynchronous suggestion before replacing it: it can otherwise
  // race with fill's separate selection and insertion browser protocol steps.
  await expect(agentName).toHaveAttribute("placeholder", "Choose a name");
  await agentName.fill("journey-agent");
  await expect(agentName).toHaveValue("journey-agent");
  await page
    .getByRole("combobox", { name: /^Model/ })
    .selectOption("openai-fixture");
  const agentCreated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  const createdResponse = await agentCreated;
  assert.equal(createdResponse.status(), 201);
  assert.equal((await createdResponse.json()).name, "journey-agent");
  await page.locator("dialog[open]").last().waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Compose a message" }).click();
  await page.getByLabel("Message your agent").fill("Explain bids precisely");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compose a message" }),
  ).toBeVisible();
  await expect(page.locator("dialog[open]").last()).toHaveCount(0);
  // A send from outside a thread still confirms on the Feed.
  await expect(page.locator(".send-confirmation")).toBeVisible();
  // Result cards live on the agent's profile, not the Feed.
  const openAgentResults = async () => {
    await page
      .locator(".agent-strip button")
      .filter({ hasText: "@journey-agent" })
      .click();
    await page
      .getByRole("heading", { name: "@journey-agent", exact: true })
      .waitFor();
    await page.getByRole("tab", { name: "Results", exact: true }).click();
  };
  await openAgentResults();
  const resultCard = page.locator(".feed-card").filter({
    has: page.getByRole("heading", {
      name: "Explain bids precisely",
      exact: true,
    }),
  });
  const resultReply = resultCard.getByRole("button", {
    name: "Reply",
    exact: true,
  });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    // A short list must scroll far enough for Reply to clear the fixed
    // composer. Replying now opens the result's thread at that message and
    // keeps the quoted context in the thread composer.
    await resultReply.click();
    const thread = page.locator("dialog.swipe-sheet");
    await expect(thread.getByLabel("Reply to agent")).toBeVisible();
    await expect(thread.getByLabel("Reply to agent")).toBeFocused();
    const chip = page.locator(".composer-reply-chip");
    await expect(chip).toContainText(/^Replying to @/);
    await chip.locator("summary").click();
    await expect(
      page.getByRole("region", { name: "Original message" }),
    ).toContainText("Fixture response:");
    await page.getByRole("button", { name: "Clear reply context" }).click();
    await expect(chip).toHaveCount(0);
    await closeSheets(page);
  }
  await page
    .getByRole("heading", { name: "Explain bids precisely", exact: true })
    .waitFor();
  const api = async (path, body, method) =>
    page.evaluate(
      async ({ path, body, method }) => {
        const r = await fetch("/api" + path, {
          method: method || (body ? "POST" : "GET"),
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(data));
        return data;
      },
      { path, body, method },
    );
  const folder = await api("/folders", {
    name: "Research Radar",
    kind: "project",
  });
  const child = await api("/folders", {
    name: "Workflows",
    kind: "folder",
    parentId: folder.id,
  });
  // Back after a while: the away summary opens the one thread that finished,
  // then leaves.
  await page.goto(base);
  await page.evaluate(() =>
    sessionStorage.setItem("loop-test-away-on-reload", "1"),
  );
  // pagehide records the current visit during reload. Set the older visit
  // before the app mounts on the next page instead of letting pagehide erase it.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("loop-test-away-on-reload") === "1") {
      sessionStorage.removeItem("loop-test-away-on-reload");
      localStorage.setItem("loop-last-visit", String(Date.now() - 2 * 3600_000));
    }
  });
  await page.reload();
  const away = page.getByRole("region", { name: "While you were away" });
  await expect(away).toContainText("1 finished");
  await away
    .getByRole("button", { name: /Open “Explain bids precisely”/ })
    .click();
  await expect(
    page.locator("dialog.swipe-sheet").getByLabel("Reply to agent"),
  ).toBeVisible();
  await expect(away).toHaveCount(0);
  await closeSheets(page);
  await page.reload();
  await openAgentResults();
  await page
    .getByRole("heading", { name: "Explain bids precisely", exact: true })
    .waitFor();
  await page
    .locator(".feed-card")
    .filter({ hasText: "Explain bids precisely" })
    .getByRole("button", { name: "File", exact: true })
    .click();
  await page
    .getByPlaceholder("Put this in Research Radar / Workflows")
    .fill("Put this workflow in Research Radar / Workflows");
  await page.getByRole("button", { name: "File it", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await closeSheets(page);
  const feed = await api("/feed"),
    artifact = feed.items.find((x) => x.title === "Explain bids precisely");
  await api("/artifacts/" + artifact.id + "/move", { folderId: child.id });
  const search = await api("/search?q=resting&folder=" + child.id);
  assert.ok(search.items.some((x) => x.id === "artifact:" + artifact.id));
  await page.goto(base + "/?artifact=" + artifact.id);
  await page.getByLabel("Result options", { exact: true }).click();
  await page.getByRole("button", { name: "Source conversation" }).click();
  await page
    .getByRole("dialog")
    .getByText("Fixture response:", { exact: false })
    .waitFor();
  await closeSheets(page);
  await openSettings(page);
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByRole("button", { name: "Add server URL" }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Deterministic MCP fixture");
  await page.getByLabel("Server address").fill("https://fixture.example/mcp");
  await page.getByLabel("Authentication").selectOption("none");
  await page.getByRole("button", { name: "Connect & test" }).click();
  await page
    .getByText("Connected. Available to all agents in your workspace.")
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save permissions" }).count(),
    0,
  );
  // Server details and permissions live behind the connection's Manage row.
  await page.getByText("Manage Deterministic MCP fixture").click();
  await page.getByText("Available to all agents · Ask every time").waitFor();
  await page.screenshot({
    path: join(tmpdir(), "loop-workspace-mcp.png"),
    fullPage: true,
  });
  await closeSheets(page);
  await page.getByRole("button", { name: "Compose a message" }).click();
  await page.getByLabel("Message your agent").fill("Show latency");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compose a message" }),
  ).toBeVisible();
  await expect(page.locator("dialog[open]").last()).toHaveCount(0);
  // The Running tab became the Feed "Needs you" filter, which lists approvals.
  await page.getByRole("tab", { name: /^Needs you/ }).click();
  // Fault-injected requests must reach Playwright rather than a service worker.
  // The main journey keeps its real service worker throughout.
  const reviewContext = await browser.newContext({
    storageState: await page.context().storageState(),
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const reviewPage = await reviewContext.newPage();
  reviewPage.on("pageerror", recordPageError);
  try {
    await reviewPage.goto(base);
    await reviewPage.getByRole("tab", { name: /^Needs you/ }).click();
    await approvalJourney(reviewPage, api);
    await chatDismissJourney(reviewPage, api);
    await semanticStatusJourney(reviewPage);
  } catch (error) {
    console.error("REVIEW PAGE", await reviewPage.locator("body").innerText());
    throw error;
  } finally {
    await reviewContext.close();
  }
  await openTab(page, "Feed");
  await page
    .locator(".agent-strip button")
    .filter({ hasText: "@journey-agent" })
    .click();
  await page.getByRole("tab", { name: "Traces", exact: true }).click();
  await page
    .locator(".trace-card")
    .filter({ hasText: "metrics" })
    .getByRole("button", { name: "View tool result" })
    .click();
  const result = page.getByRole("dialog").last();
  await expect(
    result.getByRole("heading", { name: "Fixture request latency" }),
  ).toBeVisible();
  await expect(
    result.getByRole("img", { name: /Fixture latency, ms, 2 measured points/ }),
  ).toBeVisible();
  await expect(
    result.locator('iframe[title="MCP app, isolated from Loop"]'),
  ).toHaveCount(0);
  const chartResult = (await api("/artifacts")).items.find(
    (x) => x.kind === "chart",
  );
  assert.ok(chartResult);
  assert.equal(JSON.parse(chartResult.metadata).appResource, undefined);
  await closeSheets(page);
  const conns = await api("/mcp");
  await api("/mcp/" + conns[0].id, { action: "disable" }, "PATCH");
  const chart = (await api("/artifacts")).items.find((x) => x.kind === "chart");
  assert.ok(chart);
  const denied = await page.evaluate(async (id) => {
    const r = await fetch("/api/artifacts/" + id + "/tool-call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "metrics",
        arguments: { query: "disabled" },
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    return r.status;
  }, chart.id);
  assert.equal(denied, 409);
  const detached = await api("/runs", {
    agentId: artifact.agent_id,
    input: "disconnect-check",
    idempotencyKey: crypto.randomUUID(),
  });
  const context = page.context();
  for (let i = 0; i < 50; i++) {
    const records = await (
      await context.request.get(base + "/api/runs")
    ).json();
    if (records.find((r) => r.id === detached.id)?.state === "running") break;
    await new Promise((r) => setTimeout(r, 80));
  }
  await page.close();
  let detachedDone = false;
  for (let i = 0; i < 50; i++) {
    const records = await (
      await context.request.get(base + "/api/runs")
    ).json();
    if (records.find((r) => r.id === detached.id)?.state === "completed") {
      detachedDone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(detachedDone, "worker completes with client closed");
  page = await context.newPage();
  page.on("pageerror", recordPageError);
  await page.goto(base + "/?conversation=" + detached.conversation_id);
  await page
    .getByRole("dialog")
    .getByText("Fixture response:", { exact: false })
    .waitFor();
  const recovered = await api("/conversations/" + detached.conversation_id);
  assert.equal(recovered.messages.length, 2);
  const events = await api("/events");
  const ids = events.filter((e) => e.run_id === detached.id).map((e) => e.id);
  assert.deepEqual(
    ids,
    [...new Set(ids)].sort((a, b) => a - b),
  );
  await closeSheets(page);
  // Subscription-first UI, native auth handoff shapes and actual durable worker/tool broker.
  const subs = [];
  for (const runtime of ["codex", "claude"]) {
    await openSettings(page);
    await page.getByRole("button", { name: /Provider connections/ }).click();
    const providerName = runtime === "codex" ? "ChatGPT" : "Claude";
    await page
      .getByRole("button", { name: "Add a provider", exact: true })
      .click();
    await page.getByRole("button", { name: providerName, exact: true }).click();
    assert.equal(
      await page.getByLabel(/^(OpenAI|Anthropic) API key$/).count(),
      0,
    );
    await page.locator(".connection-options summary").click();
    await page
      .getByLabel("Account name", { exact: true })
      .fill(runtime + " subscription fixture");
    await page
      .getByRole("button", {
        name: "Continue with " + providerName,
        exact: true,
      })
      .click();
    await page
      .getByRole("heading", { name: "Sign in to " + providerName, exact: true })
      .waitFor();
    const link = page.getByRole("link", {
      name: "Open " + providerName + " sign-in",
    });
    await link.waitFor();
    assert.match(
      await link.getAttribute("href"),
      runtime === "codex"
        ? /^https:\/\/auth\.openai\.com\//
        : /^https:\/\/claude\.com\/cai\/oauth\/authorize/,
    );
    if (runtime === "claude") {
      await page.getByLabel("One-time sign-in code").fill("fixture-code");
      await page
        .getByRole("button", { name: "Complete sign-in", exact: true })
        .click();
    }
    await page
      .getByRole("heading", { name: providerName + " connected", exact: true })
      .waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await closeSheets(page);
    const bootstrap = await api("/bootstrap");
    const conn = bootstrap.connections.find(
      (c) => c.label === runtime + " subscription fixture",
    );
    subs.push(conn);
    assert.equal(conn.status, "connected");
    assert.equal(conn.secret, undefined);
    const agent = await api("/agents", {
      name: runtime + "-subscription",
      connectionId: conn.id,
      model: "subscription-fixture",
    });
    if (runtime === "codex") {
      await api("/mcp/" + conns[0].id, { action: "enable" }, "PATCH");
    }
    const run = await api("/runs", {
      agentId: agent.id,
      input: "Use subscription allowance",
      idempotencyKey: crypto.randomUUID(),
    });
    let final;
    for (let i = 0; i < 60; i++) {
      final = (await api("/runs")).find((r) => r.id === run.id);
      if (final.state === "awaiting_approval") {
        const approval = (await api("/approvals")).find(
          (a) => a.run_id === run.id,
        );
        assert.ok(approval, "subscription tool requires explicit approval");
        await api("/approvals/" + approval.id, { decision: "approve" });
      }
      if (["completed", "failed"].includes(final.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(final.state, "completed");
    assert.match(
      (await api("/conversations/" + run.conversation_id)).messages.at(-1)
        .content,
      /Subscription fixture response/,
    );
  }
  const stranger = await browser.newContext();
  const other = await stranger.request.post(base + "/api/auth/sign-up/email", {
    headers: { origin: base },
    data: {
      name: "Other fixture user",
      email: "other-" + crypto.randomUUID() + "@example.com",
      password: crypto.randomUUID() + "Ab1!",
    },
  });
  assert.ok(other.ok());
  for (const path of [
    "/artifacts/" + artifact.id,
    "/artifacts/" + chart.id + "/app",
    "/conversations/" + artifact.conversation_id,
    "/agents/" + artifact.agent_id,
    "/agents/" + artifact.agent_id + "/tools",
  ])
    assert.equal(
      (await stranger.request.get(base + "/api" + path)).status(),
      404,
    );
  const otherSearch = await (
    await stranger.request.get(base + "/api/search?q=resting")
  ).json();
  assert.equal(otherSearch.items.length, 0);
  for (const conn of subs) {
    assert.equal(
      (
        await stranger.request.post(
          base + "/api/subscriptions/" + conn.id + "/status",
          { headers: { origin: base }, data: {} },
        )
      ).status(),
      404,
    );
  }
  await api("/connections/" + subs[0].id, {}, "DELETE");
  assert.equal(
    (await api("/subscriptions/" + subs[0].id + "/status", {})).authenticated,
    false,
  );
  await stranger.close();
  // Run network-failure injection in its own context without a service worker.
  // Keep real service workers in the main journey.
  const providerContext = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  let providerPage;
  const providerRequests = [];
  try {
    providerPage = await providerContext.newPage();
    providerPage.on("request", (request) => {
      if (request.url().includes("/subscriptions/"))
        providerRequests.push(["request", new URL(request.url()).pathname]);
    });
    providerPage.on("response", (response) => {
      if (response.url().includes("/subscriptions/"))
        providerRequests.push([
          "response",
          response.status(),
          new URL(response.url()).pathname,
        ]);
    });
    providerPage.on("pageerror", recordPageError);
    await providerPage.goto(base);
    await providerPage
      .getByRole("heading", { name: "Feed", exact: true })
      .waitFor();
    const providerApi = async (path, body, method) =>
      providerPage.evaluate(
        async ({ path, body, method }) => {
          const response = await fetch("/api" + path, {
            method: method || (body ? "POST" : "GET"),
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
          });
          const data = await response.json();
          if (!response.ok) throw new Error(JSON.stringify(data));
          return data;
        },
        { path, body, method },
      );
    await providerJourney(providerPage, providerApi);
    await remoteCodexJourney(providerPage, providerApi, remoteCodex);
    await remoteClaudeJourney(
      providerPage,
      providerApi,
      `http://127.0.0.1:${brokerPort}/native`,
    );
    await agentCreationJourney(providerPage, providerApi);
    await failureJourney(providerPage, providerApi, dir);
    await composerJourney(providerPage, providerApi);
    await sendCollapseJourney(providerPage, providerApi, dir);
    await scheduledSendJourney(providerPage, providerApi, dir);
  } catch (error) {
    console.log("PROVIDER REQUESTS", providerRequests.slice(-25));
    console.log(
      "PROVIDER PAGE",
      await providerPage
        ?.locator("body")
        .innerText()
        .catch(() => "(closed)"),
    );
    throw error;
  } finally {
    await providerContext.close();
  }
  await feedbackJourney(page, api, base, dir);
  await catalogJourney(page, api, base);
  // WebKit can route API calls through the service worker past page.route.
  // Isolate error injection; the main journey retains its real service worker.
  const feedbackContext = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  let feedbackPage;
  try {
    feedbackPage = await feedbackContext.newPage();
    feedbackPage.on("pageerror", recordPageError);
    await projectsAttentionJourney(feedbackPage, api, base, dir);
    await tracesJourney(feedbackPage, api, base, dir);
  } catch (error) {
    console.log("FEEDBACK PAGE URL", feedbackPage?.url());
    console.log(
      "FEEDBACK PAGE",
      await feedbackPage
        ?.locator("body")
        .innerText()
        .catch(() => "(closed)"),
    );
    throw error;
  } finally {
    await feedbackContext.close();
  }
  await page.getByRole("button", { name: "Compose a message" }).click();
  await page
    .getByLabel("Message your agent")
    .fill("Sign out must clear this draft");
  await openSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "Pick up where you left off." })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      Object.values(sessionStorage).some((value) =>
        value.includes("Sign out must clear this draft"),
      ),
    ),
    false,
  );
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/bootstrap")).status),
    401,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: labeled fixture provider connection → chosen model → streamed artifact → natural filing/Undo → project search → original conversation; workspace MCP connect/discover → model approval → native chart without app resource; disabled tools; client-close completion/reconnect without duplicate messages; direct second-user artifact/app/conversation/agent/search denial; both subscription sign-in UIs, subscription worker completion, disconnect and cross-user auth denial (fixtures).",
  );
} catch (e) {
  console.log(
    "PAGE",
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "(closed)"),
  );
  console.log("ERRORS", errors);
  console.log("SERVER", logs.slice(-1800));
  throw e;
} finally {
  await browser?.close();
  children.forEach((c) => c.kill());
  await remoteCodex.close();
  rmSync(dir, { recursive: true, force: true });
}
