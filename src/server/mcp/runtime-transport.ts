import { companionMode } from "../profile.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { runtimeEndpoint } from "../runtime-hosts.js";
import { Problem } from "../domain.js";
class RemoteRuntimeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private controller = new AbortController();
  private session = crypto.randomUUID();
  private endpoint;
  constructor(
    owner: string,
    private config: {
      command: string;
      args: string[];
      env: Record<string, string>;
    },
    hostId?: string,
  ) {
    this.endpoint = runtimeEndpoint(owner, hostId);
  }
  private async request(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const r = await this.endpoint.fetch(this.endpoint.url + path, {
      method,
      headers: {
        authorization: "Bearer " + this.endpoint.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!r.ok)
      throw new Problem(
        422,
        "The MCP runtime is unavailable. Check the machine and container image.",
      );
    return r;
  }
  async start() {
    const r = await this.request(
      "/mcp",
      "POST",
      { session: this.session, ...this.config },
      this.controller.signal,
    );
    if (!r.body) throw new Problem(422, "MCP runtime returned no stream");
    const reader = r.body.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 4_000_000)
            throw new Error("MCP record exceeds limit");
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            const value = JSON.parse(line);
            if (value.ready) continue;
            if (value.error && !value.jsonrpc)
              throw new Error(
                "MCP process stopped. Check the server configuration.",
              );
            this.onmessage?.(JSONRPCMessageSchema.parse(value));
          }
        }
      } catch (error) {
        if (!this.controller.signal.aborted) this.onerror?.(error as Error);
      } finally {
        reader.releaseLock();
        this.onclose?.();
      }
    })();
  }
  async send(message: JSONRPCMessage) {
    await this.request(
      "/mcp/" + this.session,
      "POST",
      message,
      AbortSignal.timeout(10000),
    );
  }
  async close() {
    this.controller.abort();
    await this.request(
      "/mcp/" + this.session,
      "DELETE",
      undefined,
      AbortSignal.timeout(5000),
    ).catch(() => {});
  }
}

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The SDK owns this child. No shell, container or public runtime listener. */
class LocalRuntimeTransport extends StdioClientTransport {
  constructor(
    owner: string,
    config: { command: string; args: string[]; env: Record<string, string> },
    hostId?: string,
  ) {
    runtimeEndpoint(owner, hostId);
    super({ ...config, stderr: "pipe" });
  }
  override async start() {
    await super.start();
    // Drain sensitive diagnostic output without persisting it.
    this.stderr?.on("data", () => {});
  }
}

export const RuntimeTransport = companionMode
  ? LocalRuntimeTransport
  : RemoteRuntimeTransport;
