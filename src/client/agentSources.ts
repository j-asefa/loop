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
  environmentName?: string;
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

const laptop: AgentSource = { id: "", name: "This computer" };
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
  const runtime = connectionEnvironment(connection, source);
  if (source.id)
    return runtime !== source.name &&
      !(source.kind === "docker" && runtime === "Docker")
      ? `${source.name} · ${runtime}`
      : source.name;
  return runtime;
}

function connectionEnvironment(
  connection: Connection | undefined,
  source: AgentSource,
) {
  const metadata = parse<{
    environmentName?: string;
    location?: string;
  } | null>(connection?.metadata, {});
  if (metadata?.location === "docker") return "Docker";
  const runtime = metadata?.environmentName;
  return typeof runtime === "string" &&
    runtime.trim() &&
    runtime !== "This laptop" &&
    runtime !== "This computer"
    ? runtime
    : source.name;
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
        : connectionEnvironment(connection, source),
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
  const localName = !currentSourceId
    ? current.environmentName || laptop.name
    : laptop.name;
  const local = { ...laptop, name: localName };
  const federated = capabilities.pairedDevices || !!currentSourceId;
  const [state, setState] = useState<SourceState>({
    ...empty,
    currentSourceId,
    sources: [local],
    error: "",
  });

  useEffect(() => {
    if (!owner || !federated) return;
    let active = true;
    let busy = false;
    let known: AgentSource[] = [];
    let knownLocal = { ...laptop, name: localName };
    const snapshots = new Map<string, Projection>();
    const requests = new Map<AbortController, ReturnType<typeof setTimeout>>();
    // Deadline and teardown cancellation also work on older mobile WebKit.
    const signal = () => {
      const controller = new AbortController();
      requests.set(
        controller,
        setTimeout(() => controller.abort(), 20_000),
      );
      return controller.signal;
    };
    const clearRequests = () => {
      for (const [controller, timer] of requests) {
        clearTimeout(timer);
        controller.abort();
      }
      requests.clear();
    };
    const load = async () => {
      if (busy || !active) return;
      busy = true;
      try {
        await pass();
      } finally {
        clearRequests();
        busy = false;
      }
    };
    const pass = async () => {
      let linked = known;
      let error = "";
      try {
        linked = await apiInWorkspace<AgentSource[]>(
          "/agent-sources",
          "",
          undefined,
          undefined,
          signal(),
        );
        known = linked;
      } catch (failure) {
        if (!active) return;
        // A 404 means this workspace has no linked sources: stop showing and
        // polling the ones it listed before.
        if ((failure as { status?: number }).status === 404)
          linked = known = [];
        else
          error = known.length
            ? "Connection check unavailable. Showing your last connected environments."
            : "Couldn’t connect to your execution environments. Check your connection and retry.";
      }
      const sources = [
        { ...knownLocal },
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
                environmentName?: string;
                agents: Agent[];
                connections: Connection[];
                folders: Folder[];
              }>("/bootstrap", source.id, undefined, undefined, signal()),
              apiInWorkspace<Run[]>(
                "/runs?active=1",
                source.id,
                undefined,
                undefined,
                signal(),
              ),
            ]);
            if (!source.id && bootstrap.environmentName) {
              source.name = bootstrap.environmentName;
              knownLocal = source;
            }
            return { source, data: project(source, { ...bootstrap, runs }) };
          }),
      );
      if (!active) return;
      for (const item of settled)
        if (item.status === "fulfilled")
          snapshots.set(item.value.source.id, item.value.data);
      const loaded = sources
        .filter((source) => source.id !== currentSourceId)
        .flatMap((source) =>
          snapshots.has(source.id) ? [snapshots.get(source.id)!] : [],
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
            ? "An environment is temporarily unavailable. Its last loaded agents are still shown."
            : ""),
      });
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    const retry = () => void load();
    window.addEventListener("loop-source-refresh", retry);
    return () => {
      active = false;
      clearRequests();
      clearInterval(timer);
      window.removeEventListener("loop-source-refresh", retry);
    };
  }, [owner, currentSourceId, federated, localName]);

  const ready =
    federated &&
    state.owner === owner &&
    state.currentSourceId === currentSourceId;
  const sources = ready
    ? state.sources.map((source) =>
        !source.id && !currentSourceId ? local : source,
      )
    : [local];
  const currentSource =
    sources.find((source) => source.id === currentSourceId) ||
    (currentSourceId
      ? { id: currentSourceId, name: "Connected environment" }
      : local);
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
