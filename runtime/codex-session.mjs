import { Rpc, authorizationUrl, resultChunks } from "./protocol.mjs";
import { nativeReply } from "./native-tools.mjs";
import { codexCatalog, codexTurn } from "./harness.mjs";
import { codexTrace, codexActivity } from "./traces.mjs";
import { modelOptions } from "./model-options.mjs";
import { RuntimeFailure, diagnosticText } from "./diagnostics.mjs";
import { managedWorkspace, githubEnvironment } from "./workspace.mjs";
import { redactValues } from "./redaction.mjs";

// A mailbox belongs to one thread. Never let another consumer drain its events.
class Mailbox {
  events = [];
  waiter;
  error;
  push(event) {
    if (this.error) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(event);
    } else if (this.events.length < 5000) this.events.push(event);
    else this.fail(new RuntimeFailure("Too many runtime events"));
  }
  next(signal) {
    signal.throwIfAborted();
    if (this.error) return Promise.reject(this.error);
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  fail(error) {
    this.error = error;
    this.events = [];
    this.waiter?.reject(error);
    this.waiter = undefined;
  }
}

// One official process per saved connection. Threads, credentials and controls
// are scoped to the operation; process-wide environment/config never mutates.
export class CodexSession {
  threads = new Map();
  login;
  constructor(child, { hostMode, home, cwd }) {
    Object.assign(this, { hostMode, home, cwd });
    this.rpc = new Rpc(
      child,
      (message) => {
        const threadId = message.params?.threadId;
        const thread = this.threads.get(threadId);
        return nativeReply(
          message,
          thread &&
            !thread.signal.aborted &&
            (!message.params?.turnId ||
              !thread.turnId ||
              message.params.turnId === thread.turnId)
            ? threadId
            : undefined,
        );
      },
      (message) => {
        const thread = this.threads.get(message.params?.threadId);
        if (thread) {
          if (message.method === "turn/started")
            thread.turnId ||= message.params.turn?.id;
          thread.mailbox.push(message);
        } else if (message.method === "account/login/completed")
          this.login?.push(message);
      },
      (error) => {
        for (const thread of this.threads.values()) thread.mailbox.fail(error);
        this.login?.fail(error);
        // A broken framing/transport connection cannot serve later turns.
        child.kill("SIGTERM");
      },
    );
    this.ready = this.rpc
      .call("initialize", {
        clientInfo: { name: "loop", version: "0.2.0" },
      })
      .then(() => this.rpc.send({ method: "initialized", params: {} }));
    // Startup can fail before the first command arrives.
    this.ready.catch(() => {});
  }
  async run(request, emit, signal, setSteering) {
    await this.ready;
    signal.throwIfAborted();
    const rpc = this.rpc;
    const cwd = this.hostMode
      ? this.cwd
      : managedWorkspace(
          this.home,
          request.input?.workspaceKey ?? request.workspaceKey,
        );
    if (request.action === "capabilities") {
      emit({
        result: codexCatalog(
          await rpc.call("skills/list", { cwds: [cwd], forceReload: true }),
        ),
      });
      return;
    }
    if (request.action === "login") {
      const mailbox = new Mailbox();
      this.login = mailbox;
      let loginId;
      const abort = () => mailbox.fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const login = await rpc.call("account/login/start", {
          type: "chatgptDeviceCode",
        });
        loginId = login.loginId;
        signal.throwIfAborted();
        const url = authorizationUrl(login.verificationUrl || "", "codex");
        if (!url || typeof login.userCode !== "string")
          throw new RuntimeFailure("Device sign-in unavailable");
        emit({ login: { url, code: login.userCode, acceptsCode: false } });
        let completed;
        do {
          completed = await mailbox.next(signal);
        } while (
          loginId &&
          completed.params?.loginId &&
          completed.params.loginId !== loginId
        );
        if (!completed.params?.success)
          throw new RuntimeFailure("Sign-in was not completed");
      } finally {
        signal.removeEventListener("abort", abort);
        this.login = undefined;
        if (signal.aborted && loginId)
          await rpc.call("account/login/cancel", { loginId }).catch(() => {});
      }
    }
    if (request.action === "logout") {
      await rpc.call("account/logout");
      emit({ result: { authenticated: false } });
      return;
    }
    const { account } = await rpc.call("account/read", { refreshToken: true });
    signal.throwIfAborted();
    if (account?.type !== "chatgpt") {
      if (request.action === "turn")
        throw new RuntimeFailure("Subscription sign-in required");
      emit({ result: { authenticated: false, models: [] } });
      return;
    }
    if (request.action !== "turn") {
      let cursor;
      const models = [];
      do {
        const page = await rpc.call("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        models.push(
          ...page.data.map((m) => ({
            id: m.model || m.id,
            name: m.displayName || m.id,
            capabilities: "ChatGPT subscription · account catalog",
            ...modelOptions(m),
          })),
        );
        cursor = page.nextCursor;
      } while (cursor && models.length < 300);
      const limits = await rpc
        .call("account/rateLimits/read")
        .catch(() => null);
      emit({
        result: {
          authenticated: true,
          authMode: "subscription",
          plan: account.planType,
          models,
          limits,
        },
      });
      return;
    }
    const secret =
      !this.hostMode && request.githubToken !== undefined
        ? request.githubToken
        : undefined;
    const shellEnv = secret === undefined ? {} : githubEnvironment(secret);
    const clean = (data) => redactValues(data, secret ? [secret] : []);
    const output = (event) => emit(clean(event));
    const input = { ...request.input };
    if (!this.hostMode)
      input.instructions =
        (input.instructions || "") +
        `\nCurrent runtime: native shell, file editing and network tools are enabled. Your writable workspace is ${cwd}; files here persist across messages and runs. Use it for repository checkouts, edits and tests.` +
        (secret
          ? " Git and gh are authenticated with the workspace's connected GitHub account. Use them for the user's authorized repository work; never print or store authentication tokens."
          : "");
    let threadId,
      turnId,
      completed = false;
    const mailbox = new Mailbox();
    const abort = () => mailbox.fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const started = await rpc.call("thread/start", {
        model: input.model,
        modelProvider: "openai",
        cwd,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        ephemeral: true,
        config: {
          forced_login_method: "chatgpt",
          ...(!this.hostMode
            ? {
                "shell_environment_policy.inherit": "all",
                "shell_environment_policy.ignore_default_excludes": true,
                "shell_environment_policy.set": shellEnv,
              }
            : {}),
        },
      });
      threadId = started.thread?.id;
      if (!threadId) throw new RuntimeFailure("Codex did not return a thread");
      if (started.modelProvider && started.modelProvider !== "openai")
        throw new RuntimeFailure("Codex did not use the ChatGPT provider");
      this.threads.set(threadId, { mailbox, signal });
      signal.throwIfAborted();
      const turn = await codexTurn(rpc, threadId, input, true, cwd, signal);
      turnId = turn.turn?.id;
      if (!turnId) throw new RuntimeFailure("Codex did not return a turn");
      this.threads.get(threadId).turnId = turnId;
      signal.throwIfAborted();
      setSteering(async (text) => {
        signal.throwIfAborted();
        await rpc.call("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text }],
        });
      });
      if (input.controlId) output({ steeringReady: true });
      let answer = "";
      const traces = new Map();
      for (;;) {
        const m = await mailbox.next(signal);
        if (m.params?.turnId && m.params.turnId !== turnId) continue;
        if (m.method === "turn/completed" && m.params.turn?.id !== turnId)
          continue;
        const trace = codexTrace(clean(m), traces);
        if (trace) output({ chunk: { trace } });
        const activity = codexActivity(clean(m));
        if (activity) output({ chunk: { activity } });
        if (m.method === "item/agentMessage/delta") answer += m.params.delta;
        if (
          m.method === "item/completed" &&
          m.params.item?.type === "agentMessage"
        )
          answer = m.params.item.text;
        if (
          turn.review &&
          m.method === "item/completed" &&
          m.params.item?.type === "exitedReviewMode"
        )
          answer = m.params.item.review;
        if (answer.length > 200000)
          throw new RuntimeFailure("Runtime output exceeds limit");
        if (m.method !== "turn/completed") continue;
        completed = true;
        if (m.params.turn.status !== "completed")
          throw new RuntimeFailure(
            `Codex turn ${m.params.turn.status || "failed"}: ${diagnosticText(clean(m.params.turn.error?.message)) || "The runtime did not provide a reason."}`,
            { phase: "turn", code: m.params.turn.error?.codexErrorInfo },
          );
        let value;
        if (!turn.review) {
          try {
            value = JSON.parse(answer);
          } catch {
            throw new RuntimeFailure(
              "Codex returned an invalid structured response. Check Traces for saved progress.",
              { phase: "response", code: "invalid_json" },
            );
          }
        }
        for (const chunk of turn.review
          ? [{ text: answer }]
          : resultChunks(value, input))
          output({ chunk });
        output({ chunk: { externalId: threadId } });
        output({ done: true });
        return;
      }
    } finally {
      setSteering(undefined);
      signal.removeEventListener("abort", abort);
      turnId ||= this.threads.get(threadId)?.turnId;
      // A stop or disconnected HTTP stream belongs only to this turn.
      if (threadId && turnId && !completed)
        await rpc.call("turn/interrupt", { threadId, turnId }).catch(() => {});
      if (threadId) {
        this.threads.delete(threadId);
        await rpc.call("thread/unsubscribe", { threadId }).catch(() => {});
      }
    }
  }
}
