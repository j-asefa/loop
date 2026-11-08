import {
  workspaceApi,
  type Bootstrap as BootstrapResponse,
} from "../../shared/workspace-api";
import { workspaceChangeAffects } from "../workspace-changes";
import {
  WORKSPACE_COLLECTIONS,
  type WorkspaceCollection,
} from "../../shared/workspace-events";
import { useProjectionRoute } from "../SourceContext";
import { executionSourceId } from "../sourceRouting";

import { useEffect, useRef } from "react";
import type {
  Agent,
  Connection,
  RunView as Run,
  Team,
} from "../../shared/types";

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AppModel } from "./AppController";

export type Bootstrap = Pick<
  BootstrapResponse,
  "agents" | "connections" | "folders"
> &
  Partial<Omit<BootstrapResponse, "agents" | "connections" | "folders">>;
type WorkspaceProps = {
  setWorkspaceLoadErrors: Dispatch<
    SetStateAction<Partial<Record<"bootstrap" | "runs", string>>>
  >;
  ownerRef: RefObject<string | undefined>;
  readContract: ReturnType<typeof useProjectionRoute>;
  setData: Dispatch<SetStateAction<Bootstrap>>;
  setBootstrapOwner(owner: string | undefined): void;
  openAgentChat(agent: Agent): void;
  initialAgentId: RefObject<string | null>;
  setProfile: Dispatch<SetStateAction<Agent | null>>;
  setTeamSelection: Dispatch<SetStateAction<string[]>>;
  setRuns: Dispatch<SetStateAction<Run[]>>;
  loadResults(append?: boolean, notify?: boolean): Promise<void>;
};

export function useWorkspaceData(props: WorkspaceProps) {
  const {
    setWorkspaceLoadErrors,
    ownerRef,
    readContract,
    setData,
    initialAgentId,
    setProfile,
    setTeamSelection,
    setRuns,
    loadResults,
    setBootstrapOwner,
    openAgentChat,
  } = props;
  function workspaceReadError(kind: "bootstrap" | "runs", error?: unknown) {
    const message = !error
      ? ""
      : (error as { reconnecting?: boolean }).reconnecting
        ? "Loop is reconnecting…"
        : kind === "bootstrap"
          ? "Couldn’t refresh your agents and projects."
          : "Couldn’t refresh task status.";
    setWorkspaceLoadErrors((old) => ({ ...old, [kind]: message }));
  }
  const bootstrapGeneration = useRef(0);
  async function bootstrap() {
    const generation = ++bootstrapGeneration.current;
    const owner = ownerRef.current;
    const result = await readContract(workspaceApi.bootstrap, {}).catch(
      (error) => {
        if (
          owner &&
          owner === ownerRef.current &&
          generation === bootstrapGeneration.current
        )
          workspaceReadError("bootstrap", error);
        throw error;
      },
    );
    if (
      owner &&
      owner === ownerRef.current &&
      generation === bootstrapGeneration.current
    ) {
      workspaceReadError("bootstrap");
      setData(result);
      setBootstrapOwner(owner);
      if (initialAgentId.current) {
        const match = result.agents.find(
          (agent: Agent) => agent.id === initialAgentId.current,
        );
        initialAgentId.current = null;
        const url = new URL(location.href);
        if (match && url.searchParams.has("compose")) openAgentChat(match);
        else if (match) setProfile(match);
        url.searchParams.delete("agent");
        url.searchParams.delete("compose");
        history.replaceState(history.state, "", url.pathname + url.search);
      }
      setTeamSelection((old) => {
        const present = old.filter((id) =>
          result.teams?.some((team: Team) => team.id === id),
        );
        return present.length === old.length ? old : present;
      });
    }
    return result.connections as Connection[];
  }
  const runsGeneration = useRef(0);
  async function loadRuns() {
    const owner = ownerRef.current;
    if (!owner) return;
    const generation = ++runsGeneration.current;
    // Profiles show all of an agent's work. Feed and Running apply their
    // team/project filters locally without changing the profile's data.
    const result = await readContract(workspaceApi.runs, {
      query: { active: "1" },
    }).catch((error) => {
      if (owner === ownerRef.current && generation === runsGeneration.current)
        workspaceReadError("runs", error);
      throw error;
    });
    if (owner === ownerRef.current && generation === runsGeneration.current) {
      workspaceReadError("runs");
      setRuns(result);
    }
  }
  async function refresh() {
    // Each reader owns its latest request and independent recovery state.
    await Promise.allSettled([bootstrap(), loadResults(), loadRuns()]);
  }
  return { bootstrap, loadRuns, runsGeneration, refresh };
}

export function useWorkspaceEvents(
  props: Pick<
    AppModel,
    | "session"
    | "refresh"
    | "setError"
    | "profile"
    | "view"
    | "teamKey"
    | "projectFilter"
    | "workspaceLoadError"
    | "setRevision"
    | "setCollectionRevisions"
    | "bootstrap"
    | "loadRuns"
    | "resultsVisible"
    | "loadResults"
  >,
) {
  const {
    session,
    refresh,
    setError,
    profile,
    view,
    teamKey,
    projectFilter,
    workspaceLoadError,
    setRevision,
    setCollectionRevisions,
    bootstrap,
    loadRuns,
    resultsVisible,
    loadResults,
  } = props;
  useEffect(() => {
    if (session?.user) void refresh().catch((e) => setError(e.message));
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter]);
  useEffect(() => {
    if (!session?.user) return;
    const retry = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const timer = workspaceLoadError ? setInterval(retry, 5000) : undefined;
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [
    session?.user?.id,
    profile?.id,
    view,
    teamKey,
    projectFilter,
    workspaceLoadError,
  ]);
  useEffect(() => {
    if (!session?.user) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshCurrent = false;
    let fullRefresh = false;
    let broad = false,
      refreshRuns = false,
      refreshResults = false;
    const collections = new Set<WorkspaceCollection>();
    const update = (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      refreshCurrent ||= !sources || sources.includes(executionSourceId());
      fullRefresh ||= !sources;
      broad ||= workspaceChangeAffects(event, "metadata");
      refreshRuns ||= workspaceChangeAffects(
        event,
        "runs",
        executionSourceId(),
      );
      refreshResults ||= workspaceChangeAffects(
        event,
        "results",
        executionSourceId(),
      );
      for (const collection of WORKSPACE_COLLECTIONS)
        if (workspaceChangeAffects(event, collection))
          collections.add(collection);
      if (!broad && !collections.size) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (broad) setRevision((v) => v + 1);
        else {
          const changed = [...collections];
          setCollectionRevisions((old) => {
            const next = { ...old };
            for (const collection of changed)
              next[collection] = (next[collection] || 0) + 1;
            return next;
          });
        }
        if (refreshCurrent) {
          if (fullRefresh) void refresh().catch(() => {});
          else {
            // Each scoped reader exposes exhausted failures and activates
            // workspace recovery without refreshing unrelated collections.
            void Promise.allSettled([
              ...(broad ? [bootstrap()] : []),
              ...(refreshRuns ? [loadRuns()] : []),
              ...(refreshResults && resultsVisible.current
                ? [loadResults(false, false, false, "change")]
                : []),
            ]);
          }
        }
        refreshCurrent = false;
        fullRefresh = false;
        broad = refreshRuns = refreshResults = false;
        collections.clear();
      }, 250);
    };
    window.addEventListener("loop-workspace-change", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("loop-workspace-change", update);
    };
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter]);
}
