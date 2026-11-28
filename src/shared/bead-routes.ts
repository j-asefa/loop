import { z } from "zod";
import { ProjectId, requestId } from "./contract-ids.js";
import { base, endpoint } from "./route-contract.js";

import {
  BeadId,
  StoreId,
  RequestId,
  WorkState,
  Assignment,
  WorkDetail,
  Create,
  Comment,
  WriteStatus,
} from "./bead-schemas.js";
export { BeadId } from "./bead-schemas.js";
export type {
  BeadCreate,
  BeadComment,
  BeadWorkItem,
  BeadWorkState,
  BeadDetail,
  BeadAssignmentView,
  BeadWriteStatus,
} from "./bead-schemas.js";

const params = z.object({ project: requestId(ProjectId) });
const beadParams = params.extend({ bead: BeadId });

export const beadRoutes = {
  projectWork: endpoint({
    ...base,
    operation: "projectWork",
    method: "GET",
    path: "/projects/:project/work",
    params,
    response: WorkState,
  }),
  projectWorkEnable: endpoint({
    ...base,
    operation: "projectWorkEnable",
    method: "PUT",
    path: "/projects/:project/work",
    params,
    body: z.strictObject({}),
    response: z.object({ storeId: StoreId }),
  }),
  projectBead: endpoint({
    ...base,
    operation: "projectBead",
    method: "GET",
    path: "/projects/:project/work/:bead",
    params: beadParams,
    response: WorkDetail,
  }),
  projectBeadCreate: endpoint({
    ...base,
    operation: "projectBeadCreate",
    method: "POST",
    path: "/projects/:project/work",
    params,
    body: Create,
    response: WriteStatus,
  }),
  projectBeadComment: endpoint({
    ...base,
    operation: "projectBeadComment",
    method: "POST",
    path: "/projects/:project/work/:bead/comments",
    params: beadParams,
    body: Comment,
    response: WriteStatus,
  }),
  projectBeadAgents: endpoint({
    ...base,
    operation: "projectBeadAgents",
    method: "GET",
    path: "/projects/:project/work/agents",
    params,
    response: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  projectBeadStart: endpoint({
    ...base,
    operation: "projectBeadStart",
    method: "POST",
    path: "/projects/:project/work/:bead/start",
    params: beadParams,
    body: z.object({
      storeId: StoreId,
      requestId: RequestId,
      agentId: z.string().min(1).max(256),
    }),
    response: Assignment,
  }),
  projectBeadAssignment: endpoint({
    ...base,
    operation: "projectBeadAssignment",
    method: "POST",
    path: "/projects/:project/work/:bead/assignment",
    params: beadParams,
    body: z.object({
      storeId: StoreId,
      generation: RequestId,
      action: z.enum(["resume", "release"]),
    }),
    response: Assignment,
  }),
  projectBeadClose: endpoint({
    ...base,
    operation: "projectBeadClose",
    method: "POST",
    path: "/projects/:project/work/:bead/close",
    params: beadParams,
    body: z.object({
      storeId: StoreId,
      requestId: RequestId,
      generation: RequestId.nullable(),
      reason: z.string().trim().min(1).max(2000),
    }),
    response: WriteStatus,
  }),
  projectBeadDependency: endpoint({
    ...base,
    operation: "projectBeadDependency",
    method: "POST",
    path: "/projects/:project/work/:bead/dependencies",
    params: beadParams,
    body: z.object({ storeId: StoreId, requestId: RequestId, blocker: BeadId }),
    response: WriteStatus,
  }),
  resultWork: endpoint({
    ...base,
    operation: "resultWork",
    method: "GET",
    path: "/result-work/:message",
    params: z.object({ message: z.string().min(1).max(256) }),
    response: z
      .object({
        projectId: z.string(),
        beadId: BeadId.nullable(),
      })
      .nullable(),
  }),
} as const;
