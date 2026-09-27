import { modelOptions } from "../../runtime/model-options.mjs";
import { ClaudeSteering } from "../../runtime/claude-steering.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Native } from "../native.js";
import {
  capabilities,
  conflict,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";
import type { Billing } from "../protocol.js";
const exec = promisify(execFile);

export class Claude implements Adapter {
  capabilities = { ...capabilities };
  models: { id: string; name: string }[] = [];
  commands: NativeCommand[] = [];
  private native!: Native;
  private requests = new Map<string, any>();
  private controls = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private session: string;
  private messageIds = new Map<string, string>();
  private interrupted = false;
  private active = false;
  private steering = new ClaudeSteering();
  private billing!: Billing;
  constructor(
    private options: Options,
    private emit: Emit,
  ) {
    this.session = options.resume ?? randomUUID();
  }
  async start(): Promise<Billing> {
    if (this.options.billing === "subscription")
      throw new Error(
        "Claude.ai subscription integration requires Anthropic approval for third-party products. Loop has not established that approval. Use an explicitly configured API/provider account with --billing existing; Loop will not fall back automatically.",
      );
    conflict(this.options.billing, [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]);
    const result = await exec(this.options.executable, ["auth", "status"], {
      cwd: this.options.project,
      timeout: 20000,
      maxBuffer: 100000,
    }).catch((e) => {
      if (e.stdout) return { stdout: e.stdout };
      throw new Error(
        "Could not read native Claude auth status. Run claude auth status.",
      );
    });
    const auth = JSON.parse(result.stdout);
    if (auth.authMethod === "claude.ai" && auth.apiProvider === "firstParty")
      throw new Error(
        "Claude.ai login is not enabled for this integration. Configure the native CLI with an allowed API/provider account, then use --billing existing.",
      );
    this.native = new Native(
      this.options.executable,
      [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompts",
        "host",
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(this.options.effort ? ["--effort", this.options.effort] : []),
        ...(!this.options.resume && this.options.instructions
          ? ["--append-system-prompt", this.options.instructions]
          : []),
        ...(this.options.workspaceTools
          ? [
              "--mcp-config",
              JSON.stringify({
                mcpServers: {
                  loop_workspace: {
                    type: "http",
                    url: this.options.workspaceTools.url,
                    headers: {
                      Authorization:
                        "Bearer " + this.options.workspaceTools.token,
                    },
                  },
                },
              }),
            ]
          : []),
        ...(this.options.resume
          ? ["--resume", this.session]
          : ["--session-id", this.session]),
      ],
      this.options.project,
    );
    this.native.on("message", (m) => this.message(m));
    this.native.on("failure", () => {
      for (const c of this.controls.values()) {
        clearTimeout(c.timer);
        c.reject(new Error("Claude exited"));
      }
      this.controls.clear();
      this.emit({
        type: "status",
        status: "failed",
        detail:
          "Claude Code exited. Inspect native login/configuration and resume its session.",
      });
    });
    const init = await this.control({ subtype: "initialize" });
    this.models = (init.models || []).map((m: any) => ({
      id: m.value || m.id,
      name: m.displayName || m.name || m.value || m.id,
      ...modelOptions(m),
    }));
    this.commands = (init.commands || []).map((c: any) => ({
      name: c.name,
      token: "/" + c.name,
      kind: "command",
      description: c.description || "",
      argumentHint: c.argumentHint,
      ...(["clear", "resume", "rewind", "fork", "rename"].includes(c.name)
        ? {
            disabledReason:
              "Use the native terminal for this session-management command.",
          }
        : {}),
    }));
    const account = init.account ?? {};
    if (
      account.apiProvider === "firstParty" &&
      (!account.apiKeySource || account.apiKeySource === "none")
    )
      throw new Error(
        "Claude did not confirm an API credential source for this integration. No prompt was sent.",
      );
    this.billing = {
      mode: this.options.billing,
      description:
        "Explicit native Claude API/provider mode; provider charges apply",
      provider: account.apiProvider ?? auth.apiProvider,
    };
    this.emit({
      type: "metadata",
      nativeSession: this.session,
      billing: this.billing,
    });
    return this.billing;
  }
  private control(request: Record<string, unknown>): Promise<any> {
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(request_id);
        reject(new Error("Claude control timed out; outcome unknown."));
      }, 30000);
      this.controls.set(request_id, { resolve, reject, timer });
      void this.native
        .write({ type: "control_request", request_id, request })
        .catch((e) => {
          clearTimeout(timer);
          this.controls.delete(request_id);
          reject(e);
        });
    });
  }
  async prompt(text: string) {
    this.interrupted = false;
    this.active = true;
    await this.native.write({
      type: "user",
      session_id: this.session,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
  }
  async steer(text: string) {
    if (!this.active) throw new Error("No active Claude turn.");
    try {
      await this.steering.steer(
        text,
        () => this.control({ subtype: "interrupt" }),
        (value: string) => this.prompt(value),
      );
    } catch (error) {
      this.active = false;
      this.emit({
        type: "status",
        status: "failed",
        detail:
          "Claude could not confirm the follow-up. Review its saved progress before continuing.",
      });
      throw error;
    }
  }
  async cancel() {
    this.interrupted = true;
    await this.control({ subtype: "interrupt" });
  }
  async answer(id: string, answer: Record<string, unknown>) {
    const m = this.requests.get(id);
    if (!m) throw new Error("Claude request expired.");
    const r = m.request;
    let response: unknown;
    if (r.subtype === "elicitation")
      response = { action: answer.choice, content: null };
    else if (r.tool_name === "AskUserQuestion")
      response = {
        behavior: "allow",
        updatedInput: {
          ...r.input,
          answers: Object.fromEntries(
            (r.input.questions ?? []).map((q: any, i: number) => [
              q.question,
              (answer[String(i)] as string[]).join(", "),
            ]),
          ),
        },
      };
    else
      response =
        answer.choice === "allow"
          ? { behavior: "allow", updatedInput: r.input }
          : { behavior: "deny", message: "Denied by the user in Loop." };
    this.requests.delete(id);
    await this.native.write({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    });
    this.emit({ type: "resolved", id });
  }
  private message(m: any) {
    if (m.type === "control_response") {
      const p = this.controls.get(m.response?.request_id);
      if (!p) return;
      clearTimeout(p.timer);
      this.controls.delete(m.response.request_id);
      if (m.response.subtype === "error")
        p.reject(new Error(m.response.error ?? "Claude control failed"));
      else p.resolve(m.response.response ?? {});
      return;
    }
    if (m.type === "control_cancel_request") {
      this.requests.delete(m.request_id);
      this.emit({ type: "resolved", id: m.request_id });
      return;
    }
    if (m.type === "control_request") {
      const r = m.request;
      if (r.subtype === "can_use_tool") {
        this.requests.set(m.request_id, m);
        this.emit({
          type: "request",
          request:
            r.tool_name === "AskUserQuestion"
              ? {
                  id: m.request_id,
                  kind: "question",
                  title: "Claude needs your input",
                  detail: "",
                  questions: (r.input.questions ?? []).map(
                    (q: any, i: number) => ({
                      id: String(i),
                      title: q.question,
                      multiple: q.multiSelect,
                      options: q.options?.map((o: any) => o.label),
                    }),
                  ),
                }
              : {
                  id: m.request_id,
                  kind: "approval",
                  title: r.title ?? r.tool_name,
                  detail: JSON.stringify(
                    {
                      input: r.input,
                      reason: r.decision_reason,
                      path: r.blocked_path,
                    },
                    null,
                    2,
                  ),
                  choices: ["allow", "deny"],
                },
        });
      } else if (r.subtype === "elicitation") {
        this.requests.set(m.request_id, m);
        this.emit({
          type: "request",
          request: {
            id: m.request_id,
            kind: "approval",
            title: "MCP elicitation (form/URL completion unavailable)",
            detail: r.message,
            choices: ["decline", "cancel"],
          },
        });
      } else
        void this.native
          .write({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: m.request_id,
              error: "Unsupported Loop client control request",
            },
          })
          .catch(() => {});
      return;
    }
    if (m.type === "system" && m.subtype === "init") {
      this.session = m.session_id;
      this.emit({
        type: "metadata",
        nativeSession: this.session,
        billing: { ...this.billing, model: m.model },
      });
    }
    if (m.type === "stream_event") {
      const e = m.event;
      const stream = m.parent_tool_use_id ?? "root";
      if (e.type === "message_start") {
        this.messageIds.set(stream, e.message.id);
        if (this.messageIds.size > 128)
          this.messageIds.delete(this.messageIds.keys().next().value!);
      }
      if (e.type === "content_block_delta" && e.delta.type === "text_delta")
        this.emit({
          type: "delta",
          id: this.messageIds.get(stream) ?? m.uuid,
          text: e.delta.text,
        });
      if (
        e.type === "content_block_start" &&
        e.content_block.type === "tool_use"
      )
        this.emit({
          type: "item",
          item: {
            id: e.content_block.id,
            kind: "tool",
            title: e.content_block.name,
            text: "",
            status: "running",
          },
        });
    }
    if (m.type === "assistant") {
      const content = m.message?.content ?? [];
      const text = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      if (text)
        this.emit({
          type: "item",
          item: { id: m.message.id, kind: "assistant", text },
        });
      for (const b of content)
        if (b.type === "tool_use")
          this.emit({
            type: "item",
            item: {
              id: b.id,
              kind: "tool",
              title: b.name,
              text: JSON.stringify(b.input, null, 2),
              status: "running",
            },
          });
    }
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content)
        if (b.type === "tool_result")
          this.emit({
            type: "item",
            item: {
              id: b.tool_use_id,
              kind: "tool",
              title: "Tool result",
              text:
                typeof b.content === "string"
                  ? b.content
                  : JSON.stringify(b.content),
              status: b.is_error ? "failed" : "completed",
            },
          });
    if (m.type === "result") {
      if (this.steering.result()) return;
      this.active = false;
      this.messageIds.clear();
      for (const id of this.requests.keys())
        this.emit({ type: "resolved", id });
      this.requests.clear();
      this.emit({
        type: "status",
        status: this.interrupted
          ? "interrupted"
          : m.is_error
            ? "failed"
            : "completed",
        recoverable: !!m.is_error && !this.interrupted,
        detail: m.errors?.join("\n"),
      });
    }
  }
  async dispose() {
    for (const p of this.controls.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Stopped"));
    }
    this.controls.clear();
    await this.native?.dispose();
  }
}
