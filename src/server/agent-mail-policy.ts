import { harnesses, isHarness } from "../shared/harnesses.js";
import * as teamMembersQueries from "./sql/team-members.js";
import * as agentsQueries from "./sql/agents.js";
import * as connectionsQueries from "./sql/connections.js";
import * as teamsQueries from "./sql/teams.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as delegationsQueries from "./sql/delegations.js";
import * as agentThreadMembersQueries from "./sql/agent-thread-members.js";
import * as identityQueries from "./sql/fleet-machine-identity.js";
import * as mailQueries from "./sql/agent-mail.js";
import * as runsQueries from "./sql/runs.js";
import { maybeConnection } from "./row-schemas.js";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import {
  fleetAgentAddress,
  parseFleetAgentAddress,
} from "../shared/fleet-mail.js";
import { FleetAuthority } from "./fleet-authority.js";
import { FleetMailBindings } from "./fleet-mail-bindings.js";
import * as fleetSecrets from "./secrets.js";

/** A refusal that recovery cannot repair. Disconnection is deliberately absent. */
export class MailRefusal extends Problem {}
let fleetAuthority: FleetAuthority | undefined;
export function mailAuthority() {
  if (!identityQueries.exists(db))
    throw new MailRefusal(403, "Remote mail is unavailable in this workspace.");
  // Read the same durable directory as the gateway. This instance performs no
  // enrollment, credential issuance or network activity in the execution worker.
  return (fleetAuthority ??= new FleetAuthority(db, fleetSecrets));
}
export function fleetMailBindings(owner: string) {
  return new FleetMailBindings(db, mailAuthority(), owner);
}
export function normalizeMailAgentId(value: string) {
  const reference = parseFleetAgentAddress(value);
  if (!reference) return value;
  return reference.machineId === mailAuthority().identity.machineId
    ? reference.agentId
    : fleetAgentAddress(reference);
}
export type MailThread = {
  id: string;
  owner_id: string;
  scope: "direct" | "team";
  team_id: string | null;
};
export type MailTeam = {
  id: string;
  owner_id: string;
  name: string;
  manager_id: string;
  conversation_id: string | null;
  deleted_at: number | null;
};
export function memberRole(team: MailTeam, agentId: string) {
  if (team.manager_id === agentId) return "manager" as const;
  return teamMembersQueries.exists(db, team.id, agentId)
    ? ("worker" as const)
    : undefined;
}

export function eligibleMailAgent(owner: string, agentId: string) {
  const agent = agentsQueries.owned(db, agentId, owner);
  if (!agent) throw new MailRefusal(404, "Agent not found in this workspace.");
  if (agent.retired_at)
    throw new MailRefusal(
      409,
      `@${agent.name} is retired and can't receive messages.`,
    );
  const connection = maybeConnection(
    connectionsQueries.owned(db, agent.connection_id ?? null, owner),
  );
  if (!connection)
    throw new MailRefusal(
      409,
      "This agent needs a provider connection before it can receive mail.",
    );
  const meta = connection.metadata;
  if (
    meta.loopHarness &&
    isHarness(meta.loopHarness) &&
    !harnesses[meta.loopHarness].agentMail
  )
    throw new MailRefusal(
      409,
      `${harnesses[meta.loopHarness].label} does not expose Loop workspace tools. Agent mail and team delegation require another harness.`,
    );
  if (meta.loopHarness != null && !isHarness(meta.loopHarness))
    throw new MailRefusal(
      409,
      "This native connection uses an unsupported harness.",
    );
  if (teamsQueries.hasReviewAgent(db, owner, agentId))
    throw new MailRefusal(
      409,
      "Snapshot review agents accept work only through Review changes.",
    );
  return agent;
}

export function mailConversation(
  owner: string,
  agent: string,
  conversation: string,
) {
  const row = conversationsQueries.ownedAgentConversation(
    db,
    conversation,
    owner,
    agent,
  );
  if (!row)
    throw new MailRefusal(
      404,
      "The bound conversation is unavailable. Start a new message thread.",
    );
  if (runsQueries.hasReviewInConversation(db, conversation, owner))
    throw new MailRefusal(
      409,
      "The bound conversation cannot accept agent mail. Start a new message thread.",
    );
  return conversation;
}

