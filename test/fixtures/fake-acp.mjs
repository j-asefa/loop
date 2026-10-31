#!/usr/bin/env node
import readline from "node:readline";
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const mode = process.argv[2] || "";
let level = "normal";
let currentMode = "ask";
const modes = () => ({
  currentModeId: currentMode,
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "code", name: "Code" },
  ],
});
const config = () => [
  {
    id: "level",
    name: "Level",
    type: "select",
    currentValue: level,
    options: [
      { value: "normal", name: "Normal" },
      { value: "deep", name: "Deep" },
    ],
  },
];
const update = (sessionId, body) =>
  send({ method: "session/update", params: { sessionId, update: body } });
let waitingPrompt, fleetBridge;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (mode === "probe-only" && request.method !== "initialize") {
    send({
      id: request.id,
      error: {
        code: -32603,
        message: "Probe must not create or load sessions",
      },
    });
    continue;
  }
  if (request.id === "permission-1" && waitingPrompt) {
    send({ id: waitingPrompt.id, result: { stopReason: "end_turn" } });
    waitingPrompt = undefined;
    continue;
  }
  if (request.method === "initialize")
    send({
      id: request.id,
      result: {
        protocolVersion: mode === "wrong-version" ? 99 : 1,
        agentCapabilities: {
          loadSession: mode !== "no-load",
          ...(process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER
            ? { mcpCapabilities: { http: true } }
            : {}),
        },
        authMethods:
          mode === "secret-setup"
            ? [{ id: "secret-auth-token", name: "secret-auth-token" }]
            : [],
      },
    });
  else if (request.method === "session/new") {
    if (process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER) {
      const { acpBridge } = await import(
        process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER
      );
      fleetBridge = acpBridge(request.params.mcpServers);
    }
    if (mode === "secret-setup") {
      send({
        id: request.id,
        error: { code: -32603, message: "setup failed: secret-setup-token" },
      });
      continue;
    }
    send({
      id: request.id,
      result: {
        sessionId: process.env.LOOP55_TEST_ACP_SESSION_ID || "fake-session",
        ...([
          "rich",
          "slow-setting",
          "secret-errors",
          "remove-setting",
        ].includes(mode)
          ? { configOptions: config(), modes: modes() }
          : {}),
      },
    });
  } else if (request.method === "session/load") {
    if (process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER) {
      const { acpBridge } = await import(
        process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER
      );
      fleetBridge = acpBridge(request.params.mcpServers);
    }
    send({
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed text" },
        },
      },
    });
    send({
      id: request.id,
      result:
        mode === "rich" ? { configOptions: config(), modes: modes() } : {},
    });
  } else if (request.method === "session/set_mode") {
    currentMode = request.params.modeId;
    update(request.params.sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: currentMode,
    });
    send({ id: request.id, result: {} });
  } else if (request.method === "session/set_config_option") {
    if (mode === "slow-setting")
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (mode === "secret-errors") {
      send({
        id: request.id,
        error: {
          code: -32603,
          message: "setting rejected: secret-setting-token",
        },
      });
    } else if (
      !["rich", "slow-setting"].includes(mode) ||
      request.params.configId !== "level" ||
      request.params.value === "reject"
    )
      send({
        id: request.id,
        error: { code: -32602, message: "Rejected setting" },
      });
    else {
      level = request.params.value;
      send({ id: request.id, result: { configOptions: config() } });
    }
  } else if (request.method === "session/prompt") {
    const text = request.params.prompt
      .map((part) => part.text ?? "")
      .join("\n");
    if (
      process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER &&
      text.startsWith("Fleet discovery fixture: ")
    ) {
      const { discover } = await import(
        process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER
      );
      await discover(text, fleetBridge);
      update(request.params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Fixture discovery done" },
      });
      send({ id: request.id, result: { stopReason: "end_turn" } });
      continue;
    }
    if (mode === "secret-errors") {
      send({
        id: request.id,
        error: { code: -32603, message: "prompt failed: secret-prompt-token" },
      });
      continue;
    }
    if (mode === "billing-error") {
      // The shape Grok Build 1.0.70 returns when the account has no credits.
      send({
        id: request.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: {
            message: "API error (status 402): secret-billing-detail",
            http_status: 402,
          },
        },
      });
      continue;
    }
    if (mode === "crash") process.exit(23);
    if (mode === "oversized-frame") {
      update(request.params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(8 * 1024 * 1024) },
      });
      continue;
    }
    if (mode === "permission" || mode === "permission-bounded") {
      waitingPrompt = request;
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: request.params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Write file" },
          options: [
            { optionId: "once-yes", name: "Allow once", kind: "allow_once" },
            { optionId: "once-no", name: "Deny once", kind: "reject_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
            ...(mode === "permission-bounded"
              ? [
                  ...Array.from({ length: 23 }, (_, i) => ({
                    optionId: `extra-${i}`,
                    name: `Extra ${i}`,
                    kind: "allow_once",
                  })),
                  { optionId: "hidden", name: "Hidden", kind: "allow_once" },
                ]
              : []),
          ],
        },
      });
      continue;
    }
    send({
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "answer" },
        },
      },
    });
    if (mode === "remove-setting")
      update(request.params.sessionId, {
        sessionUpdate: "config_option_update",
        configOptions: [],
      });
    if (mode === "replaced-output") {
      for (const status of ["completed", "failed"])
        for (const replacement of ["empty", "image"])
          for (const combined of [false, true]) {
            const toolCallId = `output-${status}-${replacement}-${combined}`;
            update(request.params.sessionId, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: "Run command",
              kind: "execute",
              rawInput: { command: "gh pr create --fill" },
              status: "in_progress",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "retained output" },
                },
              ],
            });
            update(request.params.sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              ...(combined ? { status } : {}),
              content:
                replacement === "empty"
                  ? []
                  : [
                      {
                        type: "content",
                        content: {
                          type: "image",
                          data: "",
                          mimeType: "image/png",
                        },
                      },
                    ],
            });
            if (!combined)
              update(request.params.sessionId, {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status,
              });
          }
    }
    if (mode === "replaced-diffs") {
      for (const status of ["completed", "failed"]) {
        for (const replacement of ["text", "empty"]) {
          for (const combined of [false, true]) {
            const toolCallId = `replace-${status}-${replacement}-${combined}`;
            update(request.params.sessionId, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: "Edit",
              kind: "edit",
              status: "in_progress",
              content: [
                {
                  type: "diff",
                  path: "/retained",
                  oldText: "before",
                  newText: "after",
                },
              ],
            });
            update(request.params.sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              content:
                replacement === "empty"
                  ? []
                  : [
                      {
                        type: "content",
                        content: { type: "text", text: "Done editing" },
                      },
                    ],
              ...(combined ? { status } : {}),
            });
            if (!combined)
              update(request.params.sessionId, {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status,
              });
          }
        }
      }
    }
    if (mode === "bounded-diffs") {
      for (const count of [200, 201, 250]) {
        update(request.params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: `large-${count}`,
          title: "Large edit",
          kind: "edit",
          status: "in_progress",
          content: Array.from({ length: count }, (_, i) => ({
            type: "diff",
            path: `/file-${i}`,
            oldText: "before",
            newText: "after",
          })),
        });
        update(request.params.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: `large-${count}`,
          content: [
            {
              type: "content",
              content: { type: "text", text: "Done editing" },
            },
          ],
        });
        update(request.params.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: `large-${count}`,
          status: "completed",
        });
      }
    }
    if (mode === "partial-tools") {
      for (const status of ["completed", "failed"]) {
        const content = [
          { type: "diff", path: "/a", oldText: "old a", newText: "new a" },
          { type: "diff", path: "/b", oldText: null, newText: "new b" },
        ];
        update(request.params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: `edit-${status}`,
          title: "Edit files",
          kind: "edit",
          status: "in_progress",
          content,
        });
        update(request.params.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: `edit-${status}`,
          status,
        });
        for (const initialOutput of [false, true]) {
          const toolCallId = `exec-${status}-${initialOutput}`;
          update(request.params.sessionId, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Run checks",
            kind: "execute",
            status: "in_progress",
            ...(initialOutput
              ? {
                  content: [
                    {
                      type: "content",
                      content: { type: "text", text: "starting" },
                    },
                  ],
                }
              : {}),
          });
          update(request.params.sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            content: [
              { type: "content", content: { type: "text", text: "working" } },
            ],
          });
          update(request.params.sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status,
            content: [
              {
                type: "content",
                content: { type: "text", text: "final output" },
              },
            ],
          });
        }
      }
    }
    if (mode === "rich") {
      update(request.params.sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect source", priority: "high", status: "completed" },
          {
            content: "Apply change",
            priority: "medium",
            status: "in_progress",
          },
        ],
      });
      update(request.params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Edit example",
        kind: "edit",
        status: "in_progress",
        content: [
          {
            type: "diff",
            path: "/tmp/example.txt",
            oldText: "before",
            newText: "after",
          },
        ],
      });
      update(request.params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/tmp/example.txt",
            oldText: "before",
            newText: "after",
          },
        ],
      });
      update(request.params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
      });
      update(request.params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "exec-1",
        title: "Check",
        kind: "execute",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "checks passed" } },
        ],
      });
      update(request.params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "terminal-1",
        title: "Run check",
        kind: "execute",
        content: [{ type: "terminal", terminalId: "terminal-1" }],
      });
      update(request.params.sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "Review files" }],
      });
      update(request.params.sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      });
    }
    send({ id: request.id, result: { stopReason: "end_turn" } });
    if (mode === "late-update")
      setTimeout(
        () =>
          update(request.params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "late answer" },
          }),
        25,
      );
  }
}
