#!/usr/bin/env node
// Explicit protocol fixture; never shipped in a production image.
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
const log = (data) =>
  appendFileSync(join(process.env.HOME, "calls"), JSON.stringify(data) + "\n");
log({
  launch: process.pid,
  cwd: process.cwd(),
  apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || null,
  githubToken: process.env.GH_TOKEN || null,
});
const send = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const threads = new Map();
let next = 0;
const complete = (id, text, status = "completed") => {
  const thread = threads.get(id);
  if (!thread) return;
  const params = { threadId: id, turnId: "turn-" + id };
  const answer = JSON.stringify({
    kind: "answer",
    text,
    tool: null,
    arguments: "{}",
  });
  send({
    method: "item/completed",
    params: {
      ...params,
      item: { id: "answer-" + id, type: "agentMessage", text: answer },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId: id, turn: { id: params.turnId, status } },
  });
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const m = JSON.parse(line);
  log({ rpc: m });
  if (!m.method || m.id == null) return;
  let result = {};
  if (
    m.method === "initialize" &&
    existsSync(join(process.env.HOME, "fail-start"))
  ) {
    send({
      id: m.id,
      error: { code: -32603, message: "Fixture startup failed" },
    });
    return;
  }
  if (m.method === "account/logout")
    writeFileSync(join(process.env.HOME, "account-type"), "none");
  if (m.method === "account/read") {
    let type = "chatgpt";
    try {
      type = readFileSync(join(process.env.HOME, "account-type"), "utf8");
    } catch {}
    result = { account: { type, planType: "plus" } };
  }
  if (m.method === "model/list")
    result = { data: [{ model: "fixture" }], nextCursor: null };
  if (m.method === "skills/list") result = { data: [{ skills: [] }] };
  if (m.method === "account/login/start") {
    if (existsSync(join(process.env.HOME, "complete-login")))
      setTimeout(() => {
        writeFileSync(join(process.env.HOME, "account-type"), "chatgpt");
        send({
          method: "account/login/completed",
          params: { loginId: "login-fixture", success: true },
        });
      }, 20);
    result = {
      loginId: "login-fixture",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "TEST-CODE",
    };
  }
  if (m.method === "thread/start") {
    const id = "thread-" + ++next;
    threads.set(id, m.params);
    if (m.params.model === "starting") {
      setTimeout(
        () =>
          send({
            id: m.id,
            result: { thread: { id }, modelProvider: "openai" },
          }),
        150,
      );
      return;
    }
    result = { thread: { id }, modelProvider: "openai" };
  }
  if (m.method === "turn/start" || m.method === "review/start") {
    const id = m.params.threadId;
    const thread = threads.get(id);
    result = { turn: { id: "turn-" + id } };
    send({
      method: "turn/started",
      params: { threadId: id, turn: result.turn },
    });
    send({ id: m.id, result });
    if (thread.model === "crash") {
      setTimeout(() => process.exit(42), 20);
      return;
    }
    if (thread.model === "stall") return;
    const text = "update for " + id;
    send({
      method: "item/completed",
      params: {
        threadId: id,
        turnId: result.turn.id,
        item: { id: "update-" + id, type: "agentMessage", text },
      },
    });
    for (const [threadId, turnId, label] of [
      [id, result.turn.id, "command-" + id],
      ["unknown", result.turn.id, "foreign command"],
      [id, "stale-turn", "stale command"],
    ])
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: label,
            type: "commandExecution",
            command: "echo " + label,
            status: "completed",
            exitCode: 0,
            aggregatedOutput: label,
          },
        },
      });
    // Unowned and stale-turn events must never leak into any run.
    send({
      method: "item/completed",
      params: {
        threadId: "unknown",
        item: { type: "agentMessage", text: "foreign output" },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: id,
        turnId: "stale-turn",
        item: { type: "agentMessage", text: "stale output" },
      },
    });
    send({
      id: "approval-" + id,
      method: "item/commandExecution/requestApproval",
      params: { threadId: id, turnId: result.turn.id },
    });
    send({
      id: "foreign-approval-" + id,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "unknown" },
    });
    if (thread.model === "quick")
      setTimeout(() => complete(id, "result for " + id), 20);
    if (thread.model === "credential") {
      const token = thread.config?.["shell_environment_policy.set"]?.GH_TOKEN;
      setTimeout(() => complete(id, "credential " + (token || "none")), 20);
    }
    if (m.method === "review/start")
      setTimeout(() => {
        send({
          method: "item/completed",
          params: {
            threadId: id,
            turnId: result.turn.id,
            item: { type: "exitedReviewMode", review: "Review for " + id },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: id,
            turn: { id: result.turn.id, status: "completed" },
          },
        });
      }, 20);
    return;
  }
  if (m.method === "turn/steer") {
    result = { turnId: m.params.expectedTurnId };
    setTimeout(() => complete(m.params.threadId, m.params.input[0].text), 30);
  }
  if (m.method === "turn/interrupt")
    complete(m.params.threadId, "interrupted", "interrupted");
  if (m.method === "thread/unsubscribe") threads.delete(m.params.threadId);
  send({ id: m.id, result });
});
