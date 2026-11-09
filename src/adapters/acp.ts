import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnNative } from "../native-spawn.js";
import { nativeFailureDetail, nativeMemoryFailure } from "../native-memory.js";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { killOwned, own } from "../processes.js";
import type { Adapter, Emit, Options, NativeCommand } from "./types.js";
import type { Billing, Item } from "../shared/protocol.js";
import {
  ACTIVITY_VERSION,
  ACTIVITY_LIMITS,
  parseActivityUpdate,
  undiscoveredCapabilities,
  type ActivityUpdate,
  type SettingValue,
  type SettingsData,
  type CommandsData,
  type FileChangeData,
} from "../shared/agent-activities.js";

const LIMIT = 8 * 1024 * 1024;
const STARTUP_MS = 15_000;
const PROMPT_FAILURE =
  "ACP turn failed. Check the agent's local login and logs, then retry the conversation.";
// Agents such as Grok Build attach the provider's HTTP status to a failed
// prompt. Only that number is read; the provider's message is never shown.
const PROMPT_STATUS_FAILURES: Record<number, string> = {
  401: "The agent's provider rejected its sign-in. Sign in to the agent again, then retry the conversation.",
  402: "The agent's provider account is out of credits or over its spending limit. Add credits or upgrade the plan, then retry the conversation.",
  429: "The agent's provider is rate limiting requests. Wait a moment, then retry the conversation.",
};
function promptFailure(error: unknown) {
  const status =
    error && typeof error === "object" && "data" in error
      ? (error.data as { http_status?: unknown } | null)?.http_status
      : undefined;
  return (
    (typeof status === "number" && PROMPT_STATUS_FAILURES[status]) ||
    PROMPT_FAILURE
  );
}
const SETTING_FAILURE =
  "ACP agent rejected the setting. Check the agent's local login and logs, then refresh settings and retry.";
class SafeAcpError extends Error {}
const text = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 64_000) : "";
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SafeAcpError(`${label} timed out`)),
        STARTUP_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Local ACP v1 subprocess. File and terminal host capabilities are deliberately absent. */
