#!/usr/bin/env node
// Local JSON-RPC peer for the full browser journey. No network/provider calls.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [control, audit] = process.argv.slice(2);
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const record = (value) => appendFileSync(audit, JSON.stringify(value) + "\n");
const sessionId = `browser-fixture-${process.pid}`;
let prompt,
  sequence = "";
const update = (body) =>
  send({ method: "session/update", params: { sessionId, update: body } });
function progress(status, text) {
  update({
    sessionUpdate: "plan",
    entries: [{ content: text, priority: "high", status }],
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "browser-tool",
    status: status === "completed" ? "completed" : "in_progress",
    title: text,
  });
}
setInterval(() => {
  if (!prompt || !existsSync(control)) return;
  const next = readFileSync(control, "utf8");
  if (next === sequence) return;
  sequence = next;
  progress("in_progress", next);
  record({ event: "progress", text: next });
}, 25);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize")
    send({
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      },
    });
  else if (request.method === "session/new")
    send({ id: request.id, result: { sessionId } });
  else if (request.method === "session/load")
    send({ id: request.id, result: {} });
  else if (request.method === "session/prompt") {
    record({ event: "prompt", sessionId: request.params.sessionId });
    prompt = request;
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Browser fixture working" },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "browser-tool",
      title: "Before disconnect",
      kind: "execute",
      status: "pending",
    });
    progress("in_progress", "Before disconnect");
    send({
      id: "browser-permission",
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "browser-tool",
          title: "Approve browser fixture",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny once", kind: "reject_once" },
        ],
      },
    });
  } else if (request.id === "browser-permission" && request.result) {
    record({ event: "decision", result: request.result });
    progress("completed", "Recovered work complete");
    send({ id: prompt.id, result: { stopReason: "end_turn" } });
    prompt = undefined;
  }
}
