import { z } from "zod";
import { FleetDigest, FleetSignature, MachineId } from "./fleet.js";
import { FleetSecret } from "./fleet-credentials.js";
import { WorkspaceClock } from "./workspace-events.js";
import {
  workspaceApi,
  type RouteContract,
  type FleetRouteContract,
} from "./workspace-api.js";

// A peer selects a declared local projection, never a URL or another source.
// Private setup, provider sign-in, native bridges, integration tokens and all
// writes are deliberately absent. Streams have a separate bounded protocol.
export const fleetReadRoutes = {
  capabilities: workspaceApi.capabilities,
  agentSuggestName: workspaceApi.agentSuggestName,
  routingPreview: workspaceApi.routingPreview,
  sharePreview: workspaceApi.sharePreview,
  bootstrap: workspaceApi.bootstrap,
  feed: workspaceApi.feed,
  feedAway: workspaceApi.feedAway,
  cardList: workspaceApi.cardList,
  cardChanges: workspaceApi.cardChanges,
  cardDetail: workspaceApi.cardDetail,
  runs: workspaceApi.runs,
  conversation: workspaceApi.conversation,
  conversationActivities: workspaceApi.conversationActivities,
  conversationOutline: workspaceApi.conversationOutline,
  conversationUsage: workspaceApi.conversationUsage,
  conversationPulls: workspaceApi.conversationPulls,
  agentDetail: workspaceApi.agentDetail,
  agentHarness: workspaceApi.agentHarness,
  agentMessages: workspaceApi.agentMessages,
  agentTraces: workspaceApi.agentTraces,
  agentMail: workspaceApi.agentMail,
  doneThreadList: workspaceApi.doneThreadList,
  doneThreadDetail: workspaceApi.doneThreadDetail,
  doneThreadListPage: workspaceApi.doneThreadListPage,
  doneThreadDetailPage: workspaceApi.doneThreadDetailPage,
  messageSearch: workspaceApi.messageSearch,
  messageDetail: workspaceApi.messageDetail,
  results: workspaceApi.results,
  resultUpdates: workspaceApi.resultUpdates,
  approvals: workspaceApi.approvals,
  nativeDecisions: workspaceApi.nativeDecisions,
  session: workspaceApi.session,
  connectionModels: workspaceApi.connectionModels,
  workspace: workspaceApi.workspace,
  runtimeList: workspaceApi.runtimeList,
  folderList: workspaceApi.folderList,
  projectSummaries: workspaceApi.projectSummaries,
  savedList: workspaceApi.savedList,
  personalFiles: workspaceApi.personalFiles,
  personalDecisions: workspaceApi.personalDecisions,
  personalApproval: workspaceApi.personalApproval,
  personalProfile: workspaceApi.personalProfile,
  personalPrompts: workspaceApi.personalPrompts,
  laterList: workspaceApi.laterList,
  scheduledSendList: workspaceApi.scheduledSendList,
  snippetList: workspaceApi.snippetList,
  artifactList: workspaceApi.artifactList,
  artifactDetail: workspaceApi.artifactDetail,
  runCheckout: workspaceApi.runCheckout,
  runVerifications: workspaceApi.runVerifications,
  runFiles: workspaceApi.runFiles,
  search: workspaceApi.search,
  searchStatus: workspaceApi.searchStatus,
  preferences: workspaceApi.preferences,
  definitionList: workspaceApi.definitionList,
  definitionRead: workspaceApi.definitionRead,
  prWatchList: workspaceApi.prWatchList,
} as const satisfies Record<string, RouteContract & { method: "GET" | "POST" }>;
// These two POST routes only select a local recipient. Classify by the fixed
// owning contract, never by a caller-supplied read flag or arbitrary method.
export function isFleetReadContract(contract: {
  method: string;
  path: string;
}) {
  return Object.values(fleetReadRoutes).some(
    (route) => route.method === contract.method && route.path === contract.path,
  );
}
export const FLEET_PREVIEW_INPUT_BYTES = 192 * 1024;
export const FleetReadRoute = z.enum(
  Object.keys(fleetReadRoutes) as [
    keyof typeof fleetReadRoutes,
    ...(keyof typeof fleetReadRoutes)[],
  ],
);
export type FleetReadRoute = z.infer<typeof FleetReadRoute>;
const Name = z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/);
const Value = z.union([z.string().max(4096), z.number().finite()]);
export const FleetReadInput = z
  .strictObject({
    route: FleetReadRoute,
    params: z
      .record(Name, Value)
      .refine((value) => Object.keys(value).length <= 8),
    query: z
      .record(Name, z.union([Value, z.array(Value).max(50)]))
      .refine((value) => Object.keys(value).length <= 32),
    body: z
      .union([workspaceApi.routingPreview.body, workspaceApi.sharePreview.body])
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).length <=
          FLEET_PREVIEW_INPUT_BYTES,
      )
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      (fleetReadRoutes[value.route].method === "GET") !==
      (value.body === undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Only named preview reads accept a body; preview reads require one.",
      });
  });
