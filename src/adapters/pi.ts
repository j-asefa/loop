import { directActivityEmitter } from "./direct-activities.js";
import { DirectControls } from "./direct-controls.js";
import type { Setting, SettingValue } from "../agent-activities.js";
import { piActivities, directUpdates } from "./direct-activities.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Native } from "../native.js";
import { NativeMemoryError, nativeFailureDetail } from "../native-memory.js";
import {
  capabilities,
  NotDelivered,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";
import type { Billing } from "../protocol.js";
import type { ModelOption } from "../shared/models.js";
import { NativeSetupError } from "./setup-error.js";
import { piInventory } from "./pi-inventory.js";

export class Pi implements Adapter {
  static readonly startupSteps: Readonly<Record<string, string>> = {
    get_state: "loading its session",
    get_available_models: "loading available models",
  };
  private controlState?: DirectControls;
  private get displayControls() {
    return (this.controlState ||= new DirectControls("pi", this.emit));
  }
  get settings() {
    return this.displayControls.settings;
  }
  get commandCatalog() {
    return this.displayControls.commands;
  }
  refreshCommandCatalog() {
    if (this.native) {
      this.displayControls.refresh(
        async () => {
          const result = await this.native.request("get_commands", {}, false);
          return (result.commands || [])
            .filter((c: any) => c.name !== "loop-status")
            .map((c: any) => ({
              name: c.name,
              token: "/" + c.name,
              kind: c.source || "command",
              description: c.description || "",
              sourceInfo: c.sourceInfo,
            }));
        },
        (commands) => {
          this.commands = commands;
          this.refreshInventory();
        },
      );
    }
  }
  get activityCapabilities() {
    return this.displayControls.capabilities;
  }

  capabilities = { ...capabilities };
  models: ModelOption[] = [];
  defaultModelOption?: ModelOption;
  commands: NativeCommand[] = [];
  customizationInventory: ReturnType<typeof piInventory> & {
    toolsTruncated?: boolean;
    projectTrusted?: boolean;
    diagnostics?: Array<{ kind: string; path?: string; event?: string }>;
  } = piInventory([]);
  private diagnostics: Array<{ kind: string; path?: string; event?: string }> =
    [];
  private state: any;
  private refreshInventory() {
    this.customizationInventory = {
      ...piInventory(this.commands, this.info?.tools, this.state),
      toolsTruncated: this.info?.toolsTruncated === true,
      projectTrusted: this.info?.projectTrusted === true,
      diagnostics: this.diagnostics,
    };
  }
  private native!: Native;
  private info: any;
  private infoWait?: {
    resolve: (x: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  };
  private messageId = "";
  private interrupted = false;
  private failed = false;
  // From an accepted prompt until Pi settles. Pi queues a steer it receives
  // while idle for its next prompt, so Loop only steers a live turn.
  private turnActive = false;
  private steering: Promise<unknown> = Promise.resolve();
  private requests = new Map<string, { m: any; timer?: NodeJS.Timeout }>();
  constructor(
    private options: Options,
    private emit: Emit,
  ) {
    this.emit = directActivityEmitter(emit);
  }
  private async readSettings(): Promise<Setting[]> {
    const state = await this.native.request("get_state", {}, false);
    this.state = state;
    const thinking = await this.native
      .request("get_available_thinking_levels", {}, false)
      .catch(() => ({ levels: [] }));
    return [
      {
        id: "model",
        label: "Model",
        type: "select",
        choices: this.models.map((m) => ({ value: m.id, label: m.name })),
        confirmed: state.model
          ? `${state.model.provider}/${state.model.id}`
          : undefined,
        application: "live",
        mutable: this.models.length > 0,
        provenance: "Pi get_state",
      },
      {
        id: "effort",
        label: "Thinking level",
        type: "select",
        choices: (thinking.levels || []).map((value: string) => ({
          value,
          label: value,
        })),
        confirmed: state.thinkingLevel,
        application: "live",
        mutable: !!thinking.levels?.length,
        reason: !thinking.levels?.length
          ? "This Pi version did not report allowed thinking levels."
          : undefined,
        provenance: "Pi get_state / get_available_thinking_levels",
      },
      {
        id: "auto-compaction",
        label: "Automatic compaction",
        type: "boolean",
        confirmed: state.autoCompactionEnabled === true,
        application: "live",
        mutable: true,
        provenance: "Pi get_state",
      },
      {
        id: "steering-mode",
        label: "Steering messages",
        type: "select",
        choices: [
          { value: "all", label: "All" },
          { value: "one-at-a-time", label: "One at a time" },
        ],
        confirmed: state.steeringMode,
        application: "live",
        mutable: true,
        provenance: "Pi get_state",
      },
      {
        id: "follow-up-mode",
        label: "Follow-up messages",
        type: "select",
        choices: [
          { value: "all", label: "All" },
          { value: "one-at-a-time", label: "One at a time" },
        ],
        confirmed: state.followUpMode,
        application: "live",
        mutable: true,
        provenance: "Pi get_state",
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
      if (id === "auto-compaction") {
        if (typeof value !== "boolean")
          throw new Error("Invalid setting value.");
        beforeApply?.();
        await this.native.request(
          "set_auto_compaction",
          { enabled: value },
          false,
        );
      } else if (typeof value !== "string")
        throw new Error("Invalid setting value.");
      else if (id === "model") {
        const slash = value.indexOf("/");
        beforeApply?.();
        await this.native.request(
          "set_model",
          { provider: value.slice(0, slash), modelId: value.slice(slash + 1) },
          false,
        );
      } else if (id === "effort") {
        beforeApply?.();
        await this.native.request(
          "set_thinking_level",
          { level: value },
          false,
        );
      } else if (id === "steering-mode" || id === "follow-up-mode") {
        if (value !== "all" && value !== "one-at-a-time")
          throw new Error("Invalid queue mode.");
        beforeApply?.();
        await this.native.request(
          id === "steering-mode" ? "set_steering_mode" : "set_follow_up_mode",
          { mode: value },
          false,
        );
      } else throw new Error("Unknown setting.");
      return this.readSettings();
    });
  }
  // Pi does not read RPC input until every session_start handler returns, so
  // an extension question asked before its first response can never be
  // answered and Pi exits.
  private startup?: (error: Error) => void;
  async start(): Promise<Billing> {
    const blocked = new Promise<never>((_, reject) => {
      this.startup = reject;
    });
    const starting = this.starting();
    starting.catch(() => {});
    try {
      return await Promise.race([starting, blocked]);
    } finally {
      this.startup = undefined;
    }
  }
  private async starting(): Promise<Billing> {
    const extension = fileURLToPath(
      new URL("../pi-extension.mjs", import.meta.url),
    );
    const firstInfo = this.waitInfo();
    this.native = new Native(
      this.options.executable,
      [
        "--mode",
        "rpc",
        ...(this.options.projectTrust === true
          ? ["--approve"]
          : this.options.projectTrust === false
            ? ["--no-approve"]
            : []),
        "--extension",
        extension,
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(!this.options.resume && this.options.instructions
          ? ["--append-system-prompt", this.options.instructions]
          : []),
        ...(this.options.resume ? ["--session", this.options.resume] : []),
      ],
      this.options.project,
      {
        ...process.env,
        LOOP_BILLING_MODE: this.options.billing,
        ...(this.options.workspaceTools
          ? {
              LOOP_TOOLS_URL: this.options.workspaceTools.url,
              LOOP_TOOLS_TOKEN: this.options.workspaceTools.token,
            }
          : {}),
      },
    );
    this.native.on("metadata", (info) => {
      this.info = info;
      this.refreshInventory();
      if (this.infoWait) {
        clearTimeout(this.infoWait.timer);
        this.infoWait.resolve(info);
        this.infoWait = undefined;
      }
    });
    this.native.on("message", (m) => this.message(m));
    this.native.on("failure", (error) => {
      this.turnActive = false;
      if (this.infoWait) {
        clearTimeout(this.infoWait.timer);
        this.infoWait.reject(
          error instanceof NativeMemoryError
            ? error
            : new NativeSetupError(
                "native_start_failed",
                // Native failures carry Loop-authored transport messages only.
                `Pi could not start (${String(error.message).replace(/\.$/, "")}). Check its executable, version and extension loading. No prompt was sent.`,
              ),
        );
        this.infoWait = undefined;
      }
      this.emit({
        type: "status",
        status: "failed",
        detail: nativeFailureDetail(
          error,
          "Pi exited. Check native login, project trust and extensions.",
        ),
      });
    });
    await firstInfo;
    this.checkBilling();
    const state = await this.native.request("get_state", {}, false);
    // Pi answered, so it reads input: later questions follow the normal path.
    this.startup = undefined;
    const available = await this.native.request(
      "get_available_models",
      {},
      false,
    );
    this.models = (available.models || [])
      .filter(
        (m: any) =>
          this.options.billing !== "subscription" ||
          this.info.modelBilling?.some(
            (entry: any) =>
              entry.id === `${m.provider}/${m.id}` &&
              entry.subscription === true,
          ),
      )
      .map((m: any) => ({
        id: m.provider + "/" + m.id,
        name: m.name || m.id,
        effortLevels: this.info.modelEfforts
          ?.find((entry: any) => entry.id === `${m.provider}/${m.id}`)
          ?.levels.map((value: string) => ({ value })),
      }));
    let settings = await this.readSettings();
    const thinking = settings.find((setting) => setting.id === "effort");
    this.defaultModelOption = {
      id: "native-default",
      name: "Use native default",
      resolvedModel: state.model
        ? `${state.model.provider}/${state.model.id}`
        : undefined,
      effortLevels: thinking?.choices?.map(({ value }) => ({
        value: String(value),
      })),
      defaultEffort:
        typeof thinking?.confirmed === "string"
          ? thinking.confirmed
          : undefined,
    };
    // Apply the saved agent preference to both new and resumed sessions before
    // sending any prompt. Pi's RPC reports the effective value after clamping.
    if (this.options.effort) {
      if (
        !thinking?.choices?.some(({ value }) => value === this.options.effort)
      )
        throw new NativeSetupError(
          "native_effort_unsupported",
          "Choose a thinking level supported by the selected Pi model.",
        );
      await this.native.request(
        "set_thinking_level",
        { level: this.options.effort },
        false,
      );
      settings = await this.readSettings();
      if (
        settings.find((setting) => setting.id === "effort")?.confirmed !==
        this.options.effort
      )
        throw new NativeSetupError(
          "native_effort_unconfirmed",
          "Pi did not apply the selected thinking level. Refresh the model options and retry.",
        );
    }
    const catalog = await this.native.request("get_commands", {}, false);
    this.commands = (catalog.commands || [])
      .filter((c: any) => c.name !== "loop-status")
      .map((c: any) => ({
        name: c.name,
        token: "/" + c.name,
        kind: c.source || "command",
        description: c.description || "",
        sourceInfo: c.sourceInfo,
      }));
    this.refreshInventory();
    this.displayControls.publish(settings, this.commands);
    const billing = this.billing();
    this.emit({
      type: "metadata",
      nativeSession: state.sessionFile ?? state.sessionId,
      billing,
    });
    const history = await this.native.request("get_messages", {}, false);
    for (const m of history.messages ?? []) {
      if (["assistant", "user"].includes(m.role))
        this.emit({
          type: "item",
          item: {
            id: randomUUID(),
            kind: m.role,
            text:
              typeof m.content === "string"
                ? m.content
                : (m.content ?? [])
                    .filter((x: any) => x.type === "text")
                    .map((x: any) => x.text)
                    .join("\n"),
          },
        });
    }
    return billing;
  }
  private waitInfo() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.infoWait = undefined;
        reject(
          new NativeSetupError(
            "native_metadata_unavailable",
            "Pi metadata extension did not initialize. Check Pi version and extension loading.",
          ),
        );
      }, 20000);
      this.infoWait = { resolve, reject, timer };
    });
  }
  private billing(): Billing {
    return {
      mode: this.options.billing,
      description: this.info.subscription
        ? "Native Pi provider declares OAuth subscription support; provider limits apply"
        : "Existing Pi provider configuration; may incur API charges",
      provider: this.info.provider,
      model: this.info.model,
    };
  }
  private checkBilling() {
    if (this.options.workspaceTools && this.info?.toolsReady === false)
      throw new NativeSetupError(
        "native_tools_unavailable",
        "Pi could not load workspace tools. Check the local Loop bridge; no prompt was sent.",
      );
    if (!this.info?.configured)
      throw new NativeSetupError(
        "native_auth_missing",
        "Pi has no configured auth for its selected model. Sign in using Pi /login.",
      );
    if (this.options.billing === "subscription" && !this.info.subscription)
      throw new NativeSetupError(
        "native_billing_mismatch",
        "This Pi model does not use a confirmed subscription login. Choose a subscription model such as the openai-codex route, or explicitly enable existing-provider billing. No prompt was sent and no API fallback occurred.",
      );
  }
  async prompt(text: string, beforeDispatch?: () => void) {
    beforeDispatch?.();
    const metadata = this.waitInfo();
    await this.native.request("prompt", { message: "/loop-status" }, false);
    await metadata;
    this.checkBilling();
    beforeDispatch?.();
    this.interrupted = false;
    this.failed = false;
    // Set before sending: Pi's events can settle the turn before the
    // response to this request is handled.
    this.turnActive = true;
    try {
      await this.native.request("prompt", { message: text }, false);
    } catch (error) {
      this.turnActive = false;
      throw error;
    }
  }
  // Pi delivers steering after the current tool calls, before its next model
  // call. A turn that ends without another model call still reads it first.
  // One steer at a time, so Pi's queue never holds two of Loop's at once.
  steer(text: string, beforeDispatch?: () => void) {
    const sent = this.steering.then(() => this.steerOnce(text, beforeDispatch));
    this.steering = sent.catch(() => {});
    return sent;
  }
  private async steerOnce(text: string, beforeDispatch?: () => void) {
    if (!this.turnActive) throw new NotDelivered("No active Pi turn.");
    beforeDispatch?.();
    await this.native.request("steer", { message: text }, false);
    const state = await this.native.request("get_state", {}, false);
    if (state?.isStreaming || !(state?.pendingMessageCount > 0)) return;
    // Pi settled after its last check, so the queue waits for its next
    // prompt. Pi can only clear its whole queue: take this input back only
    // when it is the sole entry, and put back anything else that was removed.
    // Otherwise leave it queued and report it as unconfirmed, never resent.
    const queued =
      "Pi finished its turn before Loop could confirm it read this input. Anything still queued waits for Pi's next prompt.";
    // Pi exposes text, not durable queue-entry identities. A guarded input
    // cannot safely clear/restore a queue that another native writer may change:
    // restoration would need each entry's own authorization. Keep the native
    // queue intact and the accepted input uncertain; never submit it again.
    if (beforeDispatch) throw new Error(queued);
    if (state.pendingMessageCount !== 1) throw new Error(queued);
    const cleared = await this.native.request("clear_queue", {}, false);
    const steering: string[] = cleared?.steering ?? [];
    const followUp: string[] = cleared?.followUp ?? [];
    if (steering.length === 1 && steering[0] === text && !followUp.length)
      throw new NotDelivered("Pi finished its turn before reading this input.");
    for (const message of steering)
      await this.native.request("steer", { message }, false);
    for (const message of followUp)
      await this.native.request("follow_up", { message }, false);
    throw new Error(queued);
  }
  async cancel() {
    this.interrupted = true;
    await this.native.request("abort", {}, false);
  }
  async answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ) {
    const r = this.requests.get(id);
    if (!r) throw new Error("Pi dialog expired.");
    beforeDispatch?.();
    clearTimeout(r.timer);
    this.requests.delete(id);
    await this.native.write({
      type: "extension_ui_response",
      id,
      ...(r.m.method === "confirm"
        ? { confirmed: answer.choice === "confirm" }
        : { value: (answer.value as string[])[0] ?? "" }),
    });
    this.emit({ type: "resolved", id });
  }
  private activityInputs = new Map<string, { toolName: string; args: any }>();
  private message(m: any) {
    if (m.type === "extension_error") {
      this.diagnostics = [
        ...this.diagnostics.slice(-29),
        {
          kind: "extension-error",
          path:
            typeof m.extensionPath === "string" ? m.extensionPath : undefined,
          event: typeof m.event === "string" ? m.event : undefined,
        },
      ];
      this.refreshInventory();
    }
    if (m.type === "tool_execution_start")
      this.activityInputs.set(m.toolCallId, {
        toolName: m.toolName,
        args: m.args,
      });
    for (const activity of directUpdates(
      "pi",
      piActivities(m, this.activityInputs.get(m.toolCallId)),
    ))
      this.emit({ type: "activity", activity });
    if (m.type === "tool_execution_end")
      this.activityInputs.delete(m.toolCallId);
    if (m.type === "agent_settled") this.activityInputs.clear();
    if (m.type === "agent_start")
      this.emit({ type: "status", status: "running" });
    if (m.type === "agent_settled") {
      this.turnActive = false;
      for (const [id, r] of this.requests) {
        clearTimeout(r.timer);
        this.emit({ type: "resolved", id });
      }
      this.requests.clear();
      this.emit({
        type: "status",
        status: this.interrupted
          ? "interrupted"
          : this.failed
            ? "failed"
            : "completed",
        recoverable: true,
      });
    }
    if (m.type === "message_start" && m.message.role === "assistant")
      this.messageId = randomUUID();
    if (
      m.type === "message_update" &&
      m.assistantMessageEvent?.type === "text_delta"
    )
      this.emit({
        type: "delta",
        id: this.messageId,
        text: m.assistantMessageEvent.delta,
      });
    if (m.type === "message_end" && m.message.role === "assistant") {
      this.emit({
        type: "item",
        item: {
          id: this.messageId,
          kind: "assistant",
          text: m.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n"),
        },
      });
      if (m.message.errorMessage || m.message.stopReason === "error") {
        this.failed = true;
        this.emit({
          type: "error",
          message: m.message.errorMessage || "Pi assistant failed.",
        });
      }
    }
    if (
      [
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
      ].includes(m.type)
    )
      this.emit({
        type: "item",
        item: {
          id: m.toolCallId,
          kind: "tool",
          title: m.toolName,
          status:
            m.type === "tool_execution_end"
              ? m.isError
                ? "failed"
                : "completed"
              : "running",
          text: JSON.stringify(
            m.result ?? m.partialResult ?? m.args ?? {},
            null,
            2,
          ),
        },
      });
    if (m.type === "extension_ui_request") {
      if (
        this.startup &&
        ["confirm", "input", "editor", "select"].includes(m.method)
      ) {
        // A response in the same chunk resolves first; let its continuation
        // clear the startup marker before deciding.
        setImmediate(() => {
          if (!this.startup) return this.message(m);
          this.startup(
            new NativeSetupError(
              "native_startup_question",
              "A Pi extension asked a question while Pi was starting, and Pi cannot receive an answer from Loop until startup finishes. Run pi once in a terminal on the execution computer to answer it, then refresh Pi. No prompt was sent.",
            ),
          );
          void this.native.dispose();
        });
        return;
      }
      if (["confirm", "input", "editor", "select"].includes(m.method)) {
        const timer = m.timeout
          ? setTimeout(
              () => {
                this.requests.delete(m.id);
                this.emit({ type: "resolved", id: m.id });
              },
              Math.min(m.timeout, 86400000),
            )
          : undefined;
        this.requests.set(m.id, { m, timer });
        this.emit({
          type: "request",
          request:
            m.method === "confirm"
              ? {
                  id: m.id,
                  kind: "approval",
                  title: m.title,
                  detail: m.message,
                  choices: ["confirm", "cancel"],
                }
              : {
                  id: m.id,
                  kind: "question",
                  title: m.title,
                  detail: m.prefill ?? m.placeholder ?? "",
                  questions: [
                    { id: "value", title: m.title, options: m.options },
                  ],
                },
        });
      } else if (m.method === "notify")
        this.emit({
          type: "item",
          item: { id: m.id, kind: "notice", text: m.message },
        });
    }
  }
  async dispose() {
    this.controlState?.stop();
    if (this.infoWait) {
      clearTimeout(this.infoWait.timer);
      this.infoWait.reject(new Error("Stopped"));
      this.infoWait = undefined;
    }
    for (const r of this.requests.values()) clearTimeout(r.timer);
    await this.native?.dispose();
  }
}
