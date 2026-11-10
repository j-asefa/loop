import { supportsBilling } from "../shared/harnesses.js";
import { createHash, randomBytes } from "node:crypto";
import { directActivityEmitter } from "./direct-activities.js";
import { DirectControls } from "./direct-controls.js";
import type { Setting, SettingValue } from "../shared/agent-activities.js";
import { Native, NativeRpcError } from "../native.js";
import { nativeFailureDetail } from "../native-memory.js";
import { NativeSetupError } from "./setup-error.js";
import type { Billing, Request } from "../shared/protocol.js";
import {
  capabilities,
  NotDelivered,
  type Adapter,
  type Emit,
  type NativeCommand,
  type Options,
} from "./types.js";

/** MSP command ids are UUIDv7: a millisecond timestamp, then random bits. */
export function uuidv7() {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i++)
    bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Start Muse's MSP host and complete its handshake. */
export async function museHost(
  executable: string,
  project: string,
  env?: NodeJS.ProcessEnv,
) {
  const native = new Native(executable, ["serve"], project, env);
  native.jsonrpc = true;
  try {
    // Account and login methods are on Muse's experimental surface.
    const init = await native.request("initialize", {
      clientInfo: { name: "loop", title: "Loop", version: "0.1.0" },
      // Loop's workspace tools are added per session as an MCP server.
      capabilities: {
        experimentalApi: true,
        requestedCapabilities: ["sessionMcp"],
      },
    });
    await native.write({ method: "initialized" });
    return {
      native,
      granted: new Set<string>(
        Array.isArray(init?.grantedCapabilities)
          ? init.grantedCapabilities
          : [],
      ),
    };
  } catch (error) {
    await native.dispose();
    throw error;
  }
}

const credentials: Record<string, string> = {
  accountLogin: "Meta account",
  apiKey: "stored Meta API key",
  envKey: "META_API_KEY from the environment",
};

// One Muse approval can need several decisions (a shell pipeline's stages).
// Each stage is its own Loop request; the approval lives until resolved.
type Approval = {
  requestId: string;
  requirementId: unknown;
  choices: Map<string, string>;
  /** A decision for this request is in flight or was accepted. */
  answered: boolean;
  /** Loop has reported this request resolved. */
  resolved: boolean;
};

