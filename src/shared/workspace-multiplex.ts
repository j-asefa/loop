import { z } from "zod";
import { WorkspaceFrameV3 } from "./workspace-events.js";
import { FleetEventSubscription } from "./fleet-workspace-events.js";

export const WORKSPACE_MULTIPLEX_PATH = "/api/events/multiplex/ws";
const WorkspaceSourceId = z
  .string()
  .max(180)
  .regex(/^(?:[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128})?$/);
export const WorkspaceSelection = FleetEventSubscription.pick({
  conversations: true,
  runs: true,
});
export const WorkspaceSubscription = WorkspaceSelection.extend({
  v: z.literal(1),
  type: z.literal("subscribe"),
  id: z.string().uuid(),
  source: WorkspaceSourceId,
  epoch: z.string().max(200),
  cursor: z.number().int().nonnegative().safe(),
});
export const WorkspaceMuxRequest = z.discriminatedUnion("type", [
  WorkspaceSubscription,
  z.strictObject({
    v: z.literal(1),
    type: z.literal("unsubscribe"),
    id: z.string().uuid(),
  }),
]);
export const WorkspaceSourceFrame = WorkspaceFrameV3;
export type WorkspaceSourceFrame = z.infer<typeof WorkspaceSourceFrame>;
export const WorkspaceMuxResponse = z.discriminatedUnion("type", [
  z.strictObject({
    v: z.literal(1),
    type: z.literal("frame"),
    id: z.string().uuid(),
    source: WorkspaceSourceId,
    frame: WorkspaceSourceFrame,
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("closed"),
    id: z.string().uuid(),
    source: WorkspaceSourceId,
    code: z.number().int(),
    reason: z.string().max(200),
  }),
]);
