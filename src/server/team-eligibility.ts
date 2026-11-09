import { harnesses, isHarness } from "../shared/harnesses.js";
import * as teamsQueries from "./sql/teams.js";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import type { Connection } from "./row-schemas.js";

export function assertTeamConnection(connection: Pick<Connection, "metadata">) {
  const harness = connection.metadata.loopHarness;
  if (harness && isHarness(harness) && !harnesses[harness].workspaceTools)
    throw new Problem(
      409,
      `${harnesses[harness].label} does not expose Loop workspace tools. Choose another harness for team delegation and code reviews.`,
    );
}

// A provider edit must not leave an existing manager or worker unable to use
// the tools its team requires. Deleted teams no longer constrain the agent.
export function assertTeamConnectionChange(
  owner: string,
  agentId: string,
  connection: Pick<Connection, "metadata">,
) {
  const member = teamsQueries.agentInActiveTeam(db, owner, agentId, agentId);
  if (member) assertTeamConnection(connection);
}
