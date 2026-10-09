import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { createAgent, owned, Problem } from "./domain.js";
import { createHash } from "node:crypto";
import { suggestAgentName } from "./agent-names.js";
import {
  TEAM_PRESETS,
  supportsSnapshotReview,
} from "../shared/team-presets.js";
import { startCodeReview, reviewStatus } from "./code-reviews.js";
import { isArchivedHapi } from "./legacy-execution.js";
import type { Agent, Connection } from "../shared/types.js";

export function listTeams(owner: string) {
  return (
    db
      .prepare(
        "SELECT * FROM teams WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC",
      )
      .all(owner) as any[]
  ).map((t) => ({
    ...t,
    members: (
      db
        .prepare("SELECT agent_id FROM team_members WHERE team_id=?")
        .all(t.id) as any[]
    ).map((m) => m.agent_id),
    paused_threads: (
      db
        .prepare(
          "SELECT count(*) n FROM agent_threads WHERE owner_id=? AND team_id=? AND paused_at IS NOT NULL",
        )
        .get(owner, t.id) as { n: number }
    ).n,
  }));
}
export function teamFilter(value: unknown, owner: string) {
  if (value === undefined || value === "") return [];
  const ids = [...new Set(z.string().max(2000).parse(value).split(","))];
  if (ids.length > 30) throw new Problem(400, "Choose up to 30 teams");
  ids.forEach((id) => {
    if (owned<any>("teams", id, owner).deleted_at != null)
      throw new Problem(404, "Team no longer exists");
  });
  return ids;
}
export function createTeam(owner: string, input: unknown) {
  const d = z
    .object({
      name: z.string().trim().min(1).max(80),
      managerId: z.string(),
      members: z.array(z.string()).min(1).max(8),
    })
    .parse(input);
  const members = [...new Set(d.members)];
  if (members.includes(d.managerId))
    throw new Problem(
      400,
      "Choose different agents for the manager and workers",
    );
  for (const agent of [d.managerId, ...members]) {
    const a = owned<Agent>("agents", agent, owner);
    if (a.retired_at)
      throw new Problem(
        409,
        "Restore retired agents before adding them to a team",
      );
    const connection = a.connection_id
      ? owned<any>("connections", a.connection_id, owner)
      : undefined;
    if (connection && isArchivedHapi(connection))
      throw new Problem(
        409,
        "Choose a native connection for agents on an archived HAPI connection before adding them to a team",
      );
    if (connection?.status !== "connected")
      throw new Problem(409, "Every team member needs a connected provider");
  }
  return db
    .transaction(() => {
      const teamId = id(),
        conversation = id();
      db.prepare(
        "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,?,?,?)",
      ).run(teamId, owner, d.name, d.managerId, now());
      const manager = owned<Agent>("agents", d.managerId, owner);
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,team_id,execution_backend,execution_connection_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(conversation, owner, d.managerId, d.name, teamId,
        "legacy", manager.connection_id, now());
      db.prepare("UPDATE teams SET conversation_id=? WHERE id=?").run(
        conversation,
        teamId,
      );
      members.forEach((a) =>
        db.prepare("INSERT INTO team_members VALUES(?,?)").run(teamId, a),
      );
      return listTeams(owner).find((t) => t.id === teamId)!;
    })
    .immediate();
}

