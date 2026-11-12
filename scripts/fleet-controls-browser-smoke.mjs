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
const previews = [],
  shared = [];
let refusedSharedId;
const fileRequests = [];
const uploadRequests = [];
const mailAgent = randomUUID(),
  mailConversation = randomUUID(),
  mailThreadId = randomUUID();
const mailGateway = {
  machineId: "m_" + "0".repeat(64),
  publicKey: "A".repeat(59),
};
const mailDestination = "m_" + "2".repeat(64);
const mailReference = {
  kind: "peer",
  machineId: mailDestination,
  agentId: mailAgent,
  name: "Same agent",
};
const mailMessage = {
  id: randomUUID(),
  kind: "message",
  status: "queued",
  from: mailAgent,
  to: `peer:${mailDestination}:${mailAgent}`,
  from_ref: { kind: "local", agentId: mailAgent, name: "Same agent" },
  to_ref: mailReference,
  remote_conversation: {
    machineId: mailDestination,
    conversationId: mailConversation,
  },
  conversation_id: null,
  preview: "Source-bound mail fixture",
  files: 1,
  created_at: 1,
  error: null,
};
const mailThread = {
  id: mailThreadId,
  scope: "direct",
  subject: "Machine-qualified mail",
  paused_at: null,
  paused_reason: null,
  updated_at: 1,
  participants: [mailAgent, mailMessage.to],
  participant_refs: [mailMessage.from_ref, mailReference],
  messages: [mailMessage],
};
const mailSummary = {
  ...mailThread,
  participants: [
    { id: mailAgent, name: "Same agent" },
    { id: mailMessage.to, name: "Same agent", reference: mailReference },
  ],
  message_count: 1,
  latest: mailMessage,
  source: peer,
};
const mailDirectory = {
  document: {
    version: 1,
    fleetId: randomUUID(),
    epoch: 0,
    revision: 0,
    mutationId: randomUUID(),
    parent: null,
    kind: "genesis",
    controller: mailGateway,
    members: [mailGateway.machineId, peer.slice(5), mailDestination].map(
      (machineId) => ({
        machineId,
        publicKey: "A".repeat(59),
        grantId: randomUUID(),
        name: "Same machine",
        origin: `https://${machineId.slice(2, 10)}.example`,
      }),
    ),
    tombstones: [],
  },
  signature: "A".repeat(86),
  acceptance: null,
};
let mailDirectoryUnavailable = false,
  mailGatewayId = mailGateway.machineId,
  localMail = false;
let holdUpload = false,
  releaseUpload,
  loseFirstUpload = true;
const objectId = randomUUID(),
  artifactId = randomUUID();
let holdFile = false,
  releaseFile;
