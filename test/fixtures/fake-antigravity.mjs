#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
// Catalog discovery runs beside the session, so it logs to its own file and
// never interleaves with the session's launch and prompt records.
const log = (value) => {
  if (process.env.LOOP_TEST_AGY_LOG)
    appendFileSync(
      process.env.LOOP_TEST_AGY_LOG +
        (args[0] === "acp" && !args.includes("--process-per-session")
          ? ".acp"
          : ""),
      JSON.stringify(value) + "\n",
    );
};
log({ args, pid: process.pid });
const mode = process.env.LOOP_TEST_AGY_MODE;
if (args[0] === "--version") {
  console.log("1.4.9");
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
if (args[0] === "acp" && args.includes("--process-per-session")) {
  await import("./antigravity-acp.mjs");
  process.exit(0);
}
if (args[0] === "acp") {
  // Catalog discovery only: initialize, open a session, read the advertised
  // commands and close it. Any prompt or other request fails the fixture.
  if (mode === "acp-failure") process.exit(1);
  const reply = (id, result) =>
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    log({ acp: message.method, params: message.params });
    if (message.jsonrpc !== "2.0") process.exit(92);
    if (message.method === "initialize")
      return reply(message.id, { protocolVersion: 1 });
    if (message.method === "session/new") {
      reply(message.id, { sessionId: "agy-acp-catalog" });
      if (mode === "acp-silent") process.exit(0);
      // Stays connected without ever advertising a catalog; the slow-stop
      // variant also ignores SIGTERM until forced.
      if (mode === "acp-hang-slow-stop") {
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      }
      if (mode?.startsWith("acp-hang")) return;
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "agy-acp-catalog",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "plan", description: "Plan before executing." },
                {
                  name: "antigravity-guide",
                  description: "Guide\u0007 to agy.",
                },
                { name: "bad name", description: "Rejected." },
                { name: "plan", description: "Duplicate." },
              ],
            },
          },
        }),
      );
      return;
    }
    if (message.method === "session/close")
      return mode === "acp-close-hang" ? undefined : reply(message.id, {});
    process.exit(93);
  });
} else {
  if (
    args.includes("--acp") ||
    args.includes("--dangerously-skip-permissions") ||
    args.includes("--disable-slash-commands")
  )
    process.exit(90);
  const send = (message) => console.log(JSON.stringify(message));
  const resume = args.indexOf("--conversation");
  const conversation =
    resume >= 0
      ? args[resume + 1]
      : process.env.LOOP_TEST_AGY_SESSION_ID || "agy-fixture-session";
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
  send({
    event: "init",
    conversation_id: mode === "wrong-resume" ? "other-session" : conversation,
    init: {
      permission_mode: "request-review",
      privateCredential: "private-credential-fixture",
      model: args.includes("--model")
        ? args[args.indexOf("--model") + 1]
        : undefined,
    },
  });
  let count = 0;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    log(message);
    if (
      message.event !== "user" ||
      typeof message.message?.content !== "string"
    )
      process.exit(91);
    count++;
    if (mode === "hang") return;
    const step = (body) =>
      send({
        event: "step_update",
        step_update: { conversation_id: conversation, ...body },
      });
    if (mode === "soft-denied") {
      // Print mode soft-denies a tool needing approval, then reports SUCCESS
      // with an empty response; its explanation goes only to stderr.
      step({
        step_index: count * 3,
        step_type: "tool",
        state: "DONE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "ls -la" } },
      });
      console.error(
        'Print mode: soft-denying tool confirmation "RunCommand" private-credential-fixture',
      );
      send({
        event: "result",
        result: {
          conversation_id: conversation,
          status: "SUCCESS",
          response: "",
        },
      });
      return;
    }
    step({
      step_index: count * 3,
      step_type: "tool",
      state: "DONE",
      tool_name: "run_command",
      tool_info: {
        parameters: { CommandLine: "echo fixture" },
        output: "fixture",
      },
    });
    step({
      step_index: count * 3 + 1,
      step_type: "agent_response",
      state: "ACTIVE",
      text_delta: "Antigravity ",
    });
    if (mode === "disconnect") process.exit(2);
    step({
      step_index: count * 3 + 1,
      step_type: "agent_response",
      state: "DONE",
      text_delta: "fixture answer",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    step({
      step_index: count * 3 + 2,
      step_type: "checkpoint",
      state: "DONE",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    if (mode === "foreign-result") {
      send({
        event: "result",
        result: {
          conversation_id: "other-session",
          status: "SUCCESS",
          response: "foreign private answer",
        },
      });
      return;
    }
    send({
      event: "result",
      result: {
        conversation_id: conversation,
        status: mode && !mode.startsWith("acp-") ? mode : "SUCCESS",
        response: "Antigravity fixture answer",
        error: "private-credential-fixture",
        num_turns: count,
        usage: { input_tokens: count * 999, output_tokens: count * 999 },
      },
    });
  });
}
