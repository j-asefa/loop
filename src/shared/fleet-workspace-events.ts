import { z } from "zod";
import {
  type WorkspaceEvent,
  type WorkspaceScope,
  WorkspaceFrameV3,
  eventScopes,
  invalidate,
} from "./workspace-events.js";
import { FleetDigest, FleetSignature, MachineId } from "./fleet.js";

export const FLEET_EVENTS_PATH = "/api/fleet/peer/v1/workspace/events/ws";
export const FLEET_EVENT_BYTES = 512 * 1024;
export const FLEET_EVENT_BUFFER_BYTES = 2 * 1024 * 1024;
export const FleetEventSubscription = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  epoch: z.string().max(200),
  cursor: z.number().int().nonnegative().safe(),
  conversations: z.array(z.string().min(1).max(1000)).max(16),
  runs: z.array(z.string().min(1).max(1000)).max(16),
});
export type FleetEventSubscription = z.infer<typeof FleetEventSubscription>;
export const FleetEventResponse = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  sequence: z.number().int().nonnegative().safe(),
  machineId: MachineId,
  peer: MachineId,
  grantId: z.string().uuid(),
  directory: FleetDigest,
  frame: WorkspaceFrameV3,
});
export const SignedFleetEventResponse = z.strictObject({
  response: FleetEventResponse,
  signature: FleetSignature,
});

/** Feed results, run status and approvals keep their source-level contract.
 * Transcripts require an opened conversation; other detail may select a run.
 * A scoped invalidation still advances the owning source's durable cursor. */
export function fleetEventProjection(
  event: WorkspaceEvent,
  selection: Pick<FleetEventSubscription, "conversations" | "runs">,
): WorkspaceEvent {
  if (
    event.type.startsWith("message.") ||
    event.type.startsWith("native.") ||
    [
      "trace.updated",
      "activity.updated",
      "provider.receipt",
      "progress",
    ].includes(event.type)
  ) {
    const allScopes = eventScopes(event);
    // Secondary scopes describe refresh dependencies, not permission to send
    // this event's detail payload for another selected conversation or run.
    const selected =
      event.type === "native.event"
        ? selection.conversations.includes(event.payload.conversationId)
        : (event.scope.kind === "conversation" &&
            selection.conversations.includes(event.scope.id)) ||
          (!event.type.startsWith("message.") &&
            event.scope.kind === "run" &&
            selection.runs.includes(event.scope.id));
    if (selected) return event;
    // The delta client derives these refreshes from the original event type.
    // Preserve them explicitly when removing that type and its detail payload.
    const collection =
      event.type === "provider.receipt" || event.type === "native.usage"
        ? "usage"
        : event.type === "trace.updated" || event.type === "activity.updated"
          ? "activities"
          : undefined;
    const dependencies: WorkspaceScope[] = collection
      ? [...allScopes, { kind: "collection", id: collection }]
      : allScopes;
    const extra = new Map<string, WorkspaceScope>();
    for (const scope of dependencies) {
      if (scope.kind === event.scope.kind && scope.id === event.scope.id)
        continue;
      extra.set(`${scope.kind}:${scope.id}`, scope);
    }
    // A source-scoped broad refresh preserves correctness when the extra
    // dependency would exceed the event contract's 32 secondary scopes.
    if (extra.size > 32)
      return invalidate({ kind: "collection", id: "all" }, event.subject);
    return {
      type: "invalidate",
      scope: event.scope,
      ...(event.subject ? { subject: event.subject } : {}),
      ...(extra.size ? { scopes: [...extra.values()] } : {}),
    };
  }
  return event;
}
