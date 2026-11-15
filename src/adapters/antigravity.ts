import { Acp } from "./acp.js";
import { AntigravityHeadless } from "./antigravity-headless.js";
import { meetsMinimum } from "../shared/harness-version.js";
import { ANTIGRAVITY_ACP_MINIMUM_VERSION } from "../shared/harnesses.js";
import { NativeMemoryError } from "../native-memory.js";
import { NativeSetupError } from "./setup-error.js";
import type { Adapter, Options, Emit } from "./types.js";

/** Same native conversation store, with session-scoped MCP injection over ACP.
 * https://antigravity.google/docs/ide/extensions/acp
 */
class AntigravityAcp extends Acp {
  protected override verifySessionOnProbe = true;
  protected override requireWorkspaceTools = true;
  override capabilities = {
    approvals: true,
    questions: false,
    resume: false,
    liveAttach: false,
    terminal: false,
    workspaceTools: true,
  };
  constructor(
    private nativeOptions: Options,
    emit: Emit,
  ) {
    super({ ...nativeOptions, args: ["acp", "--process-per-session"] }, emit);
  }
  protected override billing() {
    return {
      mode: "existing" as const,
      description:
        "Antigravity uses its existing native sign-in, billing and permission configuration. Provider charges may apply.",
    };
  }
  protected override async configureSession() {
    if (this.nativeOptions.probeOnly) {
      if (!(await this.waitForCommands()))
        throw new Error("ACP session unavailable");
      return;
    }
    if (this.nativeOptions.effort) {
      const effort =
        this.settingId((id) => id === "thinking_level") ??
        this.settingId((id, name) => /effort|thinking/i.test(id + " " + name));
      if (!effort)
        throw new NativeSetupError(
          "antigravity_effort_unavailable",
          "Antigravity did not expose its thinking level control. Choose another model in Model & connection or update the saved effort selection, then retry. No prompt was sent.",
        );
      try {
        await this.configureSetting(effort, this.nativeOptions.effort);
      } catch (error) {
        if (error instanceof NativeSetupError) throw error;
        throw new NativeSetupError(
          "antigravity_effort_rejected",
          "Antigravity could not apply the selected thinking level. Choose another model in Model & connection or update the saved effort selection to a supported level, then retry. No prompt was sent.",
        );
      }
    }
  }
  override async start() {
    if (this.nativeOptions.billing !== "existing")
      throw new Error("Antigravity requires --billing existing.");
    try {
      return await super.start();
    } catch (error) {
      await this.dispose();
      if (
        error instanceof NativeMemoryError ||
        error instanceof NativeSetupError
      )
        throw error;
      throw new NativeSetupError(
        "antigravity_setup_failed",
        "Antigravity setup failed. Sign in to Antigravity in Settings → Provider connections, or run agy on the execution computer, then enable Antigravity again. No prompt was sent.",
      );
    }
  }
  override async prompt(text: string, beforeDispatch?: () => void) {
    const instructions = this.nativeOptions.instructions;
    const name = text.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
    if (name && !(await this.waitForCommands()))
      throw new Error("ACP session unavailable");
    const command = name && this.commands.some((c) => c.name === name);
    const content = command
      ? instructions
        ? `${text}\n\n${instructions}`
        : text
      : instructions
        ? `${instructions}\n\n${text}`
        : text;
    return super.prompt(
      !command && content.trimStart().startsWith("/")
        ? `\u200b${content}`
        : content,
      beforeDispatch,
    );
  }
}

/** Retain the released stream reader for saved older runtime registrations.
 * A failed ACP startup never falls back to another transport or resends a task.
 */
export class Antigravity implements Adapter {
  static readonly startupSteps = Acp.startupSteps;
  private readonly adapter: Adapter;
  constructor(options: Options, emit: Emit) {
    this.adapter = meetsMinimum(
      options.version,
      ANTIGRAVITY_ACP_MINIMUM_VERSION,
    )
      ? new AntigravityAcp(options, emit)
      : new AntigravityHeadless(options, emit);
  }
  get activityTransport() {
    return this.adapter instanceof Acp ? ("acp" as const) : ("native" as const);
  }
  canReuse(registration: Options) {
    return (
      meetsMinimum(registration.version, ANTIGRAVITY_ACP_MINIMUM_VERSION) ===
      this.adapter instanceof Acp
    );
  }
  get capabilities() {
    return this.adapter.capabilities;
  }
  get reusable() {
    return this.adapter.reusable;
  }
  get models() {
    return this.adapter.models;
  }
  get commands() {
    return this.adapter.commands ?? [];
  }
  get activityCapabilities() {
    return this.adapter.activityCapabilities;
  }
  get settings() {
    return this.adapter.settings;
  }
  get commandCatalog() {
    return this.adapter.commandCatalog;
  }
  start() {
    return this.adapter.start();
  }
  prompt(text: string, beforeDispatch?: () => void) {
    return this.adapter.prompt(text, beforeDispatch);
  }
  cancel() {
    return this.adapter.cancel();
  }
  answer(
    id = "",
    answer: Record<string, unknown> = {},
    beforeDispatch?: () => void,
  ) {
    return this.adapter.answer(id, answer, beforeDispatch);
  }
  dispose() {
    return this.adapter.dispose();
  }
  setSetting(...args: Parameters<NonNullable<Adapter["setSetting"]>>) {
    if (!this.adapter.setSetting)
      return Promise.reject(
        new Error("Settings are unavailable for this Antigravity runtime."),
      );
    return this.adapter.setSetting(...args);
  }
}