export type FleetReadInput = z.infer<typeof FleetReadInput>;
const Admission = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  credential: FleetSecret,
});
export const FleetReadRequest = Admission.extend({ input: FleetReadInput });
export type FleetReadRequest = z.infer<typeof FleetReadRequest>;
export const FLEET_READ_RESPONSE_BYTES = 2 * 1024 * 1024;
// Contract-specific projection is also mandatory on both sides. This outer
// guard bounds the generic envelope before a consumer selects its contract.
export const FleetReadJson = z
  .unknown()
  .refine((value) => {
    const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const item = stack.pop()!;
      if (++count > 100_000 || item.depth > 32) return false;
      if (
        item.value === null ||
        typeof item.value === "string" ||
        typeof item.value === "boolean"
      )
        continue;
      if (typeof item.value === "number") {
        if (!Number.isFinite(item.value)) return false;
        continue;
      }
      if (typeof item.value !== "object") return false;
      if (
        !Array.isArray(item.value) &&
        Object.getPrototypeOf(item.value) !== Object.prototype &&
        Object.getPrototypeOf(item.value) !== null
      )
        return false;
      for (const child of Object.values(item.value))
        stack.push({ value: child, depth: item.depth + 1 });
    }
    return (
      new TextEncoder().encode(JSON.stringify(value)).length <=
      FLEET_READ_RESPONSE_BYTES
    );
  })
  .pipe(z.json());
const ResponseIdentity = {
  peer: MachineId,
  grantId: z.string().uuid(),
  requestDigest: FleetDigest,
};
export const FleetReadResponse = z.strictObject({
  ...ResponseIdentity,
  version: z.literal(1),
  requestId: z.string().uuid(),
  machineId: MachineId,
  directory: FleetDigest,
  result: FleetReadJson,
  clock: WorkspaceClock.optional(),
});
export type FleetReadResponse = z.infer<typeof FleetReadResponse>;
export const FleetWorkspaceCatalog = z.strictObject({
  ...ResponseIdentity,
  version: z.literal(1),
  requestId: z.string().uuid(),
  machineId: MachineId,
  directory: FleetDigest,
  profile: z.literal("companion"),
  // Unknown names from a newer peer grant no route. Keep compatible known reads.
  reads: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,99}$/)).max(100),
  actions: z.array(z.string().max(100)).max(100),
  events: z.boolean(),
  files: z.boolean(),
});
export const SignedFleetReadResponse = z.strictObject({
  response: FleetReadResponse,
  signature: FleetSignature,
});
export const SignedFleetWorkspaceCatalog = z.strictObject({
  catalog: FleetWorkspaceCatalog,
  signature: FleetSignature,
});
const base = {
  method: "POST" as const,
  params: z.strictObject({}),
  query: z.strictObject({}),
  access: "peer:workspace" as const,
};
export const fleetWorkspaceApi = {
  catalog: {
    ...base,
    path: "/fleet/peer/v1/workspace/catalog",
    body: Admission,
    response: SignedFleetWorkspaceCatalog,
  },
  read: {
    ...base,
    path: "/fleet/peer/v1/workspace/read",
    body: FleetReadRequest,
    response: SignedFleetReadResponse,
  },
} as const satisfies Record<string, FleetRouteContract>;
