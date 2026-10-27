import type { Agent } from "../shared/types";

/**
 * Who the "+" (composer launch) button addresses when it opens the chat box
 * with no draft in progress. On an agent's profile page that agent is the
 * default, ahead of the last recipient a previous send stored; off a profile
 * the last recipient is restored, as before. A profile agent that is not
 * among the available (non-retired) agents does not take over, so a retired
 * profile falls back to the last recipient.
 */
export function composerLaunchRecipient(
  availableAgents: readonly Agent[],
  profile: Pick<Agent, "id"> | null | undefined,
  lastRecipientId: string | null | undefined,
): Agent | undefined {
  if (profile) {
    const profileAgent = availableAgents.find(
      (agent) => agent.id === profile.id,
    );
    if (profileAgent) return profileAgent;
  }
  if (lastRecipientId)
    return availableAgents.find((agent) => agent.id === lastRecipientId);
  return undefined;
}