export class Acp implements Adapter {
  static readonly startupSteps: Readonly<Record<string, string>> = {
    initialize: "starting its native process",
  };
  capabilities = {
    approvals: true,
    questions: false,
    resume: false,
    liveAttach: false,
    terminal: false,
  };
  models: import("../shared/models.js").ModelOption[] = [
    { id: "native-default", name: "Use agent default" },
  ];
  protected verifySessionOnProbe = false;
  protected environment(): NodeJS.ProcessEnv {
    return process.env;
  }
  protected billing(): Billing {
    return {
      mode: "existing",
      description:
        "ACP agent uses its own local authentication and billing configuration.",
    };
  }
  commands: NativeCommand[] = [];
  activityCapabilities = undiscoveredCapabilities("ACP initialize pending");
  settings: SettingsData = { options: [], revision: 0 };
  commandCatalog: CommandsData = { commands: [], revision: 0 };
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private session?: string;
  private active = false;
  private cancelling = false;
  private terminalReported = false;
  private closed = false;
  private loading = false;
  /** session/load replayed at least one user or agent message. */
  protected historyReplayed = false;
  private sequence = new Map<string, number>();
  private settingWrite: Promise<void> = Promise.resolve();
  private pendingSettingWrites = 0;
  private supportsConfig = false;
  private modeState?: SessionModeState;
  private rawConfigOptions: SessionConfigOption[] = [];
  private modeConfirmation?: {
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private messageId = "";
  private toolKinds = new Map<string, string>();
  private toolCommands = new Map<string, string>();
  private toolItems = new Map<string, Item>();
  private toolOutputs = new Set<string>();
  // Durable file changes outlive replacement of the ACP display content.
  private toolFileChanges = new Map<
    string,
    { activity: string; omitted: number }
  >();
  private toolContent = new Map<
    string,
    Array<
      | { type: "text"; text: string }
      | { type: "file_change"; activity: string }
      | { type: "output"; activity: string }
      | { type: "unavailable"; label: string; reason: string }
    >
  >();
  private permissions = new Map<
    string,
    {
      choices: Set<string>;
      resolve: (value: RequestPermissionResponse) => void;
    }
  >();
  constructor(
    private options: Options,
    private emit: Emit,
  ) {}

  async start(): Promise<Billing> {
    const child = spawnNative(
      this.options.executable,
      this.options.args || [],
      {
        cwd: this.options.project,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.environment(),
      },
    );
    this.child = child;
    own(child);
    child.once("error", () => {
      this.cancelPermissions();
      if (!this.closed && !this.terminalReported) {
        this.terminalReported = true;
        this.emit({
          type: "status",
          status: "failed",
          detail:
            "ACP process failed. Check the executable path, local login, and agent logs.",
          recoverable: false,
        });
      }
      this.closed = true;
    });
    child.stderr.resume();
    child.once("exit", () => {
      const memory = nativeMemoryFailure(child);
      this.modeConfirmation?.reject(memory || new Error("ACP agent exited"));
      this.modeConfirmation = undefined;
      this.cancelPermissions();
      if (!this.closed && !this.terminalReported) {
        this.terminalReported = true;
        this.emit({
          type: "status",
          status: "failed",
          detail: nativeFailureDetail(
            memory,
            "ACP agent exited. Check local agent login and logs.",
          ),
          recoverable: false,
        });
      }
      this.closed = true;
    });
    // SDK frames are JSONL. Limit each incoming frame before it reaches its parser.
    let frameBytes = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          frameBytes = byte === 10 ? 0 : frameBytes + 1;
          if (frameBytes > LIMIT) throw new Error("ACP frame exceeds 8 MiB");
        }
        controller.enqueue(chunk);
      },
    });
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    void input.pipeTo(bounded.writable).catch(() => child.kill());
    this.connection = new ClientSideConnection(
      (): Client => ({
        requestPermission: (params) => this.permission(params),
        sessionUpdate: (params) => this.update(params),
      }),
      ndJsonStream(output, bounded.readable),
    );
    try {
      const init = await within(
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "Loop", version: "0.1.0" },
          clientCapabilities: {
            session: { configOptions: { boolean: {} } },
            plan: {},
          },
        }),
        "ACP initialize",
      );
      if (init.protocolVersion !== PROTOCOL_VERSION)
        throw new SafeAcpError(
          `ACP protocol is unsupported; Loop supports v${PROTOCOL_VERSION}.`,
        );
      this.capabilities.resume = init.agentCapabilities?.loadSession === true;
      this.activityCapabilities = Object.fromEntries(
        Object.keys(this.activityCapabilities).map((feature) => [
          feature,
          {
            state: feature === "tools" ? "supported" : "undiscovered",
            source: "ACP SDK 1.5.0 / initialize",
            ...(feature === "settings" || feature === "commands"
              ? { reason: "Awaiting session discovery" }
              : {}),
          },
        ]),
      ) as typeof this.activityCapabilities;
      this.emit({
        type: "activity_capabilities",
        capabilities: this.activityCapabilities,
      });
      if (init.authMethods?.length && !this.verifySessionOnProbe) {
        // Authentication methods are agent-specific; do not claim a successful login.
        this.emit({
          type: "error",
          message:
            "ACP agent offers authentication methods. Sign in with the agent's own CLI if session creation requires it.",
        });
      }
      // Generic ACP probes only initialize. Known harnesses can require a
      // prompt-free session to verify authentication and discover models.
      if (this.options.probeOnly && !this.verifySessionOnProbe)
        return this.billing();
      const mcpServers =
        this.options.workspaceTools &&
        init.agentCapabilities?.mcpCapabilities?.http
          ? [
              {
                type: "http" as const,
                name: "loop-workspace",
                url: this.options.workspaceTools.url,
                headers: [
                  {
                    name: "Authorization",
                    value: `Bearer ${this.options.workspaceTools.token}`,
                  },
                ],
              },
            ]
          : [];
      if (this.options.resume) {
        if (!this.capabilities.resume)
          throw new SafeAcpError(
            "This ACP agent does not advertise session/load. The existing conversation cannot resume.",
          );
        this.loading = true;
        this.session = this.options.resume;
        const loaded = await within(
          this.connection.loadSession({
            sessionId: this.options.resume,
            cwd: this.options.project,
            mcpServers,
          }),
          "ACP session/load",
        );
        this.supportsConfig = loaded.configOptions != null;
        this.refreshModels(loaded);
        this.refreshSettings(
          loaded.configOptions || [],
          loaded.modes || undefined,
        );
        this.loading = false;
      } else {
        const result = await within(
          this.connection.newSession({
            cwd: this.options.project,
            mcpServers,
          }),
          "ACP session/new",
        );
        this.session = result.sessionId;
        this.refreshModels(result);
        this.supportsConfig = result.configOptions != null;
        this.refreshSettings(
          result.configOptions || [],
          result.modes || undefined,
        );
      }
      if (this.options.probeOnly) return this.billing();
      if (this.options.model && this.options.model !== "native-default") {
        if (!this.models.some((model) => model.id === this.options.model))
          throw new SafeAcpError(
            "Selected model is not in the agent's session catalog.",
          );
        await within(
          this.connection.request("session/set_model", {
            sessionId: this.session,
            modelId: this.options.model,
          }),
          "ACP session/set_model",
        );
      }
      this.emit({ type: "metadata", nativeSession: this.session });
      this.emit({ type: "status", status: "ready" });
      return this.billing();
    } catch (error) {
      await this.dispose();
      const memory = nativeMemoryFailure(child);
      if (memory) throw memory;
      throw new Error(
        `ACP setup failed: ${error instanceof SafeAcpError ? error.message : "The agent did not complete setup."} Check the agent executable, local sign-in, and ACP compatibility.`,
      );
    }
  }
  private refreshModels(response: unknown) {
    // Current ACP agents can report the model extension, absent from SDK 1.5's
    // static types. Validate the native catalog before exposing it to the UI.
    const parsed = z
      .object({
        models: z
          .object({
            availableModels: z
              .array(
                z.object({
                  modelId: z.string().min(1).max(200),
                  name: z.string().min(1).max(200),
                }),
              )
              .max(300),
          })
          .optional(),
      })
      .safeParse(response);
    const state = parsed.success ? parsed.data.models : undefined;
    if (!state) return;
    this.models = [
      { id: "native-default", name: "Use agent default" },
      ...state.availableModels.map((model) => ({
        id: model.modelId,
        name: model.name,
      })),
    ];
  }
  async prompt(value: string, beforeDispatch?: () => void) {
    if (
      this.closed ||
      !this.connection ||
      !this.session ||
      this.active ||
      this.pendingSettingWrites
    )
      throw new Error("ACP session is unavailable or busy");
    beforeDispatch?.();
    this.active = true;
    this.toolCommands.clear();
    this.cancelling = false;
    this.terminalReported = false;
    this.messageId = randomUUID();
    void this.connection
      .prompt({
        sessionId: this.session,
        prompt: [{ type: "text", text: value }],
      })
      .then((result) => {
        if (this.closed || this.terminalReported) return;
        this.terminalReported = true;
        const limited = ["max_tokens", "max_turn_requests"].includes(
          result.stopReason,
        );
        this.emit({
          type: "status",
          status:
            this.cancelling ||
            ["cancelled", "max_tokens", "max_turn_requests"].includes(
              result.stopReason,
            )
              ? "interrupted"
              : "completed",
          detail: limited
            ? "ACP turn stopped at the agent's limit."
            : undefined,
          recoverable: true,
        });
      })
      .catch((error: unknown) => {
        if (this.closed || this.terminalReported) return;
        this.terminalReported = true;
        this.emit({
          type: "status",
          status: "failed",
          detail: nativeFailureDetail(
            this.child && nativeMemoryFailure(this.child),
            promptFailure(error),
          ),
          recoverable: false,
        });
      })
      .finally(() => {
        this.active = false;
        this.cancelPermissions();
      });
  }
  async cancel() {
    this.cancelling = true;
    this.cancelPermissions();
    if (!this.closed && this.session && this.connection && this.active)
      await this.connection.cancel({ sessionId: this.session });
  }
  async answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ) {
    const pending = this.permissions.get(id);
    if (!pending) throw new Error("ACP permission expired");
    if (
      typeof answer.choice !== "string" ||
      !pending.choices.has(answer.choice)
    )
      throw new Error("Choose a listed ACP permission option");
    beforeDispatch?.();
    this.permissions.delete(id);
    pending.resolve({
      outcome: { outcome: "selected", optionId: answer.choice },
    });
    this.emit({ type: "resolved", id });
  }
  async dispose() {
    this.closed = true;
    this.modeConfirmation?.reject(new Error("ACP session closed"));
    this.modeConfirmation = undefined;
    this.cancelPermissions();
    if (this.child) {
      killOwned(this.child, "SIGTERM");
      const child = this.child;
      setTimeout(() => {
        if (child.exitCode === null) killOwned(child, "SIGKILL");
      }, 2000).unref();
    }
  }
  private cancelPermissions() {
    for (const [id, pending] of this.permissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit({ type: "resolved", id });
    }
    this.permissions.clear();
  }
  private activity(
    kind: ActivityUpdate["kind"],
    id: string,
    patch: any,
    replay = false,
  ) {
    const key = `${kind}:${id}`;
    try {
      const update = parseActivityUpdate({
        v: ACTIVITY_VERSION,
        kind,
        id: id.slice(0, 300),
        source: {
          transport: "acp",
          harness: this.options.harness,
          origin: "acp",
        },
        seq: (this.sequence.get(key) || 0) + 1,
        replay,
        patch,
      });
      this.sequence.set(key, update.seq || 0);
      this.emit({ type: "activity", activity: update });
      const feature = {
        plan: "plans",
        tool: "tools",
        file_change: "diffs",
        output: "output",
        settings: "settings",
        commands: "commands",
      }[kind] as keyof typeof this.activityCapabilities;
      if (
        feature !== "settings" &&
        feature !== "commands" &&
        !(kind === "output" && patch.unavailable) &&
        this.activityCapabilities[feature].state !== "supported"
      ) {
        this.activityCapabilities[feature] = {
          state: "supported",
          source: "ACP session/update",
        };
        this.emit({
          type: "activity_capabilities",
          capabilities: this.activityCapabilities,
        });
      }
    } catch {
      // Invalid or oversized display metadata must not kill the agent session.
      this.emit({
        type: "error",
        message: "ACP activity exceeded Loop display bounds",
      });
    }
  }
  private refreshSettings(
    options: SessionConfigOption[],
    modes?: SessionModeState,
  ) {
    const previousIds = this.settings.options.map((option) => option.id);
    this.rawConfigOptions = options;
    if (modes) this.modeState = modes;
    modes = this.modeState;
    const mapped = options.slice(0, 50).map((option) => ({
      id: option.id.slice(0, 300),
      label: option.name.slice(0, 500),
      description: option.description?.slice(0, 2000) || undefined,
      type: option.type,
      confirmed: option.currentValue,
      choices:
        option.type === "select"
          ? option.options
              .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
              .slice(0, 100)
              .map((entry) => ({
                value: entry.value,
                label: entry.name,
                description: entry.description || undefined,
              }))
          : undefined,
      application: "next-turn" as const,
      mutable: this.supportsConfig,
      reason: this.supportsConfig
        ? undefined
        : "Agent did not advertise session config mutation",
      provenance: "acp session",
    }));
    if (
      modes &&
      !options.some((x) => x.category === "mode") &&
      !mapped.some((x) => x.id === "acp-mode")
    )
      mapped.push({
        id: "acp-mode",
        label: "Mode",
        description: undefined,
        type: "select",
        confirmed: modes.currentModeId,
        choices: modes.availableModes.map((mode) => ({
          value: mode.id,
          label: mode.name,
          description: mode.description || undefined,
        })),
        application: "next-turn",
        mutable: true,
        reason: undefined,
        provenance: "acp session",
      });
    this.settings = { options: mapped, revision: this.settings.revision + 1 };
    const currentIds = new Set(mapped.map((option) => option.id));
    this.activity("settings", "acp-session-settings", {
      options: mapped,
      remove: previousIds.filter((id) => !currentIds.has(id)),
      revision: this.settings.revision,
    });
    this.activityCapabilities.settings = {
      state: mapped.length ? "supported" : "unsupported",
      source: "ACP session response",
      reason: mapped.length ? undefined : "Agent supplied no session controls",
    };
    this.emit({
      type: "activity_capabilities",
      capabilities: this.activityCapabilities,
    });
  }
  async setSetting(
    id: string,
    value: SettingValue,
    revision: number,
    beforeApply?: () => void,
  ): Promise<SettingsData> {
    // Serialize mutations and check revisions at the actual dispatch boundary.
    this.pendingSettingWrites++;
    let resolve!: (value: SettingsData) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<SettingsData>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.settingWrite = this.settingWrite.then(async () => {
      try {
        if (this.closed || !this.connection || !this.session)
          throw new Error("ACP session unavailable");
        if (this.active)
          throw new Error(
            "Wait for the current turn to finish before changing settings",
          );
        if (revision !== this.settings.revision)
          throw new Error(
            "Settings changed. Refresh before applying a new value",
          );
        const option = this.settings.options.find(
          (x) => x.id === id && x.mutable,
        );
        if (
          !option ||
          (option.type === "boolean"
            ? typeof value !== "boolean"
            : typeof value !== "string" ||
              !option.choices?.some((c) => c.value === value))
        )
          throw new Error("Unsupported ACP setting or value");
        beforeApply?.();
        this.settings = {
          ...this.settings,
          revision: this.settings.revision + 1,
          options: this.settings.options.map((x) =>
            x.id === id ? { ...x, requested: value, rejected: null } : x,
          ),
        };
        this.activity("settings", "acp-session-settings", {
          options: this.settings.options,
          revision: this.settings.revision,
        });
        try {
          if (id === "acp-mode" && this.modeState) {
            const confirmed = new Promise<void>((yes, no) => {
              this.modeConfirmation = {
                id: value as string,
                resolve: yes,
                reject: no,
              };
            });
            await this.connection.setSessionMode({
              sessionId: this.session,
              modeId: value as string,
            });
            let timeout: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                confirmed,
                new Promise<never>((_, no) => {
                  timeout = setTimeout(
                    () =>
                      no(new Error("Agent did not confirm the mode change")),
                    5000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
          } else {
            const response = await this.connection.setSessionConfigOption({
              sessionId: this.session,
              configId: id,
              ...(option.type === "boolean"
                ? { type: "boolean" as const, value: value as boolean }
                : { value: value as string }),
            });
            this.refreshSettings(response.configOptions);
          }
          resolve(this.settings);
        } catch {
          this.modeConfirmation = undefined;
          this.settings = {
            ...this.settings,
            revision: this.settings.revision + 1,
            options: this.settings.options.map((x) =>
              x.id === id
                ? {
                    ...x,
                    requested: null,
                    rejected: SETTING_FAILURE,
                  }
                : x,
            ),
          };
          this.activity("settings", "acp-session-settings", {
            options: this.settings.options,
            revision: this.settings.revision,
          });
          throw new Error(SETTING_FAILURE);
        }
      } catch (error) {
        reject(error);
      } finally {
        this.pendingSettingWrites--;
      }
    });
    return result;
  }
  private permission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (
      this.closed ||
      this.cancelling ||
      this.loading ||
      request.sessionId !== this.session ||
      !this.active ||
      this.permissions.size >= 25
    )
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const choices = request.options
      .filter(
        (o) =>
          ["allow_once", "reject_once"].includes(o.kind) &&
          o.optionId.length <= 300 &&
          o.name.length <= 500,
      )
      .slice(0, 25);
    if (!choices.length)
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.permissions.set(id, {
        choices: new Set(choices.map((choice) => choice.optionId)),
        resolve,
      });
      this.emit({
        type: "request",
        request: {
          id,
          kind: "approval",
          title: text(request.toolCall.title).slice(0, 500) || "ACP permission",
          detail: choices.map((o) => `${o.name} (${o.kind})`).join("\n"),
          choices: choices.map((o) => o.optionId),
          allow: choices.find((o) => o.kind === "allow_once")?.optionId,
        },
      });
    });
  }
  private update(notification: SessionNotification) {
    if (this.closed || notification.sessionId !== this.session) return;
    const u = notification.update;
    if (
      this.loading &&
      ["user_message_chunk", "agent_message_chunk"].includes(u.sessionUpdate)
    )
      this.historyReplayed = true;
    if (
      !this.loading &&
      !this.active &&
      ![
        "config_option_update",
        "current_mode_update",
        "available_commands_update",
      ].includes(u.sessionUpdate)
    )
      return;
    if (u.sessionUpdate === "agent_message_chunk") {
      if (!this.loading && u.content.type === "text")
        this.emit({
          type: "delta",
          id: this.messageId,
          text: text(u.content.text),
        });
      return;
    }
    if (
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update"
    ) {
      const old = this.toolItems.get(u.toolCallId);
      const kind = u.kind ?? this.toolKinds.get(u.toolCallId);
      if (kind) this.toolKinds.set(u.toolCallId, kind);
      // Commands come from invocation input, never a tool title or result prose.
      const input = u.rawInput;
      const command =
        input &&
        typeof input === "object" &&
        "command" in input &&
        typeof input.command === "string"
          ? input.command
          : undefined;
      if (kind === "execute" && command && command.length <= 4000)
        this.toolCommands.set(u.toolCallId, command);
      const item: Item = {
        id: `acp:${this.session}:${u.toolCallId}`,
        kind: "tool",
        title: text(u.title) || old?.title || "ACP tool",
        text:
          u.content
            ?.map((c) =>
              c.type === "content" && c.content.type === "text"
                ? c.content.text
                : "",
            )
            .join("\n")
            .slice(0, 64_000) ??
          old?.text ??
          "",
        status: u.status || old?.status || "pending",
      };
      this.toolItems.set(u.toolCallId, item);
      const tool = u.toolCallId.slice(0, 300);
      const content: Array<
        | { type: "text"; text: string }
        | { type: "file_change"; activity: string }
        | { type: "output"; activity: string }
        | { type: "unavailable"; label: string; reason: string }
      > = u.content ? [] : this.toolContent.get(u.toolCallId) || [];
      const files: FileChangeData["files"] = [];
      let omitted = 0;
      for (const c of u.content || []) {
        if (c.type === "content") {
          if (c.content.type === "text")
            content.push({
              type: "text",
              text: text(c.content.text).slice(0, 16000),
            });
          else
            content.push({
              type: "unavailable",
              label: c.content.type,
              reason: "This ACP content type is not rendered by Loop",
            });
        } else if (c.type === "diff") {
          if (files.length >= ACTIVITY_LIMITS.files) {
            omitted++;
            continue;
          }
          const bytes =
            Buffer.byteLength(c.oldText || "") + Buffer.byteLength(c.newText);
          files.push({
            path: c.path.slice(0, 4096),
            operation: c.oldText == null ? "create" : "modify",
            ...(bytes <= 256 * 1024
              ? {
                  content: "available",
                  before: c.oldText ?? null,
                  after: c.newText,
                }
              : {
                  content: "oversized",
                  reason: "ACP diff exceeds display limit",
                }),
          });
        } else if (c.type === "terminal") {
          const id = `${tool}:terminal`;
          this.activity(
            "output",
            id,
            {
              tool,
              terminal: c.terminalId,
              unavailable:
                "Agent referenced a terminal that Loop did not host; terminal output is unavailable",
            },
            this.loading,
          );
          content.push({ type: "output", activity: id });
        }
      }
      if (files.length) {
        this.toolFileChanges.set(u.toolCallId, {
          activity: `${tool}:diff`,
          omitted,
        });
        this.activity(
          "file_change",
          `${tool}:diff`,
          {
            tool,
            state:
              item.status === "completed"
                ? "applied"
                : item.status === "failed"
                  ? "failed"
                  : "proposed",
            files,
          },
          this.loading,
        );
      }
      const fileChange = this.toolFileChanges.get(u.toolCallId);
      if (fileChange) {
        if (
          !content.some(
            (entry) =>
              entry.type === "file_change" &&
              entry.activity === fileChange.activity,
          )
        )
          content.push({ type: "file_change", activity: fileChange.activity });
        if (fileChange.omitted && u.content)
          content.push({
            type: "unavailable",
            label: "Additional file changes",
            reason: `Showing the first ${ACTIVITY_LIMITS.files} files; ${fileChange.omitted} additional diffs omitted from display.`,
          });
        if (
          !files.length &&
          (u.status === "completed" || u.status === "failed")
        )
          this.activity(
            "file_change",
            fileChange.activity,
            { state: u.status === "completed" ? "applied" : "failed" },
            this.loading,
          );
      }
      if (
        kind === "execute" &&
        u.content?.some(
          (c) => c.type === "content" && c.content.type === "text",
        )
      ) {
        const id = `${tool}:output`;
        this.toolOutputs.add(u.toolCallId);
        const joined = u.content
          .flatMap((c) =>
            c.type === "content" && c.content.type === "text"
              ? [c.content.text]
              : [],
          )
          .join("\n");
        const output = joined.slice(-64000);
        this.activity(
          "output",
          id,
          {
            tool,
            replace: [{ stream: "combined", text: output }],
            ...(this.toolCommands.has(u.toolCallId) && {
              command: this.toolCommands.get(u.toolCallId),
            }),
            ...(joined.length > 64000 && { upstreamTruncated: true }),
            status:
              item.status === "completed"
                ? "exited"
                : item.status === "failed"
                  ? "failed"
                  : "running",
          },
          this.loading,
        );
        content.push({ type: "output", activity: id });
      }
      if (this.toolOutputs.has(u.toolCallId)) {
        const id = `${tool}:output`;
        if (!content.some((c) => c.type === "output" && c.activity === id))
          content.push({ type: "output", activity: id });
        if (u.status)
          this.activity(
            "output",
            `${tool}:output`,
            {
              ...(this.toolCommands.has(u.toolCallId) && {
                command: this.toolCommands.get(u.toolCallId),
              }),
              status:
                item.status === "completed"
                  ? "exited"
                  : item.status === "failed"
                    ? "failed"
                    : "running",
            },
            this.loading,
          );
      }
      this.toolContent.set(u.toolCallId, content);
      this.activity(
        "tool",
        tool,
        {
          title: item.title,
          category: kind,
          status:
            item.status === "in_progress"
              ? "running"
              : item.status === "pending"
                ? "proposed"
                : item.status || "proposed",
          content,
          locations: u.locations?.map((x) => x.path.slice(0, 4096)),
          links: { native: u.toolCallId.slice(0, 300) },
        },
        this.loading,
      );
      return;
    }
    if (u.sessionUpdate === "plan") {
      this.activity(
        "plan",
        "acp-plan",
        {
          steps: u.entries.slice(0, 100).map((entry, index) => ({
            id: `step-${index}`,
            positional: true,
            title: entry.content.slice(0, 2000),
            status: entry.status,
            priority: entry.priority,
          })),
        },
        this.loading,
      );
      return;
    }
    if (u.sessionUpdate === "plan_update") {
      const plan = u.plan;
      if (plan.type === "items")
        this.activity(
          "plan",
          plan.planId,
          {
            steps: plan.entries.slice(0, 100).map((entry, index) => ({
              id: `step-${index}`,
              positional: true,
              title: entry.content.slice(0, 2000),
              status: entry.status,
              priority: entry.priority,
            })),
          },
          this.loading,
        );
      else if (plan.type === "markdown")
        this.activity(
          "plan",
          plan.planId,
          { steps: [], explanation: text(plan.content).slice(0, 16000) },
          this.loading,
        );
      else
        this.activity(
          "plan",
          plan.planId,
          {
            steps: [],
            explanation: `Plan file ${text(plan.uri).slice(0, 500)} is not readable through this ACP client`,
          },
          this.loading,
        );
      return;
    }
    if (u.sessionUpdate === "plan_removed") {
      this.activity(
        "plan",
        u.planId,
        { steps: [], explanation: "Plan removed by agent" },
        this.loading,
      );
      return;
    }
    if (u.sessionUpdate === "config_option_update") {
      this.refreshSettings(u.configOptions);
      return;
    }
    if (u.sessionUpdate === "current_mode_update" && this.modeState) {
      this.modeState = { ...this.modeState, currentModeId: u.currentModeId };
      this.refreshSettings(this.rawConfigOptions);
      if (this.modeConfirmation?.id === u.currentModeId) {
        this.modeConfirmation.resolve();
        this.modeConfirmation = undefined;
      }
      return;
    }
    if (u.sessionUpdate === "available_commands_update") {
      this.commands = u.availableCommands.map((c) => ({
        name: c.name,
        token: `/${c.name}`,
        kind: "command",
        description: c.description || "",
        argumentHint: c.input?.hint,
      }));
      this.commandCatalog = {
        revision: this.commandCatalog.revision + 1,
        commands: this.commands.slice(0, 500).map((c) => ({
          id: c.name.slice(0, 300),
          token: c.token,
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          kind: c.kind,
          available: true,
        })),
      };
      this.activity("commands", "acp-session-commands", this.commandCatalog);
      this.activityCapabilities.commands = {
        state: "supported",
        source: "ACP available_commands_update",
      };
      this.emit({
        type: "activity_capabilities",
        capabilities: this.activityCapabilities,
      });
    }
  }
}
