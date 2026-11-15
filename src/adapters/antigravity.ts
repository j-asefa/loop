import { supportsBilling } from "../shared/harnesses.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeMemoryError } from "../native-memory.js";
import type { Billing } from "../shared/protocol.js";
import { Acp } from "./acp.js";
import type { Emit, Options } from "./types.js";
import { NativeSetupError } from "./setup-error.js";

const exec = promisify(execFile);
const SETUP =
  "Antigravity setup failed. Choose Sign in to Antigravity in Settings → Provider connections, or run agy on the execution computer, then enable Antigravity again. Check agy models and the project configuration if sign-in is already complete.";
// agy 1.5.9 advertises its catalog a few milliseconds after session/new.
const CATALOG_WAIT = 3000;
const COMMAND = /^\/([^\s]+)(?:\s|$)/;
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Antigravity over agy's built-in ACP server, `agy acp`.
 * https://antigravity.google/docs/ide/extensions/acp/
 * Sign-in, billing and context stay with agy; Loop never calls authenticate.
 * Conversations resume with session/resume, which reopens them without
 * replaying history and also accepts conversations started by the earlier
 * stream-json adapter. A prompt sent during a running turn steers that turn
 * at its next step, so steering needs no interrupt or restart. Permission
 * requests reach Loop's approvals.
 */
export class Antigravity extends Acp {
  protected override verifySessionOnProbe = true;
  protected override resumeWithoutReplay = true;
  protected override reportsUsage = true;
  /** Settles once the catalog arrives, or CATALOG_WAIT after the session
   * opened if it never does. */
  private catalogReady: Promise<void> = Promise.resolve();

  constructor(
    private agyOptions: Options,
    emit: Emit,
  ) {
    super({ ...agyOptions, args: ["acp"] }, emit);
  }

  protected override billing(): Billing {
    return {
      mode: "existing",
      description:
        "Antigravity uses its existing native sign-in, billing and permission configuration. Provider charges may apply.",
    };
  }

  override async start(): Promise<Billing> {
    if (!supportsBilling("antigravity", this.agyOptions.billing))
      throw new Error(
        "Antigravity cannot attest subscription billing. Use --billing existing to retain its native sign-in and billing configuration.",
      );
    // agy models reports sign-in without a session or prompt.
    await exec(this.agyOptions.executable, ["models"], {
      cwd: this.agyOptions.project,
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
    let billing: Billing;
    try {
      billing = await super.start();
    } catch (error) {
      if (error instanceof NativeMemoryError) throw error;
      throw new NativeSetupError(
        "antigravity_setup_failed",
        `${SETUP} No prompt was sent.`,
      );
    }
    this.catalogReady = Promise.race([
      this.commandsAdvertised,
      wait(CATALOG_WAIT),
    ]);
    // A catalog probe exists to read the catalog, which agy advertises just
    // after the session opens.
    if (this.agyOptions.probeOnly) await this.catalogReady;
    else await this.applyEffort();
    return billing;
  }

  /** agy takes its thinking level as a session setting, not a launch flag. A
   * level the session does not offer is left to the selected model. */
  private async applyEffort() {
    const effort = this.agyOptions.effort;
    const option = this.settings.options.find((o) => o.id === "thought_level");
    if (
      !effort ||
      !option?.mutable ||
      option.confirmed === effort ||
      !option.choices?.some((choice) => choice.value === effort)
    )
      return;
    await this.setSetting("thought_level", effort, this.settings.revision);
  }

  override async prompt(text: string, beforeDispatch?: () => void) {
    // Framing depends on the catalog, which agy sends just after the session
    // opens. Nothing has been dispatched while this settles.
    await this.catalogReady;
    await super.prompt(this.content(text), beforeDispatch);
  }

  /** agy folds the follow-up into the running turn at its next step and
   * echoes it as a user message, without the leading command of a skill. */
  async steer(text: string, beforeDispatch?: () => void) {
    const name = text.match(COMMAND)?.[1];
    const echo =
      name && this.commands.some((command) => command.name === name)
        ? text.slice(name.length + 1)
        : text;
    await this.steerPrompt(text, echo, beforeDispatch);
  }

  /** agy expands a command or skill only at the start of a message. Saved
   * instructions lead other prompts and follow a discovered command. */
  private content(text: string) {
    const instructions = this.agyOptions.instructions;
    if (!instructions) return text;
    const name = text.match(COMMAND)?.[1];
    return name && this.commands.some((command) => command.name === name)
      ? `${text}\n\n${instructions}`
      : `${instructions}\n\n${text}`;
  }
}
