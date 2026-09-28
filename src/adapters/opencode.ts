import { directActivityEmitter } from "./direct-activities.js";
import { DirectControls } from "./direct-controls.js";
import type { Setting, SettingValue } from "../agent-activities.js";
import { openCodeActivities, directUpdates } from "./direct-activities.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { secret } from "../state.js";
import { killOwned, own } from "../processes.js";
import {
  capabilities,
  type Adapter,
  type NativeCommand,
  type Emit,
  type Options,
} from "./types.js";
import type { Billing } from "../protocol.js";

/** Native HTTP/SSE stays on loopback; only normalized Loop WebSockets reach the phone. */
export class OpenCode implements Adapter {
  private controlState?: DirectControls;
  private get displayControls() {
    return (this.controlState ||= new DirectControls("opencode", this.emit));
  }
  get settings() {
    return this.displayControls.settings;
  }
  get commandCatalog() {
    if (this.origin && this.session) {
      this.displayControls.refresh(
        async () => {
          const result = await this.api("/command");
          return (Array.isArray(result) ? result : []).map((c: any) => ({
            name: c.name,
            token: "/" + c.name,
            kind: "command",
            description: c.description || "",
          }));
        },
        (commands) => {
          this.commands = commands;
        },
      );
    }
    return this.displayControls.commands;
  }
  get activityCapabilities() {
    return this.displayControls.capabilities;
  }

