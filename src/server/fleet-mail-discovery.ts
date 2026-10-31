import { fleetSourceId } from "../shared/fleet.js";
import { fleetAgentAddress } from "../shared/fleet-mail.js";
import {
  FleetAgentPage,
  type FleetAgentQuery,
} from "../shared/fleet-mail-api.js";
import {
  MailSourceId,
  MailDiscoveryPage,
  type MailDiscoverySource,
} from "../shared/fleet-mail-discovery.js";
import { Problem } from "../shared/problem.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetPeerMail } from "./fleet-peer-mail.js";
import type { FleetMailCaller } from "../shared/fleet-mail-worker.js";

export type FleetMailDiscoveryPort = {
  sources(): MailDiscoverySource[];
  read(
    source: string,
    query: FleetAgentQuery,
    current: () => void,
    caller?: FleetMailCaller,
  ): Promise<MailDiscoveryPage>;
};

/** Explicit source pagination keeps one offline machine out of the local
 * directory's critical path. Only the owning lifecycle supplies this port. */
export class FleetMailDiscovery implements FleetMailDiscoveryPort {
  private readonly observed = new Map<
    string,
    { binding: string; reachable: boolean; checkedAt: number }
  >();
  constructor(
    private readonly authority: FleetAuthority,
    private readonly owner: string,
    private readonly peer: Pick<FleetPeerMail, "directory">,
    private readonly clock: () => number = Date.now,
  ) {}

  private members() {
    const document = this.authority.status(this.owner).directory?.document;
    const local = document?.members.find(
      (member) => member.machineId === this.authority.identity.machineId,
    );
    return (local ? document!.members : [])
      .filter((member) => {
        if (member.machineId === local!.machineId) return true;
        try {
          this.authority.acceptedGrant(
            this.owner,
            member.machineId,
            document!.fleetId,
            local!.grantId,
            "mail",
          );
          return true;
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          return false;
        }
      })
      .map((member) => ({
        member,
        binding: `${document!.fleetId}:${local!.grantId}:${member.grantId}:${member.origin}`,
      }));
  }

  sources(): MailDiscoverySource[] {
    const members = this.members();
    const self = this.authority.identity.machineId;
    const current = new Set(members.map(({ member }) => member.machineId));
    for (const id of this.observed.keys())
      if (!current.has(id)) this.observed.delete(id);
    return [
      {
        sourceId: "",
        machineId: self,
        name:
          members.find(({ member }) => member.machineId === self)?.member
            .name ?? "This machine",
        availability: "reachable",
      },
      ...members
        .filter(({ member }) => member.machineId !== self)
        .map(({ member, binding }) => {
          const observation = this.observed.get(member.machineId);
          const recent =
            observation?.binding === binding &&
            this.clock() >= observation.checkedAt &&
            this.clock() - observation.checkedAt < 30_000;
          return {
            sourceId: fleetSourceId(member.machineId),
            machineId: member.machineId,
            name: member.name,
            availability: recent
              ? observation.reachable
                ? ("reachable" as const)
                : ("unreachable" as const)
              : ("unknown" as const),
            ...(recent ? { checkedAt: observation.checkedAt } : {}),
          };
        }),
    ];
  }

  async read(sourceId: string, query: FleetAgentQuery, current: () => void) {
    MailSourceId.parse(sourceId);
    current();
    const source = this.sources().find(
      (source) => source.sourceId === sourceId && sourceId,
    );
    const target = this.members().find(
      ({ member }) => fleetSourceId(member.machineId) === sourceId,
    );
    if (!source || !target)
      throw new Problem(
        403,
        "This machine is not authorized for agent discovery.",
      );
    const live = () => {
      current();
      if (
        !this.members().some(
          (item) =>
            item.member.machineId === target.member.machineId &&
            item.binding === target.binding,
        )
      )
        throw new Problem(403, "This machine's mail authorization changed.");
    };
    try {
      const page = FleetAgentPage.parse(
        await this.peer.directory(source.machineId, query, live),
      );
      live();
      this.observed.set(source.machineId, {
        binding: target.binding,
        reachable: true,
        checkedAt: this.clock(),
      });
      return MailDiscoveryPage.parse({
        source: {
          ...source,
          availability: "reachable",
          checkedAt: this.clock(),
        },
        agents: page.agents.map((agent) => ({
          ...agent,
          agentId: fleetAgentAddress({
            machineId: source.machineId,
            agentId: agent.agentId,
          }),
          localAgentId: agent.agentId,
          sourceId,
          executionMachine: source.name,
        })),
        nextOffset: page.nextOffset,
      });
    } catch {
      live();
      this.observed.set(source.machineId, {
        binding: target.binding,
        reachable: false,
        checkedAt: this.clock(),
      });
      return MailDiscoveryPage.parse({
        source: {
          ...source,
          availability: "unreachable",
          checkedAt: this.clock(),
        },
        agents: [],
        nextOffset: null,
        error:
          "The machine's agent directory is unavailable. Retry or re-pair its changed address. Local agents are still available.",
      });
    }
  }
}
