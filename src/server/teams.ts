import * as teamsQueries from "./sql/teams.js";
import * as teamMembersQueries from "./sql/team-members.js";
import * as agentThreadsQueries from "./sql/agent-threads.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as teamCreationsQueries from "./sql/team-creations.js";
import * as runsQueries from "./sql/runs.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar, projectResponse } from "./registrar.js";
import type { QueryRow } from "./query-records.js";

import { z } from "zod";
import { db, id, now } from "./db.js";
import {
  ownedFolder,
  ownedTeam,
  ownedConversation,
  ownedAgent,
  ownedConnection,
  createAgent,
  Problem,
} from "./domain.js";
import { createHash } from "node:crypto";
import { suggestAgentName } from "./agent-names.js";
import { TEAM_PRESETS } from "../shared/team-presets.js";
import { startCodeReview, reviewStatus } from "./code-reviews.js";
import { assertTeamConnection } from "./team-eligibility.js";

export function listTeams(owner: string) {
  return (teamsQueries.active(db, owner) as QueryRow<"teams">[]).map((t) => ({
    ...t,
    members: (
      teamMembersQueries.agents(db, t.id) as Pick<
        QueryRow<"team_members">,
        "agent_id"
      >[]
    ).map((m) => m.agent_id),
    paused_threads: (
      agentThreadsQueries.pausedCount(db, owner, t.id) as { n: number }
    ).n,
  }));
}
export function teamFilter(value: unknown, owner: string) {
  if (value === undefined || value === "") return [];
  const ids = [...new Set(z.string().max(2000).parse(value).split(","))];
  if (ids.length > 30) throw new Problem(400, "Choose up to 30 teams");
  ids.forEach((id) => {
    if (ownedTeam(id, owner).deleted_at != null)
      throw new Problem(404, "Team no longer exists");
  });
  return ids;
}
export function createTeam(owner: string, input: unknown) {
  const d = workspaceApi.teamCreate.body.parse(input);
  const members = [...new Set(d.members)];
  if (members.includes(d.managerId))
    throw new Problem(
      400,
      "Choose different agents for the manager and workers",
    );
  for (const agent of [d.managerId, ...members]) {
    const a = ownedAgent(agent, owner);
    if (a.retired_at)
      throw new Problem(
        409,
        "Restore retired agents before adding them to a team",
      );
    const connection = a.connection_id
      ? ownedConnection(a.connection_id, owner)
      : undefined;
    if (connection?.status !== "connected")
      throw new Problem(409, "Every team member needs a connected provider");
    assertTeamConnection(connection);
  }
  return db
    .transaction(() => {
      const teamId = id(),
        conversation = id();
      teamsQueries.insert(db, teamId, owner, d.name, d.managerId, now());
      const manager = ownedAgent(d.managerId, owner);
      conversationsQueries.insertManager(
        db,
        conversation,
        owner,
        d.managerId,
        d.name,
        teamId,
        manager.connection_id,
        now(),
      );
      teamsQueries.conversation(db, conversation, teamId);
      members.forEach((a) => teamMembersQueries.insert(db, teamId, a));
      return {
        ...listTeams(owner).find((t) => t.id === teamId)!,
        conversation_id: conversation,
      };
    })
    .immediate();
}

