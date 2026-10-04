import { mcpApprovalMode } from "./mcp/approval-policy.js";
import type { AuthSecret } from "./mcp/client.js";
import { githubTokens } from "./github-api.js";

// Only an explicitly allowed, connected official GitHub integration can supply
// native Git/gh credentials. Never infer trust from a connection's display name.
export function runtimeGithubCredential(owner: string): AuthSecret | undefined {
  if (mcpApprovalMode(owner) !== "allow") return;
  const tokens = githubTokens(owner);
  // Multiple distinct accounts need an explicit selection; do not silently
  // perform repository writes as an arbitrary GitHub identity.
  if (tokens.length === 1) return { type: "bearer", token: tokens[0] };
}
