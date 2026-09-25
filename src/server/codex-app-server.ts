import { WebSocket, type Dispatcher } from "undici";
import { Problem } from "./domain.js";
import type { ChatInput, Chunk } from "./providers.js";
import { nativeReply } from "../../runtime/native-tools.mjs";
import { codexCatalog, codexTurn } from "../../runtime/harness.mjs";
import { resultChunks } from "../../runtime/protocol.mjs";

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
    }
  >();
  private events: Message[] = [];
  private waiter?: {
    resolve: (event: Message) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;
  private constructor(private socket: WebSocket) {
    socket.addEventListener("error", () => this.fail(unavailable()));
    socket.addEventListener("close", () => this.fail(unavailable()));
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
          message.error
            ? pending.reject(unavailable())
            : pending.resolve(message.result);
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
    const rpc = new CodexRpc(socket);
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
        reject(unavailable());
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
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
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(1800000)]);
  const rpc = await CodexRpc.connect(endpoint, signal);
  let threadId: string | undefined,
    turnId: string | undefined,
    completed = false;
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
    let answer = "";
    for (;;) {
      const message = await rpc.event(signal),
        params = message.params;
      if (message.id != null) {
        rpc.send({ id: message.id, ...nativeReply(message, threadId) });
        continue;
      }
      if (params?.threadId !== threadId) continue;
      if (params.turnId && params.turnId !== turnId) continue;
      const trace = codexTrace(message);
      if (trace) yield { trace };
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
            "Remote Codex stopped. Check sign-in, model access and subscription allowance. No API fallback was used.",
          );
        yield* review
          ? [{ text: answer }]
          : resultChunks(JSON.parse(answer), input);
        yield { externalId: threadId };
        return;
      }
    }
  } finally {
    if (threadId && turnId && !completed)
      await rpc
        .call("turn/interrupt", { threadId, turnId }, 5000)
        .catch(() => {});
    if (threadId)
      await rpc.call("thread/unsubscribe", { threadId }, 5000).catch(() => {});
    rpc.close();
  }
}
import { codexTrace } from "../../runtime/traces.mjs";
