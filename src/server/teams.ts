import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import type { Agent } from "../shared/types.js";

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
    if (
      !a.connection_id ||
      owned<any>("connections", a.connection_id, owner).status !== "connected"
    )
      throw new Problem(409, "Every team member needs a connected provider");
  }
  return db
    .transaction(() => {
      const teamId = id(),
        conversation = id();
      db.prepare(
        "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,?,?,?)",
      ).run(teamId, owner, d.name, d.managerId, now());
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,team_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(conversation, owner, d.managerId, d.name, teamId, now());
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
teams.post("/teams", (req, res) =>
  res.status(201).json(createTeam(res.locals.owner, req.body)),
);
teams.delete("/teams/:id", (req, res) => {
  deleteTeam(res.locals.owner, req.params.id);
  res.json({ ok: true });
});
