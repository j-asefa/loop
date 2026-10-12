#!/usr/bin/env node
// Explicit subprocess fixture for background subscription projections.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const log = (value) =>
  appendFileSync(
    process.env.LOOP_TEST_BRIEF_CALLS,
    JSON.stringify(value) + "\n",
  );
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
log({
  args,
  cwd: process.cwd(),
  pid: process.pid,
  github: !!process.env.GH_TOKEN,
});
const auth = process.env.LOOP_TEST_BRIEF_AUTH || "subscription";
function output(prompt) {
  log({ prompt });
  assert(!prompt.includes("native tools enabled"));
  assert(
    prompt.includes(
      "Native tools, commands, workspace access and external actions are unavailable",
    ),
  );
  const ref = /\[(res_[^\]]+)\]/.exec(prompt)?.[1];
  assert(ref, "Requires a result citation");
  return {
    kind: "tool",
    text: "",
    tool: "submit_brief",
    arguments: JSON.stringify({
      headline: { text: "Subscription brief", cite: [{ ref }] },
      items: [],
    }),
  };
}
function finish(prompt, model, callback) {
  const value = output(prompt);
  if (model === "wait") return setInterval(() => {}, 1000);
  if (
    model === "invalid" ||
    (model === "retry" && !prompt.includes("Your previous submit_brief"))
  )
    value.arguments = "{}";
  setTimeout(() => callback(value), model === "slow" ? 250 : 5);
}
if (args.includes("app-server")) {
  let model;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    log({ rpc: message });
    if (message.id == null) return;
    let result = {};
    if (message.method === "account/read")
      result = { account: { type: auth === "api" ? "apiKey" : "chatgpt" } };
    if (message.method === "config/read")
      result = {
        config: {
          model_provider: "openai",
          ...(process.env.LOOP_TEST_BRIEF_DEFAULT === "catalog"
            ? {}
            : {
                model:
                  message.params.cwd === process.env.LOOP_TEST_BRIEF_PROJECT
                    ? "project-default"
                    : "global-default",
              }),
          ...(auth === "alternate"
            ? {
                model_providers: {
                  openai: { base_url: "https://example.invalid" },
                },
              }
            : {}),
          mcp_servers: { outside: { command: "forbidden" } },
          plugins: { "outside@fixture": { enabled: true } },
        },
      };
    if (message.method === "model/list")
      result = {
        data: [
          { id: "other-model" },
          { id: "catalog-default", isDefault: true },
        ],
      };
    if (message.method === "thread/start") {
      assert.equal(message.params.sandbox, "read-only");
      assert.equal(message.params.approvalPolicy, "never");
      assert.equal(message.params.ephemeral, true);
      assert.equal(message.params.config["features.shell_tool"], false);
      assert.equal(message.params.config["features.apps"], false);
      assert.equal(message.params.config.mcp_servers.outside.enabled, false);
      assert.equal(
        message.params.config.plugins["outside@fixture"].enabled,
        false,
      );
      model = message.params.model;
      result = {
        thread: { id: "brief-thread" },
        modelProvider: "openai",
        approvalPolicy: "never",
        sandbox: { type: model === "unsafe" ? "dangerFullAccess" : "readOnly" },
      };
    }
    if (message.method === "turn/start") {
      assert.deepEqual(message.params.outputSchema.properties.kind.enum, [
        "tool",
      ]);
      assert.deepEqual(message.params.outputSchema.properties.tool.enum, [
        "submit_brief",
      ]);
      result = { turn: { id: "brief-turn" } };
      finish(message.params.input[0].text, model, (value) => {
        send({
          id: "ungranted-action",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "brief-thread", turnId: "brief-turn" },
        });
        send({
          method: "item/completed",
          params: {
            threadId: "brief-thread",
            turnId: "brief-turn",
            item: { type: "agentMessage", text: JSON.stringify(value) },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: "brief-thread",
            turn: { id: "brief-turn", status: "completed" },
          },
        });
      });
    }
    send({ id: message.id, result });
  });
} else if (args[0] === "auth") {
  assert.equal(args[1], "status");
  send({
    loggedIn: true,
    authMethod: auth === "api" ? "api_key" : "claude.ai",
    apiProvider: "firstParty",
    apiKeySource: auth === "alternate" ? "apiKeyHelper" : "none",
  });
} else {
  assert(args.includes("--tools"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert(args.includes("--strict-mcp-config"));
  assert(args.includes("--disable-slash-commands"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(
    JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks,
    true,
  );
  assert.deepEqual(
    JSON.parse(args[args.indexOf("--json-schema") + 1]).properties.tool.enum,
    ["submit_brief"],
  );
  let prompt = "";
  process.stdin.on("data", (chunk) => (prompt += chunk));
  process.stdin.on("end", () =>
    finish(prompt, args[args.indexOf("--model") + 1], (value) => {
      send({
        type: "result",
        subtype: "success",
        structured_output: value,
        session_id: "brief-claude",
      });
    }),
  );
}
