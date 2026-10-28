import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Native } from "../native.js";
import type { Billing } from "../protocol.js";
import type { Adapter, Emit, Options, NativeCommand } from "./types.js";
import { directActivityEmitter } from "./direct-activities.js";
import { tokenCount } from "./usage.js";

const exec = promisify(execFile);
const SETUP =
  "Antigravity setup failed. Run agy on the execution computer to sign in, then enable Antigravity again. Check agy models and the project configuration if sign-in is already complete.";

/** The public agy stream protocol; credentials and context stay with agy.
 * https://antigravity.google/docs/cli/headless/
 * No ACP, private backend API, permission bypass or credential-store reads.
 */
export class Antigravity implements Adapter {
  capabilities = {
    approvals: false,
    questions: false,
    resume: true,
    liveAttach: false,
    terminal: false,
    workspaceTools: false,
  };
  models: { id: string; name: string }[] = [];
  commands: NativeCommand[] = [];
  private native?: Native;
  private disposal?: Promise<void>;
  private session?: string;
  private active = false;
  private stopped = false;
  private turn = "";
  private responseId?: string;
  private usage = new Map<
    number,
    { input_tokens: number; output_tokens: number }
  >();
  private ready?: { resolve(): void; reject(error: Error): void };
  private billing: Billing;

  constructor(
    private options: Options,
    private emit: Emit,
  ) {
    this.emit = directActivityEmitter(emit);
    this.session = options.resume;
    this.billing = {
      mode: "existing",
      description:
        "Antigravity uses its existing native sign-in, billing and permission configuration. Provider charges may apply.",
    };
  }

