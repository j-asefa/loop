import { directActivityEmitter } from "./direct-activities.js";
import { DirectControls } from "./direct-controls.js";
import type { Setting, SettingValue } from "../agent-activities.js";
import { piActivities, directUpdates } from "./direct-activities.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Native } from "../native.js";
import {
  capabilities,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";
import type { Billing } from "../protocol.js";

export class Pi implements Adapter {
  private controlState?: DirectControls;
  private get displayControls() {
    return (this.controlState ||= new DirectControls("pi", this.emit));
  }
  get settings() {
    return this.displayControls.settings;
  }
  get commandCatalog() {
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
            }));
        },
        (commands) => {
          this.commands = commands;
        },
      );
    }
    return this.displayControls.commands;
  }
  get activityCapabilities() {
    return this.displayControls.capabilities;
  }

  capabilities = { ...capabilities };
  models: { id: string; name: string }[] = [];
  commands: NativeCommand[] = [];
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
  private requests = new Map<string, { m: any; timer?: NodeJS.Timeout }>();
  constructor(
    private options: Options,
    private emit: Emit,
  ) {
    this.emit = directActivityEmitter(emit);
  }
  private async readSettings(): Promise<Setting[]> {
    const state = await this.native.request("get_state", {}, false);
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
    ];
  }
  async setSetting(id: string, value: SettingValue, revision: number) {
    return this.displayControls.change(id, value, revision, async () => {
      if (typeof value !== "string") throw new Error("Invalid setting value.");
      if (id === "model") {
        const slash = value.indexOf("/");
        await this.native.request(
          "set_model",
          { provider: value.slice(0, slash), modelId: value.slice(slash + 1) },
          false,
        );
      } else if (id === "effort")
        await this.native.request(
          "set_thinking_level",
          { level: value },
          false,
        );
      else throw new Error("Unknown setting.");
      return this.readSettings();
    });
  }
  async start(): Promise<Billing> {
    const extension = fileURLToPath(
      new URL("../pi-extension.mjs", import.meta.url),
    );
    const firstInfo = this.waitInfo();
    this.native = new Native(
      this.options.executable,
      [
        "--mode",
        "rpc",
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
      if (this.infoWait) {
        clearTimeout(this.infoWait.timer);
        this.infoWait.resolve(info);
        this.infoWait = undefined;
      }
    });
    this.native.on("message", (m) => this.message(m));
    this.native.on("failure", () => {
      this.emit({
        type: "status",
        status: "failed",
        detail: "Pi exited. Check native login, project trust and extensions.",
      });
    });
    await firstInfo;
    this.checkBilling();
    const state = await this.native.request("get_state", {}, false);
    const available = await this.native.request(
      "get_available_models",
      {},
      false,
    );
    this.models = (available.models || []).map((m: any) => ({
      id: m.provider + "/" + m.id,
      name: m.name || m.id,
    }));
    const catalog = await this.native.request("get_commands", {}, false);
    this.commands = (catalog.commands || [])
      .filter((c: any) => c.name !== "loop-status")
      .map((c: any) => ({
        name: c.name,
        token: "/" + c.name,
        kind: c.source || "command",
        description: c.description || "",
      }));
    this.displayControls.publish(await this.readSettings(), this.commands);
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
          new Error(
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
      throw new Error(
        "Pi could not load workspace tools. Check the local Loop bridge; no prompt was sent.",
      );
    if (!this.info?.configured)
      throw new Error(
        "Pi has no configured auth for its selected model. Sign in using Pi /login.",
      );
    if (this.options.billing === "subscription" && !this.info.subscription)
      throw new Error(
        "Pi did not confirm subscription support for the effective provider/auth. Use native Pi /login and provider selection, or explicitly choose --billing existing.",
      );
  }
  async prompt(text: string) {
    const metadata = this.waitInfo();
    await this.native.request("prompt", { message: "/loop-status" }, false);
    await metadata;
    this.checkBilling();
    this.interrupted = false;
    this.failed = false;
    await this.native.request("prompt", { message: text }, false);
  }
  async cancel() {
    this.interrupted = true;
    await this.native.request("abort", {}, false);
  }
  async answer(id: string, answer: Record<string, unknown>) {
    const r = this.requests.get(id);
    if (!r) throw new Error("Pi dialog expired.");
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
