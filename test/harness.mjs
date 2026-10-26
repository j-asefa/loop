#!/usr/bin/env node
// Explicit test subprocess. Never included in the published package or selected by production.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { writeSync, appendFileSync, existsSync } from "node:fs";
const kind = process.env.LOOP_TEST_HARNESS ?? "codex";
let threadId = randomUUID();
let thinkingLevel = "medium";
let elicitationChoice;
let mailBridge;
const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
let count = 0,
  active = "",
  held = false,
  // Pi's queued input waiting for its next prompt, as [queue, message].
  piQueue = [];
if (process.argv.includes("--version")) {
  console.log(
    process.env.LOOP_TEST_HARNESS_VERSION ??
      {
        codex: "codex-cli 0.157.0",
        pi: "0.87.1",
        claude: "2.1.282 (Claude Code)",
        opencode: "1.18.32",
      }[kind],
  );
  process.exit();
}
if (process.argv.includes("auth")) {
  console.log(
    JSON.stringify({
      loggedIn: process.env.LOOP_TEST_CLAUDE_AUTH !== "none",
      authMethod:
        process.env.LOOP_TEST_CLAUDE_AUTH === "oauth" ? "claude.ai" : "api_key",
      apiProvider: "firstParty",
      apiKeySource: process.env.LOOP_TEST_CLAUDE_AUTH_KEY_SOURCE || "none",
    }),
  );
  process.exit();
}
if (kind === "claude" && process.argv.includes("--print")) {
  if (process.env.LOOP_TEST_PROBE_AUDIT)
    appendFileSync(process.env.LOOP_TEST_PROBE_AUDIT, "launch\n");
  if (
    process.env.LOOP_TEST_PROBE_FAIL_FILE &&
    existsSync(process.env.LOOP_TEST_PROBE_FAIL_FILE)
  )
    process.exit(1);
  if (process.env.LOOP_TEST_ARGV)
    appendFileSync(
      process.env.LOOP_TEST_ARGV,
      JSON.stringify(process.argv.slice(2)) + "\n",
    );
  const permissionFlag = process.argv.indexOf("--permission-prompt-tool");
  if (
    permissionFlag < 0 ||
    process.argv[permissionFlag + 1] !== "stdio" ||
    process.argv.includes("--permission-prompts")
  ) {
    console.error(
      "Claude requires --permission-prompt-tool stdio for host permission decisions",
    );
    process.exit(1);
  }
}
// Models a harness that keeps running after Loop's pipes close.
if (process.env.LOOP_TEST_OUTLIVE_STDIN) setInterval(() => {}, 1 << 30);
const audit = () => {
  if (process.env.LOOP_TEST_AUDIT)
    appendFileSync(process.env.LOOP_TEST_AUDIT, "prompt\n");
};
const note = (method, params) =>
  out({ method, params: { threadId, ...params } });
function finish(status = "completed") {
  if (kind === "codex") {
    note("item/completed", {
      item: {
        id: "tool-" + count,
        type: "commandExecution",
        command: "cat README.md",
        status: held ? "declined" : "completed",
      },
    });
    note("item/agentMessage/delta", { itemId: active, delta: "done" });
    note("item/completed", {
      item: { id: active, type: "agentMessage", text: "Fixture done" },
    });
    note("thread/tokenUsage/updated", {
      turnId: active,
      tokenUsage: {
        total: { inputTokens: count * 120, outputTokens: count * 30 },
        last: { inputTokens: 120, outputTokens: 30 },
      },
    });
    note("turn/completed", { turn: { id: active, status } });
  }
  if (kind === "claude") {
    out({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-" + count,
            content: held ? "Denied by user" : "Fixture tool output",
            is_error: held,
          },
        ],
      },
    });
    out({
      type: "assistant",
      message: {
        id: active,
        content: [{ type: "text", text: "Fixture done" }],
      },
    });
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 80,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
        output_tokens: 30,
      },
      ...(process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS
        ? { origin: { kind: "human" } }
        : {}),
    });
  }
  if (kind === "pi") {
    out({
      type: "tool_execution_end",
      toolCallId: "tool-" + count,
      toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: held ? "Denied by extension" : "Fixture tool output",
          },
        ],
      },
      isError: held,
    });
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Fixture done" }],
      },
    });
    out({ type: "agent_end" });
    setTimeout(() => out({ type: "agent_settled" }), 25);
  }
  held = false;
}
let piModel = { provider: "openai-codex", id: "fixture" };
if (kind === "pi")
  writeSync(
    3,
    JSON.stringify({
      configured: true,
      subscription: process.env.LOOP_TEST_PI_AUTH !== "api",
      provider: "openai-codex",
      model: "fixture",
      modelEfforts: [
        {
          id: "openai-codex/fixture",
          levels: ["off", "low", "medium", "high"],
        },
        { id: "openai-codex/plain", levels: ["off"] },
      ],
      modelBilling: [
        { id: "openai-codex/fixture", subscription: true },
        { id: "openai-codex/plain", subscription: true },
        { id: "openai/fixture", subscription: false },
      ],
    }) + "\n",
  );