  async start(): Promise<Billing> {
    if (this.options.billing !== "existing")
      throw new Error(
        "Antigravity cannot attest subscription billing. Use --billing existing to retain its native sign-in and billing configuration.",
      );
    try {
      const { stdout } = await exec(this.options.executable, ["models"], {
        cwd: this.options.project,
        timeout: 20000,
        maxBuffer: 256000,
      });
      if (this.stopped) throw new Error(SETUP);
      // agy models documents a slug followed by its display name. Never
      // forward diagnostics, terminal escapes or an unparsed account response.
      const models = new Map<string, string>();
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(
          /^([a-z0-9][a-z0-9._-]*)[ \t]+([^\x00-\x1f\x7f]+)$/,
        );
        if (match) models.set(match[1], match[2].trim());
      }
      this.models = [...models].map(([id, name]) => ({ id, name }));
      if (!this.models.length) throw new Error(SETUP);
      this.native = new Native(
        this.options.executable,
        [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--disable-slash-commands",
          "--print-timeout",
          "0",
          ...(this.options.resume
            ? ["--conversation", this.options.resume]
            : []),
          ...(this.options.model ? ["--model", this.options.model] : []),
          ...(this.options.effort ? ["--effort", this.options.effort] : []),
        ],
        this.options.project,
      );
      const ready = new Promise<void>((resolve, reject) => {
        this.ready = { resolve, reject };
      });
      this.native.on("message", (message) => this.message(message));
      this.native.on("failure", () => this.fail());
      const timeout = setTimeout(
        () => this.ready?.reject(new Error(SETUP)),
        20000,
      );
      try {
        await ready;
      } finally {
        clearTimeout(timeout);
        this.ready = undefined;
      }
      if (this.stopped) throw new Error(SETUP);
      return this.billing;
    } catch {
      await this.dispose();
      throw new Error(SETUP);
    }
  }

  private fail() {
    this.ready?.reject(new Error(SETUP));
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    this.emit({
      type: "status",
      status: "failed",
      detail:
        "Antigravity stopped before the session could continue. The native outcome may be incomplete. Review saved progress and send an explicit follow-up; no prompt was replayed.",
    });
  }

  async prompt(text: string) {
    if (this.stopped || !this.native || !this.session)
      throw new Error("Antigravity session is unavailable.");
    if (this.active)
      throw new Error(
        "Antigravity is still running. Queue the follow-up for the next turn.",
      );
    this.turn = randomUUID();
    this.responseId = undefined;
    this.usage.clear();
    this.active = true;
    try {
      await this.native.write({
        event: "user",
        message: {
          content: this.options.instructions
            ? `${this.options.instructions}\n\n${text}`
            : text,
        },
      });
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  private message(message: any) {
    if (this.stopped) return;
    if (message.event === "init") {
      const session = message.conversation_id;
      if (
        typeof session !== "string" ||
        !session ||
        session.length > 300 ||
        (this.session && this.session !== session)
      )
        throw new Error("Unexpected Antigravity conversation.");
      this.session = session;
      const model = message.init?.model;
      if (
        this.options.model &&
        typeof model === "string" &&
        model !== this.options.model
      )
        throw new Error("Unexpected Antigravity model.");
      if (typeof model === "string") this.billing = { ...this.billing, model };
      if (!this.options.probeOnly)
        this.emit({
          type: "metadata",
          nativeSession: session,
          billing: this.billing,
        });
      this.ready?.resolve();
      return;
    }
    if (!this.active) {
      if (message.event === "result") this.ready?.reject(new Error(SETUP));
      return;
    }
    if (message.event === "step_update") {
      const step = message.step_update;
      if (!step || step.conversation_id !== this.session) return;
      if (!Number.isSafeInteger(step.step_index) || step.step_index < 0)
        throw new Error("Invalid step identity.");
      const id = `${this.turn}:${step.step_index}`;
      if (
        step.step_type === "agent_response" &&
        typeof step.text_delta === "string"
      ) {
        this.responseId = id;
        this.emit({ type: "delta", id, text: step.text_delta });
      }
      if (step.step_type === "tool") {
        const tool = step.tool_info;
        const text = [
          tool?.parameters == null
            ? ""
            : JSON.stringify(tool.parameters, null, 2),
          typeof tool?.output === "string" ? tool.output : "",
        ]
          .filter(Boolean)
          .join("\n");
        this.emit({
          type: "item",
          item: {
            id,
            kind: "tool",
            title:
              typeof step.tool_name === "string"
                ? step.tool_name
                : "Antigravity tool",
            text,
            status: tool?.error
              ? "failed"
              : step.state === "DONE"
                ? "completed"
                : "running",
          },
        });
      }
      // result.usage is cumulative across the native conversation, including
      // before a resume. Only completed steps from this explicit turn count.
      if (step.state === "DONE") {
        const input = tokenCount(step.usage?.input_tokens);
        const output = tokenCount(step.usage?.output_tokens);
        if (input !== undefined && output !== undefined)
          this.usage.set(step.step_index, {
            input_tokens: input,
            output_tokens: output,
          });
      }
      return;
    }
    if (message.event !== "result") return;
    const result = message.result;
    if (!result || result.conversation_id !== this.session) return;
    this.active = false;
    if (typeof result.response === "string" && result.response)
      this.emit({
        type: "item",
        item: {
          id: this.responseId || `${this.turn}:response`,
          kind: "assistant",
          text: result.response,
          ...(result.status === "SUCCESS"
            ? { phase: "final_answer" as const }
            : {}),
        },
      });
    if (this.usage.size) {
      const usage = { input_tokens: 0, output_tokens: 0 };
      for (const step of this.usage.values()) {
        usage.input_tokens += step.input_tokens;
        usage.output_tokens += step.output_tokens;
      }
      if (
        tokenCount(usage.input_tokens) !== undefined &&
        tokenCount(usage.output_tokens) !== undefined
      )
        this.emit({ type: "usage", usage });
    }
    this.usage.clear();
    if (result.status === "SUCCESS") {
      this.emit({ type: "status", status: "completed" });
    } else {
      // WAITING/RUNNING can be partial timeout output with a successful exit.
      // They are never completion, and no retry submits this prompt again.
      this.stopped = true;
      this.emit({
        type: "status",
        status: ["CANCELED", "INTERRUPTED"].includes(result.status)
          ? "interrupted"
          : "failed",
        detail:
          "Antigravity did not confirm completion. Check its native permissions and sign-in, review saved progress, then send an explicit follow-up. No prompt was replayed.",
      });
      void this.dispose();
    }
  }

  async answer() {
    throw new Error(
      "Antigravity headless mode does not accept approval or question responses. Configure permissions in agy on the execution computer.",
    );
  }
  async cancel() {
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    await this.dispose();
    this.emit({ type: "status", status: "interrupted" });
  }
  async dispose() {
    this.stopped = true;
    this.ready?.reject(new Error(SETUP));
    await (this.disposal ??= this.native?.dispose() ?? Promise.resolve());
  }
}
