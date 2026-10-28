import { db } from "./db.js";
import { Problem } from "./domain.js";
import type { Connection } from "./row-schemas.js";

export function assertTeamConnection(connection: Pick<Connection, "metadata">) {
  if (connection.metadata.loopHarness === "antigravity")
    throw new Problem(
      409,
      "Antigravity does not expose Loop workspace tools. Choose another harness for team delegation and code reviews.",
    );
}

// A provider edit must not leave an existing manager or worker unable to use
// the tools its team requires. Deleted teams no longer constrain the agent.
export function assertTeamConnectionChange(
  owner: string,
  agentId: string,
  connection: Pick<Connection, "metadata">,
) {
  const member = db
    .prepare(
      `SELECT 1 FROM teams t WHERE t.owner_id=? AND t.deleted_at IS NULL
       AND (t.manager_id=? OR EXISTS (
         SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.agent_id=?
       )) LIMIT 1`,
    )
    .get(owner, agentId, agentId);
  if (member) assertTeamConnection(connection);
}
