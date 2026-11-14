import { z } from "zod";
import {
  WorkspaceClock,
  WorkspaceFrameV3,
  WorkspaceEvent,
  WorkspaceCapabilities,
  TokenEventAck,
} from "./workspace-events.js";

import { memoryRoutes } from "./memory-routes.js";
import { workspaceDeviceRoutes } from "./workspace-device-routes.js";
import { mcpRoutes } from "./mcp-routes.js";
import { appRoutes } from "./app-routes.js";
import { githubRoutes } from "./github-routes.js";
import { socialRoutes } from "./social-routes.js";
import { teamRoutes } from "./team-routes.js";
import { notificationRoutes } from "./notification-routes.js";
import { companionRoutes } from "./companion-routes.js";
import { cardRoutes } from "./card-routes.js";
import { webhookRoutes } from "./webhook-routes.js";
import { agentRoutes } from "./agent-routes.js";
import { libraryRoutes } from "./library-routes.js";
import { personalRoutes } from "./personal-routes.js";
import { mobileRoutes } from "./mobile-routes.js";
import { workspaceFeedRoutes } from "./workspace-feed-routes.js";
import { conversationRoutes } from "./conversation-routes.js";
export {
  PublicAgent,
  PublicConnection,
  PublicFolder,
  PublicTeam,
  PublicMessage,
  PublicArtifact,
  PublicRun,
  Bootstrap,
  FeedItem,
  FeedPage,
  ConversationPage,
  ResultItem,
  Approval,
  NativeDecision,
  CardErrorSchema,
} from "./workspace-contract-schemas.js";
export type {
  RouteContract,
  FleetRouteContract,
  CommandRouteContract,
  RouteInput,
  RouteResponse,
} from "./route-contract.js";
export const workspaceRoutes = {
  ...memoryRoutes,
  ...workspaceDeviceRoutes,
  ...mcpRoutes,
  ...appRoutes,
  ...githubRoutes,
  ...socialRoutes,
  ...teamRoutes,
  ...notificationRoutes,
  ...companionRoutes,
  ...cardRoutes,
  ...webhookRoutes,
  ...agentRoutes,
  ...libraryRoutes,
  ...personalRoutes,
  ...mobileRoutes,
  ...workspaceFeedRoutes,
  ...conversationRoutes,
} as const;
// Channels share the registry without
// being mounted as Express routes or widening the typed HTTP helpers.
export const workspaceApi = {
  ...workspaceRoutes,
  channels: {
    events: {
      kind: "socket",
      path: "/events/ws",
      pairedPath: "/ws",
      query: z.object({ v: z.literal("3") }),
      frames: WorkspaceFrameV3,
      event: WorkspaceEvent,
      capabilities: WorkspaceCapabilities,
      clock: WorkspaceClock,
      fallback: workspaceRoutes.events,
    },
    tokenEvents: {
      kind: "socket",
      path: workspaceRoutes.tokenEvents.path,
      security: { IntegrationBearer: [] },
      query: workspaceRoutes.tokenEvents.query,
      frames: WorkspaceFrameV3,
      request: workspaceRoutes.tokenEvents,
      confirmation: TokenEventAck,
      fallback: workspaceRoutes.events,
    },
  },
} as const;
