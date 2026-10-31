import { z } from "zod";
import { FleetDigest, FleetSignature, MachineId } from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";
import { FleetReadJson } from "./fleet-workspace-api.js";
import {
  workspaceApi,
  type RouteContract,
  type FleetRouteContract,
} from "./workspace-api.js";

// These are the destination's ordinary owning handlers. Provider setup, private
// execution, cross-source teams and arbitrary proxy paths are not operations.
export const fleetActionRoutes = {
  agentCreate: workspaceApi.agentCreate,
  agentUpdate: workspaceApi.agentUpdate,
  agentMailResume: workspaceApi.agentMailResume,
  teamThreadResume: workspaceApi.teamThreadResume,
  doneThreadCreate: workspaceApi.doneThreadCreate,
  doneThreadMove: workspaceApi.doneThreadMove,
  doneThreadRemove: workspaceApi.doneThreadRemove,
  doneThreadRemoveCard: workspaceApi.doneThreadRemoveCard,
  doneThreadRead: workspaceApi.doneThreadRead,
  doneThreadUnread: workspaceApi.doneThreadUnread,
  submit: workspaceApi.submit,
  shareSend: workspaceApi.shareSend,
  runAction: workspaceApi.runAction,
  approval: workspaceApi.approval,
  nativeAnswer: workspaceApi.nativeAnswer,
  setting: workspaceApi.setting,
  resultUpdate: workspaceApi.resultUpdate,
  conversationPosition: workspaceApi.conversationPosition,
  feedUpdate: workspaceApi.feedUpdate,
  feedRead: workspaceApi.feedRead,
  feedUnread: workspaceApi.feedUnread,
  replyState: workspaceApi.replyState,
  messageSave: workspaceApi.messageSave,
  messageUnsave: workspaceApi.messageUnsave,
  savedLabel: workspaceApi.savedLabel,
  laterCreate: workspaceApi.laterCreate,
  laterFinish: workspaceApi.laterFinish,
  laterSnooze: workspaceApi.laterSnooze,
  laterReopen: workspaceApi.laterReopen,
  projectOpened: workspaceApi.projectOpened,
  scheduledSendCreate: workspaceApi.scheduledSendCreate,
  scheduledSendCancel: workspaceApi.scheduledSendCancel,
  scheduledSendUpdate: workspaceApi.scheduledSendUpdate,
  scheduledSendRetry: workspaceApi.scheduledSendRetry,
  runReorder: workspaceApi.runReorder,
  runUpdate: workspaceApi.runUpdate,
  runWithdraw: workspaceApi.runWithdraw,
  runMove: workspaceApi.runMove,
  conversationFork: workspaceApi.conversationFork,
  conversationContinue: workspaceApi.conversationContinue,
  conversationContinueStart: workspaceApi.conversationContinueStart,
  folderCreate: workspaceApi.folderCreate,
  folderUpdate: workspaceApi.folderUpdate,
  workspaceProjectCreate: workspaceApi.workspaceProjectCreate,
  workspaceProjectUpdate: workspaceApi.workspaceProjectUpdate,
  artifactCreate: workspaceApi.artifactCreate,
  artifactUpdate: workspaceApi.artifactUpdate,
  artifactMove: workspaceApi.artifactMove,
  operationUndo: workspaceApi.operationUndo,
} as const satisfies Record<string, RouteContract>;
export const FleetActionRoute = z.enum(
  Object.keys(fleetActionRoutes) as [
    keyof typeof fleetActionRoutes,
    ...(keyof typeof fleetActionRoutes)[],
  ],
);
export const FLEET_ACTION_INPUT_BYTES = 768 * 1024;
export const FleetActionInput = z.strictObject({
  route: FleetActionRoute,
  params: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), z.string().max(4096))
    .refine((value) => Object.keys(value).length <= 8),
  body: FleetReadJson.refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      FLEET_ACTION_INPUT_BYTES,
  ),
});
export type FleetActionInput = z.infer<typeof FleetActionInput>;
export const FleetActionReference = z.strictObject({
  route: FleetActionRoute,
  payloadDigest: FleetDigest,
});
export type FleetActionReference = z.infer<typeof FleetActionReference>;
const Admission = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  commandId: z.string().uuid(),
  credential: FleetSecret,
});
export const FleetActionRequest = Admission.extend({ input: FleetActionInput });
export type FleetActionRequest = z.infer<typeof FleetActionRequest>;
export const FleetActionReceipt = z.strictObject({
  commandId: z.string().uuid(),
  state: z.enum(["started", "completed", "unknown", "refused"]),
  result: FleetReadJson.nullable(),
});
export const FleetActionResponse = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  machineId: MachineId,
  peer: MachineId,
  directory: FleetDigest,
  grantId: z.string().uuid(),
  requestDigest: FleetDigest,
  receipt: FleetActionReceipt.nullable(),
});
export const SignedFleetActionResponse = z.strictObject({
  response: FleetActionResponse,
  signature: FleetSignature,
});
const base = {
  method: "POST" as const,
  params: z.strictObject({}),
  query: z.strictObject({}),
  access: "peer:workspace" as const,
  response: SignedFleetActionResponse,
};
export const fleetWorkspaceActionApi = {
  action: {
    ...base,
    path: "/fleet/peer/v1/workspace/action",
    body: FleetActionRequest,
  },
  receipt: {
    ...base,
    path: "/fleet/peer/v1/workspace/receipt",
    body: Admission.extend({
      payloadDigest: FleetDigest,
      route: FleetActionRoute.optional(),
    }),
  },
} as const satisfies Record<string, FleetRouteContract>;
