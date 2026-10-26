import { Acp } from "./acp.js";
import type { Emit, Options } from "./types.js";
import type { Billing } from "../protocol.js";

/** Grok Build owns sign-in, billing and context; Loop speaks its native ACP API. */
export class Grok extends Acp {
  protected override verifySessionOnProbe = true;
  /** A turn in this session completed, so its first prompt was retained. */
  private instructed = false;
  constructor(
    private grokOptions: Options,
    emit: Emit,
  ) {
    // --no-leader keeps each session in a process Loop owns, even when the
    // user's configuration routes agents through a shared leader.
    super(
      { ...grokOptions, args: ["agent", "--no-leader", "stdio"] },
      (event) => {
        if (event.type === "status" && event.status === "completed")
          this.instructed = true;
        emit(event);
      },
    );
  }
  protected override environment(): NodeJS.ProcessEnv {
    // Probes and turns must not replace the binary under a running session.
    // Grok still updates itself when the user runs it. No credential
    // variables are changed.
    return { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" };
  }
  protected override billing(): Billing {
    return {
      mode: "existing",
      description:
        "Grok Build uses its existing native sign-in and billing configuration. Provider charges may apply.",
    };
  }
  override async start() {
    if (this.grokOptions.billing !== "existing")
      throw new Error(
        "Grok Build cannot verify subscription billing through ACP. Use --billing existing to retain its native sign-in and billing configuration.",
      );
    try {
      // session/new verifies credentials and reports models without a prompt.
      // Never call authenticate: sign-in belongs to grok login.
      return await super.start();
    } catch {
      throw new Error(
        "Grok Build setup failed. Sign in to Grok Build in Provider connections, then enable Grok Build again. Check the installed version and project configuration if sign-in is already complete.",
      );
    }
  }
  override async prompt(text: string) {
    // ACP has no system-instruction field, so prompts carry the saved
    // instructions until a turn completes; Grok then keeps them in that
    // session's context. They can include a transcript carried over from
    // another harness, so they are not repeated on every prompt. A resumed
    // session whose load replayed turns already has them. After a failed or
    // cancelled first turn they are sent again rather than risk losing them.
    const instructions =
      this.instructed || this.historyReplayed
        ? undefined
        : this.grokOptions.instructions;
    await super.prompt(instructions ? `${instructions}\n\n${text}` : text);
  }
}
