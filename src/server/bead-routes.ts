import { BeadsUnavailable } from "../beads-runtime.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { Problem } from "./domain.js";
import { registrar } from "./registrar.js";
import {
  commentOnBead,
  closeProjectBead,
  linkBeadDependency,
  createProjectBead,
  enableProjectWork,
  projectBead,
  projectWork,
  resultWork,
} from "./project-beads.js";

import {
  beadAssignmentStatus,
  changeBeadAssignment,
  eligibleBeadAgents,
  startBead,
} from "./bead-assignments.js";

const routes = registrar("beads");
export const beads = routes.mount;

async function work<T>(operation: () => T | Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BeadsUnavailable)
      throw new Problem(503, error.message);
    throw error;
  }
}

routes.on(workspaceApi.projectWork, async ({ params }, res) =>
  res.json(await work(() => projectWork(res.locals.owner, params.project))),
);
routes.on(workspaceApi.projectWorkEnable, async ({ params }, res) =>
  res.json(
    await work(() => enableProjectWork(res.locals.owner, params.project)),
  ),
);
routes.on(workspaceApi.projectBeadAgents, async ({ params }, res) =>
  res.json(
    await work(() => eligibleBeadAgents(res.locals.owner, params.project)),
  ),
);
routes.on(workspaceApi.projectBead, async ({ params }, res) =>
  res.json(
    await work(async () => {
      const owner = res.locals.owner;
      const detail = await projectBead(owner, params.project, params.bead);
      const assignment = await beadAssignmentStatus(
        owner,
        params.project,
        params.bead,
      );
      return { ...detail, ...assignment };
    }),
  ),
);
routes.on(workspaceApi.projectBeadCreate, async ({ params, body }, res) =>
  res.json(
    await work(() => createProjectBead(res.locals.owner, params.project, body)),
  ),
);
routes.on(workspaceApi.projectBeadComment, async ({ params, body }, res) =>
  res.json(
    await work(() =>
      commentOnBead(res.locals.owner, params.project, params.bead, body),
    ),
  ),
);
routes.on(workspaceApi.projectBeadStart, async ({ params, body }, res) =>
  res.json(
    await work(() =>
      startBead(res.locals.owner, params.project, params.bead, body),
    ),
  ),
);
routes.on(workspaceApi.projectBeadAssignment, async ({ params, body }, res) =>
  res.json(
    await work(() =>
      changeBeadAssignment(res.locals.owner, params.project, params.bead, body),
    ),
  ),
);
routes.on(workspaceApi.projectBeadClose, async ({ params, body }, res) =>
  res.json(
    await work(() =>
      closeProjectBead(res.locals.owner, params.project, params.bead, body),
    ),
  ),
);
routes.on(workspaceApi.projectBeadDependency, async ({ params, body }, res) =>
  res.json(
    await work(() =>
      linkBeadDependency(res.locals.owner, params.project, params.bead, body),
    ),
  ),
);
routes.on(workspaceApi.resultWork, ({ params }, res) =>
  res.json(resultWork(res.locals.owner, params.message)),
);
