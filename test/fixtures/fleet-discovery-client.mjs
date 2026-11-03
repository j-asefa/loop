// Opt-in native subprocess fixture. It consumes only the private tool endpoint
// supplied by that harness's production adapter, never a peer URL or credential.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function discover(text, bridge, pi = false) {
  const audit = process.env.LOOP_TEST_FLEET_DISCOVERY_AUDIT;
  let client;
  try {
    assert(bridge?.url, "The adapter did not supply its private tool endpoint");
    const target = new URL(bridge.url);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.protocol, "http:");
    const headers = bridge.headers ?? bridge.http_headers;
    assert(
      headers?.Authorization,
      "The adapter did not supply tool authorization",
    );
    const call = pi
      ? async (body) => {
          const response = await fetch(bridge.url + "/pi", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          assert(response.ok, "Private Pi tool request was refused");
          return response.json();
        }
      : undefined;
    if (!pi) {
      client = new Client({ name: "loop-fleet-fixture", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(target, {
          requestInit: { headers },
        }),
      );
    }
    const catalog = pi
      ? await call({ method: "tools/list" })
      : await client.listTools();
    assert(catalog.tools.some((tool) => tool.name === "loop_agents"));
    const invoke = async (name, args, id) => {
      const result = pi
        ? await call({
            method: "tools/call",
            id,
            name,
            arguments: args,
          })
        : await client.callTool({ name, arguments: args });
      assert(!result.isError, name + " returned a tool error");
      return JSON.parse(
        result.content.find((item) => item.type === "text").text,
      );
    };
    const local = await invoke("loop_agents", {}, "local-discover");
    const sourceId = text.slice("Fleet discovery fixture: ".length).trim();
    const remote = await invoke("loop_agents", { sourceId }, "peer-discover");
    let mail;
    if (process.env.LOOP_TEST_FLEET_MAIL_SEND === "1") {
      const to = remote.agents[0].agentId;
      const sent = await invoke(
        "loop_message",
        {
          to,
          scope: "direct",
          body: "Native fleet message fixture",
        },
        "fleet-message",
      );
      assert.equal(sent.delivery, "transport_pending");
      const handoff = await invoke(
        "loop_handoff",
        {
          to,
          threadId: sent.threadId,
          scope: "direct",
          task: "Inspect the isolated fixture",
          context: "No external provider or user workspace is involved.",
        },
        "fleet-handoff",
      );
      assert.equal(handoff.delivery, "transport_pending");
      const status = await invoke(
        "loop_message_status",
        {
          threadId: sent.threadId,
        },
        "fleet-status",
      );
      assert.equal(status.messages.length, 2);
      mail = { sent, handoff, status };
    }
    appendFileSync(
      audit,
      JSON.stringify({ ok: true, local, remote, mail }) + "\n",
    );
  } catch (error) {
    // The fixture never records endpoint URLs, headers or adapter input frames.
    appendFileSync(
      audit,
      JSON.stringify({
        ok: false,
        error:
          error instanceof assert.AssertionError
            ? error.message
            : "Private native discovery failed",
      }) + "\n",
    );
    throw error;
  } finally {
    await client?.close();
  }
}

export const acpBridge = (servers) => {
  const server = servers?.find((item) => item.name === "loop-workspace");
  return (
    server && {
      url: server.url,
      headers: Object.fromEntries(
        server.headers.map(({ name, value }) => [name, value]),
      ),
    }
  );
};
