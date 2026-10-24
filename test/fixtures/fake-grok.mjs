#!/usr/bin/env node
// ACP fixture for `grok agent --no-leader stdio`, shaped like Grok 1.0.70.
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  console.log("grok 1.0.70 (f50904eaee6c)");
  process.exit(0);
}
if (
  process.argv.slice(2).join(" ") !== "agent --no-leader stdio" ||
  process.env.GROK_DISABLE_AUTOUPDATER !== "1"
)
  process.exit(91);
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let sessionId = "grok-session";
const models = {
  currentModelId: "grok-default-fixture",
  availableModels: [
    { modelId: "grok-fixture", name: "Grok fixture" },
    { modelId: "grok-default-fixture", name: "Grok default fixture" },
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
  if (process.env.LOOP_TEST_GROK_LOG)
    appendFileSync(process.env.LOOP_TEST_GROK_LOG, line + "\n");
  if (req.method === "initialize")
    send({
      id: req.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [
          { id: "grok.com", name: "Grok", description: "Sign in with Grok" },
        ],
        _meta: { agentVersion: "1.0.70" },
      },
    });
  else if (["session/new", "session/load"].includes(req.method)) {
    // Grok reports progress notifications before answering session/new.
    send({
      method: "_x.ai/session/setup",
      params: { method: req.method, phase: "auth", sessionId: null },
    });
    if (process.env.LOOP_TEST_GROK_SIGNED_OUT) {
      // Grok 1.0.70's signed-out answer to session/new.
      send({
        id: req.id,
        error: {
          code: -32000,
          message: "Authentication required",
          data: "private-credential-do-not-show",
        },
      });
      continue;
    }
    if (req.method === "session/load") {
      sessionId = req.params.sessionId;
      // ACP loadSession replays the conversation before answering.
      if (!process.env.LOOP_TEST_GROK_EMPTY_LOAD) update("replayed answer");
    }
    send({
      id: req.id,
      result: {
        ...(req.method === "session/new" ? { sessionId } : {}),
        models,
      },
    });
  } else if (req.method === "session/set_model") {
    models.currentModelId = req.params.modelId;
    send({ id: req.id, result: {} });
  } else if (req.method === "session/prompt") {
    if (process.env.LOOP_TEST_GROK_REJECT_PROMPT) {
      // A first turn Grok rejects before retaining it.
      delete process.env.LOOP_TEST_GROK_REJECT_PROMPT;
      send({ id: req.id, error: { code: -32603, message: "Internal error" } });
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
          title: "Run fixture",
          kind: "execute",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  } else if (req.id === "permission" && pending) {
    update("Grok fixture answer");
    send({ id: pending, result: { stopReason: "end_turn" } });
    pending = undefined;
  } else if (req.method === "session/cancel" && pending) {
    send({ id: pending, result: { stopReason: "cancelled" } });
    pending = undefined;
  } else if (req.method === "authenticate") {
    // Loop must never call authenticate; fail loudly if it does.
    process.exit(92);
  } else if (req.method)
    send({ id: req.id, error: { code: -32601, message: "Unexpected method" } });
}
