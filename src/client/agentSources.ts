import { workspaceApi, type RouteContract, type RouteInput, type RouteResponse } from "../shared/workspace-api";
import { readRoute } from "./workspace-api";
import { reactiveSource } from "./workspace-projections";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useEffect, useState } from "react";
import type { Agent, Connection, Folder, RunView as Run } from "../shared/types";
import { retryAfter, parse } from "./api";
import { capabilities } from "./capabilities";
import type { Capabilities } from "../shared/capabilities";
import { executionSourceId } from "./sourceRouting";
import { connectionLocation } from "./modelChoices";

// Local and not-yet-discovered view entries have no transport kind. Wire discovery requires it.
export type AgentSource = Omit<RouteResponse<typeof workspaceApi.agentSources>[number], "kind"> & { kind?: string; capabilities?: Capabilities };
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
  // Discovery names the linked workspace; its own container hostname is not
  // another execution destination within that source.
  if (source.kind === "docker" || source.id.startsWith("docker:"))
    return source.name;
  const connection = connections.find(
    (item) => item.id === agent.connection_id,
  );
  const runtime = connectionEnvironment(connection, source);
  if (source.id)
    return runtime !== source.name
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
  if (metadata?.location === "docker")
    return connectionLocation(connection, source.name).label;
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
  const initialSources = currentSourceId
    ? [local, { id: currentSourceId, name: "Connected environment" }]
    : [local];
  const federated = capabilities.pairedDevices || !!currentSourceId;
  const [state, setState] = useState<SourceState>({
    ...empty,
    currentSourceId,
    sources: initialSources,
    error: "",
  });
  const [discovered, setDiscovered] = useState<
    Pick<SourceState, "owner" | "currentSourceId" | "sources"> & { ready: boolean }
  >({ currentSourceId, sources: initialSources, ready: false });

  useEffect(() => {
    if (!owner || !federated) return;
    let active = true;
    let busy = false;
    let pending = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const previousDiscovery = discovered.owner === owner &&
      discovered.currentSourceId === currentSourceId ? discovered : null;
    let confirmed = previousDiscovery?.ready ?? false;
    let known: AgentSource[] = confirmed
      ? previousDiscovery!.sources.filter(source => source.id)
      : [];
    let knownLocal = { ...laptop, name: localName };
    const snapshots = new Map<string, Projection>();
    if (state.owner === owner && state.currentSourceId === currentSourceId)
      for (const source of state.sources)
        snapshots.set(source.id, {
          agents: state.agents.filter((item) => item.sourceId === source.id),
          connections: state.connections.filter(
            (item) => item.sourceId === source.id,
          ),
          folders: state.folders.filter((item) => item.sourceId === source.id),
          runs: state.runs.filter((item) => item.sourceId === source.id),
        });
    const requests = new Map<AbortController, ReturnType<typeof setTimeout>>();
    const clearRequests = () => {
      for (const [controller, timer] of requests) {
        clearTimeout(timer);
        controller.abort();
      }
      requests.clear();
    };
    const readProjection = async <C extends RouteContract & { method: "GET" },>(contract: C, input: RouteInput<C>, source: string): Promise<RouteResponse<C>> => {
      const controller = new AbortController();
      const arm = (delay = 20_000) => {
        clearTimeout(requests.get(controller));
        requests.set(controller, setTimeout(() => controller.abort(), Math.min(2_147_483_647, delay)));
      };
      arm();
      try {
        return await readRoute(contract, input, source, controller.signal, error => arm(retryAfter(error) + 20_000));
      } finally {
        clearTimeout(requests.get(controller));
        requests.delete(controller);
      }
    };
    const failedSources = new Set<string>();
    type Refresh = { discovery?: boolean; changes?: Map<string, Set<string>> };
    const queuedChanges = new Map<string, Set<string>>();
    const load = async (options: Refresh = {}) => {
      if (!active) return;
      if (busy) { pending = true; return; }
      pending = false;
      busy = true;
      try {
        await pass(options);
      } finally {
        clearRequests();
        busy = false;
        if (active && pending) schedule();
      }
    };
    const pass = async (options: Refresh) => {
      let linked = known;
      let error = "";
      try {
        linked = options.changes ? known : await readProjection(workspaceApi.agentSources, {}, "");
        linked = linked.map(source => ({...source, capabilities: known.find(item => item.id === source.id)?.capabilities}));
        known = linked;
        confirmed = true;
      } catch (failure) {
        if (!active) return;
        // A 404 means this workspace has no linked sources: stop showing and
        // polling the ones it listed before.
        if ((failure as { status?: number }).status === 404) {
          linked = known = [];
          confirmed = true;
        } else
          error = known.length
            ? "Connection check unavailable. Showing your last connected environments."
            : "Couldn’t connect to your execution environments. Check your connection and retry.";
      }
      const sources: AgentSource[] = [
        { ...knownLocal, capabilities: currentSourceId === "" ? capabilities : state.sources.find(source => source.id === "")?.capabilities },
        ...linked.filter((item) =>
          /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128}$/.test(item.id),
        ),
      ];
      if (
        currentSourceId &&
        !sources.some((item) => item.id === currentSourceId)
      )
        sources.push({ id: currentSourceId, name: "Connected environment" });
      for (const source of sources) {
        source.capabilities ??= known.find(item => item.id === source.id)?.capabilities;
        if (source.id === currentSourceId) source.capabilities = capabilities;
      }
      const publish = (error: string) => {
        if (!active) return;
        const loaded = sources
          .filter((source) => source.id !== currentSourceId)
          .flatMap((source) =>
            snapshots.has(source.id) ? [snapshots.get(source.id)!] : [],
          );
        setDiscovered({owner, currentSourceId, sources: sources.map(source => ({...source})), ready: confirmed});
        setState({
          owner,
          currentSourceId,
          sources,
          agents: loaded.flatMap((item) => item.agents),
          connections: loaded.flatMap((item) => item.connections),
          folders: loaded.flatMap((item) => item.folders),
          runs: loaded.flatMap((item) => item.runs),
          error,
        });
      };
      if (!active) return;
      // Feed reads only need destinations. Creation choices still need their
      // connections, and outage warnings stay until the metadata retry settles.
      setDiscovered({ owner, currentSourceId, sources, ready: confirmed });
      const settled = await Promise.allSettled(
        sources
          .filter((source) => source.id !== currentSourceId &&
            (!options.changes || options.changes.has(source.id)) &&
            (!options.discovery || !reactiveSource(source.id, "workspace") || !snapshots.has(source.id) || failedSources.has(source.id)))
          .map(async (source) => {
            const retryMetadata = failedSources.has(source.id);
            failedSources.add(source.id);
            const prior = snapshots.get(source.id);
            // A run signal must not certify stale metadata after a failed
            // bootstrap. Retry the full source until every part recovers.
            if (prior && !retryMetadata && options.changes?.get(source.id)?.size === 1 && options.changes.get(source.id)?.has("runs")) {
              const runs = await readProjection(workspaceApi.runs, { query: { active: "1" } }, source.id);
              return { source, data: { ...prior, runs: project(source, { agents: [], connections: [], folders: [], runs }).runs } };
            }
            const [bootstrap, runs, sourceCapabilities] = await Promise.all([
              readProjection(workspaceApi.bootstrap, {}, source.id),
              readProjection(workspaceApi.runs, { query: { active: "1" } }, source.id),
              source.id.startsWith("peer:") ? readProjection(workspaceApi.capabilities, {}, source.id) : Promise.resolve(undefined),
            ]);
            source.capabilities = sourceCapabilities;
            if (!source.id && bootstrap.environmentName) {
              source.name = bootstrap.environmentName;
              knownLocal = source;
            }
            return { source, data: project(source, { ...bootstrap, runs }) };
          }),
      );
      if (!active) return;
      for (const item of settled)
        if (item.status === "fulfilled") {
          snapshots.set(item.value.source.id, item.value.data);
          failedSources.delete(item.value.source.id);
        }
      publish(
        error ||
          (sources.some(source => source.id !== currentSourceId && failedSources.has(source.id))
            ? "An environment is temporarily unavailable. Its last loaded agents are still shown."
            : ""),
      );
    };
    void load();
    // Docker/source discovery is external topology, not a database projection.
    // Complete known sources do not refetch metadata or runs on this probe.
    const timer = setInterval(() => void load({ discovery: true }), 30_000);
    const retry = () => void load();
    const schedule = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        const changes = new Map(queuedChanges);
        queuedChanges.clear();
        void load(changes.size ? { changes } : {});
      }, 250);
    };
    const changed = (kind: "runs" | "metadata") => (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail?.sources;
      for (const source of sources ?? snapshots.keys()) {
        if (source === currentSourceId) continue;
        const kinds = queuedChanges.get(source) ?? new Set<string>();
        kinds.add(kind); queuedChanges.set(source,kinds);
      }
      if (queuedChanges.size) schedule();
    };
    window.addEventListener("loop-source-refresh", retry);
    // This projection includes active runs as well as source metadata.
    const stopChanges = listenWorkspaceChanges("runs", changed("runs"));
    const stopMetadata = listenWorkspaceChanges("metadata", changed("metadata"));
    return () => {
      active = false;
      clearRequests();
      clearInterval(timer);
      clearTimeout(refreshTimer);
      window.removeEventListener("loop-source-refresh", retry);
      stopChanges();
      stopMetadata();
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
    : initialSources;
  const discoveryReady =
    federated &&
    discovered.ready &&
    discovered.owner === owner &&
    discovered.currentSourceId === currentSourceId;
  const feedSources = discoveryReady
    ? discovered.sources.map((source) =>
        !source.id && !currentSourceId ? local : source,
      )
    : initialSources;
  const currentSource =
    feedSources.find((source) => source.id === currentSourceId) ||
    (currentSourceId
      ? { id: currentSourceId, name: "Connected environment" }
      : local);
  const currentProjection = owner ? project(currentSource, current) : empty;
  return {
    sources,
    feedSources,
    loading: !!owner && federated && !discoveryReady,
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
