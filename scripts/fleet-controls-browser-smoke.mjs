// Actual source context, native-question UI and typed browser transport against
// an isolated deterministic HTTP fixture. No provider or user workspace is used.
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-fleet-controls-"));
const peer = "peer:m_" + "1".repeat(64);
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
const decision = randomUUID(),
  conversation = randomUUID();
const submissions = [];
const creations = [];
const createdAgentId = randomUUID(),
  createConnection = randomUUID();
let modelReads = 0,
  creationEffects = 0;
let refusedId,
  effectId,
  effects = 0;
let browser,
  server,
  answered = false;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import { SourceProvider } from ${JSON.stringify(resolve("src/client/SourceContext.tsx"))};
    import { NativeDecisions } from ${JSON.stringify(resolve("src/client/NativeControls.tsx"))};
    import { AgentModelSettings } from ${JSON.stringify(resolve("src/client/AgentModelSettings.tsx"))};
    import { CreateAgent } from ${JSON.stringify(resolve("src/client/CreateAgent.tsx"))};
    import { setViewOwner } from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import { setShellSource } from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    const peer = ${JSON.stringify(peer)};
    setShellSource(peer); setViewOwner("fixture-owner");
    const root = createRoot(document.getElementById("root"));
    window.fixture = mode => root.render(React.createElement(SourceProvider, {sourceId:peer, capabilities:{
      profile:"companion",nativeHarnesses:true,pairedDevices:false,runtimeHosts:false,localProjects:true,
      fleet:{version:1,machineId:mode === "wrong-machine" ? "m_"+"2".repeat(64) : peer.slice(5),
        reads:["nativeDecisions"], actions:mode === "read-only" ? [] : ["nativeAnswer"],files:false,events:false},
    }},React.createElement(NativeDecisions,{conversation:${JSON.stringify(conversation)}})));
    window.fixture("read-only");
    window.models = () => root.render(React.createElement(SourceProvider, {sourceId:peer, capabilities:{
      profile:"companion",nativeHarnesses:true,pairedDevices:false,runtimeHosts:false,localProjects:true,
      fleet:{version:1,machineId:peer.slice(5),reads:[],actions:[],files:false,events:false},
    }},React.createElement(AgentModelSettings,{
      agent:{id:"fixture",name:"fixture",model:"fixture",connection_id:"fixture"},connections:[],
      onSaved:()=>{throw new Error("Read-only model picker saved")},
      onClose:()=>root.render(React.createElement("p",null,"Model picker closed")),
    })));
    window.createFleetAgent = mode => {
      setViewOwner("fixture-create-owner");
      const capabilities = {
        profile:"companion",nativeHarnesses:true,pairedDevices:false,runtimeHosts:false,localProjects:true,
        fleet:{version:1,machineId:mode === "wrong-machine" ? "m_"+"2".repeat(64) : peer.slice(5),
          reads:["agentSuggestName","connectionModels"],actions:mode === "read-only" ? [] : ["agentCreate"],files:false,events:false},
      };
      const connection = {id:${JSON.stringify(createConnection)},provider:"openai",label:"Peer account",status:"connected",
        models:JSON.stringify([{id:"fleet-model",name:"Fleet model"}]),metadata:"{}",sourceId:peer,executionEnvironment:"Peer fixture"};
      root.render(React.createElement(CreateAgent, {
        connections:[connection],folders:[],sources:[{id:peer,name:"Peer fixture",capabilities}],
        onClose:()=>{},onConnect:()=>{},onEnvironmentSetup:()=>{},onConnectionsChanged:async()=>[],
        onCreated:(agent,folder,source)=>{window.createdFleetAgent={id:agent.id,source};root.render(React.createElement("p",null,"Fleet agent created"))},
      }));
    };

  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated fleet controls</title><link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (req.url === "/client.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(style);
      return;
    }
    if (req.url === "/client.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(script);
      return;
    }
    if (req.url === "/session") {
      reply(200, { csrf: "fixture-only" });
      return;
    }
    const sourcePrefix = `/api/agent-sources/${encodeURIComponent(peer)}`;
    if (
      req.method === "GET" &&
      req.url === sourcePrefix + "/agents/suggest-name"
    ) {
      reply(200, { name: "fleet-created-fixture" });
      return;
    }
    if (
      req.method === "GET" &&
      req.url === sourcePrefix + `/connections/${createConnection}/models`
    ) {
      modelReads++;
      reply(200, { models: [{ id: "fleet-model", name: "Fleet model" }] });
      return;
    }
    if (req.method === "POST" && req.url === sourcePrefix + "/agents") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const id = req.headers["x-loop-command-id"],
        receiptOnly = req.headers["x-loop-receipt-only"] === "1";
      assert.match(id, /^[a-f0-9-]{36}$/);
      assert.equal(body.idempotencyKey, id);
      assert.equal(body.connectionId, createConnection);
      assert.equal(req.headers["x-loop-csrf"], "fixture-only");
      creations.push({ path: req.url, id, receiptOnly });
      if (!receiptOnly) {
        creationEffects++;
        reply(503, {
          error: "Fixture creation reply lost",
          executionOutcome: "unknown",
        });
      } else {
        reply(
          201,
          {
            id: createdAgentId,
            owner_id: "fixture-destination-owner",
            name: body.name,
            provider: "openai",
            connection_id: createConnection,
            model: body.model,
            instructions: body.instructions || "",
            origin: "loop",
            created_at: 1,
          },
          { "x-loop-command-id": id, "x-loop-command-state": "completed" },
        );
      }
      return;
    }
    const prefix = `/api/agent-sources/${encodeURIComponent(peer)}/native/decisions`;
    if (req.method === "GET" && req.url?.startsWith(prefix + "?")) {
      reply(
        200,
        answered
          ? []
          : [
              {
                id: decision,
                run_id: randomUUID(),
                conversation_id: conversation,
                generation: "fixture-generation",
                native_id: "question",
                request: JSON.stringify({
                  type: "request",
                  kind: "question",
                  title: "Choose a workspace option",
                  questions: [{ id: "choice", title: "Choice" }],
                }),
                state: "pending",
                command_id: null,
                digest: null,
                created_at: Date.now(),
                name: "Fixture",
                provider: "codex",
                input: "Fixture question",
              },
            ],
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === prefix + "/" + decision &&
      req.headers["x-loop-csrf"] === "fixture-only"
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.commandId, req.headers["x-loop-command-id"]);
      submissions.push({
        ...body,
        receiptOnly: req.headers["x-loop-receipt-only"],
      });
      refusedId ??= body.commandId;
      if (body.commandId === refusedId) {
        reply(
          409,
          { error: "Fixture pre-forward refusal", executionOutcome: "refused" },
          {
            "x-loop-command-id": body.commandId,
            "x-loop-command-state": "refused",
          },
        );
        return;
      }
      if (!effectId) {
        assert.equal(req.headers["x-loop-receipt-only"], undefined);
        effectId = body.commandId;
        effects++;
        reply(503, { error: "Fixture reply lost" });
        return;
      }
      assert.equal(body.commandId, effectId);
      assert.equal(req.headers["x-loop-receipt-only"], "1");
      answered = true;
      reply(
        200,
        { state: "resolved" },
        {
          "x-loop-command-id": body.commandId,
          "x-loop-command-state": "completed",
        },
      );
      return;
    }
    reply(404, { error: "Fixture route unavailable" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const send = page.getByRole("button", { name: "Send response", exact: true });
  await expect(send).toBeDisabled();
  await expect(page.getByRole("status")).toContainText(
    "does not allow this operation",
  );
  await expect(page.getByLabel("Choice response")).toBeDisabled();
  await page.evaluate(() => window.fixture("wrong-machine"));
  await expect(send).toBeDisabled();
  assert.equal(submissions.length, 0);
  await page.evaluate(() => window.fixture("writable"));
  await expect(send).toBeEnabled();
  await page.getByLabel("Choice response").fill("fixture-private-answer");
  // Storage refusal must release the UI lock and must not dispatch the answer.
  await page.evaluate(() => {
    window.savedSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage)
        throw new Error("Fixture storage unavailable");
      return window.savedSetItem.call(this, key, value);
    };
  });
  await send.click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture storage unavailable",
  );
  await expect(send).toBeEnabled();
  assert.equal(submissions.length, 0);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.savedSetItem;
  });
  await send.click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture pre-forward refusal",
  );
  await expect(send).toBeEnabled();
  assert.equal(effects, 0);
  await send.click();
  await expect(page.getByRole("alert")).toContainText("Fixture reply lost");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(send).toHaveCount(0);
  assert.equal(submissions.length, 3);
  assert.notEqual(submissions[0].commandId, submissions[1].commandId);
  assert.equal(submissions[1].commandId, submissions[2].commandId);
  assert.equal(effects, 1);
  assert.deepEqual(submissions[0].answer, {
    choice: ["fixture-private-answer"],
  });
  const storage = await page.evaluate(() => ({
    keys: Object.keys(sessionStorage),
    contents:
      Object.values(sessionStorage).join("") +
      Object.values(localStorage).join(""),
  }));
  assert(
    storage.keys.some(
      (key) =>
        key.includes("fixture-owner") &&
        key.includes(peer) &&
        key.includes(decision),
    ),
  );
  assert(!storage.contents.includes("fixture-private-answer"));
  // The real creation UI retains the upstream model picker and saved catalog,
  // while destination capabilities gate execution and lost replies keep one ID.
  await page.evaluate(() => window.createFleetAgent("read-only"));
  const creation = page.getByRole("dialog", { name: "New chat", exact: true });
  const startChat = creation.getByRole("button", {
    name: "Start chatting",
    exact: true,
  });
  await expect(startChat).toBeDisabled();
  await expect(creation).toContainText(
    "This machine does not allow this operation",
  );
  await expect(creation).toContainText("Peer fixture");
  assert.equal(creations.length, 0);
  assert.equal(modelReads, 0, "Opening creation uses the saved catalog");
  await creation.locator(".create-agent-model-options summary").first().click();
  await expect(
    creation
      .getByRole("radiogroup", { name: "Connection", exact: true })
      .locator(`input[data-source-id="${peer}"]`),
  ).toBeChecked();
  await expect(
    creation
      .getByRole("radiogroup", { name: "Model", exact: true })
      .locator('input[value="fleet-model"]'),
  ).toBeChecked();
  await creation
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await expect.poll(() => modelReads).toBe(1);
  await expect(
    creation
      .getByRole("radiogroup", { name: "Model", exact: true })
      .locator('input[value="fleet-model"]'),
  ).toBeEnabled();
  await expect(startChat).toBeDisabled();
  await page.evaluate(() => window.createFleetAgent("wrong-machine"));
  await expect(startChat).toBeDisabled();
  await expect(creation).toContainText(
    "This machine's controls are unavailable",
  );
  await page.evaluate(() => window.createFleetAgent("writable"));
  await expect(startChat).toBeEnabled();
  await startChat.click();
  await expect(creation.getByRole("alert")).toContainText(
    "Fixture creation reply lost",
  );
  await expect(startChat).toBeEnabled();
  await startChat.click();
  await expect(creation).toHaveCount(0);
  assert.equal(creations.length, 2);
  assert.equal(creations[0].receiptOnly, false);
  assert.equal(creations[1].receiptOnly, true);
  assert.equal(creations[0].id, creations[1].id);
  assert.equal(creationEffects, 1);
  assert.equal(modelReads, 1);
  assert.deepEqual(await page.evaluate(() => window.createdFleetAgent), {
    id: createdAgentId,
    source: peer,
  });
  await page.evaluate(() => window.models());
  const done = page.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeEnabled();
  await done.click();
  await expect(
    page.getByText("Model picker closed", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(failures, []);
  console.log(
    `PASS (${engine.name()}): actual question controls refuse read-only and wrong-source capabilities; a terminal refusal permits a fresh ID; a lost response retries receipt-only with one effect; storage refusal releases the lock without IO; identities include owner and machine. Deterministic HTTP fixture.`,
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
