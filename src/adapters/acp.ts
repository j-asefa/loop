import { isWorkspaceMemorySearch } from "../shared/workspace-tools.js";
import { workspaceMcp } from "./workspace-mcp.js";
import { NativeSetupError } from "./setup-error.js";
import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnHarnessProcess, stopHarnessProcess } from "../native-spawn.js";
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
import { NotDelivered } from "./types.js";
import type { Adapter, Emit, Options, NativeCommand } from "./types.js";
import type { Billing, Item } from "../shared/protocol.js";
import { normalizeItemStatus } from "../shared/native-item-state.js";
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
type Echo = { expected: string; seen: string; resolve(): void };
/** Chunks of one message arrive in order. A chunk that cannot extend the
 * expected text starts another message. Text is compared exactly apart from
 * whitespace at either end of the message. Returns whether it is complete. */
function matchEcho(echo: Echo, chunk: string) {
  const extended = echo.seen + chunk;
  echo.seen = echo.expected.startsWith(extended.trim())
    ? extended
    : echo.expected.startsWith(chunk.trim())
      ? chunk
      : "";
  return echo.seen.trim() === echo.expected;
}
// agy echoes a prompt within a second of receiving it.
const ECHO_WAIT = 5000;
const REACTIVE_IDLE_MS = 60_000;
const REACTIVE_WATCHDOG_MS = 60 * 60_000;
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
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
  protected requireWorkspaceTools = false;
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
  private commandDiscoveryComplete = false;
  private commandWaiters = new Set<(proceed: boolean) => void>();
  private creatingSession = false;
  // Keep at most one bounded notification until session/new identifies its owner.
  private startupCommands?: SessionNotification;
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
  /** Resume with session/resume, which reopens the conversation without
   * replaying its history, instead of session/load. */
  protected resumeWithoutReplay = false;
  /** Report each turn's cumulative token usage from prompt responses. */
  protected reportsUsage = false;
  /** agy can return end_turn before its background work wakes the model. */
  protected waitsForReactiveTurns = false;
  private reactiveTools = new Set<string>();
  private reactiveEnd = false;
  private canResolveAsDaemonOnly = false;
  private reactiveIdle?: NodeJS.Timeout;
  private reactiveWatchdog?: NodeJS.Timeout;
  private reactiveWatchdogStarted = 0;
  private reactiveBudget = REACTIVE_WATCHDOG_MS;
  private retireReactiveSession = false;
  get reusable() {
    return !this.retireReactiveSession;
  }
  /** Prompt requests open in the current turn. A steering agent answers an
   * earlier request when it folds a later one into the same turn; the turn
   * ends only when the last open request settles. */
  private openPrompts = 0;
  private turnUsage?: { input_tokens: number; output_tokens: number };
  private echo?: Echo;
  /** Settles when the agent has echoed the turn's whole prompt, so no part
   * of that echo can be taken for a steering input's. */
  private promptEchoed: Promise<void> = Promise.resolve();
  private promptEcho?: Echo;
  private steering = false;
  /** The steering input's echo arrived, so it joined the running turn. */
  private steerJoined = false;
  /** An earlier request of this turn ended it normally. */
  private earlierEnd = false;
  private end!: () => void;
  /** Settles when the agent process exits or the session is disposed. */
  private ended = new Promise<void>((resolve) => {
    this.end = resolve;
  });
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
  /** Harness-specific setup stays inside the shared session startup boundary. */
  protected async configureSession(): Promise<void> {}
  protected settingId(matches: (id: string, name: string) => boolean) {
    return this.rawConfigOptions.find((option) =>
      matches(option.id, option.name),
    )?.id;
  }
  /** Startup writes share the request deadline, including queue/agent delays. */
  protected async configureSetting(id: string, value: SettingValue) {
    try {
      await within(
        this.setSetting(id, value, this.settings.revision),
        "ACP session/set_config_option",
      );
    } catch (error) {
      if (error instanceof SafeAcpError)
        throw new NativeSetupError(
          "native_acp_configuration_timeout",
          `The agent did not confirm startup configuration within ${STARTUP_MS / 1000} seconds. Retry when the execution computer is less busy; if this persists, check the agent's model and effort configuration. No prompt was sent.`,
        );
      throw error;
    }
  }
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
    // A session disposed before it started never spawns its process.
    if (this.closed) throw new Error("ACP session closed before it started");
    const child = spawnHarnessProcess(
      this.options.executable,
      this.options.args || [],
      {
        cwd: this.options.project,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.environment(),
      },
    );
    this.child = child;
    child.once("error", () => {
      clearTimeout(this.reactiveIdle);
      clearTimeout(this.reactiveWatchdog);
      this.end();
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
      this.finishCommandDiscovery(false);
    });
    child.stderr.resume();
    child.once("exit", () => {
      clearTimeout(this.reactiveIdle);
      clearTimeout(this.reactiveWatchdog);
      this.end();
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
      this.finishCommandDiscovery(false);
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
      this.capabilities.resume = this.resumeWithoutReplay
        ? init.agentCapabilities?.sessionCapabilities?.resume != null
        : init.agentCapabilities?.loadSession === true;
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
      if (
        this.requireWorkspaceTools &&
        !init.agentCapabilities?.mcpCapabilities?.http
      )
        throw new SafeAcpError(
          "This ACP agent does not advertise HTTP workspace tools.",
        );
      const mcpServers =
        this.options.workspaceTools &&
        init.agentCapabilities?.mcpCapabilities?.http
          ? workspaceMcp(this.options.workspaceTools).acp
          : [];
      if (this.options.resume && this.resumeWithoutReplay) {
        if (init.agentCapabilities?.sessionCapabilities?.resume == null)
          throw new SafeAcpError(
            "This ACP agent does not advertise session/resume. The existing conversation cannot resume.",
          );
        this.session = this.options.resume;
        const resumed = await within(
          this.connection.resumeSession({
            sessionId: this.options.resume,
            cwd: this.options.project,
            mcpServers,
          }),
          "ACP session/resume",
        );
        this.supportsConfig = resumed.configOptions != null;
        this.refreshModels(resumed);
        this.refreshSettings(
          resumed.configOptions || [],
          resumed.modes || undefined,
        );
      } else if (this.options.resume) {
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
        this.creatingSession = true;
        const result = await within(
          this.connection.newSession({
            cwd: this.options.project,
            mcpServers,
          }),
          "ACP session/new",
        );
        this.session = result.sessionId;
        this.creatingSession = false;
        this.refreshModels(result);
        this.supportsConfig = result.configOptions != null;
        this.refreshSettings(
          result.configOptions || [],
          result.modes || undefined,
        );
        const pendingCommands = this.startupCommands;
        this.startupCommands = undefined;
        if (pendingCommands) this.update(pendingCommands);
      }
      if (
        !this.options.probeOnly &&
        this.options.model &&
        this.options.model !== "native-default"
      ) {
        if (!this.models.some((model) => model.id === this.options.model))
          throw new NativeSetupError(
            "native_model_unavailable",
            "Selected model is not in the agent's current catalog. Choose an available model in Model & connection, then retry. No prompt was sent.",
          );
        const setting = this.rawConfigOptions.find(
          (option) => option.category === "model" && option.type === "select",
        );
        try {
          if (setting) {
            await this.configureSetting(setting.id, this.options.model);
          } else {
            await within(
              this.connection.request("session/set_model", {
                sessionId: this.session,
                modelId: this.options.model,
              }),
              "ACP session/set_model",
            );
          }
        } catch (error) {
          if (
            error instanceof SafeAcpError ||
            error instanceof NativeSetupError
          )
            throw error;
          throw new NativeSetupError(
            "native_model_rejected",
            "The agent could not apply the selected model. Choose an available model in Model & connection or check the agent's model configuration, then retry. No prompt was sent.",
          );
        }
      }
      await this.configureSession();
      if (this.options.probeOnly) return this.billing();
      this.emit({ type: "metadata", nativeSession: this.session });
      this.emit({ type: "status", status: "ready" });
      return this.billing();
    } catch (error) {
      await this.dispose();
      const memory = nativeMemoryFailure(child);
      if (memory) throw memory;
      if (error instanceof NativeSetupError) throw error;
      if (error instanceof SafeAcpError)
        throw new NativeSetupError(
          "native_acp_setup_failed",
          `ACP setup failed: ${error.message} Check the agent executable and ACP compatibility, then enable the connection again. No prompt was sent.`,
        );
      throw new Error(
        "ACP setup failed: The agent did not complete setup. Check the agent executable, local sign-in, and ACP compatibility.",
      );
    }
  }
  private refreshModels(response: unknown) {
    const config = z
      .object({
        configOptions: z
          .array(
            z.object({
              category: z.string().optional(),
              type: z.string(),
              options: z
                .array(
                  z.union([
                    z.object({
                      value: z.string().min(1).max(200),
                      name: z.string().min(1).max(200),
                    }),
                    z.object({
                      group: z.string(),
                      options: z.array(
                        z.object({
                          value: z.string().min(1).max(200),
                          name: z.string().min(1).max(200),
                        }),
                      ),
                    }),
                  ]),
                )
                .optional(),
            }),
          )
          .optional(),
      })
      .safeParse(response);
    const model = config.success
      ? config.data.configOptions?.find(
          (option) => option.category === "model" && option.type === "select",
        )
      : undefined;
    if (model?.options) {
      this.models = [
        { id: "native-default", name: "Use agent default" },
        ...model.options
          .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
          .map((entry) => ({ id: entry.value, name: entry.name })),
      ];
      return;
    }
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
  /** Await the first catalog or its deadline. Closing or cancelling a pending
   * prompt returns false; a missing catalog settles once as an empty catalog.
   */
  protected waitForCommands(timeoutMs = 5000): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.commandDiscoveryComplete) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (proceed: boolean) => {
        clearTimeout(timer);
        this.commandWaiters.delete(finish);
        resolve(proceed);
      };
      const timer = setTimeout(
        () => this.finishCommandDiscovery(true),
        timeoutMs,
      );
      this.commandWaiters.add(finish);
    });
  }
  private finishCommandDiscovery(proceed: boolean) {
    if (proceed) this.commandDiscoveryComplete = true;
    for (const finish of this.commandWaiters) finish(proceed);
  }
  async prompt(value: string, beforeDispatch?: () => void) {
    if (
      this.closed ||
      !this.connection ||
      !this.session ||
      this.active ||
      !this.reusable ||
      this.pendingSettingWrites
    )
      throw new Error("ACP session is unavailable or busy");
    beforeDispatch?.();
    this.active = true;
    this.toolCommands.clear();
    this.cancelling = false;
    this.terminalReported = false;
    this.messageId = randomUUID();
    this.turnUsage = undefined;
    this.earlierEnd = false;
    this.reactiveTools.clear();
    this.reactiveEnd = false;
    this.canResolveAsDaemonOnly = false;
    this.reactiveBudget = REACTIVE_WATCHDOG_MS;
    const expected = this.echoOf(value).trim();
    this.promptEcho = undefined;
    this.promptEchoed = expected
      ? new Promise((resolve) => {
          this.promptEcho = { expected, seen: "", resolve };
        })
      : Promise.resolve();
    void this.send(value).catch(() => {});
  }
  /** The text the agent echoes as a user message for a prompt. */
  protected echoOf(value: string) {
    return value;
  }
  /** Sends one prompt request in the current turn. Only the last open request
   * to settle reports the turn's terminal status. */
  private send(value: string, steer = false) {
    clearTimeout(this.reactiveIdle);
    this.openPrompts++;
    const request = this.connection!.prompt({
      sessionId: this.session!,
      prompt: [{ type: "text", text: value }],
    });
    void request
      .then(
        (result) => {
          const last = --this.openPrompts === 0;
          this.addUsage(result);
          if (this.closed || this.terminalReported) return;
          if (result.stopReason === "end_turn") {
            if (!last) this.earlierEnd = true;
            // Antigravity gives reactive passes no definitive end signal.
            // Preserve their output as partial instead of publishing it
            // based on usage, steering replies, or elapsed time.
            if (this.waitForReactiveTurn()) return;
          }
          if (!last) return;
          this.terminalReported = true;
          const limited = ["max_tokens", "max_turn_requests"].includes(
            result.stopReason,
          );
          const interrupted =
            this.cancelling ||
            this.reactiveEnd ||
            limited ||
            result.stopReason === "cancelled";
          if (interrupted && (this.reactiveEnd || this.reactiveTools.size))
            this.retireReactiveSession = true;
          this.emit({
            type: "status",
            status: interrupted ? "interrupted" : "completed",
            detail: limited
              ? "ACP turn stopped at the agent's limit."
              : undefined,
            recoverable: !this.retireReactiveSession,
          });
        },
        (error: unknown) => {
          const last = --this.openPrompts === 0;
          if (!last || this.closed || this.terminalReported) return;
          // A rejected steering input that never joined the turn does not
          // undo the turn's own normal end.
          if (this.reactiveEnd && this.cancelling) {
            this.finishReactiveTurn();
            return;
          }
          if (
            steer &&
            !this.steerJoined &&
            (this.earlierEnd || this.reactiveEnd) &&
            this.waitForReactiveTurn()
          )
            return;
          this.terminalReported = true;
          if (steer && !this.steerJoined && this.earlierEnd) {
            this.emit({
              type: "status",
              status: "completed",
              recoverable: true,
            });
            return;
          }
          this.emit({
            type: "status",
            status: "failed",
            detail: nativeFailureDetail(
              this.child && nativeMemoryFailure(this.child),
              promptFailure(error),
            ),
            recoverable: false,
          });
        },
      )
      .finally(() => {
        if (this.openPrompts || !this.terminalReported) return;
        clearTimeout(this.reactiveIdle);
        clearTimeout(this.reactiveWatchdog);
        this.reactiveWatchdog = undefined;
        this.active = false;
        this.cancelPermissions();
      });
    return request;
  }
  private waitForReactiveTurn() {
    if (
      this.cancelling ||
      !this.waitsForReactiveTurns ||
      !(this.reactiveEnd || this.reactiveTools.size || this.permissions.size)
    )
      return false;
    if (!this.reactiveEnd) this.canResolveAsDaemonOnly = !this.permissions.size;
    this.reactiveEnd = true;
    this.finishReactiveTurn();
    return true;
  }
  private finishReactiveTurn() {
    clearTimeout(this.reactiveIdle);
    if (this.closed || this.terminalReported || !this.reactiveEnd) return;
    if (this.cancelling) {
      this.interruptReactiveTurn();
      return;
    }
    if (this.permissions.size) return;
    if (
      this.canResolveAsDaemonOnly &&
      !this.openPrompts &&
      !this.reactiveTools.size
    ) {
      // The original end_turn is authoritative when every tool that
      // blocked it was subsequently identified as a daemon.
      clearTimeout(this.reactiveIdle);
      clearTimeout(this.reactiveWatchdog);
      this.reactiveWatchdog = undefined;
      this.terminalReported = true;
      this.active = false;
      this.emit({ type: "status", status: "completed", recoverable: true });
      return;
    }
    // The reactive wait stays bounded even if a concurrent steer never
    // answers. Human approval time does not count against the watchdog.
    if (!this.reactiveWatchdog) {
      this.reactiveWatchdogStarted = performance.now();
      this.reactiveWatchdog = setTimeout(
        () =>
          this.interruptReactiveTurn(
            "Antigravity did not finish its reactive turn within an hour.",
          ),
        this.reactiveBudget,
      ).unref();
    }
    if (this.openPrompts || this.reactiveTools.size) return;
    // ACP usage updates also occur mid-pass. A quiet reactive wait can
    // preserve partial output, but cannot certify a completed Result.
    this.reactiveIdle = setTimeout(
      () =>
        this.interruptReactiveTurn(
          "Antigravity did not confirm the end of its reactive turn.",
        ),
      REACTIVE_IDLE_MS,
    ).unref();
  }
  private interruptReactiveTurn(detail?: string) {
    clearTimeout(this.reactiveIdle);
    clearTimeout(this.reactiveWatchdog);
    this.reactiveWatchdog = undefined;
    this.retireReactiveSession = true;
    this.terminalReported = true;
    this.active = false;
    this.emit({
      type: "status",
      status: "interrupted",
      detail,
      recoverable: false,
    });
  }
  private addUsage(result: unknown) {
    if (!this.reportsUsage) return;
    const usage = z
      .object({
        usage: z.object({
          inputTokens: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
          outputTokens: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        }),
      })
      .safeParse(result);
    if (!usage.success) return;
    this.turnUsage = {
      input_tokens:
        (this.turnUsage?.input_tokens || 0) + usage.data.usage.inputTokens,
      output_tokens:
        (this.turnUsage?.output_tokens || 0) + usage.data.usage.outputTokens,
    };
    if (
      Number.isSafeInteger(this.turnUsage.input_tokens) &&
      Number.isSafeInteger(this.turnUsage.output_tokens)
    )
      this.emit({ type: "usage", usage: { ...this.turnUsage } });
  }
  /** For agents that fold a session/prompt sent during a running turn into
   * that turn at its next step. `echo` is the text the agent is expected to
   * echo as a user message when it takes the input. Delivery is confirmed by
   * that echo, or by the request ending the turn normally; until the request
   * is written nothing was delivered (NotDelivered). The agent refuses a
   * prompt while an approval is open, so steering waits for the answer.
   * The echo must be a complete user message equal to `echo` and must follow
   * the turn's own prompt echo, which steering waits for (briefly) first. An
   * empty expected echo cannot be told apart, so only the request confirms it.
   */
  protected async steerPrompt(
    value: string,
    echo: string,
    beforeDispatch?: () => void,
  ) {
    if (this.closed || !this.connection || !this.session)
      throw new NotDelivered("ACP session is unavailable.");
    if (!this.active || this.cancelling || this.terminalReported)
      throw new NotDelivered("No running ACP turn to steer.");
    if (this.permissions.size)
      throw new NotDelivered("Answer the open approval before steering.");
    if (this.pendingSettingWrites || this.echo || this.steering)
      throw new NotDelivered("ACP session is busy.");
    this.steering = true;
    try {
      await Promise.race([this.promptEchoed, this.ended, wait(ECHO_WAIT)]);
      await this.dispatchSteer(value, echo.trim(), beforeDispatch);
    } finally {
      this.steering = false;
    }
  }
  private async dispatchSteer(
    value: string,
    expected: string,
    beforeDispatch?: () => void,
  ) {
    // Recheck after waiting: the turn, an approval or the session may have
    // changed, and nothing has been sent yet.
    if (this.closed || !this.connection || !this.session)
      throw new NotDelivered("ACP session is unavailable.");
    if (!this.active || this.cancelling || this.terminalReported)
      throw new NotDelivered("No running ACP turn to steer.");
    if (this.permissions.size)
      throw new NotDelivered("Answer the open approval before steering.");
    if (this.pendingSettingWrites)
      throw new NotDelivered("ACP session is busy.");
    beforeDispatch?.();
    this.steerJoined = false;
    const echoed = new Promise<void>((resolve) => {
      if (expected)
        this.echo = {
          expected,
          seen: "",
          resolve: () => {
            this.steerJoined = true;
            resolve();
          },
        };
    });
    // Without its echo, only a normal end of the turn confirms the input.
    const settled = this.send(value, true).then((result) => {
      if (result.stopReason !== "end_turn")
        throw new Error(
          `The turn ended (${result.stopReason}) before steering was confirmed.`,
        );
    });
    const ended = this.ended.then(() => {
      throw new Error("The ACP session ended before steering was confirmed.");
    });
    // Once echoed, the request's later outcome belongs to the turn.
    settled.catch(() => {});
    ended.catch(() => {});
    try {
      await Promise.race([echoed, settled, ended]);
    } finally {
      this.echo = undefined;
    }
  }
  async cancel() {
    this.cancelling = true;
    clearTimeout(this.reactiveIdle);
    clearTimeout(this.reactiveWatchdog);
    this.reactiveWatchdog = undefined;
    this.finishCommandDiscovery(false);
    this.cancelPermissions();
    const notification =
      !this.closed && this.session && this.connection && this.active
        ? this.connection.cancel({ sessionId: this.session })
        : undefined;
    this.finishReactiveTurn();
    await notification;
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
    if (this.reactiveEnd && !this.cancelling) this.finishReactiveTurn();
  }
  async dispose() {
    this.closed = true;
    clearTimeout(this.reactiveIdle);
    clearTimeout(this.reactiveWatchdog);
    this.creatingSession = false;
    this.startupCommands = undefined;
    this.finishCommandDiscovery(false);
    this.end();
    this.modeConfirmation?.reject(new Error("ACP session closed"));
    this.modeConfirmation = undefined;
    this.cancelPermissions();
    await stopHarnessProcess(this.child);
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
        // Display bounds must not restrict valid native model/control values.
        const raw = this.supportsConfig
          ? this.rawConfigOptions.find((x) => x.id === id)
          : undefined;
        const option = raw
          ? {
              type: raw.type,
              choices:
                raw.type === "select"
                  ? raw.options.flatMap((entry) =>
                      "group" in entry ? entry.options : [entry],
                    )
                  : undefined,
            }
          : this.settings.options.find(
              (x) => x.id === id && id === "acp-mode" && x.mutable,
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
          if (!raw && id === "acp-mode" && this.modeState) {
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
    this.canResolveAsDaemonOnly = false;
    clearTimeout(this.reactiveIdle);
    if (this.reactiveWatchdog)
      this.reactiveBudget = Math.max(
        0,
        this.reactiveBudget -
          (performance.now() - this.reactiveWatchdogStarted),
      );
    clearTimeout(this.reactiveWatchdog);
    this.reactiveWatchdog = undefined;
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
    if (this.closed) return;
    if (!this.session) {
      if (
        this.creatingSession &&
        notification.update.sessionUpdate === "available_commands_update"
      )
        this.startupCommands = notification;
      return;
    }
    if (notification.sessionId !== this.session) return;
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
    if (u.sessionUpdate === "user_message_chunk") {
      if (this.loading || u.content.type !== "text") return;
      const chunk = u.content.text;
      // The turn's own prompt echo is consumed first and never confirms a
      // steering input.
      const prompt = this.promptEcho;
      if (prompt) {
        if (matchEcho(prompt, chunk)) {
          this.promptEcho = undefined;
          prompt.resolve();
        }
        if (prompt.seen) return;
      }
      const echo = this.echo;
      if (echo && matchEcho(echo, chunk)) {
        // The agent took the steering input; its answer is a new message.
        this.echo = undefined;
        this.messageId = randomUUID();
        echo.resolve();
      }
      return;
    }
    if (u.sessionUpdate === "agent_message_chunk") {
      if (!this.loading && u.content.type === "text") {
        if (!this.openPrompts) this.canResolveAsDaemonOnly = false;
        this.emit({
          type: "delta",
          id: this.messageId,
          text: text(u.content.text),
        });
      }
      if (this.reactiveEnd && !this.cancelling) this.finishReactiveTurn();
      return;
    }
    if (
      u.sessionUpdate === "agent_thought_chunk" &&
      this.reactiveEnd &&
      !this.cancelling
    ) {
      if (!this.openPrompts) this.canResolveAsDaemonOnly = false;
      this.finishReactiveTurn();
      return;
    }
    if (
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update"
    ) {
      let reactiveWorkChanged = false;
      if (this.waitsForReactiveTurns && !this.loading) {
        const input = u.rawInput;
        const title = u.title ?? this.toolItems.get(u.toolCallId)?.title;
        const command =
          input &&
          typeof input === "object" &&
          "CommandLine" in input &&
          typeof input.CommandLine === "string";
        const daemon =
          (command || title === "run_command" || title === "schedule") &&
          input &&
          typeof input === "object" &&
          "IsDaemon" in input &&
          input.IsDaemon === true;
        if (daemon || u.status === "completed" || u.status === "failed") {
          reactiveWorkChanged = this.reactiveTools.delete(u.toolCallId);
          if (reactiveWorkChanged && !daemon)
            this.canResolveAsDaemonOnly = false;
        } else if (u.sessionUpdate === "tool_call") {
          this.canResolveAsDaemonOnly = false;
          this.reactiveTools.add(u.toolCallId);
          reactiveWorkChanged = true;
        }
      }
      const old = this.toolItems.get(u.toolCallId);
      const title = text(u.title) || old?.title || "ACP tool";
      const memoryTool =
        old && isWorkspaceMemorySearch(old.title) ? old.title : title;
      if (isWorkspaceMemorySearch(memoryTool)) {
        const item: Item = {
          id: `acp:${this.session}:${u.toolCallId}`,
          kind: "tool",
          title: memoryTool,
          text: "",
          status: normalizeItemStatus(u.status ?? old?.status),
        };
        this.toolItems.set(u.toolCallId, item);
        this.emit({ type: "item", item });
        if (reactiveWorkChanged && this.reactiveEnd && !this.cancelling)
          this.finishReactiveTurn();
        return;
      }
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
        title,
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
        status: normalizeItemStatus(u.status ?? old?.status),
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
      if (reactiveWorkChanged && this.reactiveEnd && !this.cancelling)
        this.finishReactiveTurn();
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
      this.finishCommandDiscovery(true);
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
