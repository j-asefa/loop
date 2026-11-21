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
  if (mode === "slow-models") await new Promise((r) => setTimeout(r, 500));
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
if (!["acp", "acp --process-per-session"].includes(args.join(" ")))
  process.exit(90);

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
  setTimeout(
    () => {
      if (mode !== "acp-silent")
        update(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: commands,
        });
    },
    mode === "delayed-commands" ? 300 : 5,
  );
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
let endReactiveSteer;

function reactiveTurn(sessionId, mode) {
  const tool = (toolCallId, rawInput, title = toolCallId) =>
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      status: "in_progress",
      rawInput,
    });
  const complete = (toolCallId, status = "completed", rawInput) =>
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      rawInput,
    });
  const message = (text) =>
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  const reportUsage = () =>
    update(sessionId, { sessionUpdate: "usage_update", used: 20, size: 100 });

  if (
    [
      "reactive-rejected-steer-late-tool",
      "reactive-rejected-steer-settled-tool",
      "reactive-echoed-steer-open-tool",
      "reactive-steered-sync-tool",
    ].includes(mode)
  ) {
    message("Waiting.");
    endReactiveSteer = (request) => {
      const synchronous = mode === "reactive-steered-sync-tool";
      const joined = synchronous || mode === "reactive-echoed-steer-open-tool";
      if (joined)
        update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: request.params.prompt[0].text },
        });
      finish(sessionId);
      tool("late-background", { CommandLine: "sleep 5" }, "sleep 5");
      if (synchronous || mode === "reactive-rejected-steer-settled-tool")
        complete("late-background");
      if (synchronous) message("Done.");
      if (joined) reply(request.id, { stopReason: "end_turn" });
      else
        send({
          id: request.id,
          error: { code: -32603, message: "Steer rejected" },
        });
      setTimeout(() => {
        if (synchronous) return;
        if (mode !== "reactive-rejected-steer-settled-tool")
          complete("late-background");
        message("Done.");
        reportUsage();
      }, 30);
    };
    return;
  }
  if (
    [
      "reactive-steer-daemon",
      "reactive-daemon-unechoed-steer-output",
      "reactive-daemon-failed",
      "reactive-daemon-failed-unsteered",
      "reactive-daemon-failed-after-identification",
      "reactive-daemon-output-before-tool",
    ].includes(mode)
  ) {
    if (mode !== "reactive-daemon-output-before-tool")
      tool("daemon", undefined, "sleep 90");
    message("Daemon started.");
    const identifyDaemon = () => {
      finish(sessionId);
      if (mode === "reactive-daemon-output-before-tool") message("Waiting.");
      if (mode === "reactive-daemon-output-before-tool")
        tool("daemon", undefined, "sleep 90");
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "daemon",
        status: mode === "reactive-daemon-failed" ? "failed" : "in_progress",
        rawInput: { CommandLine: "sleep 90", IsDaemon: true },
      });
    };
    if (
      mode === "reactive-daemon-failed" ||
      mode === "reactive-daemon-failed-unsteered"
    ) {
      identifyDaemon();
      setTimeout(() => {
        if (mode === "reactive-daemon-failed-unsteered")
          complete("daemon", "failed");
        message("Daemon failed.");
      }, 30);
    } else
      endReactiveSteer = (request) => {
        identifyDaemon();
        if (mode === "reactive-daemon-failed-after-identification") {
          complete("daemon", "failed");
          setTimeout(() => message("Done."), 30);
        }
        if (mode === "reactive-daemon-output-before-tool")
          setTimeout(() => message("Done."), 30);
        if (mode === "reactive-daemon-unechoed-steer-output") {
          message("Waiting.");
          setTimeout(() => message("Done."), 30);
        }
        if (mode !== "reactive-steer-daemon")
          send({
            id: request.id,
            error: { code: -32603, message: "Steer rejected" },
          });
        else {
          update(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: request.params.prompt[0].text },
          });
          message("Done.");
          reply(request.id, { stopReason: "end_turn" });
        }
      };
    return;
  }
  if (mode === "reactive-sync-subagent") {
    tool("subagent", {}, "invoke_subagent");
    complete("subagent");
    message("Done.");
    finish(sessionId);
    return;
  }
  tool("daemon", { CommandLine: "sleep 90", IsDaemon: true }, "sleep 90");
  if (mode !== "daemon-only")
    tool(
      "background",
      {
        CommandLine: "sleep 5",
        IsDaemon: false,
        WaitMsBeforeAsync: 500,
      },
      "run_command",
    );
  message(mode === "daemon-only" ? "Daemon started." : "Waiting.");
  reportUsage();
  if (["reactive-sync-answer", "reactive-tool-only"].includes(mode)) {
    complete("background", "completed", {
      CommandLine: "sleep 5",
      WaitMsBeforeAsync: 500,
    });
    if (mode === "reactive-sync-answer") message("Done.");
    finish(sessionId);
    return;
  }
  if (mode === "reactive-steer-limit") {
    endReactiveSteer = (request) => {
      finish(sessionId);
      reply(request.id, { stopReason: "max_tokens" });
    };
    return;
  }
  if (mode === "reactive-steering" || mode === "reactive-steer-ack") {
    endReactiveSteer = (request) => {
      finish(sessionId);
      complete("background");
      if (mode === "reactive-steer-ack") {
        update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: request.params.prompt[0].text },
        });
        message("Acknowledged.");
        reportUsage(); // This usage precedes the still-open steering response.
      }
      reply(request.id, { stopReason: "end_turn" });
      if (mode === "reactive-steer-ack") reportUsage();
      setTimeout(() => {
        message("Done.");
        reportUsage();
      }, 30);
    };
    return;
  }
  finish(sessionId);
  if (mode === "reactive-reordered" || mode === "reactive-final-usage") {
    setTimeout(() => {
      message("Done.");
      if (mode === "reactive-reordered") reportUsage();
      complete("background");
      if (mode === "reactive-final-usage") reportUsage();
    }, 30);
    return;
  }
  if (mode !== "reactive") return;

  reportUsage(); // Even a usage update following end_turn leaves open work.
  setTimeout(() => {
    complete("background");
    tool("subagent", {}, "invoke_subagent");
    message("Waiting again.");
    reportUsage();
    setTimeout(() => {
      complete("subagent", "failed");
      tool("follow-up", {});
      const id = `perm-${++permission}`;
      permissions.set(id, (result) => {
        if (result.outcome.outcome !== "selected") return;
        message("Done.");
        complete("follow-up");
        reportUsage();
      });
      send({
        id,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "follow-up", title: "Reactive approval" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
          ],
        },
      });
    }, 30);
  }, 30);
}

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
          mcpCapabilities: { http: true },
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
      if (mode === "config-hang") return;
      if (req.params.configId === "thought_level") effort = req.params.value;
      return reply(req.id, { configOptions: session(sessionId).configOptions });
    case "session/close":
      return reply(req.id, {});
    case "session/cancel":
      return finish(sessionId, "cancelled");
    case "session/prompt": {
      const text = req.params.prompt[0].text;
      if (
        turn === 1 &&
        ["reactive-stalled-steer", "reactive-budget"].includes(mode)
      ) {
        update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
        });
        if (mode === "reactive-budget")
          send({
            id: `perm-${++permission}`,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: {
                toolCallId: "background",
                title: "Reactive approval",
              },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
              ],
            },
          });
        return;
      }
      if (open.length) {
        if (endReactiveSteer) {
          const finishSteering = endReactiveSteer;
          endReactiveSteer = undefined;
          return finishSteering(req);
        }
        // A prompt during a running turn steers it.
        if (mode === "steer-limit") {
          // No echo, and the turn stops at a limit.
          for (const request of open.splice(0))
            reply(request.id, { stopReason: "end_turn", usage: usage(10, 2) });
          return reply(req.id, {
            stopReason: "max_tokens",
            usage: usage(5, 1),
          });
        }
        if (mode === "steer-mangled-echo-reject") {
          // A user message differing only in inner whitespace, then a reject.
          update(sessionId, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: text.replace(/\s+/g, "") },
          });
          setTimeout(
            () =>
              send({
                id: req.id,
                error: { code: -32603, message: "private-credential-fixture" },
              }),
            200,
          );
          return;
        }
        if (mode === "end-then-reject-steer") {
          // The original turn ends normally, then agy rejects the steer
          // without taking it.
          for (const request of open.splice(0))
            reply(request.id, { stopReason: "end_turn", usage: usage(10, 2) });
          setTimeout(
            () =>
              send({
                id: req.id,
                error: { code: -32603, message: "private-credential-fixture" },
              }),
            100,
          );
          return;
        }
        if (
          mode === "reject-steer" ||
          mode === "late-echo-reject-steer" ||
          mode === "split-echo-reject-steer"
        ) {
          const reject = () =>
            send({
              id: req.id,
              error: { code: -32603, message: "private-credential-fixture" },
            });
          // The late variant rejects only after the prompt's echo arrived.
          if (mode !== "reject-steer") setTimeout(reject, 600);
          else reject();
          return;
        }
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
      const echo = () =>
        update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: echoText(text) },
        });
      // The prompt's echo can trail a steer that was sent right after it.
      if (mode === "late-echo-reject-steer") setTimeout(echo, 300);
      else if (mode === "split-echo-reject-steer") {
        // agy may split an echo; its last chunk trails a steer.
        const words = echoText(text).split(" ");
        update(sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: words.slice(0, -1).join(" ") + " " },
        });
        setTimeout(
          () =>
            update(sessionId, {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: words.at(-1) },
            }),
          300,
        );
      } else echo();
      if (outcome()?.startsWith("reactive") || outcome() === "daemon-only")
        return reactiveTurn(sessionId, outcome());
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
