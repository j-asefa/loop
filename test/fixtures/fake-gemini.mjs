#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  console.log("0.64.0");
  process.exit(0);
}
if (
  process.argv.slice(2).join(" ") !== "--acp" ||
  process.env.NO_BROWSER !== "true"
)
  process.exit(91);
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let sessionId = process.env.LOOP_TEST_GEMINI_SESSION_ID || "gemini-session";
const models = {
  currentModelId: "gemini-default-fixture",
  availableModels: [
    { modelId: "gemini-fixture", name: "Gemini fixture" },
    { modelId: "gemini-default-fixture", name: "Gemini default fixture" },
  ],
};
const update = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
let pending;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (process.env.LOOP_TEST_GEMINI_LOG)
    appendFileSync(
      process.env.LOOP_TEST_GEMINI_LOG,
      JSON.stringify({
        ...req,
        ...(req.method === "session/prompt"
          ? { fixtureModelId: models.currentModelId }
          : {}),
      }) + "\n",
    );
  if (req.method === "initialize")
    send({
      id: req.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "gemini-cli", version: "0.64.0" },
        authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
        },
      },
    });
  else if (["session/new", "session/load"].includes(req.method)) {
    if (process.env.LOOP_TEST_GEMINI_FAIL) {
      send({
        id: req.id,
        error: { code: -32000, message: "private-credential-do-not-show" },
      });
      continue;
    }
    // Gemini 0.64.0 creates a fresh Config on load; ACP setModel calls
    // Config.setModel with its default isTemporary=true. Chat history does
    // not restore that override. See upstream acpSessionManager.loadSession,
    // acpSession.setModel and core/config/config.ts Config.setModel.
    // https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/acp/acpSession.ts#L244-L247
    // https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/config/config.ts#L1929-L1943
    // https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/cli/src/acp/acpSessionManager.ts#L235-L273
    models.currentModelId = "gemini-default-fixture";
    if (req.method === "session/load") {
      sessionId = req.params.sessionId;
      update("replayed answer");
    }
    send({
      id: req.id,
      result: {
        ...(req.method === "session/new"
          ? { sessionId }
          : {}),
        models,
      },
    });
  } else if (req.method === "session/set_model") {
    models.currentModelId = req.params.modelId;
    send({ id: req.id, result: {} });
  } else if (req.method === "session/prompt") {
    if (process.env.LOOP_TEST_GEMINI_AUTO) {
      update("Fixture done");
      send({ id: req.id, result: { stopReason: "end_turn" } });
      continue;
    }
    pending = req.id;
    send({
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "tool",
          title: "Read fixture",
          kind: "read",
          status: "pending",
        },
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  } else if (req.id === "permission" && pending) {
    update("Gemini fixture answer");
    send({ id: pending, result: { stopReason: "end_turn" } });
    pending = undefined;
  } else if (req.method === "session/cancel" && pending) {
    send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
  } else if (req.method)
    send({ id: req.id, error: { code: -32601, message: "Unexpected method" } });
}
