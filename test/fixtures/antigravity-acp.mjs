// Fixture for agy 1.5.9's documented ACP worker mode. No provider calls.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
if (process.argv.slice(2).join(" ") !== "acp --process-per-session")
  process.exit(92);
const log = (value) => {
  if (process.env.LOOP_TEST_AGY_LOG)
    appendFileSync(process.env.LOOP_TEST_AGY_LOG, JSON.stringify(value) + "\n");
};
const send = (value) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
let sessionId = process.env.LOOP_TEST_AGY_SESSION_ID || "agy-acp-session";
let client;
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-agy-fixture",
    options: [{ value: "gemini-agy-fixture", name: "Gemini fixture" }],
  },
  {
    id: "thinking_level",
    name: "Thinking level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];
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
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  // Do not log session-scoped credentials.
  log({
    method: request.method,
    params: {
      ...request.params,
      mcpServers: request.params?.mcpServers?.map(({ name, url }) => ({
        name,
        url,
      })),
    },
  });
  if (request.method === "initialize") {
    send({
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: {
            http: process.env.LOOP_TEST_AGY_MODE !== "no-http",
          },
        },
      },
    });
  } else if (["session/new", "session/load"].includes(request.method)) {
    if (process.env.LOOP_TEST_AGY_MODE === "signed-out") {
      send({
        id: request.id,
        error: {
          code: -32000,
          message: "Authentication required private-fixture",
        },
      });
      continue;
    }
    if (request.method === "session/load") sessionId = request.params.sessionId;
    const server = request.params.mcpServers[0];
    if (server) {
      client = new Client({ name: "antigravity-fixture", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            if (
              typeof init?.body === "string" &&
              JSON.parse(init.body).method === "tools/call"
            ) {
              const duplicate = await fetch(url, init);
              const duplicateBody = await duplicate.json();
              const originalBody = await response.clone().json();
              log({
                event: "duplicate-mail",
                same:
                  JSON.stringify(originalBody) ===
                  JSON.stringify(duplicateBody),
              });
            }
            return response;
          },
          requestInit: {
            headers: Object.fromEntries(
              server.headers.map(({ name, value }) => [name, value]),
            ),
          },
        }),
      );
      log({
        event: "catalog",
        tools: (await client.listTools()).tools.map((t) => t.name),
      });
    }
    send({
      id: request.id,
      result: {
        ...(request.method === "session/new" ? { sessionId } : {}),
        configOptions,
      },
    });
    setTimeout(
      () =>
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "plan", description: "Plan before executing." },
              ],
            },
          },
        }),
      10,
    );
  } else if (request.method === "session/prompt") {
    if (process.env.LOOP_TEST_AGY_MODE === "disconnect") process.exit(2);
    if (process.env.LOOP_TEST_AGY_MODE === "hang") continue;
    if (client && process.env.LOOP_TEST_AGY_RECIPIENT) {
      const args = {
        to: process.env.LOOP_TEST_AGY_RECIPIENT,
        body: "Antigravity mail fixture",
      };
      const params = { name: "loop_message", arguments: args };
      // The fixture transport deliberately repeats this request identity.
      const result = await client.callTool(params);
      log({ event: "mail", result });
    }
    update("Antigravity ACP fixture answer");
    send({ id: request.id, result: { stopReason: "end_turn" } });
  } else if (request.method === "session/set_config_option") {
    const option = configOptions.find(
      (option) => option.id === request.params.configId,
    );
    if (!option) process.exit(94);
    option.currentValue = request.params.value;
    send({ id: request.id, result: { configOptions } });
  } else if (request.method === "authenticate") process.exit(93);
  else if (request.id !== undefined)
    send({
      id: request.id,
      error: { code: -32601, message: "Unexpected method" },
    });
}
await client?.close();
