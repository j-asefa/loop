import * as agentDefinitionsQueries from "./sql/agent-definitions.js";
import * as definitionCreationsQueries from "./sql/definition-creations.js";
import * as teamsQueries from "./sql/teams.js";
import * as conversationsQueries from "./sql/conversations.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar, projectResponse } from "./registrar.js";
import { createHash } from "node:crypto";

import { z } from "zod";
import { db, now } from "./db.js";
import {
  ownedAgent,
  ownedTeam,
  ownedConnection,
  createAgent,
  Problem,
} from "./domain.js";
import { addTeamMember, createTeam, listTeams } from "./teams.js";
import { parseDefinition } from "./definition-markdown.js";
import {
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
  const row = agentDefinitionsQueries.owned(db, definitionId, owner) as
    StoredDefinition | undefined;
  if (!row) throw new Problem(404, "Definition not found");
  return row;
}
function detail(row: StoredDefinition): AgentDefinition {
  const { owner_id: _, ...data } = row;
  return { ...data, spec: parseDefinition(row.markdown) };
}
function saveDefinition(owner: string, definitionId: string, input: unknown) {
  z.uuid().parse(definitionId);
  const data = workspaceApi.definitionSave.body.parse(input);
  const spec = parseDefinition(data.markdown);
  if (data.kind && spec.kind !== data.kind)
    throw new Problem(400, `Choose a ${data.kind} definition for this library`);
  return db
    .transaction(() => {
      const prior = agentDefinitionsQueries.get(db, definitionId) as
        StoredDefinition | undefined;
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
        agentDefinitionsQueries.update(
          db,
          spec.kind,
          spec.name,
          spec.description,
          data.markdown,
          at,
          definitionId,
          owner,
        );
      } else {
        agentDefinitionsQueries.insert(
          db,
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

function createFromDefinition(
  owner: string,
  definitionId: string,
  input: unknown,
): DefinitionCreation {
  const { idempotencyKey, ...data } =
    workspaceApi.definitionCreate.body.parse(input);
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
      const prior = definitionCreationsQueries.byRequest(
        db,
        owner,
        idempotencyKey,
      ) as
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
            throw new Problem(
              400,
              "Choose an available model from this connection",
            );
          if (
            !model.effortLevels?.some(
              (level) => level.value === settings.effort,
            )
          )
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
        teamsQueries.setFolder(db, folderId || null, teamId);
        conversationsQueries.setProject(
          db,
          folderId || null,
          team.conversation_id,
        );
      }
      definitionCreationsQueries.insert(
        db,
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
routes.on(workspaceApi.definitionList, (_req, res) => {
  res.json(
    agentDefinitionsQueries.summaries(
      db,
      res.locals.owner,
    ) as DefinitionSummary[],
  );
});
routes.on(workspaceApi.definitionRead, (req, res) =>
  res.json(detail(stored(res.locals.owner, req.params.id))),
);
routes.on(workspaceApi.definitionSave, (req, res) =>
  res.json(saveDefinition(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.definitionDelete, (req, res) => {
  const data = req.body;
  db.transaction(() => {
    const row = stored(res.locals.owner, req.params.id);
    if (row.version !== data.version)
      throw new Problem(
        409,
        "This definition changed. Reopen it before deleting.",
      );
    agentDefinitionsQueries.remove(db, row.id, res.locals.owner);
  }).immediate();
  res.json({ ok: true });
});
routes.on(workspaceApi.definitionCreate, (req, res) =>
  res
    .status(201)
    .json(
      projectResponse(
        workspaceApi.definitionCreate,
        createFromDefinition(res.locals.owner, req.params.id, req.body),
      ),
    ),
);
