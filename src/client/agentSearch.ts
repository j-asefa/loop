import type { Agent } from "../shared/types";

export function matchingAgents<T extends Pick<Agent, "id" | "name" | "folder_id">>(
  agents: T[],
  query: string,
  filters: { agent?: string; folder?: string } = {},
): T[] {
  const name = query.trim().replace(/^@/, "").toLowerCase();
  if (!name) return [];
  return agents.filter(a =>
    (!filters.agent || a.id === filters.agent) &&
    (!filters.folder || a.folder_id === filters.folder) &&
    a.name.toLowerCase().includes(name),
  );
}
