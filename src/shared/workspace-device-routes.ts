import { z } from "zod";
import * as app from "./app-contract-schemas.js";
import * as mcp from "./mcp-contract-schemas.js";
import { Ok, endpoint, base } from "./route-contract.js";

export const workspaceDeviceRoutes = {
  agentSources: endpoint({
    ...base,
    operation: "agentSources",
    method: "GET",
    path: "/agent-sources",
    security: "paired-device",
    response: mcp.PublicAgentSources,
  }),
  workspaceDevices: endpoint({
    ...base,
    operation: "workspaceDevices",
    method: "GET",
    path: "/workspace/devices",
    security: "paired-device",
    response: z.array(app.PublicPairedDevice),
  }),
  workspaceRevoke: endpoint({
    ...base,
    operation: "workspaceRevoke",
    method: "POST",
    path: "/workspace/revoke",
    security: "paired-device",
    body: app.PairedDeviceRevokeInput,
    response: Ok,
  }),
} as const;
