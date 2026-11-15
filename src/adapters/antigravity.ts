import { Acp } from "./acp.js";
import { AntigravityHeadless } from "./antigravity-headless.js";
import { meetsMinimum } from "../shared/harness-version.js";
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
  override async start() {
    if (this.nativeOptions.billing !== "existing")
      throw new Error("Antigravity requires --billing existing.");
    try {
      const billing = await super.start();
      if (this.nativeOptions.effort && !this.nativeOptions.probeOnly) {
        const effort = this.settings.options.find((option) =>
          /effort|thinking/i.test(option.id + " " + option.label),
        );
        if (!effort)
          throw new Error(
            "Antigravity did not expose its thinking level setting.",
          );
        await this.setSetting(
          effort.id,
          this.nativeOptions.effort,
          this.settings.revision,
        );
      }
      return billing;
    } catch (error) {
      await this.dispose();
      if (error instanceof NativeMemoryError) throw error;
      throw new NativeSetupError(
        "antigravity_setup_failed",
        "Antigravity setup failed. Sign in to Antigravity in Settings → Provider connections, or run agy on the execution computer, then enable Antigravity again. No prompt was sent.",
      );
    }
  }
  override prompt(text: string, beforeDispatch?: () => void) {
    const instructions = this.nativeOptions.instructions;
    const name = text.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
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
    this.adapter = meetsMinimum(options.version, "1.5.9")
      ? new AntigravityAcp(options, emit)
      : new AntigravityHeadless(options, emit);
  }
  get activityTransport() {
    return this.adapter instanceof Acp ? ("acp" as const) : ("native" as const);
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
