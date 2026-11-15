import { Acp } from "./acp.js";
import { AntigravityHeadless } from "./antigravity-headless.js";
import { meetsMinimum } from "../shared/harness-version.js";
import {
  ANTIGRAVITY_ACP_MINIMUM_VERSION,
  ANTIGRAVITY_WORKSPACE_MINIMUM_VERSION,
} from "../shared/harnesses.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeMemoryError } from "../native-memory.js";
import { NativeSetupError } from "./setup-error.js";
import type { Adapter, Options, Emit } from "./types.js";

const exec = promisify(execFile);
const COMMAND = /^\/([^\s]+)(?:\s|$)/;
const SETUP =
  "Antigravity setup failed. Choose Sign in to Antigravity in Settings → Provider connections, or run agy on the execution computer, then enable Antigravity again. Check agy models and the project configuration if sign-in is already complete.";

/** Same native conversation store, with session-scoped MCP injection over ACP.
 * https://antigravity.google/docs/ide/extensions/acp
 */
class AntigravityAcp extends Acp {
  protected override verifySessionOnProbe = true;
  protected override requireWorkspaceTools = false;
  protected override resumeWithoutReplay = true;
  protected override reportsUsage = true;
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
    const tools = meetsMinimum(
      nativeOptions.version,
      ANTIGRAVITY_WORKSPACE_MINIMUM_VERSION,
    );
    super(
      {
        ...nativeOptions,
        args: tools ? ["acp", "--process-per-session"] : ["acp"],
        workspaceTools: tools ? nativeOptions.workspaceTools : undefined,
      },
      emit,
    );
    this.requireWorkspaceTools = tools;
    this.capabilities.workspaceTools = tools;
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
    // agy models reports sign-in without a session or prompt.
    await exec(this.nativeOptions.executable, ["models"], {
      cwd: this.nativeOptions.project,
      timeout: 20000,
      maxBuffer: 256000,
    }).catch((error: unknown) => {
      // Recognize the CLI's explicit sign-in rejection without exposing
      // native stderr, account details or credentials to the browser.
      if (
        error &&
        typeof error === "object" &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr
          .split(/\r?\n/)
          .some((line) =>
            /^Error: Please sign in to view available models\. Launch the CLI without arguments to sign in\.$/.test(
              line.trim(),
            ),
          )
      )
        throw new NativeSetupError(
          "native_auth_missing",
          "Antigravity is not signed in on the execution computer. Choose Sign in to Antigravity, or run agy there, then enable Antigravity again. No prompt was sent.",
        );
      throw new NativeSetupError(
        "antigravity_setup_failed",
        `${SETUP} No prompt was sent.`,
      );
    });
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
    // Framing depends on the catalog, which agy sends just after the session
    // opens. Nothing has been dispatched while this settles.
    if (text.match(/^\/([^\s]+)(?:\s|$)/) && !(await this.waitForCommands()))
      throw new Error("ACP session unavailable");
    await super.prompt(this.content(text), beforeDispatch);
  }

  /** agy folds the follow-up into the running turn at its next step and
   * echoes it as a user message. */
  async steer(text: string, beforeDispatch?: () => void) {
    const value = this.literal(text);
    await this.steerPrompt(value, this.echoOf(value), beforeDispatch);
  }

  /** agy echoes a prompt without the leading command of a skill. */
  protected override echoOf(value: string) {
    const name = this.command(value);
    return name ? value.slice(name.length + 1) : value;
  }

  private command(text: string) {
    const name = text.match(COMMAND)?.[1];
    return name && this.commands.some((command) => command.name === name)
      ? name
      : undefined;
  }

  /** Only a discovered command may lead a message. Other text starting with
   * "/" gets a zero-width space, which agy does not expand, so neither an
   * unknown token nor one of agy's own CLI commands can act on it. */
  private literal(text: string, commands = true) {
    return !(commands && this.command(text)) && text.trimStart().startsWith("/")
      ? `\u200b${text}`
      : text;
  }

  /** agy expands a command or skill only at the start of a message. Saved
   * instructions lead other prompts and follow a discovered command. */
  private content(text: string) {
    const instructions = this.nativeOptions.instructions;
    if (!instructions) return this.literal(text);
    return this.command(text)
      ? `${text}\n\n${instructions}`
      : `${this.literal(instructions, false)}\n\n${text}`;
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
    if (!this.adapter.steer) this.steer = undefined;
  }
  get activityTransport() {
    return this.adapter instanceof Acp ? ("acp" as const) : ("native" as const);
  }
  canReuse(registration: Options) {
    return (
      meetsMinimum(registration.version, ANTIGRAVITY_ACP_MINIMUM_VERSION) ===
        this.adapter instanceof Acp &&
      meetsMinimum(
        registration.version,
        ANTIGRAVITY_WORKSPACE_MINIMUM_VERSION,
      ) === this.capabilities.workspaceTools
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
  async steer?(text: string, beforeDispatch?: () => void) {
    return this.adapter.steer!(text, beforeDispatch);
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
