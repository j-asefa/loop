import { registrar } from "./registrar.js";
import { createHash } from "node:crypto";

import { z } from "zod";
import { db, now } from "./db.js";
import { ownedAgent, ownedTeam, ownedConnection, agentInput, createAgent, handle, Problem } from "./domain.js";
import { addTeamMember, createTeam, listTeams } from "./teams.js";
import { parseDefinition } from "./definition-markdown.js";
import {
  MAX_DEFINITION_BYTES,
  type AgentDefinition,
  type DefinitionCreation,
  type DefinitionRole,
  type DefinitionSummary,
} from "../shared/agent-definitions.js";


type StoredDefinition = DefinitionSummary & {
  owner_id: string;
  markdown: string;
};
function stored(owner: string, definitionId: string): StoredDefinition {
  const row = db
    .prepare("SELECT * FROM agent_definitions WHERE id=? AND owner_id=?")
    .get(definitionId, owner) as StoredDefinition | undefined;
  if (!row) throw new Problem(404, "Definition not found");
  return row;
}
function detail(row: StoredDefinition): AgentDefinition {
  const { owner_id: _, ...data } = row;
  return { ...data, spec: parseDefinition(row.markdown) };
}
const version = z.number().int().positive();
const saveInput = z
  .object({
    markdown: z.string().max(MAX_DEFINITION_BYTES),
    version: z.number().int().nonnegative(),
    kind: z.enum(["agent", "team"]).optional(),
  })
  .strict();

export function saveDefinition(
  owner: string,
  definitionId: string,
  input: unknown,
) {
  z.uuid().parse(definitionId);
  const data = saveInput.parse(input);
  const spec = parseDefinition(data.markdown);
  if (data.kind && spec.kind !== data.kind)
    throw new Problem(400, `Choose a ${data.kind} definition for this library`);
  return db
    .transaction(() => {
      const prior = db
        .prepare("SELECT * FROM agent_definitions WHERE id=?")
        .get(definitionId) as StoredDefinition | undefined;
      if (prior && prior.owner_id !== owner)
        throw new Problem(404, "Definition not found");
      // A lost save response can be retried without another version or duplicate.
      if (
        prior?.version === data.version + 1 &&
        prior.markdown === data.markdown
      )
        return detail(prior);
      if ((prior?.version ?? 0) !== data.version)
        throw new Problem(
          409,
          "This definition changed. Reopen it before saving.",
        );
      const at = now();
      if (prior) {
        db.prepare(
          "UPDATE agent_definitions SET kind=?,name=?,description=?,markdown=?,version=version+1,updated_at=? WHERE id=? AND owner_id=?",
        ).run(
          spec.kind,
          spec.name,
          spec.description,
          data.markdown,
          at,
          definitionId,
          owner,
        );
      } else {
        db.prepare(
          "INSERT INTO agent_definitions(id,owner_id,kind,name,description,markdown,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
        ).run(
          definitionId,
          owner,
          spec.kind,
          spec.name,
          spec.description,
          data.markdown,
          at,
          at,
        );
      }
      return detail(stored(owner, definitionId));
    })
    .immediate();
}

const choice = z
  .object({
    connectionId: z.string().min(1),
    model: agentInput.shape.model.optional(),
    effort: agentInput.shape.effort,
  })
  .strict();
const createInput = z
  .object({
    version,
    selection: choice,
    folderId: z.string().min(1).nullable().optional(),
    teamId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    roles: z
      .record(
        z.string(),
        choice.partial().extend({ name: handle.optional() }).strict(),
      )
      .default({}),
    idempotencyKey: z.string().min(8).max(150),
  })
  .strict();

