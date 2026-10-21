import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  randomUUID,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { nativeSessions } from "./native-sessions.js";
import { nativeBindings, invokeNative } from "./native-tools.js";
import { toolBindings, invokeTool, type ToolBinding } from "./mcp/broker.js";
import { db } from "./db.js";
import type { Run } from "./queue.js";

type Ticket = {
  conversation: string;
  generation: string;
  token: string;
  bindings: Map<string, ToolBinding>;
  calls: Map<string, { digest: string; result: Promise<any> }>;
  server?: Server;
  transport?: StreamableHTTPServerTransport;
};
/** Private per-generation MCP endpoint. Never mounted behind the phone tunnel. */
export class NativeToolBridge {
  private tickets = new Map<string, Ticket>();
  private http = createServer((req, res) => {
    void this.handle(req, res);
  });
  private port = 0;
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    this.port = (this.http.address() as { port: number }).port;
  }
  issue(conversation: string, generation: string) {
    const key = randomUUID(),
      token = randomBytes(32).toString("hex");
    this.tickets.set(key, {
      conversation,
      generation,
      token,
      bindings: new Map(),
      calls: new Map(),
    });
    return { url: `http://127.0.0.1:${this.port}/${key}`, token };
  }
  async revoke(conversation: string, generation: string) {
    for (const [key, t] of this.tickets)
      if (t.conversation === conversation && t.generation === generation) {
        this.tickets.delete(key);
        await t.server?.close().catch(() => {});
      }
  }
  private list(t: Ticket) {
    const live = nativeSessions.current(t.conversation, t.generation, false);
    const run = live.run || live.bootstrapRun;
    const bindings = [
      ...nativeBindings(run),
      ...toolBindings(run.owner_id, run.agent_id!).map((b) => ({
        ...b,
        name:
          "loop_mcp_" +
          createHash("sha256")
            .update(b.connectionId + ":" + b.tool)
            .digest("hex")
            .slice(0, 20),
      })),
    ];
    // A published name must never silently change its target while this client is alive.
    for (const binding of bindings) {
      const old = t.bindings.get(binding.name);
      if (
        !old ||
        (old.connectionId === binding.connectionId && old.tool === binding.tool)
      )
        t.bindings.set(binding.name, binding);
    }
    return {
      tools: [...t.bindings.values()].map(
        ({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }),
      ),
    };
  }
  private call(
    t: Ticket,
    requestId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const live = nativeSessions.current(t.conversation, t.generation);
    const run = live.run!;
    const binding = t.bindings.get(name);
    if (!binding)
      throw new Error(
        "Tool was not advertised in this native session. Reopen the conversation to refresh tools.",
      );
    const key = run.id + ":" + requestId,
      digest = JSON.stringify([name, args]);
    const previous = t.calls.get(key);
    if (previous) {
      if (previous.digest !== digest)
        throw new Error("Tool request identity was reused");
      return previous.result;
    }
    if (!previous && t.calls.size >= 2000)
      throw new Error(
        "Native tool request limit reached; start a new conversation.",
      );
    const result = (async () => {
      let waiting = false;
      try {
        for (;;) {
          if (
            signal?.aborted ||
            nativeSessions.current(t.conversation, t.generation).run?.id !==
              run.id
          )
            throw new Error("Native tool request ended");
          const state = (
            db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as Run
          ).state;
          if (!["running", "awaiting_approval"].includes(state))
            throw new Error("Run is no longer active");
          // Only a known pending approval/delegation is polled. Uncertain external
          // calls throw from the broker and are never repeated.
          if (state === "awaiting_approval") {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          const response = await (
            binding.connectionId === "__loop__" ? invokeNative : invokeTool
          )(run, binding, key, args);
          if ("result" in response) {
            if (binding.tool === "loop_install_mcp") {
              this.list(t);
              await t.server
                ?.notification({ method: "notifications/tools/list_changed" })
                .catch(() => {});
            }
            return response.result;
          }
          if (!waiting) {
            live.bridgeWaiting++;
            waiting = true;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Workspace tool failed",
            },
          ],
        };
      } finally {
        if (waiting) live.bridgeWaiting--;
      }
    })();
    t.calls.set(key, { digest, result });
    return result;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const match = /^\/([0-9a-f-]+)(\/pi)?$/.exec(req.url || "");
      const t = match && this.tickets.get(match[1]);
      const actual = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from("Bearer " + t?.token);
      if (
        !t ||
        req.headers.host !== `127.0.0.1:${this.port}` ||
        req.headers.origin ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res.writeHead(403).end();
        return;
      }
      nativeSessions.current(t.conversation, t.generation, false);
      if (
        req.method !== "POST" &&
        req.method !== "DELETE" &&
        req.method !== "GET"
      ) {
        res.writeHead(405).end();
        return;
      }
      let body: any;
      if (req.method === "POST") {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128000) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      if (match![2]) {
        if (req.method !== "POST" || !body || typeof body !== "object") {
          res.writeHead(400).end();
          return;
        }
        const result =
          body.method === "tools/list"
            ? this.list(t)
            : body.method === "tools/call" &&
                typeof body.id === "string" &&
                body.id.length < 200 &&
                typeof body.name === "string"
              ? await this.call(t, body.id, body.name, body.arguments || {})
              : null;
        if (!result) {
          res.writeHead(400).end();
          return;
        }
        res
          .writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(JSON.stringify(result));
        return;
      }
      if (!t.transport) {
        if (body?.method !== "initialize") {
          res.writeHead(409).end();
          return;
        }
        t.server = new Server(
          { name: "loop-workspace", version: "0.1.0" },
          { capabilities: { tools: { listChanged: true } } },
        );
        t.server.setRequestHandler(ListToolsRequestSchema, async () =>
          this.list(t),
        );
        t.server.setRequestHandler(
          CallToolRequestSchema,
          async (request, extra) =>
            this.call(
              t,
              String(extra.requestId),
              request.params.name,
              request.params.arguments || {},
              extra.signal,
            ),
        );
        t.transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
        });
        await t.server.connect(t.transport);
      }
      await t.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent)
        res.writeHead(409, { "Content-Type": "application/json" });
      if (!res.writableEnded)
        res.end(
          JSON.stringify({
            error: "Native tool session unavailable or request invalid",
          }),
        );
    }
  }
  async close() {
    await Promise.allSettled(
      [...this.tickets.values()].map((t) => t.server?.close()),
    );
    this.tickets.clear();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
