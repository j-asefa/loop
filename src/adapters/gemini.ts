import { Acp } from "./acp.js";
import type { Emit, Options } from "./types.js";
import type { Billing } from "../protocol.js";

/** Gemini owns sign-in, billing and context; Loop speaks its native ACP API. */
export class Gemini extends Acp {
  protected override verifySessionOnProbe = true;
  constructor(
    private geminiOptions: Options,
    emit: Emit,
  ) {
    super({ ...geminiOptions, args: ["--acp"] }, emit);
  }
  protected override environment(): NodeJS.ProcessEnv {
    // Cached credentials can refresh, but discovery must never open a browser
    // or start an interactive login. No credential variables are changed.
    return { ...process.env, NO_BROWSER: "true" };
  }
  protected override billing(): Billing {
    return {
      mode: "existing",
      description:
        "Gemini CLI uses its existing native sign-in and billing configuration. Provider charges may apply.",
    };
  }
  override async start() {
    if (this.geminiOptions.billing !== "existing")
      throw new Error(
        "Gemini CLI cannot verify subscription billing through ACP. Use --billing existing to retain its native sign-in and billing configuration.",
      );
    try {
      // session/new verifies credentials and reports models without a prompt.
      // Never call authenticate: that can change the CLI's saved auth method.
      return await super.start();
    } catch {
      throw new Error(
        "Gemini CLI setup failed. Sign in to Gemini CLI in Provider connections, then enable Gemini again. Check the installed version and project configuration if sign-in is already complete.",
      );
    }
  }
  override async prompt(text: string) {
    // ACP has no system-instruction field. Carry the saved instructions with
    // each explicit prompt, including after session/load. A saved session ID
    // proves only creation, not that a prior prompt delivered instructions.
    // This repeats context, never an earlier user task or an uncertain effect.
    const instructions = this.geminiOptions.instructions;
    await super.prompt(instructions ? `${instructions}\n\n${text}` : text);
  }
}
