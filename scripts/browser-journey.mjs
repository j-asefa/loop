import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "loop-journey-"));
execFileSync(
  "node_modules/.bin/esbuild",
  [
    "tests/fixtures/mcp-app.ts",
    "--bundle",
    "--minify",
    "--format=iife",
    "--platform=browser",
    "--outfile=" + join(dir, "app.js"),
  ],
  { stdio: "ignore" },
);
const env = {
    ...process.env,
    NODE_ENV: "test",
    LOOP_RUNTIME_URL: "http://127.0.0.1:3109",
    LOOP_RUNTIME_TOKEN: "fixture-broker-authentication-only-32chars",
    LOOP_DATA_DIR: dir,
    LOOP_FIXTURE_APP: join(dir, "app.js"),
  },
  children = ["server", "worker"].map((name) =>
    spawn(
      process.execPath,
      ["--env-file=.env", "--import", "tsx", `scripts/fixture-${name}.ts`],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
children.push(spawn(process.execPath, ["tests/helpers/subscription-broker.mjs"], {env,stdio:["ignore","pipe","pipe"]}));
let logs = "";
children.forEach((c) => c.stderr.on("data", (b) => (logs += b)));
let browser, page;
const errors = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch("http://localhost:3000/api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    headless: true,
  });
  const workspaceContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  page = await workspaceContext.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:3000");
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
  await page.getByRole("heading", { name: "Your loop." }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Provider connections/ }).click();
  await page.getByRole("button", { name: "Use an API key", exact: true }).click();
  await page.getByLabel("Account label").fill("Deterministic fixture account");
  await page
    .getByLabel("API key", { exact: true })
    .fill("test-only-do-not-use");
  await page.getByRole("button", { name: "Validate and connect" }).click();
  await page
    .getByRole("heading", { name: "Deterministic fixture account" })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Create an agent", exact: true })
    .click();
  await page.getByLabel("Unique name").fill("journey-agent");
  await page
    .getByRole("combobox", { name: /^Model/ })
    .selectOption("openai-fixture");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByLabel("Message your agent").fill("Explain bids precisely");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText("Fixture response:", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
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
  await page.reload();
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
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const feed = await api("/feed"),
    artifact = feed.items.find((x) => x.title === "Explain bids precisely");
  await api("/artifacts/" + artifact.id + "/move", { folderId: child.id });
  const search = await api("/search?q=resting&folder=" + child.id);
  assert.ok(search.items.some((x) => x.id === "artifact:" + artifact.id));
  await page.goto("http://localhost:3000/?artifact=" + artifact.id);
  await page.getByRole("button", { name: "Source conversation" }).click();
  await page
    .getByRole("dialog")
    .getByText("Fixture response:", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Tools & integrations/ }).click();
  await page.getByRole("button", { name: "Add server URL" }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Deterministic MCP fixture");
  await page.getByLabel("Server address").fill("https://fixture.example/mcp");
  await page.getByLabel("Authentication").selectOption("none");
  await page.getByRole("button", { name: "Connect & test" }).click();
  await page
    .getByText("Connected. Select the tools and agents below.")
    .waitFor();
  await page
    .getByRole("group", { name: "Available tools" })
    .getByText("Deterministic MCP fixture", { exact: true })
    .click();
  await page.getByRole("checkbox", { name: /metrics/ }).check();
  await page.getByRole("button", { name: "Save permissions" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Message your agent").fill("Show latency");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("navigation")
    .last()
    .getByRole("button", { name: "Running", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Approve and continue", exact: true })
    .click();
  await page
    .getByRole("navigation")
    .last()
    .getByRole("button", { name: "Feed", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Fixture request latency" })
    .waitFor({ timeout: 15000 });
  await page.getByRole("heading", { name: "Fixture request latency" }).click();
  const frame = page.frameLocator(
    'iframe[title="MCP app, isolated from Loop"]',
  );
  await frame
    .getByText("Fixture result received", { exact: true })
    .waitFor({ timeout: 15000 });
  await frame.getByRole("button", { name: "Try parent access" }).click();
  await frame.getByText("Parent DOM denied").waitFor();
  await frame
    .getByRole("button", { name: "Try unsupported capability" })
    .click();
  await frame.getByText("Unsupported capability denied").waitFor();
  await frame.getByRole("button", { name: "Denied tool request" }).click();
  await frame.getByText("not allowed", { exact: false }).waitFor();
  await frame.getByRole("button", { name: "Approved tool request" }).click();
  await frame
    .getByText("Request queued for explicit approval", { exact: false })
    .waitFor();
  await page.screenshot({ path: "docs/loop-v0/evidence/mcp-app-fixture.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("navigation")
    .last()
    .getByRole("button", { name: "Running", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Approve and continue", exact: true })
    .click();
  const conns = await api("/mcp");
  await api("/mcp/" + conns[0].id, { action: "disable" }, "PATCH");
  const chart = (await api("/feed")).items.find((x) => x.kind === "chart");
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
      await context.request.get("http://localhost:3000/api/runs")
    ).json();
    if (records.find((r) => r.id === detached.id)?.state === "running") break;
    await new Promise((r) => setTimeout(r, 80));
  }
  await page.close();
  let detachedDone = false;
  for (let i = 0; i < 50; i++) {
    const records = await (
      await context.request.get("http://localhost:3000/api/runs")
    ).json();
    if (records.find((r) => r.id === detached.id)?.state === "completed") {
      detachedDone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(detachedDone, "worker completes with client closed");
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    "http://localhost:3000/?conversation=" + detached.conversation_id,
  );
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
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // Subscription-first UI, native auth handoff shapes and actual durable worker/tool broker.
  const subs = [];
  for (const runtime of ["codex", "claude"]) {
    await page.getByRole("button", {name:"Settings",exact:true}).click();
    await page.getByRole("button", {name:/Provider connections/}).click();
    assert.equal(await page.getByLabel("API key",{exact:true}).count(),0);
    await page.getByLabel("Provider",{exact:true}).selectOption(runtime);
    await page.getByLabel("Account label").fill(runtime+" subscription fixture");
    await page.getByRole("button",{name:"Continue to subscription sign-in",exact:true}).click();
    const link=page.getByRole("link",{name:"Open provider sign-in"});await link.waitFor();
    assert.match(await link.getAttribute("href"),runtime==="codex"?/auth.openai.com/:/claude.ai/);
    if(runtime==="claude") {
      await page.getByLabel("One-time sign-in code").fill("fixture-code");
      await page.getByRole("button",{name:"Complete sign-in",exact:true}).click();
    }
    await page.getByRole("heading",{name:runtime+" subscription fixture"}).locator("..").getByText(/connected · Subscription allowance/).waitFor({timeout:15000});
    await page.getByRole("button",{name:"Close",exact:true}).click();
    const bootstrap=await api("/bootstrap");
    const conn=bootstrap.connections.find(c=>c.label===runtime+" subscription fixture");subs.push(conn);
    assert.equal(conn.status,"connected");assert.equal(conn.secret,undefined);
    const agent=await api("/agents",{name:runtime+"-subscription",connectionId:conn.id,model:"subscription-fixture"});
    if(runtime==="codex") {
      await api("/mcp/"+conns[0].id,{action:"enable"},"PATCH");
      await api("/agents/"+agent.id+"/tools",[{connectionId:conns[0].id,tools:["metrics"]}],"PUT");
    }
    const run=await api("/runs",{agentId:agent.id,input:"Use subscription allowance",idempotencyKey:crypto.randomUUID()});
    let final;
    for(let i=0;i<60;i++){
      final=(await api("/runs")).find(r=>r.id===run.id);
      if(final.state==="awaiting_approval") {
        const approval=(await api("/approvals")).find(a=>a.run_id===run.id);
        assert.ok(approval,"subscription tool requires explicit approval");
        await api("/approvals/"+approval.id,{decision:"approve"});
      }
      if(["completed","failed"].includes(final.state))break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(final.state,"completed");
    assert.match((await api("/conversations/"+run.conversation_id)).messages.at(-1).content,/Subscription fixture response/);
  }
  const stranger = await browser.newContext();
  const other = await stranger.request.post(
    "http://localhost:3000/api/auth/sign-up/email",
    {
      headers: { origin: "http://localhost:3000" },
      data: {
        name: "Other fixture user",
        email: "other-" + crypto.randomUUID() + "@example.com",
        password: crypto.randomUUID() + "Ab1!",
      },
    },
  );
  assert.ok(other.ok());
  for (const path of [
    "/artifacts/" + artifact.id,
    "/artifacts/" + chart.id + "/app",
    "/conversations/" + artifact.conversation_id,
    "/agents/" + artifact.agent_id,
    "/agents/" + artifact.agent_id + "/tools",
  ])
    assert.equal(
      (await stranger.request.get("http://localhost:3000/api" + path)).status(),
      404,
    );
  const otherSearch = await (
    await stranger.request.get("http://localhost:3000/api/search?q=resting")
  ).json();
  assert.equal(otherSearch.items.length, 0);
  for(const conn of subs) {
    assert.equal((await stranger.request.post("http://localhost:3000/api/subscriptions/"+conn.id+"/status",{headers:{origin:"http://localhost:3000"},data:{}})).status(),404);
  }
  await api("/connections/"+subs[0].id,{},"DELETE");
  assert.equal((await api("/subscriptions/"+subs[0].id+"/status",{})).authenticated,false);
  await stranger.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: labeled fixture provider connection → chosen model → streamed artifact → natural filing/Undo → project search → original conversation; MCP UI connect/discover/grant → model approval → native chart → official Apps initialization + allowed request + denial + parent isolation + unsupported capability; disabled tools; client-close completion/reconnect without duplicate messages; direct second-user artifact/app/conversation/agent/search denial; both subscription sign-in UIs, subscription worker completion, disconnect and cross-user auth denial (fixtures).",
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
  rmSync(dir, { recursive: true, force: true });
}
