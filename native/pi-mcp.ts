// Process-local managed Pi bridge. The host supplies a protected launch binding.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Scope = { gatewayUrl: string; gatewayToken: string; generation: number };
type Tool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Peer = {
  listTools(cursor?: string): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  close(): Promise<void>;
};
export async function connectPiMcp(scope: Scope): Promise<Peer> {
  const client = new Client({ name: "loop-managed-pi", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(scope.gatewayUrl), {
    requestInit: { headers: { Authorization: `Bearer ${scope.gatewayToken}` }, redirect: "error" },
  });
  try {
    await client.connect(transport, { timeout: 10000 });
    return {
      listTools: (cursor) => client.listTools(cursor ? { cursor } : {}, { timeout: 10000 }),
      callTool: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal, timeout: 1800000 }),
      close: () => client.close(),
    };
  } catch {
    await client.close().catch(() => {});
    throw new Error("Loop workspace tools are unavailable");
  }
}

export function registerManagedPiMcp(
  pi: { on(event: string, handler: (...args: any[]) => any): void; registerTool(tool: any): void },
  binding: () => Scope,
  connect: (scope: Scope) => Promise<Peer> = connectPiMcp,
  report: (ready: boolean) => void = () => {},
) {
  let peer: Peer | undefined;
  let scope: Scope | undefined;
  let ready = false;
  const check = () => {
    const current = binding();
    if (!ready || !scope || current.generation !== scope.generation ||
        current.gatewayUrl !== scope.gatewayUrl || current.gatewayToken !== scope.gatewayToken)
      throw new Error("Loop workspace tools are unavailable or fenced");
  };
  pi.on("session_start", async () => {
    ready = false;
    await peer?.close().catch(() => {});
    peer = undefined;
    try {
      scope = binding();
      peer = await connect(scope);
      const catalog: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await peer.listTools(cursor);
        catalog.push(...page.tools);
        if (catalog.length > 1000) throw new Error("Catalog too large");
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated catalog cursor");
        if (cursor) cursors.add(cursor);
        if (cursors.size > 100) throw new Error("Too many catalog pages");
      } while (cursor);
      const names = new Set<string>();
      for (const tool of catalog) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name) ||
            !tool.inputSchema || tool.inputSchema.type !== "object") throw new Error("Invalid catalog");
        names.add(tool.name);
      }
      for (const tool of catalog) pi.registerTool({
        name: tool.name, label: tool.name, description: tool.description ?? tool.name,
        parameters: tool.inputSchema,
        async execute(_id: string, args: Record<string, unknown>, signal?: AbortSignal) {
          check();
          try {
            signal?.throwIfAborted();
            const result = await peer!.callTool(tool.name, args, signal);
            if (result.isError) throw new Error("Tool failed");
            return { content: result.content ?? [], details: { workspace: true } };
          } catch {
            // Never replay an effect or expose raw gateway/auth errors.
            throw new Error("Loop workspace tool did not complete; inspect its outcome in Loop before retrying");
          }
        },
      });
      ready = true;
      check();
    } catch {
      ready = false;
      await peer?.close().catch(() => {});
      peer = undefined;
    }
    report(ready);
  });
  pi.on("input", () => {
    // Pi catches hook exceptions and continues; handled explicitly blocks dispatch.
    try { check(); return { action: "continue" }; }
    catch { return { action: "handled" }; }
  });
  pi.on("session_shutdown", async () => {
    ready = false;
    await peer?.close().catch(() => {});
    peer = undefined;
  });
}
