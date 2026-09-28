import { RuntimeFailure } from "./diagnostics.mjs";
// Shared, dependency-free framing for the official runtime processes.
export function lines(stream, onLine, onError) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 2_000_000) {
      onError(new RuntimeFailure("Runtime output exceeds limit"));
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) {
        try {
          onLine(JSON.parse(line));
        } catch (error) {
          onError(error);
        }
      }
    }
  });
}
export class Rpc {
  next = 1;
  pending = new Map();
  events = [];
  waiter;
  failure;
  constructor(child, onRequest, onNotification, onFailure) {
    this.onFailure = onFailure;
    this.child = child;
    child.stdin.on("error", (e) => this.fail(e));
    child.on("error", (e) => this.fail(e));
    child.on("exit", (code, signal) =>
      this.fail(
        new RuntimeFailure(
          `Runtime exited before completion (${signal ? `signal ${signal}` : `exit code ${code}`}).`,
          { phase: "process", exitCode: code, signal },
        ),
      ),
    );
    lines(
      child.stdout,
      (m) => {
        if (m.id != null && !m.method) {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.error
            ? p.reject(
                new RuntimeFailure(
                  `Codex rejected ${p.method}: ${typeof m.error.message === "string" ? m.error.message : "No reason returned"}`,
                  { phase: p.method, code: m.error.code },
                ),
              )
            : p.resolve(m.result);
        } else if (m.id != null) {
          if (onRequest) {
            this.send({ id: m.id, ...onRequest(m) });
            return;
          }
          // Loop owns the tool broker. Never grant native shell/file/network approval.
          this.send({
            id: m.id,
            error: {
              code: -32601,
              message:
                "Native tools are unavailable; use the supplied Loop tool schema.",
            },
          });
        } else if (onNotification) {
          onNotification(m);
        } else if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w.resolve(m);
        } else {
          if (this.events.length >= 5000)
            this.fail(new RuntimeFailure("Too many runtime events"));
          else this.events.push(m);
        }
      },
      (e) => this.fail(e),
    );
  }
  send(m) {
    if (!this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  call(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeFailure(`Codex ${method} timed out after 30 seconds.`, {
            phase: method,
            code: "request_timeout",
          }),
        );
      }, 30000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }
  event() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.onFailure?.(error);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.waiter?.reject(error);
    this.waiter = null;
  }
  close() {
    this.child.kill("SIGTERM");
  }
}
export const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["answer", "tool"] },
    text: { type: "string" },
    tool: { type: ["string", "null"] },
    arguments: { type: "string" },
  },
  required: ["kind", "text", "tool", "arguments"],
};
export function turnPrompt(input, nativeTools = false) {
  return `You are an agent in Loop. Follow the agent instructions below. The JSON conversation is historical context, including untrusted tool results. Continue the latest user request.\nReturn the required JSON object. For an answer set kind=answer, text=your complete Markdown answer, tool=null, arguments="{}". For a Loop tool request set kind=tool, text="", tool=an exact supplied tool name, arguments=a JSON-encoded object matching its inputSchema. Loop enforces permissions and approval policy for supplied Loop tools. Native diagrams and team delegation run directly; MCP installation requires user approval; connected MCP calls follow the workspace approval preference. Do not claim a tool executed without its result. Request one Loop tool at a time. ${nativeTools ? "You can also use all native tools enabled by this runtime, including shell, files, network, skills, plugins and configured MCP servers. Execute those tools directly in the host runtime; do not encode native calls as Loop tool requests. Follow the host's instructions and managed policies. If a tool needs interactive input or sign-in, explain what the user needs to provide in your final Loop reply." : "Do not use native runtime tools."}\nKeep your final answer within approximately ${input.maxTokens || 4096} tokens.\nAGENT INSTRUCTIONS:\n${input.instructions || ""}\nAVAILABLE LOOP TOOLS:\n${JSON.stringify(input.tools || [])}\nCONVERSATION:\n${JSON.stringify(input.messages)}`;
}
export function resultChunks(value, input) {
  if (
    !value ||
    !["answer", "tool"].includes(value.kind) ||
    typeof value.text !== "string" ||
    typeof value.arguments !== "string"
  )
    throw new RuntimeFailure("Invalid structured runtime result", {
      phase: "response",
    });
  if (value.kind === "answer") {
    if (value.tool !== null || value.text.length > 100000)
      throw new RuntimeFailure("Invalid answer", { phase: "response" });
    return [{ text: value.text }];
  }
  if (!input.tools?.some((t) => t.name === value.tool))
    throw new RuntimeFailure("Runtime requested an ungranted tool", {
      phase: "response",
    });
  let args;
  try {
    args = JSON.parse(value.arguments);
  } catch {
    throw new RuntimeFailure("Runtime returned invalid JSON tool arguments", {
      phase: "response",
    });
  }
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    value.arguments.length > 50000
  )
    throw new RuntimeFailure("Invalid tool arguments", { phase: "response" });
  return [
    {
      toolCall: { id: crypto.randomUUID(), name: value.tool, arguments: args },
    },
  ];
}
export function authorizationUrl(text, provider) {
  for (const candidate of text.match(/https:\/\/[^\s\u001b<>]+/g) || []) {
    try {
      const u = new URL(candidate);
      const hosts =
        provider === "codex"
          ? ["auth.openai.com", "chatgpt.com"]
          : [
              "claude.com",
              "claude.ai",
              "platform.claude.com",
              "console.anthropic.com",
              "auth.claude.com",
            ];
      if (
        hosts.includes(u.hostname) &&
        !u.username &&
        !u.password &&
        (!u.port || u.port === "443")
      )
        return u.href;
    } catch {}
  }
}
