import { workspaceMcp } from "./workspace-mcp.js";
import { isWorkspaceMemorySearch } from "../shared/workspace-tools.js";
import { runHarnessCommand } from "../harness-command.js";
import { tokenCount, type Tokens } from "./usage.js";
import { DirectAdapter } from "./direct-adapter.js";
import type { Setting, SettingValue } from "../shared/agent-activities.js";
import { claudeActivities, directUpdates } from "./direct-activities.js";
import { modelOptions } from "../shared/model-options.js";
import { ClaudeSteering } from "./claude-steering.js";
import { randomUUID } from "node:crypto";
import { Native } from "../native.js";
import { NativeMemoryError, nativeFailureDetail } from "../native-memory.js";
import {
  capabilities,
  conflict,
  NotDelivered,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";
import type { Billing } from "../shared/protocol.js";
import { NativeSetupError } from "./setup-error.js";

/** Why a `result` message does not end this launch's user turn, or "" when it
 * does. Older CLIs leave `origin` absent, so only an explicit non-human kind
 * disqualifies one: unrecognised kinds stay disqualified, because settling the
 * user's prompt on someone else's result loses their reply, while an ignored
 * result only stalls a turn the caller can still stop. Callers must report
 * every non-empty reason — nothing else explains a stalled turn. */
function foreignResult(m: any, active: boolean, session: string) {
  if (!active) return "no user turn is open";
  if (m.parent_tool_use_id) return "it belongs to a child tool session";
  if (m.session_id && m.session_id !== session)
    return "it belongs to a different native session";
  if (m.origin != null && m.origin.kind !== "human")
    return `origin.kind=${JSON.stringify(m.origin.kind)} is not human`;
  return "";
}

function claudeTokens(value: any): Tokens | undefined {
  const input = tokenCount(value?.input_tokens);
  const output = tokenCount(value?.output_tokens);
  if (input === undefined || output === undefined) return;
  const cached = tokenCount(value.cache_read_input_tokens) ?? 0;
  const total =
    input + cached + (tokenCount(value.cache_creation_input_tokens) ?? 0);
  if (!Number.isSafeInteger(total)) return;
  return {
    input_tokens: total,
    output_tokens: output,
    ...(cached > 0 ? { cache_read_tokens: cached } : {}),
  };
}

export class Claude extends DirectAdapter implements Adapter {
  static readonly startupSteps: Readonly<Record<string, string>> = {};

  capabilities = { ...capabilities };
  models: { id: string; name: string }[] = [];
  commands: NativeCommand[] = [];
  private native!: Native;
  private requests = new Map<string, any>();
  private session: string;
  private messageIds = new Map<string, string>();
  // Assistant item ids already emitted for child-session (Task tool) streams.
  // Keyed by the item id, because a stream's id can switch before
  // `message_start` arrives. An id already emitted must never be established
  // again: the projector replaces an item by id, so an empty re-established
  // item would overwrite the child's saved text. Cleared at the result and
  // again at the next new user turn, so a delayed delta re-establishes its
  // commentary item in the fresh projector window.
  private childItems = new Set<string>();
  // Child item ids whose stream completed in an earlier turn. A completed
  // child stream is frozen: a late delta or assistant message for it must
  // never re-create its item in a later run (that would move or overwrite
  // the earlier run's native row and misattribute the output), so such
  // events are ignored entirely. Ids are harvested at each turn's result
  // and kept for the adapter's lifetime — they are ids only, and evicting
  // one would let a late event treat a completed stream as new.
  private priorChildIds = new Set<string>();
  // Last-known text per child item id for the current (or upcoming) turn:
  // the full assistant message (written whether a turn is open or not) plus
  // any deltas seen before the next prompt. Kept across prompt() (unlike
  // childItems) so a re-established item in a fresh window carries the known
  // text instead of replacing it with empty; cleared at the result, where
  // its ids move into priorChildIds. Each entry is capped at the projector's
  // display-preview limit and the map is bounded by both bytes and entry
  // count, so a long session cannot grow adapter memory with copies of
  // child output.
  private childText = new Map<string, string>();
  private childTextBytes = 0;
  private rememberChildText(id: string, text: string) {
    // Keep only a display-sized tail, mirroring the projector's own preview
    // bound, so one long-lived stream cannot grow its entry without limit.
    if (Buffer.byteLength(text) > 64000) {
      let low = 0;
      let high = text.length;
      while (low < high) {
        const keep = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(-keep)) <= 64000) low = keep;
        else high = keep - 1;
      }
      text = text.slice(-low);
    }
    const previous = this.childText.get(id);
    const previousBytes = previous ? Buffer.byteLength(previous) : 0;
    this.childTextBytes += Buffer.byteLength(text) - previousBytes;
    this.childText.set(id, text);
    while (
      (this.childTextBytes > 4 * 1024 * 1024 || this.childText.size > 512) &&
      this.childText.size > 1
    ) {
      const oldest = this.childText.keys().next().value!;
      this.childTextBytes -= Buffer.byteLength(this.childText.get(oldest)!);
      this.childText.delete(oldest);
    }
  }
  private interrupted = false;
  private active = false;
  private steering = new ClaudeSteering();
  private orphanTurn = false;
  private billing!: Billing;
  constructor(
    private options: Options,
    emit: Emit,
  ) {
    super("claude", emit);
    this.session = options.resume ?? randomUUID();
    this.permissionMode = options.permissionMode;
  }
  private permissionMode?: string;
  private sessionOptions(model?: string | null): Setting[] {
    return [
      {
        id: "model",
        label: "Model",
        type: "select",
        choices: this.models.map((m) => ({ value: m.id, label: m.name })),
        confirmed: model,
        mutable: this.models.length > 0,
        application: "live",
        provenance: "Claude control protocol",
      },
      {
        id: "mode",
        label: "Native permission mode",
        type: "select",
        choices: [
          "default",
          "acceptEdits",
          "plan",
          "bypassPermissions",
          "dontAsk",
          "auto",
        ].map((value) => ({ value, label: value })),
        confirmed: this.permissionMode,
        mutable: true,
        application: "live",
        provenance: "Claude control protocol",
        description:
          "Changes the native harness permission mode. Loop workspace tool approvals remain governed by Loop.",
      },
      {
        id: "effort",
        label: "Reasoning effort",
        type: "text",
        requested: this.options.effort,
        mutable: false,
        application: "new-session",
        reason:
          "Configured with the Claude launch flag. Change the agent's model settings for its next session.",
        provenance: "Claude --effort launch option",
      },
    ];
  }
  async setSetting(
    id: string,
    value: SettingValue,
    revision: number,
    beforeApply?: () => void,
  ) {
    return this.displayControls.change(id, value, revision, async () => {
      if (typeof value !== "string" || !["model", "mode"].includes(id))
        throw new Error("Invalid session setting.");
      beforeApply?.();
      if (id === "mode") {
        await this.control({ subtype: "set_permission_mode", mode: value });
        this.permissionMode = value;
      } else {
        await this.control({ subtype: "set_model", model: value });
        this.options.model = value;
      }
      return this.sessionOptions(
        id === "model"
          ? value
          : (this.settings.options.find((o) => o.id === "model")?.confirmed as
              string | undefined),
      );
    });
  }
  async start(): Promise<Billing> {
    conflict(this.options.billing, [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]);
    const result = await runHarnessCommand(
      this.options.executable,
      ["auth", "status"],
      {
        cwd: this.options.project,
        timeout: 20000,
        maxBuffer: 100000,
      },
    ).catch((e) => {
      if (e.stdout) return { stdout: e.stdout };
      throw new Error(
        "Could not read native Claude auth status. Run claude auth status.",
      );
    });
    const auth = JSON.parse(result.stdout);
    const subscription =
      auth.loggedIn === true &&
      auth.authMethod === "claude.ai" &&
      auth.apiProvider === "firstParty" &&
      (!auth.apiKeySource || auth.apiKeySource === "none");
    if (this.options.billing === "subscription" && !subscription)
      throw new NativeSetupError(
        "claude_subscription_required",
        "Sign in to Claude Code with your Claude account before using subscription mode. No API fallback was attempted.",
      );
    this.native = new Native(
      this.options.executable,
      [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--permission-prompt-tool",
        "stdio",
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(this.options.effort ? ["--effort", this.options.effort] : []),
        ...(this.options.permissionMode &&
        this.options.permissionMode !== "default"
          ? ["--permission-mode", this.options.permissionMode]
          : []),
        ...(!this.options.resume && this.options.instructions
          ? ["--append-system-prompt", this.options.instructions]
          : []),
        ...(this.options.workspaceTools
          ? [
              "--mcp-config",
              JSON.stringify(workspaceMcp(this.options.workspaceTools).claude),
            ]
          : []),
        ...(this.options.resume
          ? ["--resume", this.session]
          : ["--session-id", this.session]),
      ],
      this.options.project,
    );
    this.native.on("message", (m) => this.message(m));
    this.native.on("failure", (error) => {
      this.steering.abandon(
        "Claude exited before confirming that it read the follow-up.",
      );
      this.emit({
        type: "status",
        status: "failed",
        detail: nativeFailureDetail(
          error,
          "Claude Code exited. Inspect native login/configuration and resume its session.",
        ),
      });
    });
    const init = await this.control({ subtype: "initialize" });
    this.models = (init.models || []).map((m: any) => ({
      id: m.value || m.id,
      name: m.displayName || m.name || m.value || m.id,
      ...modelOptions(m),
    }));
    this.commands = (init.commands || []).map((c: any) => ({
      name: c.name,
      token: "/" + c.name,
      kind: "command",
      description: c.description || "",
      argumentHint: c.argumentHint,
      ...(["clear", "resume", "rewind", "fork", "rename"].includes(c.name)
        ? {
            disabledReason:
              "Use the native terminal for this session-management command.",
          }
        : {}),
    }));
    const account = init.account ?? {};
    const apiKeyActive =
      (!!auth.apiKeySource && auth.apiKeySource !== "none") ||
      (!!account.apiKeySource && account.apiKeySource !== "none");
    if (!subscription && account.apiProvider === "firstParty" && !apiKeyActive)
      throw new NativeSetupError(
        "claude_api_source_unverified",
        "Claude did not confirm an API credential source for this integration. No prompt was sent.",
      );
    if (
      this.options.billing === "subscription" &&
      (account.apiProvider !== "firstParty" || apiKeyActive)
    )
      throw new NativeSetupError(
        "claude_subscription_unverified",
        apiKeyActive
          ? "Claude reported an API key for this session. Remove the key from Claude settings before using subscription mode. No prompt was sent."
          : "Claude did not confirm the native subscription provider. No prompt was sent.",
      );
    this.billing = {
      mode: this.options.billing,
      description:
        subscription && !apiKeyActive
          ? "Native Claude account; provider plan limits and enabled usage credits apply"
          : "Explicit native Claude API/provider mode; provider charges apply",
      provider: account.apiProvider ?? auth.apiProvider,
    };
    this.emit({
      type: "metadata",
      nativeSession: this.session,
      billing: this.billing,
    });
    this.displayControls.publish(
      this.sessionOptions(this.billing.model),
      this.commands,
    );
    return this.billing;
  }
  private control(request: Record<string, unknown>): Promise<any> {
    const request_id = randomUUID();
    return this.native.requestFrame(
      request_id,
      String(request.subtype),
      { type: "control_request", request_id, request },
      {
        timeout: () => new Error("Claude control timed out; outcome unknown."),
        failure: (error) =>
          error instanceof NativeMemoryError
            ? error
            : new Error("Claude exited"),
      },
    );
  }
  async prompt(text: string, beforeDispatch?: () => void) {
    beforeDispatch?.();
    this.interrupted = false;
    // A new user turn clears the child ids: attaching the run resets the
    // projector's item window, and an item folded between runs has no run,
    // so a post-dispatch delta must re-establish its commentary item (seeded
    // from childText) or the projector would create a phase-less fragment
    // that is eligible as the answer. Mid-turn steering follow-ups are written
    // by steer() and leave the ids alone, so their deltas still merge into the
    // open items. Trade-off: if a stream's seed was
    // evicted from childText (over 512 streams or 4 MiB in one turn cycle),
    // the re-established item carries only the new fragment, so that
    // stream's progress preview loses earlier text. It is never phase-less.
    if (!this.active) this.childItems.clear();
    this.active = true;
    await this.send(text, randomUUID());
  }
  private send(text: string, uuid: string) {
    return this.native.write({
      type: "user",
      session_id: this.session,
      uuid,
      origin: { kind: "human" },
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
  }
  /** Writes a follow-up into the running turn without interrupting it and
   * resolves once Claude reads it. See ClaudeSteering. */
  async steer(text: string, beforeDispatch?: () => void) {
    if (!this.active) throw new NotDelivered("No active Claude turn.");
    beforeDispatch?.();
    const uuid = randomUUID();
    const read = this.steering.expect(uuid);
    try {
      await this.send(text, uuid);
    } catch (error) {
      // Unconfirmed, so it must not hold the turn open waiting for an echo.
      this.steering.drop(uuid);
      throw error;
    }
    await read;
  }
  async cancel() {
    this.interrupted = true;
    await this.control({ subtype: "interrupt" });
  }
  async answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ) {
    const m = this.requests.get(id);
    if (!m) throw new Error("Claude request expired.");
    const r = m.request;
    let response: unknown;
    if (r.subtype === "elicitation")
      response = { action: answer.choice, content: null };
    else if (r.tool_name === "AskUserQuestion")
      response = {
        behavior: "allow",
        updatedInput: {
          ...r.input,
          answers: Object.fromEntries(
            (r.input.questions ?? []).map((q: any, i: number) => [
              q.question,
              (answer[String(i)] as string[]).join(", "),
            ]),
          ),
        },
      };
    else
      response =
        answer.choice === "allow"
          ? { behavior: "allow", updatedInput: r.input }
          : { behavior: "deny", message: "Denied by the user in Loop." };
    beforeDispatch?.();
    this.requests.delete(id);
    await this.native.write({
      type: "control_response",
      response: { subtype: "success", request_id: id, response },
    });
    this.emit({ type: "resolved", id });
  }
  private activityInputs = new Map<string, { name: string; input: any }>();
  private message(m: any) {
    if (m.type === "user" && m.isReplay) {
      this.echo(m.uuid);
      return;
    }
    if (this.orphanTurn) {
      if (m.type === "result" && !m.parent_tool_use_id) this.orphanTurn = false;
      // Nobody can answer its permission requests; refuse them.
      if (m.type === "control_request")
        void this.native
          .write({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: m.request_id,
              response:
                m.request?.subtype === "elicitation"
                  ? { action: "decline", content: null }
                  : {
                      behavior: "deny",
                      message: "Loop stopped this turn's run.",
                    },
            },
          })
          .catch(() => {});
      if (m.type !== "control_response") return;
    }
    // Streaming input also carries results for turns injected by Claude
    // (notably stopped background tasks on resume). They must not settle the
    // user's queued prompt, end a turn holding an unread follow-up, or clear
    // approvals.
    if (m.type === "result") {
      const foreign = foreignResult(m, this.active, this.session);
      // A dropped terminal result leaves the run streaming with no watchdog,
      // so say why: the only visible symptom is a turn that never finishes,
      // and `origin.kind` is an upstream protocol that keeps growing.
      if (foreign) {
        console.warn(
          `Loop ignored a Claude result that is not this turn (${foreign}).`,
        );
        return;
      }
    }
    if (
      ["assistant", "user"].includes(m.type) &&
      Array.isArray(m.message?.content)
    ) {
      for (const block of m.message.content) {
        if (block.type === "tool_use")
          this.activityInputs.set(block.id, {
            name: block.name,
            input: block.input,
          });
        for (const activity of directUpdates(
          "claude",
          claudeActivities(block, this.activityInputs.get(block.tool_use_id)),
        ))
          this.emit({ type: "activity", activity });
      }
    }
    if (m.type === "result") this.activityInputs.clear();
    if (m.type === "control_response") {
      this.native.settleRequest(
        m.response?.request_id,
        m.response?.response ?? {},
        m.response?.subtype === "error"
          ? new Error(m.response.error ?? "Claude control failed")
          : undefined,
      );
      return;
    }
    if (m.type === "control_cancel_request") {
      this.requests.delete(m.request_id);
      this.emit({ type: "resolved", id: m.request_id });
      return;
    }
    if (m.type === "control_request") {
      const r = m.request;
      if (r.subtype === "can_use_tool") {
        this.requests.set(m.request_id, m);
        this.emit({
          type: "request",
          request:
            r.tool_name === "AskUserQuestion"
              ? {
                  id: m.request_id,
                  kind: "question",
                  title: "Claude needs your input",
                  detail: "",
                  questions: (r.input.questions ?? []).map(
                    (q: any, i: number) => ({
                      id: String(i),
                      title: q.question,
                      multiple: q.multiSelect,
                      options: q.options?.map((o: any) => o.label),
                    }),
                  ),
                }
              : {
                  id: m.request_id,
                  kind: "approval",
                  title: r.title ?? r.tool_name,
                  detail: JSON.stringify(
                    {
                      input: r.input,
                      reason: r.decision_reason,
                      path: r.blocked_path,
                    },
                    null,
                    2,
                  ),
                  choices: ["allow", "deny"],
                  allow: "allow",
                },
        });
      } else if (r.subtype === "elicitation") {
        this.requests.set(m.request_id, m);
        this.emit({
          type: "request",
          request: {
            id: m.request_id,
            kind: "approval",
            title: "MCP elicitation (form/URL completion unavailable)",
            detail: r.message,
            choices: ["decline", "cancel"],
          },
        });
      } else
        void this.native
          .write({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: m.request_id,
              error: "Unsupported Loop client control request",
            },
          })
          .catch(() => {});
      return;
    }
    if (m.type === "system" && m.subtype === "init") {
      if (Array.isArray(m.slash_commands))
        this.commands = m.slash_commands
          .filter((name: unknown) => typeof name === "string")
          .map((name: string) => ({
            name,
            token: "/" + name,
            kind: "command",
            description:
              this.commands.find((c) => c.name === name)?.description || "",
            disabledReason: [
              "clear",
              "resume",
              "rewind",
              "fork",
              "rename",
            ].includes(name)
              ? "Use the native terminal for this session-management command."
              : undefined,
          }));
      if (typeof m.permissionMode === "string")
        this.permissionMode = m.permissionMode;
      if (typeof m.model === "string")
        this.displayControls.publish(
          this.sessionOptions(m.model),
          this.commands,
        );
      this.session = m.session_id;
      this.emit({
        type: "metadata",
        nativeSession: this.session,
        billing: { ...this.billing, model: m.model },
      });
    }
    if (m.type === "stream_event") {
      const e = m.event;
      const stream = m.parent_tool_use_id ?? "root";
      if (e.type === "message_start") {
        this.messageIds.set(stream, e.message.id);
        if (this.messageIds.size > 128)
          this.messageIds.delete(this.messageIds.keys().next().value!);
      }
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
        const id = this.messageIds.get(stream) ?? m.uuid;
        // A child stream whose turn completed is frozen; a late delta must
        // not re-create its item in this run (it would move or overwrite
        // the earlier run's native row), so ignore it entirely.
        if (m.parent_tool_use_id && this.priorChildIds.has(id)) return;
        if (m.parent_tool_use_id && !this.active) {
          // Between turns the projector may drop a bare delta (no run) or
          // attach the next run during recall before active flips true. In
          // both cases a bare delta could leave a phase-less item that is
          // selectable as the answer, so fold the delta into a single
          // commentary item carrying the accumulated seed: the item is
          // never phase-less and its text preserves the stream (including
          // an evicted seed's id — the item then carries the fragment, not
          // an empty seed). No separate delta is emitted here.
          this.rememberChildText(
            id,
            (this.childText.get(id) ?? "") + e.delta.text,
          );
          this.emit({
            type: "item",
            item: {
              id,
              kind: "assistant",
              text: this.childText.get(id) ?? "",
              phase: "commentary",
            },
          });
        } else if (m.parent_tool_use_id && !this.childItems.has(id)) {
          this.childItems.add(id);
          this.emit({
            type: "item",
            item: {
              id,
              kind: "assistant",
              // Seed with any text already known for this id (a full child
              // assistant message or deltas seen earlier); the projector
              // replaces by id, so an empty item would drop it.
              text: this.childText.get(id) ?? "",
              phase: "commentary",
            },
          });
        }
        // Keep the seed current with every active delta (the inactive fold
        // above already accumulated its delta), so a later re-established
        // item carries everything the stream has said so far and a
        // subsequent delta appends instead of overwriting it. Empty deltas
        // contribute nothing, so they do not add a cache entry.
        if (m.parent_tool_use_id && this.active && e.delta.text)
          this.rememberChildText(
            id,
            (this.childText.get(id) ?? "") + e.delta.text,
          );
        // Root (parent) streams always emit deltas; child streams emit them
        // only while a turn is open (while inactive their delta was folded
        // into the commentary item above).
        if (!m.parent_tool_use_id || this.active)
          this.emit({ type: "delta", id, text: e.delta.text });
      }
      if (
        e.type === "content_block_start" &&
        e.content_block.type === "tool_use"
      ) {
        this.activityInputs.set(e.content_block.id, {
          name: e.content_block.name,
          input: e.content_block.input,
        });
        this.emit({
          type: "item",
          item: {
            id: e.content_block.id,
            kind: "tool",
            title: e.content_block.name,
            text: "",
            status: "running",
          },
        });
      }
    }
    if (m.type === "assistant") {
      const content = m.message?.content ?? [];
      const text = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      // A child stream whose turn completed is frozen: a late assistant
      // message for it must not re-create its item, but its tool updates are
      // still emitted below so the trace keeps the tool arguments.
      const frozen =
        m.parent_tool_use_id && this.priorChildIds.has(m.message.id);
      if (text && !frozen) {
        // Remember the emitted id and its text so a later delta merges into
        // this item instead of establishing an empty one that replaces it.
        if (m.parent_tool_use_id) {
          this.childItems.add(m.message.id);
          this.rememberChildText(m.message.id, text);
        }
        this.emit({
          type: "item",
          item: {
            id: m.message.id,
            kind: "assistant",
            text,
            // A Task tool (subagent) session's assistant message must not
            // become the parent run's answer; commentary keeps it visible
            // as progress while the projector excludes it from selection.
            ...(m.parent_tool_use_id ? { phase: "commentary" as const } : {}),
          },
        });
      }
      for (const b of content)
        if (b.type === "tool_use") {
          this.activityInputs.set(b.id, { name: b.name, input: b.input });
          this.emit({
            type: "item",
            item: {
              id: b.id,
              kind: "tool",
              title: b.name,
              text: JSON.stringify(b.input, null, 2),
              status: "running",
            },
          });
        }
    }
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content)
        if (b.type === "tool_result") {
          const tool = this.activityInputs.get(b.tool_use_id)?.name;
          const memorySearch = isWorkspaceMemorySearch(tool);
          this.activityInputs.delete(b.tool_use_id);
          this.emit({
            type: "item",
            item: {
              id: b.tool_use_id,
              kind: "tool",
              title: tool || "Tool result",
              text: memorySearch
                ? ""
                : typeof b.content === "string"
                  ? b.content
                  : JSON.stringify(b.content),
              status: b.is_error ? "failed" : "completed",
            },
          });
        }
    if (m.type === "result") {
      const usage = claudeTokens(m.usage);
      if (usage) this.emit({ type: "usage", usage });
      // Claude answers an unread follow-up in a further turn, even after an
      // interrupt, so the run stays open until it reads it (see echo()).
      if (this.steering.pending) {
        this.steering.hold(m, () => this.finish({ ...m, errors: [] }));
        return;
      }
      this.finish(m);
    }
  }
  /** Claude read the message with this uuid; its turn starts now. */
  private echo(uuid: unknown) {
    if (this.steering.read(uuid)) {
      // A cancelled run also stops the turn that answers its follow-up.
      if (this.interrupted)
        this.control({ subtype: "interrupt" }).catch(() => {});
    } else if (this.steering.abandoned(uuid)) {
      // A follow-up Loop gave up on started a turn no Loop run owns: drop its
      // output and result, and stop it if no newer prompt has been written.
      this.orphanTurn = true;
      if (!this.active) this.control({ subtype: "interrupt" }).catch(() => {});
    }
  }
  private finish(m: any) {
    const earlier = this.steering.release();
    this.steering.abandon(
      "Claude stopped before confirming that it read the follow-up.",
    );
    this.active = false;
    // The turn's child streams are now complete; freeze their ids so late
    // events for them cannot move or overwrite this run's native history.
    // The set is ids-only and kept for the adapter's lifetime: evicting an
    // id would let a late event treat a completed stream as new and
    // overwrite its recorded history.
    for (const id of this.childItems) this.priorChildIds.add(id);
    for (const id of this.childText.keys()) this.priorChildIds.add(id);
    this.messageIds.clear();
    this.childItems.clear();
    this.childText.clear();
    this.childTextBytes = 0;
    for (const id of this.requests.keys()) this.emit({ type: "resolved", id });
    this.requests.clear();
    this.emit({
      type: "status",
      status: this.interrupted
        ? "interrupted"
        : m.is_error
          ? "failed"
          : "completed",
      recoverable: !!m.is_error && !this.interrupted,
      // An earlier turn of this run that ended while a follow-up was unread
      // keeps its errors here; the status is that of the final turn.
      detail: [...earlier, ...(m.errors ?? [])].join("\n") || undefined,
    });
  }
  async dispose() {
    this.steering.abandon(
      "Claude closed before confirming that it read the follow-up.",
    );
    await this.native?.dispose();
  }
}
