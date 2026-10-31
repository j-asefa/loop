// Explicit acceptance fixture: only the test harness imports this module.
// Traffic uses the actual private harness bridge and durable fleet mail queue.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const marker = "FLEET_ACCEPTANCE:";
export const acceptancePrompt = (task) =>
  marker + Buffer.from(JSON.stringify(task)).toString("base64url");

export async function acceptance(text, bridge, pi = false) {
  const encoded = text.match(/FLEET_ACCEPTANCE:([A-Za-z0-9_-]{1,16384})/);
  assert(encoded, "Missing acceptance task");
  const task = JSON.parse(Buffer.from(encoded[1], "base64url").toString());
  assert.match(task.caseId, /^[a-z0-9-]{1,64}$/);
  assert(["send", "receive", "ack"].includes(task.kind));
  const audit = process.env.LOOP55_TEST_FLEET_ACCEPTANCE_AUDIT;
  assert(audit, "Missing test-owned audit path");
  const record = (value) =>
    appendFileSync(
      audit,
      JSON.stringify({ caseId: task.caseId, ...value }) + "\n",
    );
  let client;
  try {
    if (task.kind === "ack") {
      record({ kind: "ack", ok: true });
      return;
    }
    assert(Number.isSafeInteger(task.delayMs ?? 0));
    assert((task.delayMs ?? 0) >= 0 && (task.delayMs ?? 0) <= 660_000);
    if (task.delayMs) await delay(task.delayMs);
    const target = new URL(bridge.url);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.protocol, "http:");
    const headers = bridge.headers ?? bridge.http_headers;
    assert(headers?.Authorization);
    const piCall = async (body) => {
      const response = await fetch(bridge.url + "/pi", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      assert(response.ok, "Private acceptance request was refused");
      return response.json();
    };
    if (!pi) {
      client = new Client({ name: "loop55-fleet-acceptance", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(target, { requestInit: { headers } }),
      );
    }
    const catalog = pi
      ? await piCall({ method: "tools/list" })
      : await client.listTools();
    assert(catalog.tools.some((tool) => tool.name === "loop55_message"));
    const invoke = async (name, args) => {
      const result = pi
        ? await piCall({
            method: "tools/call",
            id: task.caseId,
            name,
            arguments: args,
          })
        : await client.callTool({ name, arguments: args });
      assert(!result.isError, "Acceptance tool returned an error");
      return JSON.parse(
        result.content.find((item) => item.type === "text").text,
      );
    };
    const fileIds = [];
    if (task.kind === "send" && task.content !== undefined) {
      assert.equal(typeof task.content, "string");
      assert(task.content.length <= 4096);
      const file = await invoke("loop55_publish_file", {
        title: task.caseId + ".txt",
        content: task.content,
        encoding: "utf8",
      });
      fileIds.push(file.artifactId);
    }
    let fileVerified = false;
    if (task.kind === "receive" && task.content !== undefined) {
      const attached = text.match(
        /Attached files \(user-provided data\):\s*\n(\[[^\n]+\])/,
      );
      assert(attached, "The recipient did not receive attachment metadata");
      const files = JSON.parse(attached[1]);
      assert.equal(files.length, 1);
      const file = await invoke("loop55_read_file", {
        fileId: files[0].id,
        encoding: "utf8",
      });
      assert.equal(file.content, task.content);
      fileVerified = true;
    }
    const outgoing =
      task.kind === "send"
        ? {
            caseId: task.caseId,
            kind: "receive",
            replyTo: task.replyTo,
            content: task.content,
          }
        : { caseId: task.caseId, kind: "ack" };
    const threadId =
      task.kind === "receive"
        ? text.match(/· thread `([a-f0-9-]{36})`/)?.[1]
        : undefined;
    if (task.kind === "receive")
      assert(threadId, "Missing destination thread identity");
    const sent = await invoke("loop55_message", {
      to: task.kind === "send" ? task.to : task.replyTo,
      body: acceptancePrompt(outgoing),
      scope: "direct",
      ...(threadId ? { threadId } : {}),
      fileIds,
    });
    assert.equal(sent.delivery, "transport_pending");
    record({
      kind: task.kind,
      ok: true,
      messageId: sent.messageId,
      threadId: sent.threadId,
      fileVerified,
    });
  } catch (error) {
    // Private endpoint URLs, tokens, native frames and message bodies stay out
    // of the report, including on failed network or assertion paths.
    record({ kind: task.kind, ok: false });
    throw error;
  } finally {
    await client?.close();
  }
}