/** Muse Code owns sign-in, billing and context; Loop speaks its native MSP API. */
export class Muse implements Adapter {
  static readonly startupSteps: Readonly<Record<string, string>> = {
    initialize: "starting its native process",
    "account/read": "checking its sign-in",
    "model/list": "loading available models",
  };
  private controlState?: DirectControls;
  private get displayControls() {
    if (!this.controlState) {
      this.controlState = new DirectControls("muse", this.emit);
      // Muse tool calls appear as native traces; Loop does not yet derive
      // structured tool, output, diff or plan activities from MSP items.
      for (const feature of ["tools", "output", "diffs", "plans"] as const)
        this.controlState.capabilities[feature] = {
          state: "unsupported",
          source: "muse native protocol",
          reason: "Shown as native tool traces",
        };
    }
    return this.controlState;
  }
  get settings() {
    return this.displayControls.settings;
  }
  get activityCapabilities() {
    return this.displayControls.capabilities;
  }
  capabilities = { ...capabilities };
  commands: NativeCommand[] = [];
  models: {
    id: string;
    name: string;
    effortLevels?: { value: string }[];
    defaultEffort?: string;
  }[] = [];
  private native!: Native;
  private session = "";
  private turn = "";
  private turnRevision = 0;
  /** Whether this session's context already holds the saved instructions. */
  private instructed = false;
  private model?: string;
  private approvals = new Map<string, Approval>();
  private questions = new Map<string, Map<string, boolean>>();
  private messages = new Set<string>();
  private settled = new Set<string>();
  /** Shown with the first prompt: start() runs before a run is attached. */
  private notice?: string;
  constructor(
    private options: Options,
    private emit: Emit,
  ) {
    this.emit = directActivityEmitter(emit);
  }
  private sessionOptions(model?: string): Setting[] {
    const selected = this.models.find(
      (m) => m.id === (this.options.model || model),
    );
    return [
      {
        id: "model",
        label: "Model",
        type: "select",
        choices: this.models.map((m) => ({ value: m.id, label: m.name })),
        confirmed: model,
        mutable: this.models.length > 0,
        application: "next-turn",
        provenance: "native model catalog",
      },
      ...(selected?.effortLevels?.length
        ? [
            {
              id: "effort",
              label: "Reasoning effort",
              type: "select" as const,
              choices: selected.effortLevels.map((e) => ({
                value: e.value,
                label: e.value,
              })),
              confirmed: this.options.effort ?? selected.defaultEffort,
              mutable: true,
              application: "next-turn" as const,
              provenance: "native model catalog",
            },
          ]
        : []),
    ];
  }
  async setSetting(
    id: string,
    value: SettingValue,
    revision: number,
    beforeApply?: () => void,
  ) {
    return this.displayControls.change(id, value, revision, async () => {
      if (typeof value !== "string" || !["model", "effort"].includes(id))
        throw new Error("Invalid session setting.");
      beforeApply?.();
      this.options[id as "model" | "effort"] = value;
      if (id === "model") {
        this.options.effort = undefined;
        this.displayControls.publish(
          this.sessionOptions(this.model).map((o) =>
            o.id === "model" ? { ...o, requested: value } : o,
          ),
        );
      }
      return undefined; // The next prompt acknowledgement confirms application.
    });
  }
  async start(): Promise<Billing> {
    if (!supportsBilling("muse", this.options.billing))
      throw new Error(
        "Muse Code cannot verify subscription billing. Use --billing existing to retain its native sign-in and billing configuration.",
      );
    const host = await museHost(this.options.executable, this.options.project);
    this.native = host.native;
    this.native.on("message", (m) => this.message(m));
    this.native.on("failure", (error) =>
      this.emit({
        type: "status",
        status: "failed",
        detail: nativeFailureDetail(
          error,
          "Muse Code exited. Check its sign-in in Provider connections, then resume the native session.",
        ),
      }),
    );
    // Prompt-free account check: a signed-out host would only fail at the
    // first model call.
    const account = await this.native.request("account/read", {});
    if (account.credentialRequired !== false && !credentials[account.state])
      throw new Error(
        "Muse Code is not signed in. Sign in to Muse Code in Provider connections, then enable it again.",
      );
    const catalog = await this.native
      .request("model/list", {})
      .catch(() => ({ models: [] }));
    this.models = (catalog.models || [])
      .filter((m: any) => typeof m.modelId === "string" && m.modelId)
      .map((m: any) => ({
        id: m.modelId,
        name: m.displayLabel || m.modelId,
        ...(Array.isArray(m.variants)
          ? {
              effortLevels: m.variants
                .filter((v: unknown) => typeof v === "string")
                .map((value: string) => ({ value })),
            }
          : {}),
        ...(typeof m.defaultReasoningEffort === "string"
          ? { defaultEffort: m.defaultReasoningEffort }
          : {}),
      }));
    const fallback =
      catalog.models?.find((m: any) => m.isDefault)?.modelId ??
      this.models[0]?.id;
    const billing: Billing = {
      mode: "existing",
      description: `Muse Code uses its existing ${credentials[account.state] || "configuration"}. Provider charges may apply.`,
      provider: "meta",
      model: this.options.model || fallback,
    };
    if (this.options.probeOnly) return billing;
    // Session MCP is a capability the host may withhold. Without it the
    // session runs without Loop's workspace tools rather than failing.
    if (this.options.workspaceTools && !host.granted.has("sessionMcp"))
      this.notice =
        "Muse Code did not grant session MCP, so Loop's workspace tools are unavailable in this session.";
    const config =
      this.options.workspaceTools && host.granted.has("sessionMcp")
        ? {
            mcpServers: {
              // Optional: a workspace-tools outage must not fail the turn.
              loop_workspace: {
                transport: "streamableHttp",
                mode: "optional",
                url: this.options.workspaceTools.url,
                headers: {
                  Authorization: "Bearer " + this.options.workspaceTools.token,
                },
              },
            },
          }
        : undefined;
    const r = this.options.resume
      ? // Muse keeps the full context; Loop already persists display history.
        await this.native
          .request("session/resume", {
            commandId: uuidv7(),
            sessionId: this.options.resume,
            excludeItems: true,
            ...(config ? { config } : {}),
          })
          .catch((error) => {
            if (
              error instanceof NativeRpcError &&
              error.kind === "sessionInUse"
            )
              throw new NativeSetupError(
                "native_session_in_use",
                "This conversation is in use by another Muse Code client. Leave the session there, then retry in Loop. No prompt was sent.",
              );
            if (
              error instanceof NativeRpcError &&
              error.kind === "sessionNotFound"
            )
              throw new NativeSetupError(
                "native_session_missing",
                "This Muse Code session is no longer stored on this computer. Start a new conversation. No prompt was sent.",
              );
            throw error;
          })
      : await this.native.request("session/start", {
          commandId: uuidv7(),
          workspaceRoot: this.options.project,
          ...(this.options.model ? { modelId: this.options.model } : {}),
          ...(config ? { config } : {}),
        });
    this.session = r.session.sessionId;
    // Loop creates Muse sessions and its first prompt carries the
    // instructions, so a session with turns already has them.
    this.instructed = (r.session.turnCount ?? 0) > 0;
    this.model = r.session.modelId || this.options.model || fallback;
    billing.model = this.model;
    this.displayControls.publish(this.sessionOptions(this.model), []);
    this.emit({ type: "metadata", nativeSession: this.session, billing });
    return billing;
  }
  private input(text: string) {
    return [{ type: "text", text }];
  }
  async prompt(text: string, beforeDispatch?: () => void) {
    beforeDispatch?.();
    if (this.notice) {
      this.emit({ type: "error", message: this.notice });
      this.notice = undefined;
    }
    const model = this.options.model;
    if (model && model !== this.model) {
      await this.native.request("session/setModel", {
        commandId: uuidv7(),
        sessionId: this.session,
        model: { modelId: model },
      });
      this.model = model;
    }
    // MSP has no system-instruction field. The first prompt of a session
    // carries the saved instructions (which can include a transferred
    // transcript); Muse keeps them in the session's context after that.
    const instructions = this.instructed
      ? undefined
      : this.options.instructions;
    const revision = this.turnRevision;
    beforeDispatch?.();
    const r = await this.native.request("turn/start", {
      commandId: uuidv7(),
      sessionId: this.session,
      input: this.input(instructions ? `${instructions}\n\n${text}` : text),
      ...(this.options.effort ? { reasoningEffort: this.options.effort } : {}),
    });
    this.instructed = true;
    this.displayControls.confirmNextTurn();
    // Lifecycle notifications can start and finish the turn before this
    // response resumes; a finished turn must not become active again.
    if (r.startedNewTurn && !this.turn && this.turnRevision === revision)
      this.turn = r.turnId;
  }
  async steer(text: string, beforeDispatch?: () => void) {
    if (!this.turn) throw new NotDelivered("No active Muse Code turn.");
    beforeDispatch?.();
    await this.native
      .request("turn/steer", {
        commandId: uuidv7(),
        sessionId: this.session,
        expectedTurnId: this.turn,
        input: this.input(text),
      })
      .catch((error) => {
        // An error response is Muse refusing the input (for example, the
        // turn just ended). Only a transport failure leaves delivery unknown.
        if (error instanceof NativeRpcError)
          throw new NotDelivered(
            "Muse Code did not accept the input for this turn.",
          );
        throw error;
      });
  }
  async cancel() {
    if (!this.turn) throw new Error("No active Muse Code turn.");
    await this.native.request("turn/interrupt", {
      commandId: uuidv7(),
      sessionId: this.session,
      turnId: this.turn,
    });
  }
  async answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ) {
    const entry = [...this.approvals].find(([, a]) => a.requestId === id);
    if (entry) {
      const [approvalId, approval] = entry;
      const choiceId = approval.choices.get(answer.choice as string);
      if (!choiceId || approval.answered)
        throw new Error("Unsupported Muse Code decision.");
      beforeDispatch?.();
      approval.answered = true;
      try {
        await this.native.request("approval/decide", {
          commandId: uuidv7(),
          sessionId: this.session,
          approvalId,
          choiceId,
          requirementId: approval.requirementId,
        });
      } catch (error) {
        // Muse refused the decision (for example a stale requirement). If
        // this request is still the one waiting, the person can answer
        // again; if Muse moved on meanwhile, its resolution stands.
        if (
          error instanceof NativeRpcError &&
          this.approvals.get(approvalId) === approval &&
          !approval.resolved
        ) {
          approval.answered = false;
          throw new NotDelivered("Muse Code did not accept this decision.");
        }
        throw error;
      }
      this.resolve(approval);
      return;
    }
    const questions = this.questions.get(id);
    if (!questions) throw new Error("Native request expired.");
    beforeDispatch?.();
    this.questions.delete(id);
    try {
      await this.native.request("userInput/answer", {
        commandId: uuidv7(),
        sessionId: this.session,
        userInputId: id,
        answers: [...questions].map(([questionId, multiple]) => {
          const value = answer[questionId];
          const labels = (Array.isArray(value) ? value : [value])
            .filter((v) => v !== undefined && v !== null)
            .map(String);
          return multiple
            ? { questionId, selectedLabels: labels }
            : { questionId, selectedLabel: labels[0] ?? "" };
        }),
      });
    } catch (error) {
      // An explicit refusal leaves the prompt open for another answer,
      // unless Muse settled it meanwhile.
      if (error instanceof NativeRpcError && !this.settled.has(id)) {
        this.questions.set(id, questions);
        throw new NotDelivered("Muse Code did not accept this answer.");
      }
      throw error;
    }
    this.emit({ type: "resolved", id });
  }
  private resolve(approval: Approval) {
    if (approval.resolved) return;
    approval.resolved = true;
    this.emit({ type: "resolved", id: approval.requestId });
  }
  private approval(p: any) {
    // Offer only this-call decisions. Session or saved grants would outlive
    // the request a person is looking at.
    const choices = new Map<string, string>();
    for (const c of p.availableChoices ?? []) {
      if (c?.scope !== "once" || typeof c.choiceId !== "string") continue;
      const choice =
        c.decision === "approved"
          ? "allow"
          : c.decision === "denied"
            ? "deny"
            : undefined;
      if (choice && !choices.has(choice)) choices.set(choice, c.choiceId);
    }
    // The id names the stage and what is shown for it. A change to either
    // retires the shown request, so a decision never applies to an action
    // the person did not see.
    const shown = createHash("sha256")
      .update(JSON.stringify([p.subject, p.rawArgs, [...choices]]))
      .digest("hex")
      .slice(0, 12);
    const id = `approval:${p.approvalId}:${p.currentRequirementId?.sourceIndex ?? 0}:${shown}`;
    const prior = this.approvals.get(p.approvalId);
    if (prior?.requestId === id) return;
    if (prior) this.resolve(prior);
    this.approvals.delete(p.approvalId);
    if (!choices.size) {
      // Nothing Loop may offer (only session-wide or saved grants). Waiting
      // would strand the turn, so stop it and say why.
      this.emit({
        type: "error",
        message:
          "Muse Code asked for an approval Loop can only grant in Muse itself. The turn was stopped; approve it in Muse Code or retry.",
      });
      const turnId = p.turnId || this.turn;
      if (turnId)
        void this.native
          .request("turn/interrupt", {
            commandId: uuidv7(),
            sessionId: this.session,
            turnId,
          })
          .catch(() => {});
      return;
    }
    this.approvals.set(p.approvalId, {
      requestId: id,
      requirementId: p.currentRequirementId,
      choices,
      answered: false,
      resolved: false,
    });
    const subject = p.subject ?? {};
    const request: Request = {
      id,
      kind: "approval",
      title: `Allow ${subject.kind === "shell" ? "shell command" : subject.toolName || p.toolName || "tool call"}?`,
      detail: JSON.stringify(
        {
          tool: p.toolName,
          subject,
          arguments: p.rawArgs,
          choices: (p.availableChoices ?? []).map((c: any) => c.label),
        },
        null,
        2,
      ),
      choices: [...choices.keys()],
      allow: choices.has("allow") ? "allow" : undefined,
    };
    this.emit({ type: "request", request });
  }
  private item(item: any, completed: boolean) {
    if (!item || typeof item.itemId !== "string") return;
    if (item.kind === "agentMessage") this.messages.add(item.itemId);
    if (item.kind === "agentMessage")
      this.emit({
        type: "item",
        item: {
          id: item.itemId,
          kind: "assistant",
          text: item.text ?? "",
          phase:
            item.messagePhase === "finalAnswer"
              ? "final_answer"
              : item.messagePhase === "commentary"
                ? "commentary"
                : undefined,
        },
      });
    else if (
      ["toolCall", "userShell", "subagent", "webSearch"].includes(item.kind)
    )
      this.emit({
        type: "item",
        item: {
          id: item.itemId,
          kind: "tool",
          title:
            (completed ? item.displayLabel?.done : item.displayLabel?.active) ||
            item.tool ||
            item.kind,
          status:
            item.status === "inProgress"
              ? "running"
              : (item.status ?? (completed ? "completed" : "running")),
          text: JSON.stringify(item, null, 2),
        },
      });
    // Live prompts already have a durable Loop item; reminders, reasoning
    // and bookkeeping items are Muse's own.
  }
  private message(m: any) {
    const p = m.params ?? {};
    const other =
      !!p.sessionId && !!this.session && p.sessionId !== this.session;
    if (m.id !== undefined && m.method) {
      // Requests are presentations; the decision travels separately. Every
      // request is answered, including ones for a session this run doesn't own.
      const presented =
        !other && ["approval/request", "userInput/request"].includes(m.method);
      if (presented && m.method === "approval/request") this.approval(p);
      else if (presented) this.question(p);
      void this.native
        .write(
          presented
            ? { id: m.id, result: {} }
            : {
                id: m.id,
                error: {
                  code: -32601,
                  message: "Unsupported Loop client request",
                },
              },
        )
        .catch(() => {});
      return;
    }
    if (other) return;
    // A multi-stage command moved to its next stage: present that stage as
    // a new request, targeting its own requirement.
    if (m.method === "approval/updated" && this.approvals.has(p.approvalId))
      this.approval(p);
    if (m.method === "approval/resolved") {
      const approval = this.approvals.get(p.approvalId);
      this.approvals.delete(p.approvalId);
      if (approval) this.resolve(approval);
    }
    if (m.method === "userInput/settled") {
      this.questions.delete(p.userInputId);
      this.settled.add(p.userInputId);
      this.emit({ type: "resolved", id: p.userInputId });
    }
    if (m.method === "turn/started") {
      this.turnRevision++;
      this.turn = p.turnId;
      this.emit({ type: "status", status: "running" });
    }
    // Only agent messages stream into the reply; other items' text deltas
    // (reasoning, tool output) are not assistant text.
    if (
      m.method === "item/delta" &&
      (p.field ?? "text") === "text" &&
      this.messages.has(p.itemId)
    )
      this.emit({ type: "delta", id: p.itemId, text: p.delta });
    if (m.method === "item/started" || m.method === "item/completed")
      this.item(p.item, m.method === "item/completed");
    if (m.method === "turn/completed") {
      if (this.turn && p.turnId !== this.turn) return;
      this.turnRevision++;
      this.turn = "";
      for (const a of this.approvals.values()) this.resolve(a);
      for (const id of this.questions.keys())
        this.emit({ type: "resolved", id });
      this.approvals.clear();
      this.questions.clear();
      this.messages.clear();
      this.settled.clear();
      if (p.usage)
        this.emit({
          type: "usage",
          usage: {
            input_tokens: p.usage.inputTokens ?? 0,
            output_tokens: p.usage.outputTokens ?? 0,
          },
        });
      this.emit({
        type: "status",
        status:
          p.terminal === "cancelled"
            ? "interrupted"
            : p.terminal === "failed"
              ? "failed"
              : "completed",
        recoverable: p.terminal === "failed",
        detail:
          p.error?.kind === "authRequired"
            ? "Muse Code is not signed in. Sign in to Muse Code in Provider connections, then retry."
            : typeof p.error?.message === "string"
              ? p.error.message.slice(0, 1000)
              : undefined,
      });
    }
  }
  private question(p: any) {
    if (!Array.isArray(p.questions) || !p.questions.length) {
      // Nothing to ask: decline it so the tool call resolves.
      void this.native
        .request("userInput/cancel", {
          commandId: uuidv7(),
          sessionId: this.session,
          userInputId: p.userInputId,
          reason: "No questions to answer.",
        })
        .catch(() => {});
      return;
    }
    this.questions.set(
      p.userInputId,
      new Map(p.questions.map((q: any) => [q.id, q.selection === "multiple"])),
    );
    this.emit({
      type: "request",
      request: {
        id: p.userInputId,
        kind: "question",
        title: "Muse Code needs your input",
        detail: "",
        questions: p.questions.map((q: any) => ({
          id: q.id,
          title: q.question,
          options: (q.options ?? []).map((o: any) => o.label),
          multiple: q.selection === "multiple",
        })),
      },
    });
  }
  async dispose() {
    this.controlState?.stop();
    await this.native?.dispose();
  }
}