export function createPresetTeam(owner: string, input: unknown) {
  const d = workspaceApi.teamFromPreset.body.parse(input);
  const { idempotencyKey, ...details } = d;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        ...details,
        roles: Object.fromEntries(Object.entries(d.roles).sort()),
      }),
    )
    .digest("hex");
  return db
    .transaction(() => {
      const prior = teamCreationsQueries.get(db, owner, idempotencyKey) as
        QueryRow<"team_creations"> | undefined;
      if (prior) {
        if (prior.request_hash !== hash)
          throw new Problem(
            409,
            "This request key belongs to different team details",
          );
        const team = listTeams(owner).find((t) => t.id === prior.team_id);
        if (!team)
          throw new Problem(409, "This team was deleted; start a new creation");
        return team;
      }
      const preset = TEAM_PRESETS.find((p) => p.id === d.presetId);
      if (!preset) throw new Problem(400, "Choose an available team preset");
      if (
        Object.keys(d.roles).some(
          (role) => !preset.roles.some((r) => r.id === role),
        )
      )
        throw new Problem(400, "Unknown preset role");
      ownedFolder(d.folderId, owner);
      const agents = preset.roles.map((role) => {
        const chosen = d.roles[role.id] || d.selection;
        ownedConnection(chosen.connectionId, owner);
        return {
          role: role.id,
          agent: createAgent(owner, {
            ...chosen,
            name: suggestAgentName(),
            folderId: d.folderId,
            instructions: role.instructions,
          }),
        };
      });
      const team = createTeam(owner, {
        name: d.name,
        managerId: agents[0].agent.id,
        members: agents.slice(1).map((a) => a.agent.id),
      });
      teamsQueries.preset(
        db,
        preset.id,
        preset.version,
        JSON.stringify({
          ...preset,
          assignments: agents.map((a) => ({
            role: a.role,
            agentId: a.agent.id,
          })),
        }),
        d.folderId,
        team.id,
      );
      teamCreationsQueries.insert(db, owner, idempotencyKey, hash, team.id);
      return listTeams(owner).find((t) => t.id === team.id)!;
    })
    .immediate();
}
export function addTeamMember(owner: string, teamId: string, input: unknown) {
  const { agentId } = workspaceApi.teamMemberAdd.body.parse(input);
  return db
    .transaction(() => {
      const team = ownedTeam(teamId, owner);
      if (team.deleted_at != null)
        throw new Problem(404, "Team no longer exists");
      if (team.preset_id === "code-review")
        throw new Problem(
          409,
          "Review teams have three fixed reviewer roles. Edit their agents or create a custom team.",
        );
      if (team.manager_id === agentId)
        throw new Problem(400, "The manager is already on this team");
      const agent = ownedAgent(agentId, owner);
      if (agent.retired_at)
        throw new Problem(409, "Restore this agent before adding it to a team");
      if (
        !agent.connection_id ||
        ownedConnection(agent.connection_id, owner).status !== "connected"
      )
        throw new Problem(409, "This agent needs a connected provider");
      assertTeamConnection(ownedConnection(agent.connection_id, owner));
      const existing = teamMembersQueries.exists(db, teamId, agentId);
      if (!existing) {
        const count = (
          teamMembersQueries.activeCount(db, teamId) as { n: number }
        ).n;
        if (count >= 8)
          throw new Problem(409, "A team can have up to 8 workers");
        teamMembersQueries.add(db, teamId, agentId);
      }
      return listTeams(owner).find((item) => item.id === teamId)!;
    })
    .immediate();
}
// Called inside the agent PATCH transaction, before clearing retired_at.
export function assertTeamRestoreCapacity(owner: string, agentId: string) {
  const full = teamsQueries.fullForRestoredAgent(db, owner, agentId) as
    { name: string } | undefined;
  if (full)
    throw new Problem(
      409,
      `Cannot restore this agent: team "${full.name}" already has 8 active workers. Retire another worker or delete the team first.`,
    );
}

const routes = registrar("teams");
export const teams = routes.mount;
export function setTeamFeedVisibility(
  owner: string,
  teamId: string,
  input: unknown,
) {
  const { hideResultsFromFeed } =
    workspaceApi.teamFeedVisibility.body.parse(input);
  return db
    .transaction(() => {
      const team = ownedTeam(teamId, owner);
      if (team.deleted_at != null)
        throw new Problem(404, "Team no longer exists");
      teamsQueries.feedVisibility(
        db,
        Number(hideResultsFromFeed),
        teamId,
        owner,
      );
      return listTeams(owner).find((item) => item.id === teamId)!;
    })
    .immediate();
}

export function deleteTeam(owner: string, teamId: string) {
  db.transaction(() => {
    ownedTeam(teamId, owner);
    teamsQueries.remove(db, now(), teamId, owner);
    conversationsQueries.clearTeam(db, teamId, owner);
  }).immediate();
}
routes.on(workspaceApi.teamList, (_req, res) =>
  res.json(listTeams(res.locals.owner)),
);
routes.on(workspaceApi.teamPresets, (_req, res) => res.json([...TEAM_PRESETS]));
routes.on(workspaceApi.teamFromPreset, (req, res) =>
  res.status(201).json(createPresetTeam(res.locals.owner, req.body)),
);
routes.on(workspaceApi.teamReview, (req, res) =>
  res
    .status(201)
    .json(
      projectResponse(
        workspaceApi.teamReview,
        startCodeReview(res.locals.owner, req.params.id, req.body),
      ),
    ),
);
routes.on(workspaceApi.reviewStatus, (req, res) => {
  ownedConversation(req.params.id, res.locals.owner);
  const run = runsQueries.latestReview(db, req.params.id, res.locals.owner) as
    { reviewId: string | null } | undefined;
  res.json(
    projectResponse(
      workspaceApi.reviewStatus,
      run?.reviewId
        ? reviewStatus(
            res.locals.owner,
            run.reviewId,
            req.query.freshness === "true",
          )
        : null,
    ),
  );
});
routes.on(workspaceApi.teamCreate, (req, res) =>
  res.status(201).json(createTeam(res.locals.owner, req.body)),
);
routes.on(workspaceApi.teamMemberAdd, (req, res) =>
  res.json(addTeamMember(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.teamFeedVisibility, (req, res) =>
  res.json(setTeamFeedVisibility(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.teamDelete, (req, res) => {
  deleteTeam(res.locals.owner, req.params.id);
  res.json({ ok: true });
});