let holdPreview = false,
  releasePreview;
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
    import { Conversation } from ${JSON.stringify(resolve("src/client/Conversation.tsx"))};
    import { NativeDecisions } from ${JSON.stringify(resolve("src/client/NativeControls.tsx"))};
    import { ShareSheet } from ${JSON.stringify(resolve("src/client/Sharing.tsx"))};
    import { AttachmentList, UploadButton } from ${JSON.stringify(resolve("src/client/Attachments.tsx"))};
    import { FileLink } from ${JSON.stringify(resolve("src/client/FilePreview.tsx"))};
    import { AgentModelSettings } from ${JSON.stringify(resolve("src/client/AgentModelSettings.tsx"))};
    import { CreateAgent } from ${JSON.stringify(resolve("src/client/CreateAgent.tsx"))};
    import { AgentMailThreads } from ${JSON.stringify(resolve("src/client/AgentMail.tsx"))};
    import { AgentThreadReader } from ${JSON.stringify(resolve("src/client/AgentThreadCard.tsx"))};
    import { FleetProvider, useFleet } from ${JSON.stringify(resolve("src/client/FleetContext.tsx"))};
    import { setViewOwner } from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import { setShellSource } from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import { readFleetJournal } from ${JSON.stringify(resolve("src/client/fleetCommandStorage.ts"))};
    window.commandStorage = async () => (await readFleetJournal("loop:fleet-commands:v1:fixture-owner")) ?? "";
    const peer = ${JSON.stringify(peer)};
    setShellSource(peer); setViewOwner("fixture-owner");
    const root = createRoot(document.getElementById("root"));
    window.fixture = mode => root.render(React.createElement(SourceProvider, {sourceId:peer, capabilities:{
      pairedDevices:false,fleet:{version:1,machineId:mode === "wrong-machine" ? "m_"+"2".repeat(64) : peer.slice(5),
        reads:["nativeDecisions"], actions:mode === "read-only" ? [] : ["nativeAnswer"],files:false,events:false},
    }},React.createElement(NativeDecisions,{conversation:${JSON.stringify(conversation)}})));
    window.fixture("read-only");
    window.closeContinuation = () => root.render(React.createElement("p",null,"Continuation closed"));
    window.continuation = (mode, source=peer) => {
      setViewOwner("fixture-owner");
      root.render(React.createElement(SourceProvider, {sourceId:source, capabilities:{
        pairedDevices:false,fleet:{version:1,machineId:mode === "wrong-machine" ? "m_"+"2".repeat(64) : peer.slice(5),
          reads:["conversation"], actions:mode === "enabled" ? ["conversationContinueStart"] : [],files:false,events:false},
      }},React.createElement(Conversation, {
        id:${JSON.stringify(conversation)},revision:0,
        agents:[{id:"continuation-target",name:"continuation-target",provider:"openai",model:"fixture",connection_id:"fixture",retired_at:null}],
        connections:[],teams:[],composer:null,onClose:()=>{},onContinue:()=>{},onReady:()=>{},onReply:()=>{},onUsePrompt:()=>{},
        onRestoreDraft:()=>{},onWithdraw:async()=>{},onSubmitted:()=>{},onProfile:()=>{},onNewConversation:()=>{},
      })));
    };
    let sharedDraft = {url:"",title:"",excerpt:"fixture-private-share",question:"@share-agent inspect",folderId:""};
    window.share = (mode, source=peer) => root.render(React.createElement(SourceProvider, {sourceId:source, capabilities:{
      pairedDevices:false,fleet:{version:1,machineId:source.slice(5),reads:["sharePreview"],actions:mode === "read-only" ? [] : ["shareSend","agentCreate"],files:false,events:false}
    }},React.createElement(ShareSheet, {draft:sharedDraft,setDraft:next=>{sharedDraft=next;window.share(mode,source)},folders:[],agents:[],onCreate:()=>{},onClose:()=>{},onSent:()=>{window.sharedSent=true}})));
    window.files = (source=peer,owner="fixture-owner") => {
      setViewOwner(owner);
      root.render(React.createElement(SourceProvider,{sourceId:source,capabilities:{
        pairedDevices:false,fleet:{version:1,machineId:source.slice(5),reads:[],actions:[],files:true,events:false},
      }},React.createElement(AttachmentList,{files:[{id:${JSON.stringify(artifactId)},objectId:${JSON.stringify(objectId)},name:"fleet-fixture.txt",mime:"text/plain",size:20}]})));
    };
    window.filelink = (source=peer,owner="fixture-owner") => {
      setViewOwner(owner);
      root.render(React.createElement(FileLink,{url:"/api/agent-sources/"+encodeURIComponent(source)+"/objects/"+${JSON.stringify(objectId)},name:"linked-file.txt"},"Open linked file"));
    };
    window.uploads = (mode="enabled",source=peer,owner="fixture-upload-owner") => {
      setViewOwner(owner);
      root.render(React.createElement(SourceProvider,{sourceId:source,capabilities:{
        pairedDevices:false,fleet:{version:1,machineId:source.slice(5),reads:[],actions:mode === "enabled" ? ["uploadCreate"] : [],files:true,events:false},
      }},React.createElement(UploadButton,{onUploaded:file=>{window.uploadedFile=file}})));
    };
    window.models = () => root.render(React.createElement(SourceProvider, {sourceId:peer, capabilities:{
      pairedDevices:false,fleet:{version:1,machineId:peer.slice(5),reads:[],actions:[],files:false,events:false},
    }},React.createElement(AgentModelSettings,{
      agent:{id:"fixture",name:"fixture",model:"fixture",connection_id:"fixture"},connections:[],
      onSaved:()=>{throw new Error("Read-only model picker saved")},
      onClose:()=>root.render(React.createElement("p",null,"Model picker closed")),
    })));
    window.createFleetAgent = mode => {
      setViewOwner("fixture-create-owner");
      const capabilities = {
        pairedDevices:false,fleet:{version:1,machineId:mode === "wrong-machine" ? "m_"+"2".repeat(64) : peer.slice(5),
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
    const RefreshMailDirectory = () => {
      const fleet = useFleet();
      return React.createElement("button", {onClick:()=>void fleet.refresh()}, "Refresh mail directory");
    };
    window.mail = (reader=false, owner="fixture-mail-owner") => {
      setViewOwner(owner); setShellSource(peer); window.openedMail = null;
      const capabilities = {
        pairedDevices:false, fleet:{version:1, machineId:peer.slice(5), reads:["agentMail","agentThreadDetail"], actions:[], files:true, events:false},
      };
      const view = reader
        ? React.createElement(AgentThreadReader, {
          thread:${JSON.stringify(mailSummary)}, onClose:()=>{},
          onOpen:(id,message,source)=>{window.openedMail={id,message,source}},
        })
        : React.createElement(AgentMailThreads, {
          target:{kind:"agent",id:${JSON.stringify(mailAgent)}}, ownerKey:owner, sourceId:peer,
          agents:[], onChanged:()=>{}, onOpenConversation:(id,source)=>{window.openedMail={id,source}},
        });
      root.render(React.createElement(FleetProvider, {owner,key:owner},
        React.createElement(SourceProvider,{sourceId:peer,capabilities},
          React.createElement(React.Fragment,null,React.createElement(RefreshMailDirectory),view))));
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
    if (req.url === "/api/fleet/admin/state") {
      reply(
        mailDirectoryUnavailable ? 503 : 200,
        mailDirectoryUnavailable
          ? { error: "Fixture directory unavailable" }
          : {
              identity: { ...mailGateway, machineId: mailGatewayId },
              origin: "https://gateway.example",
              state:
                mailGatewayId === mailGateway.machineId
                  ? "controller"
                  : "replica",
              head: "0".repeat(64),
              directory: mailDirectory,
              scope: ["read", "mail"],
              pendingDistribution: 0,
              unconfirmed: [],
            },
      );
      return;
    }
    if (
      req.url ===
      `/api/agent-sources/${encodeURIComponent(peer)}/agents/${mailAgent}/mail`
    ) {
      const message = localMail
        ? {
            ...mailMessage,
            to: mailAgent,
            from_ref: undefined,
            to_ref: undefined,
            remote_conversation: undefined,
            conversation_id: mailConversation,
          }
        : mailMessage;
      reply(200, {
        threads: [
          {
            ...mailThread,
            participant_refs: localMail
              ? undefined
              : mailThread.participant_refs,
            messages: [message],
          },
        ],
      });
      return;
    }
    if (
      req.url?.split("?")[0] ===
      `/api/agent-sources/${encodeURIComponent(peer)}/feed/agent-threads/${mailThreadId}`
    ) {
      reply(200, {
        thread: mailSummary,
        next: null,
        messages: [
          {
            ...mailMessage,
            content: mailMessage.preview,
            message_id: null,
            attachments: [{ id: artifactId, name: "fleet-fixture.txt" }],
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/uploads")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Request("http://fixture.invalid", {
        method: "POST",
        headers: req.headers,
        body: Buffer.concat(chunks),
      }).formData();
      const manifest = JSON.parse(String(form.get("manifest")));
      const id = req.headers["x-loop-command-id"],
        receiptOnly = req.headers["x-loop-receipt-only"] === "1";
      assert.match(id, /^[a-f0-9-]{36}$/);
      assert.equal(req.headers["x-loop-csrf"], "fixture-only");
      assert.equal(form.has("file"), !receiptOnly);
      if (!receiptOnly)
        assert.equal(form.get("file").size, manifest.body.file.size);
      uploadRequests.push({ path: req.url, id, receiptOnly, manifest });
      if (holdUpload)
        await new Promise((resolve) => {
          releaseUpload = resolve;
        });
      if (res.destroyed) return;
      if (loseFirstUpload && !receiptOnly) {
        reply(503, {
          error: "Fixture upload outcome is unknown",
          executionOutcome: "unknown",
        });
      } else
        reply(
          201,
          {
            id: artifactId,
            objectId,
            name: manifest.body.file.name,
            mime: manifest.body.file.mime,
            size: manifest.body.file.size,
          },
          {
            "x-loop-command-id": id,
            "x-loop-command-state": "completed",
          },
        );
      return;
    }
    if (req.method === "GET" && req.url?.endsWith("/objects/" + objectId)) {
      fileRequests.push(req.url);
      if (holdFile)
        await new Promise((resolve) => {
          releaseFile = resolve;
        });
      if (res.destroyed) return;
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename*=UTF-8''fleet-fixture.txt",
        "cache-control": "no-store",
      });
      res.end("Source-bound fixture file");
      return;
    }
    if (
      req.method === "POST" &&
      /^\/api\/agent-sources\/peer%3Am_[a-f0-9]{64}\/share\/(preview|send)$/.test(
        req.url,
      )
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url.endsWith("/preview")) {
        assert.equal(req.headers["x-loop-command-id"], undefined);
        previews.push({ path: req.url, body });
        if (holdPreview)
          await new Promise((resolve) => {
            releasePreview = resolve;
          });
        reply(200, {
          mode: "queue",
          agent: {
            id: "share-fixture",
            name: "share-agent",
            provider: "openai",
            model: "fixture",
            effort: null,
          },
        });
      } else {
        assert.match(req.headers["x-loop-command-id"], /^[a-f0-9-]{36}$/);
        assert.equal(body.idempotencyKey, req.headers["x-loop-command-id"]);
        const id = req.headers["x-loop-command-id"],
          receiptOnly = req.headers["x-loop-receipt-only"] === "1";
        shared.push({ path: req.url, id, receiptOnly });
        if (id === refusedSharedId || (id === shared[0].id && receiptOnly)) {
          refusedSharedId = id;
          reply(
            409,
            {
              error: "Fixture shared command was confirmed absent",
              executionOutcome: "refused",
            },
            { "x-loop-command-id": id, "x-loop-command-state": "refused" },
          );
          return;
        }
        reply(503, {
          error: "Fixture shared receipt is unknown",
          executionOutcome: "unknown",
        });
      }
      return;
    }
    const sourcePrefix = `/api/agent-sources/${encodeURIComponent(peer)}`;
    if (
      req.method === "GET" &&
      req.url.split("?")[0] === sourcePrefix + `/conversations/${conversation}`
    ) {
      reply(200, {
        conversation: {
          id: conversation,
          owner_id: "fixture-owner",
          agent_id: null,
          title: "Continuation permissions",
          origin: "loop",
          external_id: null,
          created_at: 1,
          team_id: null,

          execution_connection_id: null,
          project_id: null,
          feed_hidden: 0,
        },
        messages: [
          {
            id: "continuation-message",
            revision: 0,
            owner_id: "fixture-owner",
            conversation_id: conversation,
            role: "user",
            content: "Continue this work",
            metadata: "{}",
            created_at: 1,
            run_id: null,
            cursor: [1, 1, 1],
          },
        ],
        working: false,
        range: { from: [0, 0, 0], before: [2, 0, 0] },
        steerable_run_id: null,
        latest_agent_message: null,
        next: null,
        position_message_id: null,
        saved: [],
        resumed: false,
      });
      return;
    }
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
  const storage = await page.evaluate(async () => ({
    keys: Object.keys(sessionStorage),
    contents:
      Object.values(sessionStorage).join("") +
      Object.values(localStorage).join("") +
      (await window.commandStorage()),
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
  await page.evaluate(() => window.share("read-only"));
  await page
    .getByRole("button", { name: "Preview route", exact: true })
    .click();
  const shareSend = page.getByRole("button", {
    name: "Send after review",
    exact: true,
  });
  await expect(shareSend).toBeDisabled();
  assert.equal(previews.length, 1);
  assert.equal(shared.length, 0);
  await page.evaluate(() => window.share("writable"));
  await expect(shareSend).toBeEnabled();
  await shareSend.click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture shared receipt is unknown",
  );
  assert.equal(shared.length, 1);
  const sharedStorage = await page.evaluate(() => window.commandStorage());
  assert(sharedStorage.includes(shared[0].id));
  assert(!sharedStorage.includes("fixture-private-share"));
  await shareSend.click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture shared command was confirmed absent",
  );
  assert.equal(shared.length, 2);
  assert.equal(shared[1].id, shared[0].id);
  assert.equal(shared[1].receiptOnly, true);
  await shareSend.click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture shared receipt is unknown",
  );
  assert.equal(shared.length, 3);
  assert.notEqual(shared[2].id, shared[0].id);
  assert.equal(shared[2].receiptOnly, false);
  await shareSend.click();
  await expect.poll(() => shared.length).toBe(4);
  await expect(shareSend).toBeEnabled();
  assert.equal(shared[3].id, shared[2].id);
  assert.equal(shared[3].receiptOnly, true);
  const retryStorage = await page.evaluate(() => window.commandStorage());
  assert(retryStorage.includes(shared[2].id));
  assert(!retryStorage.includes(shared[0].id));
  holdPreview = true;
  await page
    .getByRole("button", { name: "Preview route", exact: true })
    .click();
  await expect.poll(() => previews.length).toBe(2);
  await page.evaluate(() =>
    window.share("writable", "peer:m_" + "2".repeat(64)),
  );
  await expect(shareSend).toHaveCount(0);
  releasePreview();
  holdPreview = false;
  await expect(
    page.getByRole("button", { name: "Preview route", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Preview route", exact: true })
    .click();
  await expect(shareSend).toBeEnabled();
  assert.equal(previews.length, 3);
  assert(previews.at(-1).path.includes("2".repeat(64)));
  assert.equal(shared.length, 4);
  assert.equal(await page.evaluate(() => !!window.sharedSent), false);
  await page.evaluate(() => window.files());
  const previewFile = page.getByRole("button", {
    name: "Preview fleet-fixture.txt",
    exact: true,
  });
  await previewFile.click();
  await expect(page.locator(".file-preview-content pre")).toHaveText(
    "Source-bound fixture file",
  );
  assert(fileRequests.at(-1).includes(encodeURIComponent(peer)));
  await page.evaluate(() => window.files("peer:m_" + "2".repeat(64)));
  await expect(page.locator(".file-preview-content")).toHaveCount(0);
  assert.equal(
    fileRequests.length,
    1,
    "A source change must not reuse the prior source's object id",
  );
  await page.evaluate(async () => {
    window.files();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal(
    fileRequests.length,
    1,
    "Returning to a source must not reopen its previous preview",
  );
  await page.evaluate(async () => {
    window.files("peer:m_" + "2".repeat(64));
    await new Promise(requestAnimationFrame);
  });
  holdFile = true;
  await previewFile.click();
  await expect.poll(() => fileRequests.length).toBe(2);
  await page.evaluate(() =>
    window.files("peer:m_" + "2".repeat(64), "other-owner"),
  );
  await expect(page.locator(".file-preview-content")).toHaveCount(0);
  releaseFile();
  holdFile = false;
  await previewFile.click();
  await expect(page.locator(".file-preview-content pre")).toHaveText(
    "Source-bound fixture file",
  );
  assert.equal(fileRequests.length, 3);
  assert(fileRequests.at(-1).includes("2".repeat(64)));
  await page.evaluate(() => window.filelink());
  await page.getByRole("link", { name: "Open linked file" }).click();
  await expect(page.locator(".file-preview-content pre")).toHaveText(
    "Source-bound fixture file",
  );
  assert.equal(fileRequests.length, 4);
  await page.evaluate(() => window.filelink("peer:m_" + "2".repeat(64)));
  await expect(page.locator(".file-preview-content")).toHaveCount(0);
  assert.equal(
    fileRequests.length,
    4,
    "An open link cannot retarget its file read",
  );
  await page.getByRole("link", { name: "Open linked file" }).click();
  await expect(page.locator(".file-preview-content pre")).toHaveText(
    "Source-bound fixture file",
  );
  await page.evaluate(() =>
    window.filelink("peer:m_" + "2".repeat(64), "another-owner"),
  );
  await expect(page.locator(".file-preview-content")).toHaveCount(0);
  assert.equal(
    fileRequests.length,
    5,
    "An owner change cannot reuse an open link",
  );
  await page.evaluate(() => window.uploads("read-only"));
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true }),
  ).toBeDisabled();
  assert.equal(uploadRequests.length, 0);
  await page.evaluate(() => window.uploads());
  const upload = page.getByLabel("Attach files", { exact: true });
  const file = {
    name: "résumé.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Original fixture upload"),
  };
  await upload.setInputFiles(file);
  await expect(page.getByRole("alert")).toContainText("outcome is unknown");
  assert.equal(uploadRequests.length, 1);
  await upload.setInputFiles(file);
  await expect
    .poll(() => page.evaluate(() => window.uploadedFile?.name))
    .toBe("résumé.txt");
  assert.equal(uploadRequests.length, 2);
  assert.equal(uploadRequests[0].id, uploadRequests[1].id);
  assert.equal(uploadRequests[1].receiptOnly, true);
  assert.deepEqual(uploadRequests[0].manifest, uploadRequests[1].manifest);
  assert(uploadRequests[0].path.includes(encodeURIComponent(peer)));
  holdUpload = true;
  loseFirstUpload = false;
  await page.evaluate(() => {
    window.uploadedFile = undefined;
  });
  await upload.setInputFiles({ ...file, name: "held.txt" });
  await expect.poll(() => uploadRequests.length).toBe(3);
  await page.evaluate(() =>
    window.uploads("enabled", "peer:m_" + "2".repeat(64), "changed-owner"),
  );
  releaseUpload();
  holdUpload = false;
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true }),
  ).toBeEnabled();
  assert.equal(await page.evaluate(() => window.uploadedFile), undefined);
  assert.equal(
    uploadRequests.length,
    3,
    "Changing owner/source must not replay a held upload",
  );
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
  await page.evaluate(() => window.mail());
  const mail = page.getByRole("region", { name: "Agent mail" });
  const openMail = mail.getByRole("button", { name: /Open in/ });
  await expect(mail).toContainText("Same agent on Same machine (22222222)");
  await expect(openMail).toBeEnabled();
  await openMail.click();
  assert.deepEqual(await page.evaluate(() => window.openedMail), {
    id: mailConversation,
    source: `peer:${mailDestination}`,
  });
  mailDirectoryUnavailable = true;
  await page
    .getByRole("button", { name: "Refresh mail directory", exact: true })
    .click();
  // Production GET recovery waits 2s and 4s before reporting a persistent 503.
  await expect(openMail).toBeDisabled({ timeout: 10_000 });
  await expect(mail).toContainText("Refresh the fleet directory");
  mailDirectoryUnavailable = false;
  await page
    .getByRole("button", { name: "Refresh mail directory", exact: true })
    .click();
  await expect(openMail).toBeEnabled();
  await page.evaluate(() => window.mail(true));
  const original = page.getByRole("button", {
    name: "Open original conversation",
    exact: true,
  });
  await expect(original).toBeEnabled();
  await expect(
    page.getByRole("link", { name: "fleet-fixture.txt", exact: true }),
  ).toHaveAttribute(
    "href",
    new RegExp(
      `source=${encodeURIComponent(peer)}.*artifact=${artifactId}|artifact=${artifactId}.*source=${encodeURIComponent(peer)}`,
    ),
  );
  await original.click();
  assert.deepEqual(await page.evaluate(() => window.openedMail), {
    id: mailConversation,
    message: undefined,
    source: `peer:${mailDestination}`,
  });
  mailGatewayId = mailDestination;
  await page.evaluate(() => window.mail(false, "fixture-recipient-gateway"));
  await expect(openMail).toBeEnabled();
  await openMail.click();
  assert.deepEqual(await page.evaluate(() => window.openedMail), {
    id: mailConversation,
    source: "",
  });
  localMail = true;
  await page.evaluate(() => window.mail(false, "fixture-local-mail"));
  await expect(openMail).toBeEnabled();
  await openMail.click();
  assert.deepEqual(await page.evaluate(() => window.openedMail), {
    id: mailConversation,
    source: peer,
  });
  // Mount the production conversation under a restricted current fleet catalog.
  // Denial happens before retaining a continuation intent or attempting IO.
  const continuationRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/continue/start"))
      continuationRequests.push(request.url());
  });
  const continuationStorage = () =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("loop-continuation:"),
      ),
    );
  const beforeContinuations = await continuationStorage();
  await page.evaluate(() => window.continuation("read-only"));
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Continue with another agent", exact: true })
    .click();
  const continuationSheet = page.getByRole("dialog", {
    name: "Continue with another agent",
    exact: true,
  });
  await expect(
    continuationSheet.getByRole("checkbox", {
      name: "You: Continue this work",
    }),
  ).toBeChecked();
  await continuationSheet
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption("continuation-target");
  const startContinuation = continuationSheet.getByRole("button", {
    name: "Start continuation",
    exact: true,
  });
  await expect(startContinuation).toBeDisabled();
  await expect(continuationSheet.getByRole("status")).toContainText(
    "does not allow this operation",
  );
  await page.evaluate(() => window.continuation("wrong-machine"));
  await expect(startContinuation).toBeDisabled();
  await expect(continuationSheet.getByRole("status")).toContainText(
    "does not allow this operation",
  );
  await page.evaluate(() => window.continuation("enabled"));
  await expect(startContinuation).toBeEnabled();
  await page.evaluate(() => window.continuation("read-only"));
  await expect(startContinuation).toBeDisabled();
  // Attempting a DOM click must not retain an intent or dispatch an action.
  await startContinuation.evaluate((button) => {
    button.disabled = false;
    button.click();
  });
  assert.deepEqual(await continuationStorage(), beforeContinuations);
  assert.deepEqual(continuationRequests, []);
  // A current uncertain request stays intact if its peer later loses permission.
  await page.evaluate(() => window.closeContinuation());
  await expect(continuationSheet).toHaveCount(0);
  const retained = {
    agentId: "continuation-target",
    messageIds: ["continuation-message"],
    start: {
      input: "Previously submitted continuation",
      idempotencyKey: randomUUID(),
    },
  };
  const retainedKey =
    "loop-continuation:" +
    JSON.stringify(["fixture-owner", peer, conversation]) +
    ":" +
    retained.start.idempotencyKey;
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: retainedKey, value: retained },
  );
  await page.evaluate(() => window.continuation("read-only"));
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Continue with another agent", exact: true })
    .click();
  const retryContinuation = continuationSheet.getByRole("button", {
    name: "Retry continuation",
    exact: true,
  });
  await expect(retryContinuation).toBeDisabled();
  assert.deepEqual(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      retainedKey,
    ),
    retained,
  );
  await page.evaluate(() => window.continuation("enabled"));
  await expect(retryContinuation).toBeEnabled();
  assert.deepEqual(continuationRequests, []);

  assert.deepEqual(failures, []);
  console.log(
    `PASS (${engine.name()}): continuation, question and upload controls respect capabilities; denied continuations retain uncertain requests without new storage or dispatch; questions and shared sends renew confirmed refusals and retain uncertain identities; question reconciliation produces no second effect; sharing and uploads reconcile uncertain commands without resubmission; upload reconciliation omits file bytes; held requests and previews are fenced by owner/source changes; mail identity labels and conversation navigation retain the owning machine, block stale directory navigation and preserve current source-local targets. Deterministic HTTP fixture.`,
  );
} finally {
  releasePreview?.();
  releaseFile?.();
  releaseUpload?.();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
