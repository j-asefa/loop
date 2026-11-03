import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
type McpConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  session?: string;
};
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lines } from "./protocol.ts";

export function mcpContainerArgs(
  prefix: string,
  image: string,
  name: string,
  config: McpConfig,
): string[] {
  if (
    !/^[A-Za-z0-9_./-]{1,200}$/.test(config.command) ||
    !Array.isArray(config.args) ||
    config.args.length > 80 ||
    config.args.some((a) => typeof a !== "string" || a.length > 4000) ||
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env) ||
    Object.keys(config.env).length > 30 ||
    Object.entries(config.env).some(
      ([k, v]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ||
        typeof v !== "string" ||
        v.length > 10000,
    )
  )
    throw new Error("Invalid MCP configuration");
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--label",
    "loop.runtime=" + prefix,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--memory=1g",
    "--cpus=1",
    "--pids-limit=256",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=512m,mode=1777",
    "--tmpfs",
    "/home/node:rw,nosuid,size=128m,uid=1000,gid=1000",
    "--env",
    "npm_config_cache=/tmp/npm",
    "--env",
    "npm_config_yes=true",
    ...Object.entries(config.env).flatMap(([key, value]) => [
      "--env",
      key + "=" + value,
    ]),
    "--entrypoint",
    config.command,
    image,
    ...config.args,
  ];
}
export function mcpHandler(
  prefix: string,
  image: string,
  readBody: (req: IncomingMessage) => Promise<any>,
  json: (res: ServerResponse, data: unknown, code?: number) => void,
  remove: (name: string) => Promise<boolean>,
) {
  const sessions = new Map<
    string,
    { p: ChildProcessWithoutNullStreams; close: () => void }
  >();
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/mcp")) return false;
    const session = req.url.split("/")[2];
    if (req.url === "/mcp" && req.method === "POST") {
      const config = await readBody(req);
      if (
        !/^[a-f0-9-]{36}$/.test(config.session) ||
        sessions.has(config.session) ||
        sessions.size >= 8
      )
        throw new Error("Invalid session or runtime at capacity");
      const name = prefix + "-mcp-" + randomUUID();
      const p = spawn("docker", mcpContainerArgs(prefix, image, name, config), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const close = () => {
        p.kill("SIGTERM");
        void remove(name);
      };
      const timeout = setTimeout(close, 20 * 60 * 1000);
      sessions.set(config.session, { p, close });
      p.stderr.resume();
      p.stdin.on("error", close);
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      });
      res.write(JSON.stringify({ ready: true }) + "\n");
      lines(
        p.stdout,
        (message) => res.write(JSON.stringify(message) + "\n"),
        close,
      );
      const finish = () => {
        clearTimeout(timeout);
        sessions.delete(config.session);
        if (!res.writableEnded)
          res.end(JSON.stringify({ error: "MCP process closed" }) + "\n");
        void remove(name);
      };
      p.once("error", finish);
      p.once("close", finish);
      res.on("close", close);
      return true;
    }
    const active = sessions.get(session);
    if (!active) {
      json(res, { error: "Session not found" }, 404);
      return true;
    }
    if (req.method === "DELETE") {
      active.close();
      json(res, { ok: true });
      return true;
    }
    if (req.method !== "POST") {
      json(res, { error: "Method not allowed" }, 405);
      return true;
    }
    const message = await readBody(req);
    if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP message");
    active.p.stdin.write(JSON.stringify(message) + "\n");
    json(res, { ok: true });
    return true;
  };
}
