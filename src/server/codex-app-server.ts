import { modelOptions } from "../../runtime/model-options.mjs";
import { idleDeadline } from "../../runtime/idle-deadline.mjs";
import { WebSocket, type Dispatcher } from "undici";
import { Problem } from "./domain.js";
import type { ChatInput, Chunk } from "./providers.js";
import { nativeReply } from "../../runtime/native-tools.mjs";
import { codexCatalog, codexTurn } from "../../runtime/harness.mjs";
import { resultChunks } from "../../runtime/protocol.mjs";
import {
  RuntimeFailure,
  diagnosticText,
  errorFacts,
  errorSummary,
  runtimeFailureFacts,
} from "../../runtime/diagnostics.mjs";

export type CodexEndpoint = {
  url: string;
  token: string;
  dispatcher?: Dispatcher;
};
type Message = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: unknown;
};
const unavailable = () =>
  new Problem(
    422,
    "Could not reach Codex app-server. Check its address, access token and version.",
  );

// Each operation owns a WebSocket and its own ephemeral thread. Never adopt,
// interrupt or sign out a session belonging to another app-server client.
class CodexRpc {
  private next = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      method: string;
    }
  >();
  private events: Message[] = [];
  private waiter?: {
    resolve: (event: Message) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;
  private constructor(
    private socket: WebSocket,
    private token: string,
  ) {
    socket.addEventListener("error", ({ error }) =>
      this.fail(
        new Problem(
          502,
          `Remote Codex connection failed (${errorSummary(error, [], false)}). Check Traces for saved progress.`,
          { phase: "connection", ...errorFacts(error) },
        ),
      ),
    );
    socket.addEventListener("close", ({ code }) =>
      this.fail(
        new Problem(
          502,
          `Remote Codex connection closed (WebSocket code ${code}) before the response finished. Check Traces for saved progress.`,
          { phase: "connection", code },
        ),
      ),
    );
    socket.addEventListener("message", ({ data }) => {
      try {
        if (typeof data !== "string" || Buffer.byteLength(data) > 4_000_000)
          throw unavailable();
        const message = JSON.parse(data) as Message;
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw unavailable();
        if (message.id != null && !message.method) {
          const pending = this.pending.get(Number(message.id));
          if (!pending) return;
          this.pending.delete(Number(message.id));
          clearTimeout(pending.timer);
          if (message.error) {
            const error = message.error as {
              message?: unknown;
              code?: unknown;
            };
            pending.reject(
              new Problem(
                422,
                `Remote Codex rejected ${pending.method}: ${diagnosticText(error.message, [this.token]) || "No reason returned."}`,
                runtimeFailureFacts({
                  phase: pending.method,
                  code: error.code,
                }),
              ),
            );
          } else pending.resolve(message.result);
        } else if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter.resolve(message);
        } else {
          if (this.events.length >= 5000) throw unavailable();
          this.events.push(message);
        }
      } catch {
        this.fail(unavailable());
      }
    });
  }
  static async connect(endpoint: CodexEndpoint, signal: AbortSignal) {
    signal.throwIfAborted();
    const socket = new WebSocket(endpoint.url, {
      headers: { authorization: "Bearer " + endpoint.token },
      dispatcher: endpoint.dispatcher,
    });
    const rpc = new CodexRpc(socket, endpoint.token);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", fail);
          socket.removeEventListener("open", open);
          socket.removeEventListener("error", fail);
          socket.removeEventListener("close", fail);
        };
        const open = () => {
          cleanup();
          resolve();
        };
        const fail = () => {
          cleanup();
          reject(unavailable());
        };
        const timer = setTimeout(fail, 10000);
        socket.addEventListener("open", open);
        socket.addEventListener("error", fail);
        socket.addEventListener("close", fail);
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) fail();
      });
      await rpc.call("initialize", {
        clientInfo: { name: "loop", title: "Loop", version: "0.2.0" },
      });
      rpc.send({ method: "initialized", params: {} });
      signal.throwIfAborted();
      return rpc;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }
  send(message: Message) {
    if (this.socket.readyState !== WebSocket.OPEN) throw unavailable();
    this.socket.send(JSON.stringify(message));
  }
  call(method: string, params: object = {}, timeout = 10000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Problem(
            408,
            `Remote Codex ${method} timed out after ${Math.ceil(timeout / 1000)} seconds.`,
            { phase: method, code: "request_timeout" },
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ id, method, params });
      } catch {
        this.fail(unavailable());
      }
    });
  }
  async event(signal: AbortSignal): Promise<Message> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.events.length) return this.events.shift()!;
    let abort: () => void = () => {};
    try {
      return await new Promise((resolve, reject) => {
        this.waiter = { resolve, reject };
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
    } finally {
      signal.removeEventListener("abort", abort);
      this.waiter = undefined;
    }
  }
  private fail(error: Error) {
    this.failure ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.waiter?.reject(error);
    this.waiter = undefined;
    this.events = [];
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
  close() {
    this.fail(unavailable());
  }
}

export async function codexStatus(endpoint: CodexEndpoint) {
  const rpc = await CodexRpc.connect(endpoint, AbortSignal.timeout(15000));
  try {
    const { account } = await rpc.call("account/read", { refreshToken: true });
    if (account?.type !== "chatgpt")
      throw new Problem(
        422,
        "Sign in with ChatGPT using codex login on the remote machine, then try again. API-key sign-in is not used for this connection.",
      );
    let cursor: string | undefined;
    const models: { id: string; name: string; capabilities: string }[] = [];
    do {
      const page = await rpc.call("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data)) throw unavailable();
      models.push(
        ...page.data.map((model: any) => ({
          id: model.model || model.id,
          name: model.displayName || model.id,
          capabilities: "Remote Codex app-server · ChatGPT subscription",
          ...modelOptions(model),
        })),
      );
      cursor = page.nextCursor;
      if (cursor && !page.data.length) throw unavailable();
    } while (cursor && models.length < 300);
    return {
      authenticated: true,
      authMode: "subscription",
      plan: account.planType,
      models: models.slice(0, 300),
    };
  } finally {
    rpc.close();
  }
}

export async function codexCapabilities(endpoint: CodexEndpoint) {
  const rpc = await CodexRpc.connect(endpoint, AbortSignal.timeout(30000));
  try {
    return codexCatalog(await rpc.call("skills/list", { forceReload: true }));
  } finally {
    rpc.close();
  }
}

export async function* codexStream(
  endpoint: CodexEndpoint,
  input: ChatInput,
): AsyncGenerator<Chunk> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const rpc = await CodexRpc.connect(endpoint, signal);
  const idle = idleDeadline((error) =>
    controller.abort(new Problem(408, error.message)),
  );
  let threadId: string | undefined,
    turnId: string | undefined,
    completed = false;
  let stopSteering: (() => Promise<void>) | undefined;
  try {
    const { account } = await rpc.call("account/read", { refreshToken: true });
    if (account?.type !== "chatgpt")
      throw new Problem(
        422,
        "Sign in to ChatGPT on the remote Codex machine before running this agent.",
      );
    // Keep the host's skills, plugins, features, MCPs and working directory.
    // Managed runtime requirements still decide whether full access is allowed.
    signal.throwIfAborted();
    const started = await rpc.call("thread/start", {
      model: input.model,
      modelProvider: "openai",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      ephemeral: true,
      config: { forced_login_method: "chatgpt" },
    });
    threadId = started.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw unavailable();
    if (started.modelProvider !== "openai")
      throw new Problem(
        422,
        "This app-server did not use the ChatGPT provider. Check the remote Codex configuration.",
      );
    signal.throwIfAborted();
    const { turn, review } = await codexTurn(rpc, threadId, input, true);
    turnId = turn.id;
    if (typeof turnId !== "string" || !turnId) throw unavailable();
    stopSteering = input.steering?.listen(async (message) => {
      await rpc.call("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: message.content }],
      });
    });
    idle.progress();
    let answer = "";
    const traceMessages = new Map();
    for (;;) {
      const message = await rpc.event(signal),
        params = message.params;
      if (message.id != null) {
        rpc.send({ id: message.id, ...nativeReply(message, threadId) });
        continue;
      }
      if (params?.threadId !== threadId) continue;
      if (params.turnId && params.turnId !== turnId) continue;
      const trace = codexTrace(message, traceMessages);
      if (trace) {
        idle.progress();
        yield { trace };
      }
      const activity = codexActivity(message);
      if (activity) yield { activity };
      if (message.method === "item/agentMessage/delta") answer += params.delta;
      if (
        message.method === "item/completed" &&
        params.item?.type === "agentMessage"
      )
        answer = params.item.text;
      if (
        review &&
        message.method === "item/completed" &&
        params.item?.type === "exitedReviewMode"
      )
        answer = params.item.review;
      if (typeof answer !== "string" || answer.length > 200000)
        throw unavailable();
      if (message.method === "turn/completed" && params.turn?.id === turnId) {
        completed = true;
        if (params.turn.status !== "completed")
          throw new Problem(
            422,
            `Remote Codex turn ${diagnosticText(params.turn.status, [endpoint.token]) || "failed"}: ${diagnosticText(params.turn.error?.message, [endpoint.token]) || "The runtime did not provide a reason."}`,
            runtimeFailureFacts({
              phase: "turn",
              code: params.turn.error?.codexErrorInfo,
            }),
          );
        let output;
        if (!review) {
          try {
            output = JSON.parse(answer);
          } catch {
            throw new Problem(
              422,
              "Remote Codex returned an invalid structured response. Check Traces for saved progress.",
              { phase: "response", code: "invalid_json" },
            );
          }
        }
        yield* review ? [{ text: answer }] : resultChunks(output, input);
        yield { externalId: threadId };
        return;
      }
    }
  } catch (error) {
    if (error instanceof RuntimeFailure)
      throw new Problem(
        422,
        `Remote Codex: ${diagnosticText(error.message, [endpoint.token])}`,
        runtimeFailureFacts(error.details),
      );
    throw error;
  } finally {
    idle.clear();
    await stopSteering?.();
    if (threadId && turnId && !completed)
      await rpc
        .call("turn/interrupt", { threadId, turnId }, 5000)
        .catch(() => {});
    if (threadId)
      await rpc.call("thread/unsubscribe", { threadId }, 5000).catch(() => {});
    rpc.close();
  }
}
import { codexActivity, codexTrace } from "../../runtime/traces.mjs";
