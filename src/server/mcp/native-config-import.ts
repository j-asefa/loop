import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Problem } from "../domain.js";
import { installConfig } from "./install.js";
import { parseMcpConfig } from "./install.js";

const run = promisify(execFile);
type Entry =
  | { command: string; args: string[]; env: Record<string, string> }
  | { url: string; headers?: Record<string, string> };
type Candidate = {
  id: string;
  provider: string;
  name: string;
  kind: "command" | "http";
  entry: Entry;
};
const candidateId = (provider: string, name: string) =>
  createHash("sha256")
    .update(JSON.stringify([provider, name]))
    .digest("hex")
    .slice(0, 24);

async function jsonFile(path: string) {
  try {
    const input = await readFile(path, "utf8");
    if (input.length > 2_000_000) return null;
    return JSON.parse(input) as any;
  } catch {
    return null;
  }
}

function add(
  results: Candidate[],
  provider: string,
  name: string,
  entry: unknown,
) {
  if (!name || name.length > 70 || !entry || typeof entry !== "object") return;
  try {
    const parsed = parseMcpConfig({ mcpServers: { [name]: entry } });
    const value = parsed[0][1];
    results.push({
      id: candidateId(provider, name),
      provider,
      name,
      kind: "command" in value ? "command" : "http",
      entry: value as Entry,
    });
  } catch {
    // An unsupported native transport or private endpoint stays in its
    // harness. We do not partially import or guess its credentials.
  }
}

function standardServers(
  results: Candidate[],
  provider: string,
  servers: unknown,
) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, config] of Object.entries(servers).slice(0, 100))
    add(results, provider, name, config);
}

export async function nativeMcpCandidates() {
  const results: Candidate[] = [];
  // The Codex CLI merges user, project and plugin configuration. Its JSON
  // output is read only inside the source process; env values never go to UI.
  try {
    const { stdout } = await run("codex", ["mcp", "list", "--json"], {
      timeout: 10000,
      maxBuffer: 2_000_000,
    });
    const servers = JSON.parse(stdout) as any[];
    if (Array.isArray(servers))
      for (const server of servers.slice(0, 100)) {
        if (server?.enabled === false || typeof server?.name !== "string")
          continue;
        const transport = server.transport;
        if (transport?.type === "stdio" && !transport.cwd) {
          const env = { ...(transport.env || {}) };
          for (const key of transport.env_vars || []) {
            if (typeof key === "string" && process.env[key] !== undefined)
              env[key] = process.env[key];
          }
          add(results, "Codex", server.name, {
            command: transport.command,
            args: transport.args || [],
            env,
          });
        } else if (
          ["http", "streamable_http", "streamable-http"].includes(
            transport?.type,
          )
        ) {
          add(results, "Codex", server.name, {
            url: transport.url,
            headers: transport.headers || {},
          });
        }
      }
  } catch {
    // An uninstalled CLI does not prevent other harness configurations.
  }

  const home = homedir();
  const claude = await jsonFile(join(home, ".claude.json"));
  standardServers(results, "Claude", claude?.mcpServers);
  const claudeSettings = await jsonFile(join(home, ".claude", "settings.json"));
  standardServers(results, "Claude", claudeSettings?.mcpServers);
  const projectMcp = await jsonFile(join(process.cwd(), ".mcp.json"));
  standardServers(results, "Claude project", projectMcp?.mcpServers);

  const openCode = await jsonFile(
    join(home, ".config", "opencode", "opencode.json"),
  );
  if (openCode?.mcp && typeof openCode.mcp === "object")
    for (const [name, value] of Object.entries(openCode.mcp).slice(0, 100)) {
      const entry = value as any;
      if (entry?.enabled === false || entry?.disabled === true) continue;
      if (entry?.type === "local" && Array.isArray(entry.command))
        add(results, "OpenCode", name, {
          command: entry.command[0],
          args: entry.command.slice(1),
          env: entry.environment || {},
        });
      else if (entry?.type === "remote")
        add(results, "OpenCode", name, {
          url: entry.url,
          headers: entry.headers || {},
        });
    }

  // Pi's MCP support comes from extensions. The common mcp.json adapter
  // format is importable; extension-specific stores remain owned by Pi.
  const pi = await jsonFile(join(home, ".pi", "agent", "mcp.json"));
  standardServers(results, "Pi", pi?.mcpServers);

  const seen = new Set<string>();
  return results.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

export async function publicNativeMcpCandidates() {
  return (await nativeMcpCandidates()).map(({ id, provider, name, kind }) => ({
    id,
    provider,
    name,
    kind,
  }));
}

export async function importNativeMcpCandidate(
  owner: string,
  candidateId: string,
) {
  const candidate = (await nativeMcpCandidates()).find(
    (item) => item.id === candidateId,
  );
  if (!candidate) throw new Problem(404, "Installed MCP server unavailable");
  const name = `${candidate.provider} · ${candidate.name}`.slice(0, 80);
  return installConfig(owner, {
    mcpServers: { [name]: candidate.entry },
  });
}
