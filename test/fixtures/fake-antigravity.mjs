#!/usr/bin/env node
// agy fixture: `models` for sign-in and `acp` shaped like agy 1.5.9's ACP
// server. A prompt sent while another is open steers that turn: the earlier
// request ends with end_turn, the new text is echoed (without a leading
// skill command) and the turn continues.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (value) => {
  if (process.env.LOOP_TEST_AGY_LOG)
    appendFileSync(process.env.LOOP_TEST_AGY_LOG, JSON.stringify(value) + "\n");
};
log({ args, pid: process.pid });
const mode = process.env.LOOP_TEST_AGY_MODE;
// Turn outcome modes apply to a process's first turn, so a follow-up in the
// same live session behaves normally.
const outcome = () => (turn === 1 ? mode : undefined);
if (args[0] === "--version") {
  console.log("1.5.9");
  process.exit(0);
}
if (args[0] === "models") {
  if (mode === "auth-failure" || mode === "signed-out") {
    if (mode === "signed-out")
      console.error(
        "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
      );
    console.error("private-credential-fixture");
    process.exit(1);
  }
  console.log(
    "gemini-agy-fixture    Gemini fixture\nclaude-agy-fixture    Claude fixture",
  );
  process.exit(0);
}
if (args.join(" ") !== "acp") process.exit(90);

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (sessionId, body) =>
  send({ method: "session/update", params: { sessionId, update: body } });
const commands = [
  { name: "plan", description: "Plan before executing." },
  { name: "antigravity-guide", description: "Guide to agy." },
];
let effort = "medium";
const session = (sessionId) => ({
  sessionId,
  models: {
    currentModelId: "gemini-agy-fixture",
    availableModels: [
      { modelId: "gemini-agy-fixture", name: "Gemini fixture" },
      { modelId: "claude-agy-fixture", name: "Claude fixture" },
    ],
  },
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ],
  },
  configOptions: [
    {
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: ["low", "medium", "high"].map((value) => ({
        value,
        name: value,
      })),
    },
  ],
});
const advertise = (sessionId) =>
  setTimeout(() => {
    if (mode !== "acp-silent")
      update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: commands,
      });
  }, 5);
const echoText = (text) => {
  const name = text.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
  return name && commands.some((c) => c.name === name)
    ? text.slice(name.length + 1)
    : text;
};

if (process.env.LOOP_TEST_AGY_SLOW_STOP) {
  setInterval(() => {}, 1000);
  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      log({ event: "fixture-exit", pid: process.pid });
      process.exit(0);
    }, 1500);
  });
}
process.on("exit", () => log({ event: "fixture-exit", pid: process.pid }));

// Open prompt requests of the current turn, oldest first.
let open = [];
let turn = 0;
const usage = (inputTokens, outputTokens) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});
const finish = (sessionId, stopReason = "end_turn") => {
  for (const request of open.splice(0))
    reply(request.id, {
      stopReason,
      usage: usage(request.steer ? 5 : 13, request.steer ? 1 : 3),
    });
};
let permission = 0;
const permissions = new Map();

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.jsonrpc !== "2.0") process.exit(92);
  if (req.method === undefined) {
    // A response to our permission request.
    log({ acp: "permission-response", result: req.result });
    permissions.get(req.id)?.(req.result);
    return;
  }
  log({ acp: req.method, params: req.params });
  const sessionId = req.params?.sessionId;
  switch (req.method) {
    case "initialize":
      return reply(req.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
        },
        authMethods: [
          {
            id: "oauth-personal",
            name: "Log in with Google",
            description: "private-credential-fixture",
          },
        ],
        _meta: { antigravity: { tier: true } },
      });
    case "session/new": {
      const id = process.env.LOOP_TEST_AGY_SESSION_ID || "agy-fixture-session";
      reply(req.id, session(id));
      return advertise(id);
    }
    case "session/resume":
      if (mode === "resume-missing")
        return send({
          id: req.id,
          error: { code: -32002, message: "private-credential-fixture" },
        });
      reply(req.id, session(sessionId));
      return advertise(sessionId);
    case "session/set_model":
      return reply(req.id, {});
    case "session/set_config_option":
      if (req.params.configId === "thought_level") effort = req.params.value;
      return reply(req.id, { configOptions: session(sessionId).configOptions });
    case "session/close":
      return reply(req.id, {});
    case "session/cancel":
      return finish(sessionId, "cancelled");
    case "session/prompt": {
      const text = req.params.prompt[0].text;
      if (open.length) {
        // A prompt during a running turn steers it.
        if (mode === "reject-steer")
          return send({
            id: req.id,
            error: { code: -32603, message: "private-credential-fixture" },
          });
        const earlier = open.splice(0);
        for (const request of earlier)
          reply(request.id, { stopReason: "end_turn", usage: usage(10, 2) });
        open.push({ id: req.id, steer: true });
        if (mode === "steer-no-echo") return;
        update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: echoText(text) },
        });
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Steered answer" },
        });
        return finish(sessionId);
      }
      turn++;
      open.push({ id: req.id, steer: false });
      update(sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: echoText(text) },
      });
      if (outcome() === "hang") return;
      if (text.includes("[slow]")) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Partial essay" },
        });
        return;
      }
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${turn}`,
        title: "run_command",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "echo fixture" },
      });
      if (text.includes("[approve]")) {
        const id = `perm-${++permission}`;
        permissions.set(id, () => {
          update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: `tool-${turn}`,
            status: "completed",
          });
          update(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Approved answer" },
          });
          finish(sessionId);
        });
        return send({
          id,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: `tool-${turn}`, title: "run_command" },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
      }
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: `tool-${turn}`,
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "fixture" } },
        ],
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Antigravity fixture answer" },
      });
      if (outcome() === "disconnect") process.exit(2);
      if (outcome() === "error") {
        open.splice(0);
        return send({
          id: req.id,
          error: { code: -32603, message: "private-credential-fixture" },
        });
      }
      return finish(
        sessionId,
        ["cancelled", "max_tokens"].includes(outcome())
          ? outcome()
          : "end_turn",
      );
    }
    default:
      // session/load would replay history; agy conversations resume instead.
      process.exit(93);
  }
});
