import * as profileQueries from "./sql/deployment-profile.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { MachineId } from "../shared/fleet.js";
import {
  FleetAgentReference,
  fleetAgentAddress,
} from "../shared/fleet-mail.js";
import { Problem } from "../shared/problem.js";
import type { FleetAuthority } from "./fleet-authority.js";

const Id = z.string().uuid();
const Binding = z.strictObject({
  thread_id: Id,
  owner_id: z.string().min(1).max(256),
  origin_id: MachineId,
  wire_thread_id: Id,
  local_agent_id: Id,
  peer_id: MachineId,
  remote_agent_id: Id,
  remote_name: z.string().min(1).max(200),
  fleet_id: Id,
  local_grant_id: Id,
  peer_grant_id: Id,
});
export type FleetMailThreadBinding = z.infer<typeof Binding>;
const refusal = () =>
  new Problem(403, "The original remote mail thread or grant is unavailable.");
const BindInput = z.strictObject({
  threadId: Id,
  origin: MachineId,
  wireThreadId: Id,
  localAgentId: Id,
  remote: FleetAgentReference,
  remoteName: z.string().min(1).max(200),
  fleetId: Id,
  localGrantId: Id,
  peerGrantId: Id,
});

/** Owns only direct thread attribution. The existing mail policy still checks
 * local agents, conversations, quotas and queue/steering eligibility. A remote
 * reference is never projected as a local agent or team member. */
export class FleetMailBindings {
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly owner: string,
  ) {}
  private current(binding: FleetMailThreadBinding) {
    const profile = profileQueries.current(this.db) as
      { profile: string } | undefined;
    if (profile?.profile !== "companion" || binding.owner_id !== this.owner)
      throw refusal();
    const directory = this.authority.directory(this.owner)?.document;
    const local = directory?.members.find(
      (m) => m.machineId === this.authority.identity.machineId,
    );
    const peer = directory?.members.find(
      (m) => m.machineId === binding.peer_id,
    );
    if (
      !directory ||
      !local ||
      !peer ||
      peer.machineId === local.machineId ||
      ![local.machineId, peer.machineId].includes(binding.origin_id) ||
      directory.fleetId !== binding.fleet_id ||
      local.grantId !== binding.local_grant_id ||
      peer.grantId !== binding.peer_grant_id
    )
      throw refusal();
    this.authority.acceptedGrant(
      this.owner,
      peer.machineId,
      directory.fleetId,
      local.grantId,
      "mail",
    );
    return { local, peer, directory };
  }
  private participants(binding: FleetMailThreadBinding) {
    const thread = this.db
      .prepare(
        "SELECT scope,team_id FROM agent_threads WHERE owner_id=? AND id=?",
      )
      .get(this.owner, binding.thread_id) as
      { scope: string; team_id: string | null } | undefined;
    const local = this.db
      .prepare("SELECT 1 FROM agents WHERE owner_id=? AND id=?")
      .get(this.owner, binding.local_agent_id);
    if (
      !thread ||
      thread.scope !== "direct" ||
      thread.team_id !== null ||
      !local
    )
      throw refusal();
    const remote = fleetAgentAddress({
      machineId: binding.peer_id,
      agentId: binding.remote_agent_id,
    });
    const members = this.db
      .prepare(
        "SELECT agent_id,conversation_id FROM agent_thread_members WHERE thread_id=?",
      )
      .all(binding.thread_id) as {
      agent_id: string;
      conversation_id: string | null;
    }[];
    if (
      members.length !== 2 ||
      ![binding.local_agent_id, remote].every((agent) =>
        members.some((member) => member.agent_id === agent),
      )
    )
      throw refusal();
    return { remote, members };
  }
  get(threadId: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM fleet_mail_threads WHERE owner_id=? AND thread_id=?",
      )
      .get(this.owner, Id.parse(threadId));
    return row ? Binding.parse(row) : null;
  }
  find(origin: string, wireThreadId: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM fleet_mail_threads WHERE owner_id=? AND origin_id=? AND wire_thread_id=?",
      )
      .get(this.owner, MachineId.parse(origin), Id.parse(wireThreadId));
    return row ? Binding.parse(row) : null;
  }
  originate(
    threadId: string,
    localAgentId: string,
    remote: { machineId: string; agentId: string },
    remoteName: string,
  ) {
    const directory = this.authority.directory(this.owner)?.document;
    const local = directory?.members.find(
      (member) => member.machineId === this.authority.identity.machineId,
    );
    const peer = directory?.members.find(
      (member) => member.machineId === remote.machineId,
    );
    if (!directory || !local || !peer) throw refusal();
    return this.bind({
      threadId,
      origin: local.machineId,
      wireThreadId: threadId,
      localAgentId,
      remote,
      remoteName,
      fleetId: directory.fleetId,
      localGrantId: local.grantId,
      peerGrantId: peer.grantId,
    });
  }
  bind(input: z.input<typeof BindInput>) {
    const value = BindInput.parse(input);
    const binding: FleetMailThreadBinding = {
      owner_id: this.owner,
      thread_id: value.threadId,
      origin_id: value.origin,
      wire_thread_id: value.wireThreadId,
      local_agent_id: value.localAgentId,
      peer_id: value.remote.machineId,
      remote_agent_id: value.remote.agentId,
      remote_name: value.remoteName,
      fleet_id: value.fleetId,
      local_grant_id: value.localGrantId,
      peer_grant_id: value.peerGrantId,
    };
    return this.db
      .transaction(() => {
        this.current(binding);
        this.participants(binding);
        const previous =
          this.get(value.threadId) ??
          this.find(value.origin, value.wireThreadId);
        if (previous) {
          for (const field of Object.keys(
            binding,
          ) as (keyof FleetMailThreadBinding)[])
            if (field !== "remote_name" && binding[field] !== previous[field])
              throw refusal();
          this.db
            .prepare(
              "UPDATE fleet_mail_threads SET remote_name=? WHERE owner_id=? AND thread_id=?",
            )
            .run(binding.remote_name, this.owner, binding.thread_id);
        } else
          this.db
            .prepare(
              `INSERT INTO fleet_mail_threads
        (thread_id,owner_id,origin_id,wire_thread_id,local_agent_id,peer_id,remote_agent_id,remote_name,fleet_id,local_grant_id,peer_grant_id)
        VALUES(@thread_id,@owner_id,@origin_id,@wire_thread_id,@local_agent_id,@peer_id,@remote_agent_id,@remote_name,@fleet_id,@local_grant_id,@peer_grant_id)`,
            )
            .run(binding);
        return binding;
      })
      .immediate();
  }
  authorize(threadId: string, sender: string, recipient: string) {
    const binding = this.get(threadId);
    if (!binding) throw refusal();
    const current = this.current(binding);
    const participants = this.participants(binding);
    if (
      sender === recipient ||
      ![sender, recipient].every(
        (agent) =>
          agent === binding.local_agent_id || agent === participants.remote,
      )
    )
      throw refusal();
    return { binding, ...current, ...participants };
  }
}