if (kind !== "opencode") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line),
      type = m.method ?? m.type;
    const result = (value) =>
      out(
        kind === "pi"
          ? {
              type: "response",
              id: m.id,
              command: type,
              success: true,
              data: value,
            }
          : { id: m.id, result: value },
      );
    if (type === "initialize") return result({});
    if (type === "account/read")
      return result({ account: { type: "chatgpt", planType: "plus" } });
    if (type === "skills/list") return result({ data: [] });
    if (type === "get_commands")
      return result({
        commands: process.env.LOOP_TEST_PI_LARGE_CATALOG
          ? Array.from({ length: 120 }, (_, i) => ({
              name: `large-${i}`,
              source: "extension",
              description: "x".repeat(30_000),
            }))
          : process.env.LOOP_TEST_PI_COMMAND_METADATA
            ? [
                {
                  name: "fixture-command",
                  source: "extension",
                  description: "Fixture command",
                  sourceInfo: {
                    source: "fixture",
                    scope: "user",
                    packageId: "fixture-package",
                  },
                },
              ]
            : [],
      });
    if (type === "model/list") return result({ data: [] });
    if (type === "get_available_thinking_levels")
      return result({ levels: ["off", "low", "medium", "high"] });
    if (type === "get_available_models")
      return result({
        models: [
          { provider: "openai-codex", id: "fixture", name: "Fixture" },
          { provider: "openai-codex", id: "plain", name: "Plain" },
          ...Array.from(
            { length: Number(process.env.LOOP_TEST_PI_MODEL_COUNT || 0) },
            (_, i) => ({
              provider: "openai-codex",
              id:
                i === 0 && process.env.LOOP_TEST_PI_LONG_MODEL_ID
                  ? "custom-" + "x".repeat(250)
                  : `model-${i}`,
              name: i === 0 ? "Long model name ".repeat(60) : `Model ${i}`,
            }),
          ),
          ...(process.env.LOOP_TEST_PI_API_MODEL
            ? [{ provider: "openai", id: "fixture", name: "Fixture" }]
            : []),
        ],
      });
    if (type === "set_model") {
      piModel = { provider: m.provider, id: m.modelId };
      if (process.env.LOOP_TEST_PI_MODEL_AUDIT)
        appendFileSync(process.env.LOOP_TEST_PI_MODEL_AUDIT, piModel.id + "\n");
      return result({});
    }
    if (type === "set_thinking_level") {
      thinkingLevel = m.level;
      return result({});
    }
    if (type === "config/read")
      return result({
        config: {
          model_provider: "openai",
          ...(process.env.LOOP_TEST_CODEX_NULL_MODEL ? { model: null } : {}),
        },
      });
    if (type === "thread/start" || type === "thread/resume") {
      mailBridge = m.params?.config?.["mcp_servers.loop_workspace"];
      if (
        type === "thread/resume" &&
        process.env.LOOP_TEST_REQUIRE_RESUME_CWD &&
        m.params.cwd !== process.cwd()
      )
        return out({
          id: m.id,
          error: {
            code: -32602,
            message: "Resume must select the bound workspace directory",
          },
        });
      if (type === "thread/resume" && process.env.LOOP_TEST_CODEX_WRITER_BUSY)
        return out({
          id: m.id,
          error: {
            code: -32600,
            // Codex owns this wording: "reworded" stands in for an upstream
            // change Loop must still recognise.
            message:
              process.env.LOOP_TEST_CODEX_WRITER_BUSY === "reworded"
                ? `conversation ${m.params.threadId} already has an active writer (pid 4121); retry later.`
                : `thread ${m.params.threadId} already has an active writer`,
          },
        });
      if (m.params?.threadId) threadId = m.params.threadId;
      if (type === "thread/resume" && process.env.LOOP_TEST_LARGE_CODEX_HISTORY)
        return result({
          thread: {
            id: threadId,
            turns: m.params.excludeTurns
              ? []
              : [
                  {
                    items: [
                      {
                        id: "large-history",
                        type: "agentMessage",
                        text: "x".repeat(9 * 1024 * 1024),
                      },
                    ],
                  },
                ],
          },
          modelProvider: "openai",
          model: "fixture",
        });
      return result({
        thread: {
          id: threadId,
          turns: process.env.LOOP_TEST_ASYNC_HISTORY
            ? [
                {
                  items: [
                    {
                      id: "old-question",
                      type: "agentMessage",
                      text: "Old question",
                      delivery: "async",
                      questions: [
                        { title: "Old question", options: ["Yes", "No"] },
                      ],
                    },
                  ],
                },
              ]
            : [],
        },
        modelProvider: "openai",
        model: "fixture",
      });
    }
    if (type === "thread/list")
      return result({
        data: [
          {
            id: "external-thread",
            cwd: process.env.LOOP_TEST_HISTORY_PROJECT || process.cwd(),
            preview: "External fixture history",
          },
        ],
        nextCursor: null,
      });
    if (type === "thread/read" || type === "thread/fork")
      return result({
        thread: {
          id: type === "thread/fork" ? randomUUID() : m.params.threadId,
          turns: [
            {
              items: [
                {
                  id: "external-message",
                  type: "agentMessage",
                  text: "Native saved context",
                },
              ],
            },
          ],
        },
      });
    if (type === "get_state")
      return result({
        sessionId: process.env.LOOP_TEST_PI_SESSION_ID || "pi-1",
        model: piModel,
        thinkingLevel,
        isStreaming: !!active && !piQueue.length,
        pendingMessageCount: piQueue.length,
      });
    if (type === "clear_queue") {
      const cleared = { steering: [], followUp: [] };
      for (const [queue, message] of piQueue) cleared[queue].push(message);
      piQueue = [];
      return result(cleared);
    }
    // Test-only: what Pi still holds for its next prompt.
    if (type === "fixture_queue") return result({ queue: piQueue });
    if (type === "follow_up" && kind === "pi") {
      piQueue.push(["followUp", m.message]);
      return result({});
    }
    if (type === "get_messages") return result({ messages: [] });
    if (type === "control_request") {
      if (
        m.request.subtype === "set_permission_mode" &&
        process.env.LOOP_TEST_SETTING_AUDIT
      ) {
        appendFileSync(
          process.env.LOOP_TEST_SETTING_AUDIT,
          m.request.mode + "\n",
        );
        if (m.request.mode === "plan" && process.env.LOOP_TEST_SETTING_DROP)
          process.exit(0);
      }
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response:
            m.request.subtype === "initialize"
              ? {
                  account: {
                    apiProvider:
                      process.env.LOOP_TEST_CLAUDE_PROVIDER || "firstParty",
                    subscriptionType: "pro",
                    apiKeySource:
                      process.env.LOOP_TEST_CLAUDE_KEY_SOURCE ||
                      (process.env.LOOP_TEST_CLAUDE_AUTH === "oauth"
                        ? "none"
                        : "user"),
                  },
                }
              : {},
        },
      });
      if (m.request.subtype === "interrupt") {
        if (process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS)
          out({
            type: "result",
            is_error: false,
            origin: { kind: "task-notification" },
          });
        finish("interrupted");
      }
      return;
    }
    if (type === "turn/interrupt" || type === "abort") {
      result({});
      finish("interrupted");
      return;
    }
    if (type === "steer" && kind === "pi") {
      if (!active) throw new Error("Pi was steered without a turn");
      // Models a steer arriving after Pi's last check: it waits for the
      // next prompt instead of joining the turn. With "late-behind" an
      // extension's follow-up was already queued ahead of it; with
      // "late-read" Pi read it, but an extension's follow-up arrived after.
      if (piQueue.length || m.message.startsWith("late")) {
        if (m.message === "late-behind" || m.message === "late-read")
          piQueue.push(["followUp", "extension follow-up"]);
        if (m.message !== "late-read") piQueue.push(["steering", m.message]);
        return result({ disposition: "queued" });
      }
      result({ disposition: "queued" });
      setTimeout(() => finish(), 30);
      return;
    }
    if (type === "turn/steer") {
      if (m.params.expectedTurnId !== active)
        throw new Error("Wrong turn was steered");
      if (
        process.env.LOOP_TEST_ASYNC_ANSWER &&
        !m.params.input[0].text.includes('"Wait for active agents"')
      )
        throw new Error("Missing async question answer");
      result({ turnId: active });
      setTimeout(() => finish(), 30);
      return;
    }
    if (
      type === "extension_ui_response" ||
      type === "control_response" ||
      ([101, 102].includes(m.id) && m.result)
    ) {
      if (kind === "codex" && m.id === 102) {
        const expected = {
          action: elicitationChoice,
          content: elicitationChoice === "accept" ? {} : null,
        };
        if (JSON.stringify(m.result) !== JSON.stringify(expected))
          throw new Error(
            "Incorrect MCP confirmation response: " + JSON.stringify(m.result),
          );
        if (held) finish();
        return;
      }
      if (kind === "codex" && m.result?.decision !== "decline")
        throw new Error("Fixture expected native decline decision");
      if (kind === "pi" && m.confirmed !== false)
        throw new Error("Fixture expected native confirm=false");
      if (kind === "claude" && m.response?.response?.behavior !== "deny")
        throw new Error("Fixture expected native deny behavior");
      if (process.env.LOOP_TEST_DECISION_AUDIT)
        appendFileSync(process.env.LOOP_TEST_DECISION_AUDIT, "answer\n");
      if (held && !process.env.LOOP_TEST_DECISION_HOLD) finish();
      return;
    }
    if (type === "prompt" && m.message === "/loop-status") {
      writeSync(
        3,
        JSON.stringify({
          configured: true,
          subscription: true,
          provider: "openai-codex",
          model: "fixture",
        }) + "\n",
      );
      result({});
      return;
    }
    if (["turn/start", "prompt", "user"].includes(type)) {
      audit();
      active = "turn-" + ++count;
      const text =
        type === "turn/start"
          ? m.params.input[0].text
          : type === "prompt"
            ? m.message
            : m.message.content;
      if (kind === "codex") {
        note("turn/started", { turn: { id: active } });
        result({ turn: { id: active, status: "inProgress" } });
        note("item/agentMessage/delta", { itemId: active, delta: "Fixture " });
        note("item/started", {
          item: {
            type: "commandExecution",
            id: "tool-" + count,
            command: "cat README.md",
          },
        });
      }
      if (kind === "pi") {
        result({});
        out({ type: "agent_start" });
        out({ type: "message_start", message: { role: "assistant" } });
        out({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Fixture " },
        });
        out({
          type: "tool_execution_start",
          toolCallId: "tool-" + count,
          toolName: "read",
          args: { path: "README.md" },
        });
      }
      if (kind === "claude") {
        if (process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS) {
          if (m.origin?.kind !== "human")
            throw new Error("Loop prompts must declare human origin");
          for (const origin of [
            "task-notification",
            "peer",
            "channel",
            "future-origin",
          ])
            out({
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: m.session_id,
              origin: { kind: origin },
            });
          out({
            type: "result",
            is_error: true,
            errors: ["Background failure"],
            origin: { kind: "task-notification" },
          });
          out({
            type: "result",
            is_error: false,
            session_id: "another-session",
          });
          out({ type: "result", is_error: false, parent_tool_use_id: "child" });
        }
        out({
          type: "stream_event",
          event: { type: "message_start", message: { id: active } },
        });
        out({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Fixture " },
          },
        });
        out({
          type: "assistant",
          message: {
            id: active,
            content: [
              {
                type: "tool_use",
                id: "tool-" + count,
                name: "Read",
                input: { file_path: "README.md" },
              },
            ],
          },
        });
      }
      if (
        process.env.LOOP_TEST_AGENT_MAIL &&
        text.includes("To reply, call loop_message")
      ) {
        // Exercise the production authenticated native bridge from a real
        // subprocess, without a provider/model request.
        void (async () => {
          const call = async (body) => {
            const r = await fetch(mailBridge.url + "/pi", {
              method: "POST",
              headers: {
                ...mailBridge.http_headers,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error("Bridge refused fixture");
            return r.json();
          };
          const catalog = await call({ method: "tools/list" });
          if (
            ![
              "loop_agents",
              "loop_message",
              "loop_message_status",
              "loop_handoff",
            ].every((name) => catalog.tools.some((t) => t.name === name))
          )
            throw new Error("Missing mail catalog");
          const directory = await call({
            method: "tools/call",
            id: "discover",
            name: "loop_agents",
            arguments: {},
          });
          if (directory.isError) throw new Error("Discovery failed");
          const reply =
            /To reply, call loop_message with to "([^"]+)" and threadId "([^"]+)"/.exec(
              text,
            );
          const request = {
            method: "tools/call",
            id: "native-reply",
            name: "loop_message",
            arguments: {
              to: reply[1],
              threadId: reply[2],
              body: "Native reply: target v2.",
            },
          };
          const receipt = await call(request);
          if (
            receipt.isError ||
            JSON.stringify(await call(request)) !== JSON.stringify(receipt)
          )
            throw new Error("Native mail receipt failed");
          finish();
        })().catch((error) => {
          process.stderr.write(error.message);
          finish("failed");
        });
        return;
      }
      if (text === "wait") return;
      if (kind === "codex" && text === "latency-stream") {
        let index = 0;
        const timer = setInterval(() => {
          const item = {
            id: "latency-" + index,
            type: "agentMessage",
            text: ("Streaming fixture " + index + " ").repeat(400),
          };
          note("item/started", { item: { ...item, text: "" } });
          note("item/agentMessage/delta", {
            itemId: item.id,
            delta: item.text,
          });
          note("item/completed", { item });
          if (++index === 80) {
            clearInterval(timer);
            finish();
          }
        }, 100);
        return;
      }
      if (kind === "codex" && text.startsWith("mcp-")) {
        held = true;
        const [choice, params] = text.slice(4).split("\n");
        elicitationChoice = choice;
        out({
          id: 102,
          method: "mcpServer/elicitation/request",
          params: {
            ...JSON.parse(params),
            threadId,
            turnId: active,
          },
        });
        return;
      }

      if (kind === "codex" && text.startsWith("async-question")) {
        const item = {
          id: "async-question-" + count,
          type: "agentMessage",
          text: "Restart now or wait?",
          phase: "final_answer",
          delivery: "async",
          questions: [
            {
              title: "Restart now or wait?",
              options: ["Wait for active agents", "Restart now"],
            },
          ],
        };
        note("item/started", { item });
        note("item/completed", { item });
        note("item/completed", { item });
        if (text === "async-question-finish") finish();
        return;
      }
      if (
        kind === "codex" &&
        process.env.LOOP_TEST_ASYNC_ANSWER &&
        !text.includes('"Wait for active agents"')
      )
        throw new Error("Missing async question answer");
      if (text === "approve") {
        held = true;
        if (kind === "codex")
          out({
            id: 101,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId: active,
              command: "cat README.md",
              itemId: "tool-" + count,
            },
          });
        if (kind === "pi")
          out({
            type: "extension_ui_request",
            id: "101",
            method: "confirm",
            title: "Read file?",
            message: "README.md",
          });
        if (kind === "claude")
          out({
            type: "control_request",
            request_id: "101",
            request: {
              subtype: "can_use_tool",
              tool_name: "Read",
              input: { file_path: "README.md" },
            },
          });
        if (kind === "claude" && process.env.LOOP_TEST_CLAUDE_INJECTED_RESULTS)
          out({
            type: "result",
            is_error: false,
            origin: { kind: "task-notification" },
          });
      } else
        setTimeout(() => finish(text === "fail" ? "failed" : "completed"), 30);
    }
  });
} else {
  const streams = new Set();
  let streamReady;
  const listening = new Promise((resolve) => {
    streamReady = resolve;
  });
  let history = [],
    permissions = [];
  const event = (type, properties) => {
    for (const s of streams)
      s.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
  };
  const end = () => {
    event("message.part.updated", {
      part: {
        id: "prt_tool",
        sessionID: "ses_1",
        messageID: "msg_a",
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output: "Fixture tool settled",
        },
      },
    });
    event("message.part.updated", {
      part: {
        id: active,
        sessionID: "ses_1",
        messageID: "msg_a",
        type: "text",
        text: "Fixture done",
      },
    });
    event("session.status", { sessionID: "ses_1", status: { type: "idle" } });
  };
  const server = createServer(async (req, res) => {
    if (
      req.headers.authorization !==
      "Basic " +
        Buffer.from("loop:" + process.env.OPENCODE_SERVER_PASSWORD).toString(
          "base64",
        )
    ) {
      res.writeHead(401).end();
      return;
    }
    const path = new URL(req.url, "http://localhost").pathname;
    let input = "";
    for await (const b of req) input += b;
    const data = input ? JSON.parse(input) : {};
    if (path === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Split both CRLF pairs across writes to exercise streaming SSE framing.
      res.write(
        'data: {"type":"fixture.noop","properties":{"sessionID":"ses_1"}}\r',
      );
      await new Promise((r) => setTimeout(r, 5));
      res.write("\n\r");
      await new Promise((r) => setTimeout(r, 5));
      res.write("\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      streamReady();
      return;
    }
    let answer = {};
    if (path === "/session") answer = { id: "ses_1" };
    if (path === "/config") answer = { model: "fixture/model" };
    if (path.endsWith("/message")) answer = history;
    if (path === "/permission") answer = permissions;
    if (path === "/question") answer = [];
    if (path.endsWith("prompt_async")) {
      await listening;
      audit();
      active = "prt_" + ++count;
      const text = data.parts[0].text;
      event("session.status", { sessionID: "ses_1", status: { type: "busy" } });
      event("message.updated", {
        info: { id: "msg_a", role: "assistant", sessionID: "ses_1" },
      });
      event("message.part.updated", {
        part: {
          id: active,
          sessionID: "ses_1",
          messageID: "msg_a",
          type: "text",
          text: "",
        },
      });
      event("message.part.delta", {
        sessionID: "ses_1",
        messageID: "msg_a",
        partID: active,
        field: "text",
        delta: "Fixture ",
      });
      event("message.part.updated", {
        part: {
          id: "prt_tool",
          sessionID: "ses_1",
          messageID: "msg_a",
          type: "tool",
          tool: "read",
          state: { status: "running", input: {} },
        },
      });
      if (text === "approve") {
        permissions = [
          {
            id: "per_101",
            sessionID: "ses_1",
            permission: "read",
            patterns: ["README.md"],
            metadata: {},
          },
        ];
        event("permission.asked", permissions[0]);
      } else if (text !== "wait") setTimeout(end, 30);
      res.writeHead(204).end();
      return;
    }
    if (path.endsWith("/reply")) {
      if (data.reply !== "reject")
        throw new Error("Fixture expected native reject permission");
      event("permission.replied", { sessionID: "ses_1", requestID: "per_101" });
      permissions = [];
      end();
    }
    if (path.endsWith("/abort")) end();
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(answer));
  });
  server.listen(0, "127.0.0.1", () =>
    console.log(
      "opencode server listening on http://127.0.0.1:" + server.address().port,
    ),
  );
}
