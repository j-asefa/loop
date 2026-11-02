import * as agentThreadMembersQueries from "./sql/agent-thread-members.js";
import * as identityQueries from "./sql/fleet-machine-identity.js";
import * as mailQueries from "./sql/agent-mail.js";
import * as runsQueries from "./sql/runs.js";
import { maybeConnection } from "./row-schemas.js";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import { companionMode } from "./profile.js";
import type { Agent } from "../shared/types.js";
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
  if (!companionMode || !identityQueries.exists(db))
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
  return db
    .prepare("SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?")
    .get(team.id, agentId)
    ? ("worker" as const)
    : undefined;
}

export function eligibleMailAgent(owner: string, agentId: string) {
  const agent = db
    .prepare("SELECT * FROM agents WHERE id=? AND owner_id=?")
    .get(agentId, owner) as Agent | undefined;
  if (!agent) throw new MailRefusal(404, "Agent not found in this workspace.");
  if (agent.retired_at)
    throw new MailRefusal(
      409,
      `@${agent.name} is retired and can't receive messages.`,
    );
  const connection = maybeConnection(
    db
      .prepare("SELECT * FROM connections WHERE id=? AND owner_id=?")
      .get(agent.connection_id ?? null, owner),
  );
  if (!connection)
    throw new MailRefusal(
      409,
      "This agent needs a provider connection before it can receive mail.",
    );
  const meta = connection.metadata;
  if (meta.loop55Harness === "antigravity")
    throw new MailRefusal(
      409,
      "Antigravity does not expose Loop55 workspace tools. Agent mail and team delegation require another harness.",
    );
  if (meta.backend === "hapi")
    throw new MailRefusal(
      409,
      "Archived HAPI agents cannot receive mail. Select a supported connection first.",
    );
  if (
    meta.loop55Harness != null &&
    (!companionMode ||
      ![
        "codex",
        "claude",
        "pi",
        "opencode",
        "gemini",
        "muse",
        "grok",
        "acp",
      ].includes(meta.loop55Harness))
  )
    throw new MailRefusal(
      409,
      "This native connection cannot execute in this deployment profile.",
    );
  if (
    db
      .prepare(
        "SELECT 1 FROM teams t WHERE t.owner_id=? AND t.preset_id='code-review' AND t.deleted_at IS NULL AND (t.manager_id=? OR EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.agent_id=?))",
      )
      .get(owner, agentId, agentId)
  )
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
  const row = db
    .prepare(
      "SELECT * FROM conversations WHERE id=? AND owner_id=? AND agent_id=?",
    )
    .get(conversation, owner, agent) as
    { execution_backend: string | null } | undefined;
  if (!row)
    throw new MailRefusal(
      404,
      "The bound conversation is unavailable. Start a new message thread.",
    );
  if (
    row.execution_backend === "hapi" ||
    runsQueries.hasReviewInConversation(db, conversation, owner)
  )
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
      (db
        .prepare(
          `SELECT p.state FROM delegations d
       JOIN runs child ON child.id=d.child_run_id AND child.owner_id=? AND child.agent_id=?
       JOIN agents sender ON sender.id=child.agent_id AND sender.owner_id=child.owner_id
       JOIN runs p ON p.id=d.parent_run_id AND p.owner_id=child.owner_id AND p.agent_id=?
       WHERE d.child_run_id=? AND d.background=1 AND json_extract(p.payload,'$.teamId')=?`,
        )
        .get(
          thread.owner_id,
          sender,
          recipient,
          resultRunId,
          thread.team_id,
        ) as { state: string } | undefined);
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
    const team = db
      .prepare(
        "SELECT * FROM teams WHERE id=? AND owner_id=? AND deleted_at IS NULL",
      )
      .get(thread.team_id, thread.owner_id) as MailTeam | undefined;
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
  const members = agentThreadMembersQueries.members(db, thread.id) as {
    agent_id: string;
    conversation_id: string | null;
  }[];
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
  const mail = mailQueries.forQueuedRun(db, runId, runId) as
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
    const selected = runsQueries.mailConnection(db, runId) as {
      id: string;
      status: string | null;
      current_id: string;
    };
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
  if (!mailQueries.hasQueuedRun(db, run.id, run.id)) return true;
  const connection = db
    .prepare("SELECT status FROM connections WHERE id=? AND owner_id=?")
    .get(run.payload.connectionId, run.owner_id) as
    { status: string } | undefined;
  return connection?.status === "connected";
}
