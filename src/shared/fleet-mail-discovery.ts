import { z } from "zod";
import { MachineId } from "./fleet.js";
import { FleetDirectoryAgent } from "./fleet-mail-api.js";

export const MailSourceId = z.union([
  z.literal(""),
  z.string().regex(/^peer:m_[a-f0-9]{64}$/),
]);
export const MailDiscoverySource = z.strictObject({
  sourceId: MailSourceId,
  machineId: MachineId,
  name: z.string().min(1).max(80),
  availability: z.enum(["unknown", "reachable", "unreachable"]),
  checkedAt: z.number().int().nonnegative().optional(),
});
export type MailDiscoverySource = z.infer<typeof MailDiscoverySource>;
export const MailDiscoveryPage = z.strictObject({
  source: MailDiscoverySource,
  agents: z
    .array(
      FleetDirectoryAgent.extend({
        agentId: z.string().max(200),
        localAgentId: z.string().uuid(),
        sourceId: MailSourceId,
        executionMachine: z.string().min(1).max(80),
      }),
    )
    .max(50),
  nextOffset: z.number().int().min(0).max(100000).nullable(),
  error: z.string().max(300).optional(),
});
export type MailDiscoveryPage = z.infer<typeof MailDiscoveryPage>;
