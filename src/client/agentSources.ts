import { useEffect, useState } from "react";
import type { Agent, Connection, Folder, Run } from "../shared/types";
import { apiInWorkspace, parse } from "./api";
import { capabilities } from "./capabilities";
import { executionSourceId } from "./sourceRouting";

export type AgentSource = { id: string; name: string; kind?: string };
export type EnvironmentAgent = Agent & {
  sourceId?: string;
  executionEnvironment?: string;
};
export type EnvironmentRun = Run & { sourceId?: string };
export type EnvironmentConnection = Connection & {
  sourceId?: string;
  executionEnvironment?: string;
};
export type EnvironmentFolder = Folder & { sourceId?: string };

type CurrentData = {
  agents: Agent[];
  connections: Connection[];
  folders: Folder[];
  runs: Run[];
};
type Projection = {
  agents: EnvironmentAgent[];
  connections: EnvironmentConnection[];
  folders: EnvironmentFolder[];
  runs: EnvironmentRun[];
};
type SourceState = Projection & {
  owner?: string;
  currentSourceId: string;
  sources: AgentSource[];
  error: string;
};

const laptop: AgentSource = { id: "", name: "This laptop" };
const empty: Projection = {
  agents: [],
  connections: [],
  folders: [],
  runs: [],
};

export function agentEnvironment(
  agent: Agent,
  connections: Connection[],
  source: AgentSource,
) {
  const connection = connections.find(
    (item) => item.id === agent.connection_id,
  );
  const runtime = parse<{ environmentName?: string }>(
    connection?.metadata,
    {},
  ).environmentName;
  if (source.id)
    return runtime && runtime !== "This laptop" && runtime !== source.name
      ? `${source.name} · ${runtime}`
      : source.name;
  return runtime || laptop.name;
}

function project(source: AgentSource, data: CurrentData): Projection {
  return {
    agents: data.agents.map((agent) => ({
      ...agent,
      sourceId: source.id,
      executionEnvironment: agentEnvironment(agent, data.connections, source),
    })),
    connections: data.connections.map((connection) => ({
      ...connection,
      sourceId: source.id,
      executionEnvironment: source.id
        ? source.name
        : parse<{ environmentName?: string }>(connection.metadata, {})
            .environmentName || laptop.name,
    })),
    folders: data.folders.map((folder) => ({ ...folder, sourceId: source.id })),
    runs: data.runs.map((run) => ({ ...run, sourceId: source.id })),
  };
}

// The current source is already loaded by App. Reuse that snapshot instead of
// issuing duplicate bootstrap/runs reads on every Feed update. Other sources
// keep their own owner and dispatch identities; only their read projections
// are merged here. A response from a prior signed-in owner is discarded.
export function useAgentSources(
  owner: string | undefined,
  current: CurrentData,
) {
  const currentSourceId = executionSourceId();
  const federated = capabilities.pairedDevices || !!currentSourceId;
  const [state, setState] = useState<SourceState>({
    ...empty,
    currentSourceId,
    sources: [laptop],
    error: "",
  });

  useEffect(() => {
    if (!owner || !federated) return;
    let active = true;
    const load = async () => {
      let linked: AgentSource[] = [];
      let error = "";
      try {
        linked = await apiInWorkspace<AgentSource[]>("/agent-sources", "");
      } catch (failure) {
        if ((failure as { status?: number }).status !== 404)
          error = "Couldn’t check connected execution sources.";
      }
      const sources = [
        laptop,
        ...linked.filter((item) =>
          /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128}$/.test(item.id),
        ),
      ];
      if (
        currentSourceId &&
        !sources.some((item) => item.id === currentSourceId)
      )
        sources.push({ id: currentSourceId, name: "Connected environment" });
      const settled = await Promise.allSettled(
        sources
          .filter((source) => source.id !== currentSourceId)
          .map(async (source) => {
            const [bootstrap, runs] = await Promise.all([
              apiInWorkspace<{
                agents: Agent[];
                connections: Connection[];
                folders: Folder[];
              }>("/bootstrap", source.id),
              apiInWorkspace<Run[]>("/runs?active=1", source.id),
            ]);
            return project(source, { ...bootstrap, runs });
          }),
      );
      if (!active) return;
      const loaded = settled.flatMap((item) =>
        item.status === "fulfilled" ? [item.value] : [],
      );
      setState({
        owner,
        currentSourceId,
        sources,
        agents: loaded.flatMap((item) => item.agents),
        connections: loaded.flatMap((item) => item.connections),
        folders: loaded.flatMap((item) => item.folders),
        runs: loaded.flatMap((item) => item.runs),
        error:
          error ||
          (settled.some((item) => item.status === "rejected")
            ? "Some agents are temporarily unavailable. Try refreshing the Feed."
            : ""),
      });
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [owner, currentSourceId, federated]);

  const ready =
    federated &&
    state.owner === owner &&
    state.currentSourceId === currentSourceId;
  const sources = ready ? state.sources : [laptop];
  const currentSource =
    sources.find((source) => source.id === currentSourceId) ||
    (currentSourceId
      ? { id: currentSourceId, name: "Connected environment" }
      : laptop);
  const currentProjection = owner ? project(currentSource, current) : empty;
  return {
    sources,
    agents: [...currentProjection.agents, ...(ready ? state.agents : [])],
    connections: [
      ...currentProjection.connections,
      ...(ready ? state.connections : []),
    ],
    folders: [...currentProjection.folders, ...(ready ? state.folders : [])],
    runs: [...currentProjection.runs, ...(ready ? state.runs : [])],
    error: ready ? state.error : "",
  };
}
