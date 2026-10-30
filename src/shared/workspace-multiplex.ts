import { z } from "zod";
import { WorkspaceFrameV3 } from "./workspace-events.js";
import { FleetEventSubscription } from "./fleet-workspace-events.js";

export const WORKSPACE_MULTIPLEX_PATH = "/api/events/multiplex/ws";
export const WorkspaceSourceId = z
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
// v2 sources support invalidation only; never forward their untyped payloads.
export const WorkspaceSourceFrame = z.union([
  WorkspaceFrameV3,
  z.object({
    v: z.literal(2),
    type: z.enum(["reset", "events"]),
    epoch: z.string().min(1).max(200),
    cursor: z.number().int().nonnegative().safe(),
    build: z.string().max(1000).optional(),
    buildIdentity: z.unknown().optional(),
  }),
]);
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
