import { runHarnessCommand } from "../harness-command.js";
import { tokenCount, type Tokens } from "./usage.js";
import { DirectAdapter } from "./direct-adapter.js";
import type { Setting, SettingValue } from "../shared/agent-activities.js";
import { claudeActivities, directUpdates } from "./direct-activities.js";
import { modelOptions } from "../../runtime/model-options.ts";
import { ClaudeSteering } from "../../runtime/claude-steering.ts";
import { randomUUID } from "node:crypto";
import { Native } from "../native.js";
import { NativeMemoryError, nativeFailureDetail } from "../native-memory.js";
import {
  capabilities,
  conflict,
  NotDelivered,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";
import type { Billing } from "../shared/protocol.js";
import { NativeSetupError } from "./setup-error.js";

/** Why a `result` message does not end this launch's user turn, or "" when it
 * does. Older CLIs leave `origin` absent, so only an explicit non-human kind
 * disqualifies one: unrecognised kinds stay disqualified, because settling the
 * user's prompt on someone else's result loses their reply, while an ignored
 * result only stalls a turn the caller can still stop. Callers must report
 * every non-empty reason — nothing else explains a stalled turn. */
function foreignResult(m: any, active: boolean, session: string) {
  if (!active) return "no user turn is open";
  if (m.parent_tool_use_id) return "it belongs to a child tool session";
  if (m.session_id && m.session_id !== session)
    return "it belongs to a different native session";
  if (m.origin != null && m.origin.kind !== "human")
    return `origin.kind=${JSON.stringify(m.origin.kind)} is not human`;
  return "";
}

function claudeTokens(value: any): Tokens | undefined {
  const input = tokenCount(value?.input_tokens);
  const output = tokenCount(value?.output_tokens);
  if (input === undefined || output === undefined) return;
  const total =
    input +
    (tokenCount(value.cache_read_input_tokens) ?? 0) +
    (tokenCount(value.cache_creation_input_tokens) ?? 0);
  if (!Number.isSafeInteger(total)) return;
  return { input_tokens: total, output_tokens: output };
}

export class Claude extends DirectAdapter implements Adapter {
  static readonly startupSteps: Readonly<Record<string, string>> = {};

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
    emit: Emit,
  ) {
    super("claude", emit);
    this.session = options.resume ?? randomUUID();
    this.permissionMode = options.permissionMode;
  }
  private permissionMode?: string;
  private sessionOptions(model?: string | null): Setting[] {
    return [
      {
        id: "model",
        label: "Model",
        type: "select",
        choices: this.models.map((m) => ({ value: m.id, label: m.name })),
        confirmed: model,
        mutable: this.models.length > 0,
        application: "live",
        provenance: "Claude control protocol",
      },
      {
        id: "mode",
        label: "Native permission mode",
        type: "select",
        choices: [
          "default",
          "acceptEdits",
          "plan",
          "bypassPermissions",
          "dontAsk",
          "auto",
        ].map((value) => ({ value, label: value })),
        confirmed: this.permissionMode,
        mutable: true,
        application: "live",
        provenance: "Claude control protocol",
        description:
          "Changes the native harness permission mode. Loop workspace tool approvals remain governed by Loop.",
      },
      {
        id: "effort",
        label: "Reasoning effort",
        type: "text",
        requested: this.options.effort,
        mutable: false,
        application: "new-session",
        reason:
          "Configured with the Claude launch flag. Change the agent's model settings for its next session.",
        provenance: "Claude --effort launch option",
      },
    ];
  }
  async setSetting(
    id: string,
    value: SettingValue,
    revision: number,
    beforeApply?: () => void,
  ) {
    return this.displayControls.change(id, value, revision, async () => {
      if (typeof value !== "string" || !["model", "mode"].includes(id))
        throw new Error("Invalid session setting.");
      beforeApply?.();
      if (id === "mode") {
        await this.control({ subtype: "set_permission_mode", mode: value });
        this.permissionMode = value;
      } else {
        await this.control({ subtype: "set_model", model: value });
        this.options.model = value;
      }
      return this.sessionOptions(
        id === "model"
          ? value
          : (this.settings.options.find((o) => o.id === "model")?.confirmed as
              string | undefined),
      );
    });
  }
  async start(): Promise<Billing> {
    conflict(this.options.billing, [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]);
    const result = await runHarnessCommand(
      this.options.executable,
      ["auth", "status"],
      {
        cwd: this.options.project,
        timeout: 20000,
        maxBuffer: 100000,
      },
    ).catch((e) => {
      if (e.stdout) return { stdout: e.stdout };
      throw new Error(
        "Could not read native Claude auth status. Run claude auth status.",
      );
    });
    const auth = JSON.parse(result.stdout);
    const subscription =
      auth.loggedIn === true &&
      auth.authMethod === "claude.ai" &&
      auth.apiProvider === "firstParty" &&
      (!auth.apiKeySource || auth.apiKeySource === "none");
    if (this.options.billing === "subscription" && !subscription)
      throw new NativeSetupError(
        "claude_subscription_required",
        "Sign in to Claude Code with your Claude account before using subscription mode. No API fallback was attempted.",
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
        "--permission-prompt-tool",
        "stdio",
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(this.options.effort ? ["--effort", this.options.effort] : []),
        ...(this.options.permissionMode &&
        this.options.permissionMode !== "default"
          ? ["--permission-mode", this.options.permissionMode]
          : []),
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
    this.native.on("failure", (error) => {
      for (const c of this.controls.values()) {
        clearTimeout(c.timer);
        c.reject(
          error instanceof NativeMemoryError
            ? error
            : new Error("Claude exited"),
        );
      }
      this.controls.clear();
      this.emit({
        type: "status",
        status: "failed",
        detail: nativeFailureDetail(
          error,
          "Claude Code exited. Inspect native login/configuration and resume its session.",
        ),
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
    const apiKeyActive =
      (!!auth.apiKeySource && auth.apiKeySource !== "none") ||
      (!!account.apiKeySource && account.apiKeySource !== "none");
    if (!subscription && account.apiProvider === "firstParty" && !apiKeyActive)
      throw new NativeSetupError(
        "claude_api_source_unverified",
        "Claude did not confirm an API credential source for this integration. No prompt was sent.",
      );
    if (
      this.options.billing === "subscription" &&
      (account.apiProvider !== "firstParty" || apiKeyActive)
    )
      throw new NativeSetupError(
        "claude_subscription_unverified",
        apiKeyActive
          ? "Claude reported an API key for this session. Remove the key from Claude settings before using subscription mode. No prompt was sent."
          : "Claude did not confirm the native subscription provider. No prompt was sent.",
      );
    this.billing = {
      mode: this.options.billing,
      description:
        subscription && !apiKeyActive
          ? "Native Claude account; provider plan limits and enabled usage credits apply"
          : "Explicit native Claude API/provider mode; provider charges apply",
      provider: account.apiProvider ?? auth.apiProvider,
    };
    this.emit({
      type: "metadata",
      nativeSession: this.session,
      billing: this.billing,
    });
    this.displayControls.publish(
      this.sessionOptions(this.billing.model),
      this.commands,
    );
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
  async prompt(text: string, beforeDispatch?: () => void) {
    beforeDispatch?.();
    this.interrupted = false;
    this.active = true;
    await this.native.write({
      type: "user",
      session_id: this.session,
      uuid: randomUUID(),
      origin: { kind: "human" },
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
  }
  async steer(text: string, beforeDispatch?: () => void) {
    if (!this.active) throw new NotDelivered("No active Claude turn.");
    beforeDispatch?.();
    try {
      await this.steering.steer(
        text,
        () => this.control({ subtype: "interrupt" }),
        (value: string) => this.prompt(value, beforeDispatch),
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
  async answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ) {
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
    beforeDispatch?.();
    this.requests.delete(id);
    await this.native.write({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    });
    this.emit({ type: "resolved", id });
  }
  private activityInputs = new Map<string, { name: string; input: any }>();
  private message(m: any) {
    // Streaming input also carries results for turns injected by Claude
    // (notably stopped background tasks on resume). They must not settle the
    // user's queued prompt, consume a steering interrupt, or clear approvals.
    if (m.type === "result") {
      const foreign = foreignResult(m, this.active, this.session);
      // A dropped terminal result leaves the run streaming with no watchdog,
      // so say why: the only visible symptom is a turn that never finishes,
      // and `origin.kind` is an upstream protocol that keeps growing.
      if (foreign) {
        console.warn(
          `Loop ignored a Claude result that is not this turn (${foreign}).`,
        );
        return;
      }
    }
    if (
      ["assistant", "user"].includes(m.type) &&
      Array.isArray(m.message?.content)
    ) {
      for (const block of m.message.content) {
        if (block.type === "tool_use")
          this.activityInputs.set(block.id, {
            name: block.name,
            input: block.input,
          });
        for (const activity of directUpdates(
          "claude",
          claudeActivities(block, this.activityInputs.get(block.tool_use_id)),
        ))
          this.emit({ type: "activity", activity });
        if (block.type === "tool_result")
          this.activityInputs.delete(block.tool_use_id);
      }
    }
    if (m.type === "result") this.activityInputs.clear();
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
                  allow: "allow",
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
      if (Array.isArray(m.slash_commands))
        this.commands = m.slash_commands
          .filter((name: unknown) => typeof name === "string")
          .map((name: string) => ({
            name,
            token: "/" + name,
            kind: "command",
            description:
              this.commands.find((c) => c.name === name)?.description || "",
            disabledReason: [
              "clear",
              "resume",
              "rewind",
              "fork",
              "rename",
            ].includes(name)
              ? "Use the native terminal for this session-management command."
              : undefined,
          }));
      if (typeof m.permissionMode === "string")
        this.permissionMode = m.permissionMode;
      if (typeof m.model === "string")
        this.displayControls.publish(
          this.sessionOptions(m.model),
          this.commands,
        );
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
      const usage = claudeTokens(m.usage);
      if (usage) this.emit({ type: "usage", usage });
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