/** Used at submission, recovery, Resume, and the worker's atomic claim. */
export function authorizeMail(
  thread: MailThread,
  sender: string,
  recipient: string,
  resultRunId?: string | null,
) {
  let remote;
  try {
    remote =
      parseFleetAgentAddress(sender) || parseFleetAgentAddress(recipient);
  } catch {
    throw new MailRefusal(400, "Invalid remote agent reference.");
  }
  if (remote) {
    if (
      thread.scope !== "direct" ||
      thread.team_id !== null ||
      resultRunId !== undefined
    )
      throw new MailRefusal(
        403,
        "Remote messages do not confer team or delegation authority.",
      );
    let bound;
    try {
      bound = fleetMailBindings(thread.owner_id).authorize(
        thread.id,
        sender,
        recipient,
      );
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      throw new MailRefusal(error.status, error.message);
    }
    eligibleMailAgent(thread.owner_id, bound.binding.local_agent_id);
    const conversation = bound.members.find(
      (m) => m.agent_id === bound.binding.local_agent_id,
    )!.conversation_id;
    if (conversation)
      mailConversation(
        thread.owner_id,
        bound.binding.local_agent_id,
        conversation,
      );
    return;
  }
  // A stored background result belongs to the accepted delegation, not to
  // the worker's current team membership or ability to start another turn.
  // Ordinary messages never supply this internal provenance.
  if (resultRunId !== undefined) {
    const parent =
      thread.scope === "team" &&
      delegationsQueries.backgroundParentState(
        db,
        thread.owner_id,
        sender,
        recipient,
        resultRunId,
        thread.team_id,
      );
    if (!parent)
      throw new MailRefusal(
        403,
        "This result has no authorized background delegation.",
      );
    if (parent.state === "cancelled")
      throw new MailRefusal(
        409,
        "The delegating task was cancelled. Its result was not delivered.",
      );
  } else eligibleMailAgent(thread.owner_id, sender);
  eligibleMailAgent(thread.owner_id, recipient);
  if (sender === recipient)
    throw new MailRefusal(400, "You can't message yourself.");
  if (thread.scope === "team") {
    const team = teamsQueries.activeOwned(db, thread.team_id, thread.owner_id);
    if (
      !team ||
      (resultRunId === undefined && !memberRole(team, sender)) ||
      !memberRole(team, recipient)
    )
      throw new MailRefusal(
        403,
        "Message only members of this team. Its membership may have changed.",
      );
    return team;
  }
  const members = agentThreadMembersQueries.members(db, thread.id);
  if (
    members.length !== 2 ||
    ![sender, recipient].every((a) => members.some((m) => m.agent_id === a))
  )
    throw new MailRefusal(
      403,
      "A direct thread has two fixed participants. Start a new thread to contact another agent.",
    );
  for (const member of members)
    if (member.conversation_id)
      mailConversation(
        thread.owner_id,
        member.agent_id,
        member.conversation_id,
      );
}

/** Refuse obsolete queued mail before it can cause an external effect. */
export function queuedMailFailure(runId: string): string | undefined {
  const mail = mailQueries.forQueuedRun(db, runId) as
    | {
        id: string;
        owner_id: string;
        scope: MailThread["scope"];
        team_id: string | null;
        thread_id: string;
        sender_agent_id: string;
        recipient_agent_id: string;
        recipient_conversation_id: string | null;
        kind: string;
        sender_run_id: string | null;
        state: string;
        error: string | null;
      }
    | undefined;
  if (!mail) return;
  try {
    if (mail.state === "refused")
      throw new MailRefusal(409, mail.error ?? "Mail was refused.");
    authorizeMail(
      { ...mail, id: mail.thread_id },
      mail.sender_agent_id,
      mail.recipient_agent_id,
      mail.kind === "result" ? mail.sender_run_id : undefined,
    );
    if (mail.recipient_conversation_id)
      mailConversation(
        mail.owner_id,
        mail.recipient_agent_id,
        mail.recipient_conversation_id,
      );
    const selected = runsQueries.mailConnection(db, runId)!;
    // A queued turn retains its original provider selection. If that provider
    // is gone, or the agent has moved away from its disconnected provider,
    // fail visibly instead of waiting forever or silently changing billing.
    if (
      !selected.status ||
      (selected.status !== "connected" && selected.id !== selected.current_id)
    )
      throw new MailRefusal(
        409,
        "The provider selected for this mail is no longer available. Start a new message thread.",
      );
  } catch (error) {
    if (!(error instanceof MailRefusal)) throw error;
    mailQueries.refuse(db, error.message, mail.id);
    return error.message;
  }
}

export function queuedMailReady(run: {
  id: string;
  owner_id: string;
  payload: import("./row-schemas.js").RunPayload;
}) {
  if (!mailQueries.hasQueuedRun(db, run.id)) return true;
  const connection = connectionsQueries.status(
    db,
    run.payload.connectionId,
    run.owner_id,
  );
  return connection?.status === "connected";
}
