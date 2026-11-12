import { normalizeItemStatus } from "../shared/native-item-state.js";
import { workspaceMcp } from "./workspace-mcp.js";
import { DirectAdapter } from "./direct-adapter.js";
import type { Setting, SettingValue } from "../shared/agent-activities.js";
import { codexActivities, directUpdates } from "./direct-activities.js";
import { modelOptions } from "../shared/model-options.js";
import { Native } from "../native.js";
import { nativeFailureDetail } from "../native-memory.js";
import { NativeSetupError } from "./setup-error.js";
import { codexToolApproval } from "../shared/codex-approval.js";
import { codexApprovalDetail } from "./codex-approval-display.js";
import { tokenCount, type Tokens } from "./usage.js";
import type { Billing, Request } from "../shared/protocol.js";
import {
  capabilities,
  conflict,
  NotDelivered,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";

function elicitationUrl(params: any): string | undefined {
  if (
    params.mode !== "url" ||
    typeof params.elicitationId !== "string" ||
    !params.elicitationId ||
    typeof params.url !== "string"
  )
    return;
  try {
    const url = new URL(params.url);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {}
}

function codexTokens(value: any): Tokens | undefined {
  const input = tokenCount(value?.inputTokens);
  const output = tokenCount(value?.outputTokens);
  // Cached input and reasoning output are already included in these totals.
  if (input === undefined || output === undefined) return;
  return { input_tokens: input, output_tokens: output };
}

export class Codex extends DirectAdapter implements Adapter {
  static readonly startupSteps: Readonly<Record<string, string>> = {
    initialize: "starting its native process",
    "account/read": "checking its sign-in",
    "config/read": "loading its configuration",
    "model/list": "loading available models",
    "skills/list": "loading available skills",
    "thread/resume": "reopening this conversation",
    "thread/start": "opening a new conversation",
  };
  refreshCommandCatalog() {
    if (this.native && this.thread) {
      this.displayControls.refresh(
        async () => {
          const result = await this.native.request("skills/list", {
            cwds: [this.options.project],
            forceReload: true,
          });
          this.skills = (result.data || [])
            .flatMap((d: any) => d.skills || [])
            .filter(
              (s: any) =>
                s.enabled &&
                typeof s.path === "string" &&
                /^[\w.:-]+$/.test(s.name),
            );
          return this.skills.map((s: any) => ({
            name: s.name,
            token: "$" + s.name,
            kind: "skill",
            description: s.interface?.shortDescription || s.description || "",
          }));
        },
        (commands) => {
          this.commands = commands;
        },
      );
    }
  }

  capabilities = { ...capabilities };
  models: { id: string; name: string }[] = [];
  commands: NativeCommand[] = [];
  private native!: Native;
  private skills: { name: string; path: string }[] = [];
  private thread = "";
  private turn = "";
  private turnRevision = 0;
  private tokenTotal?: Tokens;
  private tokenBaseline?: Tokens;
  private requests = new Map<string, any>();
  private asyncQuestions = new Map<string, Request>();
  private seenAsyncQuestions = new Set<string>();
  private defaultModel: string | undefined;
  get defaultModelOption() {
    return {
      id: "native-default",
      name: "Use native default",
      resolvedModel: this.defaultModel,
    };
  }
  constructor(
    private options: Options,
    emit: Emit,
  ) {
    super("codex", emit);
  }
  private sessionOptions(model?: string): Setting[] {
    const selected = this.models.find(
      (m) => m.id === (this.options.model || model),
    ) as any;
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
      ...(selected?.effortLevels
        ? [
            {
              id: "effort",
              label: "Reasoning effort",
              type: "select" as const,
              choices: selected.effortLevels.map((e: any) => ({
                value: e.value,
                label: e.value,
              })),
              confirmed: this.options.effort,
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
        const options = this.sessionOptions(
          this.settings.options.find((o) => o.id === "model")?.confirmed as
            string | undefined,
        );
        this.displayControls.publish(
          options.map((o) =>
            o.id === "model" ? { ...o, requested: value } : o,
          ),
        );
      }
      return undefined; // The next prompt acknowledgement confirms application.
    });
  }
  async start(): Promise<Billing> {
    conflict(this.options.billing, [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_BASE_URL",
    ]);
    this.native = new Native(
      this.options.executable,
      ["app-server"],
      this.options.project,
      undefined,
      // Codex sends whole file uploads in tool confirmations. Transport size
      // must not veto them before the display-only approval projection runs.
      Number.POSITIVE_INFINITY,
    );
    this.native.on("message", (m) => this.message(m));
    this.native.on("failure", (error) =>
      this.emit({
        type: "status",
        status: "failed",
        detail: nativeFailureDetail(
          error,
          "Codex exited. Use loop doctor, then resume the native thread.",
        ),
      }),
    );
    await this.native.request("initialize", {
      clientInfo: { name: "loop_cli", title: "Loop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    await this.native.write({ method: "initialized" });
    const account = await this.native.request("account/read", {
      refreshToken: false,
    });
    const config = await this.native.request("config/read", {
      includeLayers: false,
      cwd: this.options.project,
    });
    if (
      this.options.billing === "subscription" &&
      (account.account?.type !== "chatgpt" ||
        ![null, undefined, "openai"].includes(config.config.model_provider) ||
        config.config.model_providers?.openai)
    ) {
      throw new Error(
        "Codex subscription mode requires native ChatGPT login and the built-in OpenAI provider. Run codex login and check codex configuration, or explicitly select --billing existing.",
      );
    }
    const modelList = await this.native
      .request("model/list", { limit: 100 })
      .catch(() => ({ data: [] }));
    this.defaultModel =
      config.config.model ||
      modelList.data?.find((model: any) => model.isDefault)?.model ||
      modelList.data?.find((model: any) => model.isDefault)?.id ||
      modelList.data?.[0]?.model ||
      modelList.data?.[0]?.id;
    this.models = (modelList.data || []).map((m: any) => ({
      id: m.model || m.id,
      name: m.displayName || m.model || m.id,
      ...modelOptions(m),
    }));
    const skillList = await this.native
      .request("skills/list", {
        cwds: [this.options.project],
        forceReload: true,
      })
      .catch(() => ({ data: [] }));
    this.skills = (skillList.data || [])
      .flatMap((d: any) => d.skills || [])
      .filter(
        (s: any) =>
          s.enabled && typeof s.path === "string" && /^[\w.:-]+$/.test(s.name),
      );
    this.commands = this.skills.map((s: any) => ({
      name: s.name,
      token: "$" + s.name,
      kind: "skill",
      description: s.interface?.shortDescription || s.description || "",
    }));
    if (this.options.probeOnly)
      return {
        mode: this.options.billing,
        description:
          account.account?.type === "chatgpt"
            ? `Native ChatGPT account (${account.account.planType ?? "plan unknown"}); limits and enabled overage apply`
            : "Existing Codex provider; may incur API charges",
        provider: config.config.model_provider || "openai",
        model: config.config.model,
      };
    const extras = {
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(!this.options.resume && this.options.instructions
        ? {
            developerInstructions: [
              config.config.developer_instructions,
              this.options.instructions,
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        : {}),
      ...(this.options.workspaceTools
        ? {
            config: workspaceMcp(this.options.workspaceTools).codex,
          }
        : {}),
    };
    const r = await this.native
      .request(
        this.options.resume ? "thread/resume" : "thread/start",
        this.options.resume
          ? // Codex retains the full context. Loop already persists its display
            // history; copying every old turn (including file data) into this
            // single response can exceed the transport's bounded frame size.
            {
              threadId: this.options.resume,
              cwd: this.options.project,
              excludeTurns: true,
              ...extras,
            }
          : { cwd: this.options.project, ...extras },
      )
      .catch((error) => {
        // Codex owns this wording, so match the phrase rather than the whole
        // message: a rewording upstream must not silently drop the person
        // back to the raw native error this branch exists to replace.
        if (
          this.options.resume &&
          error instanceof Error &&
          /already has an active writer/i.test(error.message)
        )
          throw new NativeSetupError(
            "native_session_in_use",
            "This conversation is in use by another Codex client, such as the desktop app. Stop or release the session there, then retry in Loop. No prompt was sent.",
          );
        throw error;
      });
    this.thread = r.thread.id;
    if (this.options.billing === "subscription" && r.modelProvider !== "openai")
      throw new Error(
        "Resumed thread uses a different provider; refusing subscription-mode work.",
      );
    const billing: Billing = {
      mode: this.options.billing,
      description:
        account.account?.type === "chatgpt"
          ? `Native ChatGPT account (${account.account.planType ?? "plan unknown"}); plan limits and enabled overage apply`
          : "Existing Codex provider configuration; may incur API charges",
      provider: r.modelProvider,
      // Report the model turn/start will dispatch, not the thread's last one.
      model: this.options.model || this.defaultModel || r.model,
    };
    this.displayControls.publish(this.sessionOptions(r.model), this.commands);
    this.emit({ type: "metadata", nativeSession: this.thread, billing });
    for (const turn of r.thread.turns ?? [])
      for (const item of turn.items ?? []) this.item(item, true, true);
    return billing;
  }
  async inspect(
    method: "thread/list" | "thread/read" | "thread/fork",
    params: Record<string, unknown>,
  ) {
    return this.native.request(method, params);
  }
  async prompt(text: string, beforeDispatch?: () => void) {
    if (this.options.billing === "subscription") {
      conflict(this.options.billing, [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_BASE_URL",
      ]);
      const account = await this.native.request("account/read", {
        refreshToken: false,
      });
      const config = await this.native.request("config/read", {
        includeLayers: false,
        cwd: this.options.project,
      });
      if (
        account.account?.type !== "chatgpt" ||
        ![undefined, null, "openai"].includes(config.config.model_provider) ||
        config.config.model_providers?.openai
      )
        throw new Error(
          "Codex effective subscription configuration changed. No prompt was sent.",
        );
    }
    beforeDispatch?.();
    this.tokenBaseline = this.tokenTotal;
    const revision = this.turnRevision;
    const r = await this.native.request("turn/start", {
      threadId: this.thread,
      ...(this.options.model || this.defaultModel
        ? { model: this.options.model || this.defaultModel }
        : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      input: [
        { type: "text", text, text_elements: [] },
        ...this.skills
          .filter(
            (s) =>
              text.trimStart().startsWith("$" + s.name + " ") ||
              text.trim() === "$" + s.name,
          )
          .map((s) => ({ type: "skill", name: s.name, path: s.path })),
      ],
    });
    this.displayControls.confirmNextTurn();
    // Lifecycle notifications can finish the turn before this response resumes
    // our await. The response must not resurrect that completed native turn.
    if (
      this.turnRevision === revision &&
      !this.turn &&
      r.turn.status === "inProgress"
    )
      this.turn = r.turn.id;
  }
  async steer(text: string, beforeDispatch?: () => void) {
    if (!this.turn) {
      if (this.asyncQuestions.size) return this.prompt(text, beforeDispatch);
      throw new NotDelivered("No active Codex turn.");
    }
    beforeDispatch?.();
    await this.native.request("turn/steer", {
      threadId: this.thread,
      expectedTurnId: this.turn,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }
  async cancel() {
    if (!this.turn) {
      if (!this.asyncQuestions.size) throw new Error("No active Codex turn.");
      this.clearAsyncQuestions();
      this.emit({ type: "status", status: "interrupted" });
      return;
    }
    await this.native.request("turn/interrupt", {
      threadId: this.thread,
      turnId: this.turn,
    });
  }
  async answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ) {
    const question = this.asyncQuestions.get(id);
    if (question) {
      // Async input has no outstanding JSON-RPC request. Deliver the user's
      // explicit answer as native input, once, in the same thread.
      const dispatch = () => {
        beforeDispatch?.();
        this.asyncQuestions.delete(id);
      };
      const text =
        "Answers to your questions:\n" +
        question
          .questions!.map((q) => `${q.title}\n${JSON.stringify(answer[q.id])}`)
          .join("\n\n");
      if (this.turn) await this.steer(text, dispatch);
      else await this.prompt(text, dispatch);
      this.emit({ type: "resolved", id });
      return;
    }
    const m = this.requests.get(id);
    if (!m) throw new Error("Native request expired.");
    let result: unknown;
    if (m.method === "item/tool/requestUserInput")
      result = {
        answers: Object.fromEntries(
          Object.entries(answer).map(([k, answers]) => [k, { answers }]),
        ),
      };
    else if (m.method === "item/permissions/requestApproval")
      result = {
        permissions: answer.choice === "allow" ? m.params.permissions : {},
        scope: "turn",
      };
    else if (m.method === "mcpServer/elicitation/request") {
      const approval = codexToolApproval(m.params);
      if (
        ![
          "decline",
          "cancel",
          ...(approval || elicitationUrl(m.params) ? ["accept"] : []),
        ].includes(answer.choice as string)
      )
        throw new Error("Unsupported MCP elicitation decision.");
      // Empty form content approves this call only. Do not send persistence
      // metadata or invent values for a form that needs user input.
      result = {
        action: answer.choice,
        content: answer.choice === "accept" && approval ? {} : null,
      };
    } else result = { decision: answer.choice };
    beforeDispatch?.();
    this.requests.delete(id);
    await this.native.write({ id: m.id, result });
    this.emit({ type: "resolved", id });
  }
  private clearAsyncQuestions() {
    for (const id of this.asyncQuestions.keys())
      this.emit({ type: "resolved", id });
    this.asyncQuestions.clear();
    this.seenAsyncQuestions.clear();
  }
  private item(item: any, completed: boolean, history = false) {
    if (!item || typeof item.id !== "string") return;
    if (
      item.type === "agentMessage" &&
      item.delivery === "async" &&
      completed &&
      !history &&
      !this.seenAsyncQuestions.has(item.id) &&
      Array.isArray(item.questions) &&
      item.questions.length
    ) {
      const request: Request = {
        id: `async:${item.id}`,
        kind: "question",
        title: "Codex needs your input",
        detail: "",
        questions: item.questions.map((q: any, index: number) => ({
          id: String(index),
          title: q.title,
          options: q.options ?? undefined,
        })),
      };
      this.seenAsyncQuestions.add(item.id);
      this.asyncQuestions.set(request.id, request);
      this.emit({ type: "request", request });
    }
    if (item.type === "agentMessage")
      this.emit({
        type: "item",
        item: {
          id: item.id,
          kind: "assistant",
          text: item.text ?? "",
          phase: item.phase,
        },
      });
    else if (item.type === "userMessage") {
      if (history)
        this.emit({
          type: "item",
          item: {
            id: item.id,
            kind: "user",
            text: (item.content ?? [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n"),
          },
        });
      // Live prompts already have a durable Loop item.
    } else if (
      !["reasoning", "enteredReviewMode", "exitedReviewMode"].includes(
        item.type,
      )
    )
      this.emit({
        type: "item",
        item: {
          id: item.id,
          kind: "tool",
          title: item.type,
          status: normalizeItemStatus(item.status, completed),
          text: JSON.stringify(item, null, 2),
        },
      });
  }
  private message(m: any) {
    const p = m.params ?? {};
    if (p.threadId && this.thread && p.threadId !== this.thread) return;
    const turnId = p.turnId || p.turn?.id;
    if (
      turnId &&
      this.turn &&
      turnId !== this.turn &&
      m.method !== "turn/started"
    )
      return;
    if (
      m.method === "item/commandExecution/outputDelta" &&
      typeof m.params?.itemId === "string" &&
      typeof m.params?.delta === "string"
    ) {
      this.emit({
        type: "activity",
        activity: {
          v: 1,
          kind: "output",
          id: m.params.itemId,
          source: {
            transport: "native",
            harness: "codex",
            origin: "codex:structured",
          },
          patch: {
            append: [
              { stream: "combined", text: m.params.delta.slice(-64000) },
            ],
          },
        },
      });
    }
    for (const activity of directUpdates(
      "codex",
      codexActivities(m.method, m.params ?? {}),
    ))
      this.emit({ type: "activity", activity });
    if (m.id !== undefined && m.method) {
      const id = String(m.id);
      if (m.method === "item/tool/requestUserInput") {
        this.requests.set(id, m);
        this.emit({
          type: "request",
          request: {
            id,
            kind: "question",
            title: "Codex needs your input",
            detail: "",
            questions: p.questions.map((q: any) => ({
              id: q.id,
              title: q.question,
              options: q.options?.map((o: any) => o.label),
              secret: q.isSecret,
            })),
          },
        });
      } else if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
          "mcpServer/elicitation/request",
        ].includes(m.method)
      ) {
        const toolApproval =
          m.method === "mcpServer/elicitation/request"
            ? codexToolApproval(p)
            : undefined;
        const completionUrl =
          m.method === "mcpServer/elicitation/request"
            ? elicitationUrl(p)
            : undefined;
        const choices =
          m.method === "item/permissions/requestApproval"
            ? ["allow", "deny"]
            : m.method === "mcpServer/elicitation/request"
              ? [
                  ...(toolApproval || completionUrl ? ["accept"] : []),
                  "decline",
                  "cancel",
                ]
              : (
                  p.availableDecisions ?? ["accept", "decline", "cancel"]
                ).filter(
                  (d: unknown) =>
                    typeof d === "string" &&
                    ["accept", "decline", "cancel"].includes(d),
                );
        this.requests.set(id, m);
        this.emit({
          type: "request",
          request: {
            id,
            kind: "approval",
            title:
              m.method === "mcpServer/elicitation/request"
                ? toolApproval
                  ? `Allow ${toolApproval.tool || "tool call"}?`
                  : completionUrl
                    ? "Complete MCP request in your browser"
                    : "MCP elicitation (form completion unavailable)"
                : "Codex permission",
            // Workspace events are strict: omit the key unless it has a value.
            ...(completionUrl && { completionUrl }),
            detail: completionUrl
              ? `${typeof p.message === "string" ? p.message : "Open the link to complete this request."}\nAfter completing the browser flow, select Completed.`
              : toolApproval
                ? codexApprovalDetail(p)
                : JSON.stringify(p, null, 2),
            choices,
            allow:
              m.method === "mcpServer/elicitation/request" && !toolApproval
                ? undefined
                : choices.find((c: string) => ["accept", "allow"].includes(c)),
          },
        });
      } else
        void this.native
          .write({
            id: m.id,
            error: {
              code: -32601,
              message: "Unsupported Loop client request",
            },
          })
          .catch(() => {});
      return;
    }
    if (m.method === "turn/started") {
      this.turnRevision++;
      if (this.turn !== p.turn.id) this.tokenBaseline = this.tokenTotal;
      this.turn = p.turn.id;
      this.emit({ type: "status", status: "running" });
    }
    if (
      m.method === "thread/tokenUsage/updated" &&
      this.turn &&
      p.turnId === this.turn
    ) {
      const total = codexTokens(p.tokenUsage?.total);
      const last = codexTokens(p.tokenUsage?.last);
      if (!total) return;
      // A resumed thread already has usage. Establish its pre-turn baseline
      // from the first new increment, then use cumulative snapshots so
      // repeated notifications and multiple model calls cannot double count.
      if (!this.tokenBaseline) {
        if (!last) return;
        this.tokenBaseline = {
          input_tokens: Math.max(0, total.input_tokens - last.input_tokens),
          output_tokens: Math.max(0, total.output_tokens - last.output_tokens),
        };
      }
      if (
        this.tokenTotal &&
        (total.input_tokens < this.tokenTotal.input_tokens ||
          total.output_tokens < this.tokenTotal.output_tokens)
      )
        return;
      this.tokenTotal = total;
      this.emit({
        type: "usage",
        usage: {
          input_tokens: Math.max(
            0,
            total.input_tokens - this.tokenBaseline.input_tokens,
          ),
          output_tokens: Math.max(
            0,
            total.output_tokens - this.tokenBaseline.output_tokens,
          ),
        },
      });
    }
    if (m.method === "turn/completed") {
      this.turnRevision++;
      this.turn = "";
      for (const id of this.requests.keys())
        this.emit({ type: "resolved", id });
      this.requests.clear();
      // Codex may finish its independent work while an async question is
      // unanswered. Keep Loop's decision live; an answer starts the next
      // native turn in this same run and generation.
      if (p.turn.status === "completed" && this.asyncQuestions.size) {
        this.emit({ type: "status", status: "awaiting-input" });
        return;
      }
      this.clearAsyncQuestions();
      this.emit({
        type: "status",
        status:
          p.turn.status === "interrupted"
            ? "interrupted"
            : p.turn.status === "failed"
              ? "failed"
              : "completed",
        recoverable: p.turn.status === "failed",
        detail: p.turn.error?.message,
      });
    }
    if (m.method === "item/agentMessage/delta")
      this.emit({ type: "delta", id: p.itemId, text: p.delta });
    if (m.method === "item/started" || m.method === "item/completed")
      this.item(p.item, m.method === "item/completed");
    if (m.method === "serverRequest/resolved") {
      this.requests.delete(String(p.requestId));
      this.emit({ type: "resolved", id: String(p.requestId) });
    }
    if (m.method === "error" && !p.willRetry)
      this.emit({ type: "error", message: p.error?.message ?? "Codex error" });
  }
  async dispose() {
    this.controlState?.stop();
    await this.native?.dispose();
  }
}