  capabilities = { ...capabilities };
  models: { id: string; name: string }[] = [];
  commands: NativeCommand[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private origin = "";
  private password = secret();
  private session = "";
  private abort = new AbortController();
  private stream?: Promise<void>;
  private requests = new Map<string, any>();
  private parts = new Map<string, any>();
  private roles = new Map<string, string>();
  private interrupted = false;
  private failed = false;
  private recovering = false;
  private reconcileOnly = false;
  private refresh?: NodeJS.Timeout;
  private refreshing = false;
  private refreshAgain = false;
  private loadedHistory = false;
  private activeTurn = false;
  private previousMessages = new Set<string>();
  private finalRefresh = false;
  constructor(
    private options: Options,
    private emit: Emit,
  ) {
    this.emit = directActivityEmitter(emit);
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
  async setSetting(id: string, value: SettingValue, revision: number) {
    return this.displayControls.change(id, value, revision, async () => {
      if (typeof value !== "string" || !["model", "effort"].includes(id))
        throw new Error("Invalid session setting.");
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
    // The server's provider metadata does not expose an authoritative effective billing mode.
    // OAuth alone is not sufficient. Keep the native configuration only with explicit consent.
    if (this.options.billing === "subscription")
      throw new Error(
        "OpenCode does not expose a verified effective subscription mode through this server interface. Check your provider in opencode, then explicitly use --billing existing to retain it. Loop never substitutes an API provider.",
      );
    const environmentConfig = this.options.workspaceTools
      ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")
      : undefined;
    this.child = spawn(
      this.options.executable,
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: this.options.project,
        env: {
          ...process.env,
          ...(this.options.workspaceTools
            ? {
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                  ...environmentConfig,
                  mcp: {
                    ...environmentConfig.mcp,
                    loop_workspace: {
                      type: "remote",
                      url: this.options.workspaceTools.url,
                      headers: {
                        Authorization:
                          "Bearer " + this.options.workspaceTools.token,
                      },
                    },
                  },
                }),
              }
            : {}),
          OPENCODE_SERVER_USERNAME: "loop",
          OPENCODE_SERVER_PASSWORD: this.password,
        },
        stdio: "pipe",
        shell: false,
        detached: true,
      },
    );
    own(this.child);
    this.child.stderr.resume();
    this.origin = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "OpenCode server startup timed out. Run opencode doctor/config diagnostics.",
            ),
          ),
        45000,
      );
      this.child!.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.child!.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("OpenCode server exited during startup."));
        if (!this.abort.signal.aborted)
          this.emit({
            type: "status",
            status: "failed",
            detail: "OpenCode server exited.",
          });
      });
      this.child!.stdout.on("data", (b) => {
        buffer = (buffer + b.toString()).slice(-16000);
        const match = buffer.match(
          /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const config = await this.api("/config");
    const catalog = await this.api("/command").catch(() => []);
    this.commands = (Array.isArray(catalog) ? catalog : []).map((c: any) => ({
      name: c.name,
      token: "/" + c.name,
      kind: "command",
      description: c.description || "",
    }));
    const providers = await this.api("/provider").catch(() => ({
      all: [],
      connected: [],
    }));
    this.models = (providers.all || [])
      .filter((p: any) => providers.connected?.includes(p.id))
      .flatMap((p: any) =>
        Object.entries(p.models || {}).map(([id, m]: [string, any]) => ({
          id: p.id + "/" + id,
          name: m.name || id,
          ...(m.variants
            ? {
                effortLevels: Object.keys(m.variants).map((value) => ({
                  value,
                })),
              }
            : {}),
        })),
      );

    if (this.options.probeOnly)
      return {
        mode: "existing",
        description:
          "Existing OpenCode provider/authentication; may use API credits",
        model: config.model,
      };
    const session = this.options.resume
      ? await this.api("/session/" + encodeURIComponent(this.options.resume))
      : await this.api("/session", {});
    this.session = session.id;
    const billing: Billing = {
      mode: "existing",
      description:
        "Existing OpenCode provider/authentication; billing is provider-specific and may use API credits",
      model: config.model ?? "Native default (resolved by OpenCode)",
    };
    this.displayControls.publish(
      this.sessionOptions(config.model),
      this.commands,
    );
    this.emit({ type: "metadata", nativeSession: this.session, billing });
    let ready!: () => void;
    let rejectReady!: (e: Error) => void;
    const listening = new Promise<void>((resolve, reject) => {
      ready = resolve;
      rejectReady = reject;
    });
    this.stream = this.events(ready, rejectReady);
    await listening;
    return billing;
  }
  private url(path: string) {
    const url = new URL(path, this.origin);
    url.searchParams.set("directory", this.options.project);
    return url;
  }
  private headers() {
    return {
      authorization:
        "Basic " + Buffer.from("loop:" + this.password).toString("base64"),
      "content-type": "application/json",
    };
  }
  private async api(path: string, data?: unknown, timeout = 30000) {
    const res = await fetch(this.url(path), {
      method: data === undefined ? "GET" : "POST",
      headers: this.headers(),
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(timeout),
      ]),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(
        `OpenCode ${path.split("?")[0]} returned ${res.status}. Inspect native configuration/session.`,
      );
    }
    if (res.status === 204) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body)
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024)
          throw new Error("OpenCode response exceeds display limit");
        chunks.push(chunk);
      }
    const text = Buffer.concat(chunks).toString();
    return text ? JSON.parse(text) : undefined;
  }
  async prompt(text: string) {
    if (this.recovering)
      throw new Error(
        "OpenCode event stream is recovering. Wait before sending.",
      );
    // Snapshot the boundary without projecting previous answers into the new run.
    const previous = await this.api(
      `/session/${this.session}/message?limit=100`,
    );
    this.previousMessages = new Set(previous.map((m: any) => m.info.id));
    this.activeTurn = true;
    this.interrupted = false;
    this.failed = false;
    const command = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (command && this.commands.some((c) => c.name === command[1])) {
      await this.api(
        `/session/${this.session}/command`,
        {
          command: command[1],
          arguments: command[2] || "",
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.effort ? { variant: this.options.effort } : {}),
        },
        1800000,
      );
      this.displayControls.confirmNextTurn();
      return;
    }
    await this.api(`/session/${this.session}/prompt_async`, {
      parts: [{ type: "text", text }],
      ...(this.options.effort ? { variant: this.options.effort } : {}),
      ...(this.options.model && this.options.model.includes("/")
        ? {
            model: {
              providerID: this.options.model.split("/")[0],
              modelID: this.options.model.split("/").slice(1).join("/"),
            },
          }
        : {}),
      ...(this.options.instructions
        ? { system: this.options.instructions }
        : {}),
    });
    this.displayControls.confirmNextTurn();
  }
  async cancel() {
    this.interrupted = true;
    await this.api(`/session/${this.session}/abort`, {});
  }
  async answer(id: string, answer: Record<string, unknown>) {
    const r = this.requests.get(id);
    if (!r) throw new Error("OpenCode request expired.");
    this.requests.delete(id);
    if (r.type === "permission.asked")
      await this.api(
        r.v2
          ? `/api/session/${this.session}/permission/${encodeURIComponent(id)}/reply`
          : `/permission/${encodeURIComponent(id)}/reply`,
        { reply: answer.choice },
      );
    else
      await this.api(
        r.v2
          ? `/api/session/${this.session}/question/${encodeURIComponent(id)}/reply`
          : `/question/${encodeURIComponent(id)}/reply`,
        {
          answers: r.properties.questions.map(
            (_q: any, i: number) => answer[String(i)],
          ),
        },
      );
    this.emit({ type: "resolved", id });
  }
  private part(p: any) {
    if (
      (!this.activeTurn && this.loadedHistory) ||
      p.sessionID !== this.session ||
      this.previousMessages.has(p.messageID)
    )
      return;
    if (this.activeTurn)
      for (const activity of directUpdates(
        "opencode",
        openCodeActivities("message.part.updated", { part: p }),
      ))
        this.emit({ type: "activity", activity });
    this.parts.set(p.id, p);
    if (this.parts.size > 500)
      this.parts.delete(this.parts.keys().next().value!);
    if (p.type === "text" && this.roles.get(p.messageID) === "assistant")
      this.emit({
        type: "item",
        item: { id: p.id, kind: "assistant", text: p.text ?? "" },
      });
    if (p.type === "tool")
      this.emit({
        type: "item",
        item: {
          id: p.id,
          kind: "tool",
          title: p.tool,
          status: p.state.status,
          text: JSON.stringify(p.state, null, 2),
        },
      });
  }
  private event(m: any) {
    if (m.type?.includes(".v2."))
      m = { ...m, type: m.type.replace(".v2.", "."), v2: true };
    const p = m.properties ?? {};
    if (p.sessionID && p.sessionID !== this.session) return;
    if (m.type === "todo.updated" && this.activeTurn)
      for (const activity of directUpdates(
        "opencode",
        openCodeActivities(m.type, p),
      ))
        this.emit({ type: "activity", activity });
    if (m.type === "message.updated" && p.info.sessionID === this.session) {
      this.roles.set(p.info.id, p.info.role);
      if (this.roles.size > 500)
        this.roles.delete(this.roles.keys().next().value!);
      for (const part of this.parts.values())
        if (part.messageID === p.info.id) this.part(part);
    }
    if (m.type === "message.part.updated") this.part(p.part);
    if (m.type === "message.part.delta" && p.field === "text") {
      // Native SSE has no replay cursor. After a gap, replace complete parts
      // instead of appending possibly overlapping deltas for this turn.
      if (this.reconcileOnly) {
        this.scheduleHistory();
        return;
      }
      if (!this.activeTurn || this.previousMessages.has(p.messageID)) return;
      const part = this.parts.get(p.partID);
      if (part?.type === "text") {
        part.text = ((part.text ?? "") + p.delta).slice(-64000);
        if (this.roles.get(p.messageID) === "assistant")
          this.emit({ type: "delta", id: p.partID, text: p.delta });
      }
    }
    if (m.type === "session.status") {
      if (p.status.type === "idle") {
        // Recover final full parts before settling the worker's current run.
        if (this.reconcileOnly) this.scheduleHistory(true);
        else this.idle();
      } else this.emit({ type: "status", status: "running" });
    }
    if (m.type === "session.error") {
      this.failed = true;
      this.emit({
        type: "status",
        status: "failed",
        recoverable: true,
        detail: p.error?.data?.message ?? "OpenCode session failed",
      });
    }
    if (m.type === "permission.asked") {
      this.requests.set(p.id, m);
      this.emit({
        type: "request",
        request: {
          id: p.id,
          kind: "approval",
          title: p.permission ?? p.action,
          detail: JSON.stringify(
            { patterns: p.patterns ?? p.resources, metadata: p.metadata },
            null,
            2,
          ),
          choices: ["once", "reject"],
        },
      });
    }
    if (m.type === "question.asked") {
      this.requests.set(p.id, m);
      this.emit({
        type: "request",
        request: {
          id: p.id,
          kind: "question",
          title: "OpenCode needs your input",
          detail: "",
          questions: p.questions.map((q: any, i: number) => ({
            id: String(i),
            title: q.question,
            options: q.options?.map((o: any) => o.label),
            multiple: q.multiple,
          })),
        },
      });
    }
    if (
      ["permission.replied", "question.replied", "question.rejected"].includes(
        m.type,
      )
    ) {
      this.requests.delete(p.requestID);
      this.emit({ type: "resolved", id: p.requestID });
    }
  }
  private idle() {
    const status = this.activeTurn
      ? this.interrupted
        ? "interrupted"
        : this.failed
          ? "failed"
          : "completed"
      : "ready";
    this.activeTurn = false;
    this.reconcileOnly = false;
    this.emit({ type: "status", status, recoverable: status === "failed" });
  }
  private async history() {
    const history = await this.api(
      `/session/${this.session}/message?limit=100`,
    );
    for (const m of history) {
      if (this.previousMessages.has(m.info.id)) continue;
      if (this.activeTurn && m.info.role === "assistant" && m.info.error) {
        if (m.info.error.name === "MessageAbortedError")
          this.interrupted = true;
        else this.failed = true;
      }
      if (!this.loadedHistory && m.info.role === "user")
        this.emit({
          type: "item",
          item: {
            id: m.info.id,
            kind: "user",
            text: m.parts
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n"),
          },
        });
      this.roles.set(m.info.id, m.info.role);
      for (const part of m.parts) this.part(part);
    }
    this.loadedHistory = true;
  }
  private scheduleHistory(final = false, attempt = 0) {
    this.finalRefresh ||= final;
    this.refreshAgain = true;
    if (this.refresh || this.refreshing) return;
    this.refresh = setTimeout(
      async () => {
        this.refresh = undefined;
        this.refreshing = true;
        this.refreshAgain = false;
        const final = this.finalRefresh;
        let retry = 0;
        try {
          if (final) {
            this.finalRefresh = false;
            await this.reconcile();
          } else await this.history();
        } catch {
          if (!this.abort.signal.aborted) {
            this.emit({
              type: "error",
              message: "Could not recover native history.",
            });
            if (final && this.activeTurn) {
              if (attempt < 3) {
                // Idle may be the last SSE event. Retain the final refresh until
                // it succeeds or explicitly release the worker after exhaustion.
                this.finalRefresh = true;
                this.refreshAgain = true;
                retry = attempt + 1;
              } else {
                this.finalRefresh = false;
                this.refreshAgain = false;
                this.failed = true;
                this.idle();
              }
            }
          }
        } finally {
          this.refreshing = false;
          if (this.refreshAgain && !this.abort.signal.aborted)
            this.scheduleHistory(false, retry);
        }
      },
      100 * 2 ** attempt,
    );
  }
  private async reconcile() {
    const permissions = await this.api("/permission");
    const questions = await this.api("/question");
    const v2Permissions = await this.api(
      `/api/session/${this.session}/permission`,
    );
    const v2Questions = await this.api(`/api/session/${this.session}/question`);
    for (const id of this.requests.keys()) this.emit({ type: "resolved", id });
    this.requests.clear();
    const statuses = await this.api("/session/status");
    // Fetch history after status, so an idle result includes its final output.
    await this.history();
    if (["busy", "retry"].includes(statuses[this.session]?.type))
      this.emit({ type: "status", status: "running" });
    else this.idle();
    for (const p of permissions)
      if (p.sessionID === this.session)
        this.event({ type: "permission.asked", properties: p });
    for (const q of questions)
      if (q.sessionID === this.session)
        this.event({ type: "question.asked", properties: q });
    for (const p of Array.isArray(v2Permissions) ? v2Permissions : [])
      this.event({ type: "permission.v2.asked", properties: p });
    for (const q of Array.isArray(v2Questions) ? v2Questions : [])
      this.event({ type: "question.v2.asked", properties: q });
  }
  private async events(ready: () => void, reject: (e: Error) => void) {
    let connected = false;
    while (!this.abort.signal.aborted) {
      try {
        this.recovering = true;
        const res = await fetch(this.url("/event"), {
          headers: this.headers(),
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error("OpenCode SSE unavailable");
        // Reader buffers events during history fetch; reconcile again after transport gaps.
        const reader = res.body.getReader();
        await this.reconcile();
        this.recovering = false;
        ready();
        connected = true;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) throw new Error("OpenCode event stream closed");
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(
            /\r\n/g,
            "\n",
          );
          if (buffer.length > 8 * 1024 * 1024)
            throw new Error("OpenCode event frame too large");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) this.event(JSON.parse(data));
          }
        }
      } catch (e) {
        if (this.abort.signal.aborted) return;
        if (!connected) {
          reject(e as Error);
          return;
        }
        this.recovering = true;
        this.reconcileOnly = true;
        this.emit({
          type: "error",
          message:
            "OpenCode event connection lost; recovering native history. Do not repeat pending actions.",
        });
        await new Promise<void>((r) => {
          const t = setTimeout(r, 1000);
          this.abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              r();
            },
            { once: true },
          );
        });
      }
    }
  }
  async dispose() {
    this.controlState?.stop();
    clearTimeout(this.refresh);
    this.abort.abort();
    if (this.child) killOwned(this.child, "SIGTERM");
    await this.stream;
    if (this.child?.exitCode === null) killOwned(this.child, "SIGKILL");
  }
}
