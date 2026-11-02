#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (value) => {
  if (process.env.LOOP55_TEST_AGY_LOG)
    appendFileSync(
      process.env.LOOP55_TEST_AGY_LOG,
      JSON.stringify(value) + "\n",
    );
};
log({ args, pid: process.pid });
const mode = process.env.LOOP55_TEST_AGY_MODE;
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
if (
  args.includes("--acp") ||
  args.includes("--dangerously-skip-permissions") ||
  !args.includes("--disable-slash-commands")
)
  process.exit(90);
const send = (message) => console.log(JSON.stringify(message));
const resume = args.indexOf("--conversation");
const conversation =
  resume >= 0
    ? args[resume + 1]
    : process.env.LOOP55_TEST_AGY_SESSION_ID || "agy-fixture-session";
if (process.env.LOOP55_TEST_AGY_SLOW_STOP) {
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
  if (message.event !== "user" || typeof message.message?.content !== "string")
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
      status: mode || "SUCCESS",
      response: "Antigravity fixture answer",
      error: "private-credential-fixture",
      num_turns: count,
      usage: { input_tokens: count * 999, output_tokens: count * 999 },
    },
  });
});
