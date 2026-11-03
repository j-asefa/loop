import * as connectionsQueries from "./sql/connections.js";
import * as agentsQueries from "./sql/agents.js";
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
  const connections = connectionsQueries.legacyRuntimeCandidates(db);
  for (const row of connections) {
    if (signal?.aborted) return;
    try {
      const connection = parseConnection(row);
      if (!isSubscription(connection)) continue;
      const metadata = connection.metadata;
      if (
        metadata.loopHarness ||
        runtimeEndpoint(
          connection.owner_id,
          metadata.runtimeHostId,
          connection.provider === "codex" ? "codex" : "claude",
        ).kind !== "broker"
      )
        continue;
      const github = runtimeGithubCredential(connection.owner_id);
      const agents = agentsQueries.forConnection(
        db,
        connection.owner_id,
        connection.id,
      ) as { id: string }[];
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
