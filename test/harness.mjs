#!/usr/bin/env node
// Explicit test subprocess. Never included in the published package or selected by production.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { writeSync, appendFileSync } from "node:fs";
const kind = process.env.LOOP_TEST_HARNESS ?? "codex";
let threadId = randomUUID();
const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
let count = 0,
  active = "",
  held = false;
if (process.argv.includes("--version")) {
  console.log(
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
      loggedIn: true,
      authMethod: "api_key",
      apiProvider: "firstParty",
    }),
  );
  process.exit();
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
    out({ type: "result", subtype: "success", is_error: false });
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
if (kind === "pi")
  writeSync(
    3,
    JSON.stringify({
      configured: true,
      subscription: true,
      provider: "openai-codex",
      model: "fixture",
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
    if (type === "get_commands") return result({ commands: [] });
    if (type === "model/list") return result({ data: [] });
    if (type === "get_available_thinking_levels")
      return result({ levels: ["off", "low", "medium", "high"] });
    if (type === "get_available_models") return result({ models: [] });
    if (type === "config/read")
      return result({ config: { model_provider: "openai" } });
    if (type === "thread/start" || type === "thread/resume") {
      if (m.params?.threadId) threadId = m.params.threadId;
      return result({
        thread: { id: threadId, turns: [] },
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
    if (type === "get_state") return result({ sessionId: "pi-1" });
    if (type === "get_messages") return result({ messages: [] });
    if (type === "control_request") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response:
            m.request.subtype === "initialize"
              ? {
                  account: {
                    apiProvider: "firstParty",
                    subscriptionType: "pro",
                    apiKeySource: "user",
                  },
                }
              : {},
        },
      });
      if (m.request.subtype === "interrupt") finish("interrupted");
      return;
    }
    if (type === "turn/interrupt" || type === "abort") {
      result({});
      finish("interrupted");
      return;
    }
    if (type === "turn/steer") {
      if (m.params.expectedTurnId !== active)
        throw new Error("Wrong turn was steered");
      result({ turnId: active });
      setTimeout(() => finish(), 30);
      return;
    }
    if (
      type === "extension_ui_response" ||
      type === "control_response" ||
      (m.id === 101 && m.result)
    ) {
      if (kind === "codex" && m.result?.decision !== "decline")
        throw new Error("Fixture expected native decline decision");
      if (kind === "pi" && m.confirmed !== false)
        throw new Error("Fixture expected native confirm=false");
      if (kind === "claude" && m.response?.response?.behavior !== "deny")
        throw new Error("Fixture expected native deny behavior");
      if (held) finish();
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
      if (text === "wait") return;
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
