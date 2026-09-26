import { db } from "./db.js";
import { mcpApprovalMode } from "./mcp/approval-policy.js";
import {
  readSecret,
  type AuthSecret,
  type MCPConnection,
} from "./mcp/client.js";

// Only an explicitly allowed, connected official GitHub integration can supply
// native Git/gh credentials. Never infer trust from a connection's display name.
export function runtimeGithubCredential(owner: string): AuthSecret | undefined {
  if (mcpApprovalMode(owner) !== "allow") return;
  const tokens = new Set<string>();
  const connections = db
    .prepare(
      "SELECT * FROM mcp_connections WHERE owner_id=? AND status='connected'",
    )
    .all(owner) as MCPConnection[];
  for (const connection of connections) {
    let url: URL;
    try {
      url = new URL(connection.url);
    } catch {
      continue;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.githubcopilot.com" ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/mcp(?:\/|$)/.test(url.pathname)
    )
      continue;
    const secret = readSecret(connection);
    if (secret.stdio) continue;
    const authorization = Object.entries(secret.headers || {}).find(
      ([key]) => key.toLowerCase() === "authorization",
    )?.[1];
    const token =
      secret.type === "bearer"
        ? secret.token
        : secret.type === "oauth"
          ? secret.tokens?.access_token
          : secret.type === "headers"
            ? authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
            : undefined;
    if (
      typeof token === "string" &&
      token.length > 0 &&
      token.length <= 8192 &&
      !/[\r\n\0]/.test(token)
    )
      tokens.add(token);
  }
  // Multiple distinct accounts need an explicit selection; do not silently
  // perform repository writes as an arbitrary GitHub identity.
  if (tokens.size === 1) return { type: "bearer", token: [...tokens][0] };
}
