import { parseConnection } from "./row-schemas.js";
import { db } from "./db.js";
import { companionMode } from "./profile.js";
import {
  runtimeAction,
  runtimeWorkspaceKey,
  isSubscription,
} from "./subscriptions.js";
import { runtimeEndpoint } from "./runtime-hosts.js";
import { runtimeGithubCredential } from "./runtime-github.js";

// No model turn or inference cost. Storage maintenance needs no provider/GitHub
// credential; retiring registered PRs additionally needs this owner's GitHub.
// Retired direct connections keep their existing broker homes eligible.
export async function cleanupMergedWorkspaces(signal?: AbortSignal) {
  if (companionMode) return;
  const connections = db
    .prepare(
      "SELECT * FROM connections WHERE (status='connected' OR (status='disconnected' AND json_extract(metadata,'$.retiredDirectRuntime')=1)) AND provider IN ('codex','anthropic')",
    )
    .all();
  for (const row of connections) {
    if (signal?.aborted) return;
    try {
      const connection = parseConnection(row);
      if (!isSubscription(connection)) continue;
      const metadata = connection.metadata;
      if (
        metadata.loop55Harness ||
        runtimeEndpoint(
          connection.owner_id,
          metadata.runtimeHostId,
          connection.provider === "codex" ? "codex" : "claude",
        ).kind !== "broker"
      )
        continue;
      const github = runtimeGithubCredential(connection.owner_id);
      const agents = db
        .prepare("SELECT id FROM agents WHERE owner_id=? AND connection_id=?")
        .all(connection.owner_id, connection.id) as { id: string }[];
      if (!agents.length) continue;
      for (let i = 0; i < agents.length; i += 100) {
        if (signal?.aborted) return;
        const result = await runtimeAction(
          connection,
          "cleanup",
          {
            workspaceKeys: agents
              .slice(i, i + 100)
              .map((agent) =>
                runtimeWorkspaceKey(connection.owner_id, agent.id),
              ),
            ...(github ? { githubToken: github.token } : {}),
          },
          AbortSignal.any([
            AbortSignal.timeout(180000),
            ...(signal ? [signal] : []),
          ]),
        );
        if (result.skipped) break;
      }
    } catch {
      // A disconnected account, busy host or unverified merge must never cause
      // deletion or affect ordinary work. Retry during a later idle check.
    }
  }
}
