#!/usr/bin/env node
// MSP fixture shaped after `muse serve` 1.4.12 frames: no provider traffic.
import readline from "node:readline";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
if (process.argv[2] === "--version") {
  console.log("Muse Code 1.4.12 (1.4.12-R6909.1)");
  process.exit(0);
}
if (process.argv[2] !== "serve") process.exit(91);
const dir = process.env.LOOP_TEST_MUSE_DIR || process.cwd();
const credential = dir + "/muse-credential.json";
const log = (value) =>
  process.env.LOOP_TEST_MUSE_LOG &&
  appendFileSync(process.env.LOOP_TEST_MUSE_LOG, JSON.stringify(value) + "\n");
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const notify = (method, params) =>
  send({ method, params: { ...params, viewCursor: "v4:fixture" } });
const v7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const account = () =>
  process.env.META_API_KEY
    ? { credentialRequired: true, state: "envKey" }
    : existsSync(credential)
      ? {
          credentialRequired: true,
          state: JSON.parse(readFileSync(credential, "utf8")).state,
        }
      : { credentialRequired: true, state: "loggedOut" };
let sessionId = "";
let model = "muse-spark-fixture";
let turn = 0;
let approval;
let pendingLogin;
let granted = [];
const finishTurn = (turnId, terminal = "completed") => {
  notify("turn/completed", {
    sessionId,
    turnId,
    terminal,
    usage: {
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
  });
};
const answerTurn = (turnId, text) => {
  const itemId = "message-" + turnId;
  // Reasoning streams text deltas too; it is not part of the reply.
  notify("item/started", {
    sessionId,
    item: {
      itemId: "reasoning-" + turnId,
      kind: "reasoning",
      revision: 1,
      status: "inProgress",
      turnId,
    },
  });
  notify("item/delta", {
    sessionId,
    itemId: "reasoning-" + turnId,
    field: "text",
    delta: "private reasoning",
  });
  notify("item/started", {
    sessionId,
    item: {
      itemId,
      kind: "agentMessage",
      revision: 1,
      status: "inProgress",
      text: "",
      turnId,
    },
  });
  notify("item/delta", { sessionId, itemId, field: "text", delta: text });
  notify("item/completed", {
    sessionId,
    item: {
      itemId,
      kind: "agentMessage",
      messagePhase: "finalAnswer",
      revision: 2,
      status: "completed",
      text,
      turnId,
    },
  });
  finishTurn(turnId);
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  log(req);
  if (req.jsonrpc !== "2.0") {
    send({
      id: req.id ?? null,
      error: { code: -32600, message: "missing or invalid jsonrpc member" },
    });
    continue;
  }
  const p = req.params ?? {};
  if (p.commandId !== undefined && !v7.test(p.commandId)) {
    send({
      id: req.id,
      error: { code: -32602, message: "commandId: expected UUIDv7" },
    });
    continue;
  }
  const reply = (result) => send({ id: req.id, result });
  if (req.method === "initialize") {
    granted = process.env.LOOP_TEST_MUSE_NO_MCP
      ? []
      : (p.capabilities?.requestedCapabilities ?? []);
    reply({
      experimentalApi: !!p.capabilities?.experimentalApi,
      grantedCapabilities: granted,
      serverInfo: { name: "muse", version: "1.4.12" },
    });
  } else if (req.method === "initialized") continue;
  else if (req.method === "account/read") reply(account());
  else if (req.method === "account/loginStart") {
    if (p.type === "apiKey") {
      writeFileSync(
        credential,
        JSON.stringify({ state: "apiKey", method: "api", key: p.apiKey }),
        { mode: 0o600 },
      );
      if (!process.env.LOOP_TEST_MUSE_SILENT_KEY)
        notify("account/loginCompleted", { outcome: "granted" });
      reply({});
    } else {
      reply({
        verificationUrl: "https://auth.meta.com/oauth/device/?code=FIXT-CODE",
        userCode: "FIXT-CODE",
      });
      pendingLogin = setInterval(() => {
        if (!existsSync(dir + "/authorize-muse")) return;
        clearInterval(pendingLogin);
        writeFileSync(
          credential,
          JSON.stringify({
            state: "accountLogin",
            method: "oauth",
            key: "fixture-token-private",
          }),
          { mode: 0o600 },
        );
        notify("account/loginCompleted", { outcome: "granted" });
      }, 25);
    }
  } else if (req.method === "account/loginCancel") {
    clearInterval(pendingLogin);
    notify("account/loginCompleted", { outcome: "cancelled" });
    reply({ cancelled: true });
  } else if (req.method === "account/logout") {
    if (existsSync(credential))
      writeFileSync(credential, JSON.stringify({ state: "loggedOut" }));
    reply(account());
  } else if (req.method === "model/list")
    reply({
      providerId: "meta",
      models: [
        {
          modelId: "muse-spark-fixture",
          displayLabel: "Muse Spark fixture",
          isDefault: true,
          variants: ["low", "high"],
          defaultReasoningEffort: "high",
        },
        {
          modelId: "muse-other-fixture",
          displayLabel: "Muse other fixture",
          isDefault: false,
          variants: ["high"],
        },
      ],
    });
  else if (req.method === "session/start" || req.method === "session/resume") {
    if (p.config?.mcpServers && !granted.includes("sessionMcp")) {
      send({
        id: req.id,
        error: {
          code: -32602,
          message:
            "session MCP configuration requires the sessionMcp capability",
        },
      });
      continue;
    }
    if (p.sessionId === "missing-session") {
      send({
        id: req.id,
        error: {
          code: -32004,
          data: { kind: "sessionNotFound" },
          message: "session not found",
        },
      });
      continue;
    }
    sessionId = p.sessionId || "01a16dbe-0000-7000-8000-000000000001";
    const turns =
      req.method === "session/resume" && existsSync(dir + "/muse-turns")
        ? Number(readFileSync(dir + "/muse-turns", "utf8"))
        : 0;
    if (p.modelId) model = p.modelId;
    reply({
      session: { sessionId, modelId: model, status: "idle", turnCount: turns },
      viewCursor: "",
    });
  } else if (req.method === "session/setModel") {
    model = p.model.modelId;
    reply({ status: "accepted" });
  } else if (req.method === "turn/start") {
    const turnId = p.commandId;
    turn++;
    writeFileSync(dir + "/muse-turns", String(turn));
    if (p.input.some((part) => part.text.includes("finishes at once"))) {
      // The reply and the whole turn in one stdout chunk.
      const frame = (value) =>
        JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";
      process.stdout.write(
        frame({
          id: req.id,
          result: {
            commandId: turnId,
            disposition: "started",
            startedNewTurn: true,
            status: "accepted",
            turnId,
          },
        }) +
          frame({
            method: "turn/started",
            params: { sessionId, turnId, viewCursor: "v4:fixture" },
          }) +
          frame({
            method: "turn/completed",
            params: {
              sessionId,
              turnId,
              terminal: "completed",
              viewCursor: "v4:fixture",
            },
          }),
      );
      continue;
    }
    reply({
      commandId: p.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId,
    });
    notify("turn/started", { sessionId, turnId, commandId: p.commandId });
    const text = p.input.map((part) => part.text).join("\n");
    if (text.includes("empty input")) {
      approval = { turnId };
      send({
        id: "server-" + turn,
        method: "userInput/request",
        params: {
          sessionId,
          turnId,
          userInputId: "empty-" + turn,
          questions: [],
        },
      });
      // Complete only when Loop declines this request with userInput/cancel.
      continue;
    }
    if (text.includes("foreign request"))
      send({
        id: "foreign-" + turn,
        method: "approval/request",
        params: {
          sessionId: "another-session",
          approvalId: "foreign",
          availableChoices: [],
        },
      });
    if (text.includes("needs approval")) {
      approval = {
        turnId,
        approvalId: "approval-" + turn,
        stages: text.includes("two stages") ? 2 : 1,
        stage: 0,
        refuseFirst: text.includes("refuse first"),
        resolveWhileDeciding: text.includes("resolved while deciding"),
      };
      send({
        id: "server-" + turn,
        method: "approval/request",
        params: {
          sessionId,
          turnId,
          approvalId: approval.approvalId,
          itemId: "tool-" + turn,
          toolName: "shell",
          toolCallId: "call-" + turn,
          rawArgs: '{"command":"ls"}',
          judgeEscalated: false,
          protectedWrite: false,
          subject: { kind: "shell", command: "ls" },
          currentRequirementId: {
            approvalId: approval.approvalId,
            sourceIndex: 0,
          },
          availableChoices: text.includes("session-only")
            ? [
                {
                  choiceId: "c-session",
                  decision: "approvedForSession",
                  label: "Yes, this session",
                  scope: "session",
                },
              ]
            : [
                {
                  choiceId: "c-once",
                  decision: "approved",
                  label: "Yes, once",
                  scope: "once",
                },
                {
                  choiceId: "c-session",
                  decision: "approvedForSession",
                  label: "Yes, this session",
                  scope: "session",
                },
                {
                  choiceId: "c-deny",
                  decision: "denied",
                  label: "No",
                  scope: "once",
                },
              ],
        },
      });
      if (text.includes("changes command"))
        notify("approval/updated", {
          sessionId,
          approvalId: approval.approvalId,
          change: { kind: "subjectChanged" },
          subject: { kind: "shell", command: "rm -rf build" },
          currentRequirementId: {
            approvalId: approval.approvalId,
            sourceIndex: 0,
          },
          availableChoices: [
            {
              choiceId: "c-once",
              decision: "approved",
              label: "Yes, once",
              scope: "once",
            },
            {
              choiceId: "c-deny",
              decision: "denied",
              label: "No",
              scope: "once",
            },
          ],
        });
    } else if (text.includes("needs input")) {
      approval = { turnId };
      send({
        id: "server-" + turn,
        method: "userInput/request",
        params: {
          sessionId,
          turnId,
          userInputId: "input-" + turn,
          itemId: "tool-" + turn,
          toolCallId: "call-" + turn,
          toolName: "request_user_input",
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              selection: "single",
              options: [{ label: "Red" }, { label: "Blue" }],
            },
          ],
        },
      });
    } else if (text.includes("stays running")) {
      approval = { turnId };
    } else answerTurn(turnId, `${model}: ${text}`);
  } else if (
    req.method === "approval/decide" &&
    approval.resolveWhileDeciding
  ) {
    // A policy resolves the approval, then Muse refuses the late decision.
    notify("approval/resolved", {
      sessionId,
      approvalId: p.approvalId,
      decision: "denied",
      itemId: "tool",
      policyResult: "deny",
      resolvedBy: "policy",
      stageEvidence: [],
      turnId: approval.turnId,
    });
    send({
      id: req.id,
      error: {
        code: -32051,
        data: { kind: "approvalAlreadyResolved" },
        message: "approval already resolved",
      },
    });
    answerTurn(approval.turnId, "denied by policy");
  } else if (req.method === "approval/decide" && approval.refuseFirst) {
    approval.refuseFirst = false;
    send({
      id: req.id,
      error: {
        code: -32053,
        data: { kind: "approvalRequirementStale" },
        message: "approval requirement is stale",
      },
    });
  } else if (req.method === "approval/decide") {
    if (p.requirementId?.sourceIndex !== approval.stage) {
      send({
        id: req.id,
        error: { code: -32053, message: "approval requirement is stale" },
      });
      continue;
    }
    reply({ status: "accepted" });
    if (p.choiceId !== "c-deny" && ++approval.stage < approval.stages) {
      // The next pipeline stage needs its own decision.
      notify("approval/updated", {
        sessionId,
        approvalId: p.approvalId,
        change: { kind: "stageAdvanced" },
        subject: { kind: "shell", command: "ls | wc -l" },
        currentRequirementId: {
          approvalId: p.approvalId,
          sourceIndex: approval.stage,
        },
        availableChoices: [
          {
            choiceId: "c-once",
            decision: "approved",
            label: "Yes, once",
            scope: "once",
          },
          {
            choiceId: "c-deny",
            decision: "denied",
            label: "No",
            scope: "once",
          },
        ],
      });
      continue;
    }
    notify("approval/resolved", {
      sessionId,
      approvalId: p.approvalId,
      decision: p.choiceId === "c-deny" ? "denied" : "approved",
      itemId: "tool",
      policyResult: p.choiceId === "c-deny" ? "deny" : "allow",
      resolvedBy: "user",
      stageEvidence: [],
      turnId: approval.turnId,
    });
    answerTurn(approval.turnId, p.choiceId === "c-deny" ? "denied" : "ran ls");
  } else if (req.method === "userInput/answer") {
    reply({ status: "accepted" });
    notify("userInput/settled", {
      sessionId,
      userInputId: p.userInputId,
      outcome: "answered",
      answers: p.answers,
    });
    answerTurn(approval.turnId, "picked " + p.answers[0].selectedLabel);
  } else if (req.method === "userInput/cancel") {
    reply({ status: "accepted" });
    answerTurn(approval.turnId, "input declined");
  } else if (req.method === "turn/steer") {
    if (
      p.expectedTurnId !== approval?.turnId ||
      p.input.some((part) => part.text.includes("refused"))
    ) {
      send({
        id: req.id,
        error: { code: -32010, message: "turn is no longer active" },
      });
      continue;
    }
    reply({ status: "accepted" });
    answerTurn(
      p.expectedTurnId,
      "steered: " + p.input.map((part) => part.text).join(""),
    );
  } else if (req.method === "turn/interrupt") {
    reply({ status: "accepted" });
    finishTurn(p.turnId, "cancelled");
  } else
    send({ id: req.id, error: { code: -32601, message: "Method not found" } });
}