export function createFromDefinition(
  owner: string,
  definitionId: string,
  input: unknown,
): DefinitionCreation {
  const { idempotencyKey, ...data } = createInput.parse(input);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        definitionId,
        ...data,
        roles: Object.fromEntries(Object.entries(data.roles).sort()),
      }),
    )
    .digest("hex");
  return db
    .transaction(() => {
      const prior = db
        .prepare(
          "SELECT * FROM definition_creations WHERE owner_id=? AND request_key=?",
        )
        .get(owner, idempotencyKey) as
        | {
            request_hash: string;
            agent_id: string | null;
            team_id: string | null;
          }
        | undefined;
      const result = (
        agentId?: string | null,
        teamId?: string | null,
      ): DefinitionCreation => {
        const team = teamId
          ? listTeams(owner).find((t) => t.id === teamId)
          : undefined;
        // A worker survives its team's deletion; its committed receipt must
        // still recover the agent without creating or attaching anything.
        if (teamId && !team && !agentId)
          throw new Problem(409, "This team was deleted; start a new creation");
        return {
          ...(agentId ? { agent: ownedAgent(agentId, owner) } : {}),
          ...(team ? { team } : {}),
        };
      };
      if (prior) {
        if (prior.request_hash !== hash)
          throw new Problem(
            409,
            "This request key belongs to different creation details",
          );
        return result(prior.agent_id, prior.team_id);
      }
      const definition = stored(owner, definitionId);
      if (definition.version !== data.version)
        throw new Problem(
          409,
          "This definition changed. Reopen it before creating.",
        );
      const spec = parseDefinition(definition.markdown);
      if (spec.kind === "team" && data.teamId)
        throw new Problem(400, "Choose an agent definition to add a worker");
      const roles =
        spec.kind === "agent" ? [spec] : [spec.manager, ...spec.members];
      if (
        Object.keys(data.roles).some(
          (key) => !roles.some((role) => role.name === key),
        )
      )
        throw new Problem(400, "Unknown definition role");
      let folderId = data.folderId;
      if (data.teamId) {
        const team = ownedTeam(data.teamId, owner);
        if (team.deleted_at != null)
          throw new Problem(404, "Team no longer exists");
        if (folderId === undefined) folderId = team.folder_id || undefined;
      }
      const makeAgent = (role: DefinitionRole) => {
        const override = Object.hasOwn(data.roles, role.name)
          ? data.roles[role.name]
          : undefined;
        const settings = {
          name:
            override?.name ??
            (spec.kind === "agent" ? data.name : undefined) ??
            role.name,
          connectionId: override?.connectionId ?? data.selection.connectionId,
          model:
            override?.model ??
            (role.model === "inherit" ? undefined : role.model) ??
            data.selection.model,
          effort:
            override?.effort !== undefined
              ? override.effort
              : role.effort !== undefined
                ? role.effort
                : data.selection.effort,
          instructions: role.instructions,
          folderId: folderId || undefined,
        };
        const connection = ownedConnection(settings.connectionId, owner);
        if (settings.effort) {
          const catalog = connection.models;
          const model = catalog.find((model) => model.id === settings.model);
          if (!model)
            throw new Problem(400, "Choose an available model from this connection");
          if (!model.effortLevels?.some((level) => level.value === settings.effort))
            throw new Problem(
              400,
              "Choose an effort level reported by this model, or the runtime default",
            );
        }
        return createAgent(owner, settings);
      };
      let agentId: string | undefined,
        teamId = data.teamId;
      if (spec.kind === "agent") {
        agentId = makeAgent(spec).id;
        if (teamId) addTeamMember(owner, teamId, { agentId });
      } else {
        const manager = makeAgent(spec.manager);
        const members = spec.members.map((member) => makeAgent(member).id);
        const team = createTeam(owner, {
          name: data.name ?? spec.name,
          managerId: manager.id,
          members,
        });
        teamId = team.id;
        db.prepare("UPDATE teams SET folder_id=? WHERE id=?").run(
          folderId || null,
          teamId,
        );
        db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
          folderId || null,
          team.conversation_id,
        );
      }
      db.prepare("INSERT INTO definition_creations VALUES(?,?,?,?,?)").run(
        owner,
        idempotencyKey,
        hash,
        agentId || null,
        teamId || null,
      );
      return result(agentId, teamId);
    })
    .immediate();
}

const routes = registrar("agentDefinitions");
export const agentDefinitions = routes.mount;
routes.legacy("GET /agent-definitions", (_req, res) => {
  res.json(
    db
      .prepare(
        "SELECT id,kind,name,description,version,created_at,updated_at FROM agent_definitions WHERE owner_id=? ORDER BY updated_at DESC,id",
      )
      .all(res.locals.owner),
  );
});
routes.legacy("GET /agent-definitions/:id", (req, res) =>
  res.json(detail(stored(res.locals.owner, req.params.id))),
);
routes.legacy("PUT /agent-definitions/:id", (req, res) =>
  res.json(saveDefinition(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("DELETE /agent-definitions/:id", (req, res) => {
  const data = z.object({ version }).strict().parse(req.body);
  db.transaction(() => {
    const row = stored(res.locals.owner, req.params.id);
    if (row.version !== data.version)
      throw new Problem(
        409,
        "This definition changed. Reopen it before deleting.",
      );
    db.prepare("DELETE FROM agent_definitions WHERE id=? AND owner_id=?").run(
      row.id,
      res.locals.owner,
    );
  }).immediate();
  res.json({ ok: true });
});
routes.legacy("POST /agent-definitions/:id/create", (req, res) =>
  res
    .status(201)
    .json(createFromDefinition(res.locals.owner, req.params.id, req.body)),
);
