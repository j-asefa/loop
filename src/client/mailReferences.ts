import type {
  MailThread,
  PublicMailAgentReference,
} from "../shared/agent-mail";
import type { FleetState } from "./FleetContext";

export function mailReferenceId(reference: PublicMailAgentReference) {
  return reference.kind === "peer"
    ? `peer:${reference.machineId}:${reference.agentId}`
    : reference.agentId;
}

export function mailReferenceName(
  reference: PublicMailAgentReference | undefined,
  fallback: string,
  fleet: FleetState | null,
) {
  if (!reference) return fallback;
  const name = reference.name ?? "former agent";
  if (reference.kind === "local") return name;
  const members = fleet?.directory?.document.members ?? [];
  const machine = members.find(
    (member) => member.machineId === reference.machineId,
  );
  const shortId = reference.machineId.slice(2, 10);
  const label = machine
    ? members.filter((member) => member.name === machine.name).length > 1
      ? `${machine.name} (${shortId})`
      : machine.name
    : `machine ${shortId}`;
  return `${name} on ${label}`;
}

/** A remote conversation is resolved against this browser's gateway, never
 * against the machine whose mail sheet happens to be open. */
export function mailConversationTarget(
  message: MailThread["messages"][number],
  source: string,
  fleet: FleetState | null,
  directoryUnavailable = false,
) {
  const remote = message.remote_conversation;
  if (remote) {
    if (
      !fleet ||
      directoryUnavailable ||
      message.to_ref?.kind !== "peer" ||
      message.to_ref.machineId !== remote.machineId
    )
      return null;
    if (remote.machineId === fleet.identity.machineId)
      return { id: remote.conversationId, source: "" };
    if (
      !fleet.scope.includes("read") ||
      !["controller", "replica"].includes(fleet.state) ||
      !fleet.directory?.document.members.some(
        (member) => member.machineId === remote.machineId,
      )
    )
      return null;
    return { id: remote.conversationId, source: `peer:${remote.machineId}` };
  }
  // Older projections expose only a source-local conversation. A remote ID
  // must not become local just because the peer projection is incomplete.
  if (message.to_ref?.kind === "peer") return null;
  return message.conversation_id
    ? { id: message.conversation_id, source }
    : null;
}