export function createPresetTeam(owner: string, input: unknown) {
  const selection = z.object({
    connectionId: z.string(),
    model: z.string().min(1),
    effort: z.string().nullable().optional(),
  });
  const d = z
    .object({
      presetId: z.string(),
      name: z.string().trim().min(1).max(80),
      folderId: z.string().min(1),
      selection,
      roles: z.record(z.string(), selection).default({}),
      idempotencyKey: z.string().min(8).max(150),
    })
    .parse(input);
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
      const prior = db
        .prepare(
          "SELECT * FROM team_creations WHERE owner_id=? AND request_key=?",
        )
        .get(owner, idempotencyKey) as any;
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
      owned("folders", d.folderId, owner);
      const agents = preset.roles.map((role) => {
        const chosen = d.roles[role.id] || d.selection;
        const connection = owned<Connection>(
          "connections",
          chosen.connectionId,
          owner,
        );
        if (preset.id === "code-review" && !supportsSnapshotReview(connection))
          throw new Problem(
            409,
            "Snapshot reviews require API connections. Native harnesses do not yet enforce read-only review; billing will not be switched automatically.",
          );
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
      db.prepare(
        "UPDATE teams SET preset_id=?,preset_version=?,preset_config=?,folder_id=? WHERE id=?",
      ).run(
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
      db.prepare("INSERT INTO team_creations VALUES(?,?,?,?)").run(
        owner,
        idempotencyKey,
        hash,
        team.id,
      );
      return listTeams(owner).find((t) => t.id === team.id)!;
    })
    .immediate();
}
export function addTeamMember(owner: string, teamId: string, input: unknown) {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(input);
  return db
    .transaction(() => {
      const team = owned<any>("teams", teamId, owner);
      if (team.deleted_at != null)
        throw new Problem(404, "Team no longer exists");
      if (team.preset_id === "code-review")
        throw new Problem(
          409,
          "Review teams have three fixed reviewer roles. Edit their agents or create a custom team.",
        );
      if (team.manager_id === agentId)
        throw new Problem(400, "The manager is already on this team");
      const agent = owned<Agent>("agents", agentId, owner);
      if (agent.retired_at)
        throw new Problem(409, "Restore this agent before adding it to a team");
      if (
        !agent.connection_id ||
        owned<any>("connections", agent.connection_id, owner).status !==
          "connected"
      )
        throw new Problem(409, "This agent needs a connected provider");
      const existing = db
        .prepare("SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?")
        .get(teamId, agentId);
      if (!existing) {
        const count = (
          db
            .prepare(
              `SELECT count(*) n FROM team_members m
               JOIN agents a ON a.id=m.agent_id
               WHERE m.team_id=? AND a.retired_at IS NULL`,
            )
            .get(teamId) as { n: number }
        ).n;
        if (count >= 8)
          throw new Problem(409, "A team can have up to 8 workers");
        db.prepare(
          "INSERT INTO team_members(team_id,agent_id) VALUES(?,?)",
        ).run(teamId, agentId);
      }
      return listTeams(owner).find((item) => item.id === teamId)!;
    })
    .immediate();
}
// Called inside the agent PATCH transaction, before clearing retired_at.
export function assertTeamRestoreCapacity(owner: string, agentId: string) {
  const full = db
    .prepare(
      `
    SELECT t.name FROM teams t
    JOIN team_members membership ON membership.team_id=t.id
    WHERE t.owner_id=? AND t.deleted_at IS NULL AND membership.agent_id=?
      AND (SELECT count(*) FROM team_members m
           JOIN agents a ON a.id=m.agent_id
           WHERE m.team_id=t.id AND a.retired_at IS NULL) >= 8
    LIMIT 1
  `,
    )
    .get(owner, agentId) as { name: string } | undefined;
  if (full)
    throw new Problem(
      409,
      `Cannot restore this agent: team "${full.name}" already has 8 active workers. Retire another worker or delete the team first.`,
    );
}

export const teams = Router();
export function deleteTeam(owner: string, teamId: string) {
  db.transaction(() => {
    owned("teams", teamId, owner);
    db.prepare(
      "UPDATE teams SET deleted_at=COALESCE(deleted_at,?) WHERE id=? AND owner_id=?",
    ).run(now(), teamId, owner);
    db.prepare(
      "UPDATE conversations SET team_id=NULL WHERE team_id=? AND owner_id=?",
    ).run(teamId, owner);
  }).immediate();
}
teams.get("/teams", (_req, res) => res.json(listTeams(res.locals.owner)));
teams.get("/team-presets", (_req, res) => res.json(TEAM_PRESETS));
teams.post("/teams/from-preset", (req, res) =>
  res.status(201).json(createPresetTeam(res.locals.owner, req.body)),
);
teams.post("/teams/:id/reviews", (req, res) =>
  res
    .status(201)
    .json(startCodeReview(res.locals.owner, req.params.id, req.body)),
);
teams.get("/reviews/conversation/:id", (req, res) => {
  owned("conversations", req.params.id, res.locals.owner);
  const run = db
    .prepare(
      "SELECT json_extract(payload,'$.reviewId') reviewId FROM runs WHERE conversation_id=? AND owner_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(req.params.id, res.locals.owner) as any;
  res.json(
    run?.reviewId
      ? reviewStatus(
          res.locals.owner,
          run.reviewId,
          req.query.freshness === "true",
        )
      : null,
  );
});
teams.post("/teams", (req, res) =>
  res.status(201).json(createTeam(res.locals.owner, req.body)),
);
teams.post("/teams/:id/members", (req, res) =>
  res.json(addTeamMember(res.locals.owner, req.params.id, req.body)),
);
teams.delete("/teams/:id", (req, res) => {
  deleteTeam(res.locals.owner, req.params.id);
  res.json({ ok: true });
});
