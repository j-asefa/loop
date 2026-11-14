import {
  workspaceApi,
  type Bootstrap as BootstrapResponse,
} from "../../shared/workspace-api";
import { workspaceChangeAffects } from "../workspace-changes";
import {
  WORKSPACE_COLLECTIONS,
  type WorkspaceCollection,
} from "../../shared/workspace-events";
import { useSourceId } from "../SourceContext";
import { useCollectionRead } from "../CollectionRead";
import { readRoute } from "../api";
import { viewGeneration } from "../viewCache";
import { executionSourceId } from "../sourceRouting";

import { useEffect, useMemo, useRef } from "react";
import type { Agent, RunView as Run, Team } from "../../shared/types";

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
  setData: Dispatch<SetStateAction<Bootstrap>>;
  setBootstrapOwner(owner: string | undefined): void;
  openAgentChat(agent: Agent): void;
  initialAgentId: RefObject<string | null>;
  initialCompose: boolean;
  setProfile: Dispatch<SetStateAction<Agent | null>>;
  setTeamSelection: Dispatch<SetStateAction<string[]>>;
  setRuns: Dispatch<SetStateAction<Run[]>>;
  loadResults(append?: boolean, notify?: boolean): Promise<void>;
};

export function useWorkspaceData(props: WorkspaceProps) {
  const {
    setWorkspaceLoadErrors,
    ownerRef,
    setData,
    initialAgentId,
    initialCompose,
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
  const source = useSourceId();
  const key = JSON.stringify([viewGeneration(), source]);
  const bootstrapRead = useCollectionRead("bootstrap:" + key);
  const runsRead = useCollectionRead("runs:" + key);
  const snapshot = useMemo(
    () => ({ value: undefined as BootstrapResponse | undefined }),
    [key],
  );
  useEffect(() => {
    setWorkspaceLoadErrors({});
  }, [key]);
  async function bootstrap() {
    const owner = ownerRef.current;
    if (!owner) throw new DOMException("Workspace changed", "AbortError");
    const completion = await bootstrapRead.execute(
      (signal, mode) =>
        readRoute(workspaceApi.bootstrap, {}, source, signal, undefined, mode),
      (result) => {
        if (owner !== ownerRef.current) return;
        snapshot.value = result;
        workspaceReadError("bootstrap");
        setData(result);
        setBootstrapOwner(owner);
        if (initialAgentId.current) {
          const match = result.agents.find(
            (agent: Agent) => agent.id === initialAgentId.current,
          );
          initialAgentId.current = null;
          const url = new URL(location.href);
          if (match && initialCompose) openAgentChat(match);
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
      },
    );
    if (
      completion.status === "cancelled" ||
      !completion.current() ||
      owner !== ownerRef.current
    )
      throw new DOMException("Workspace changed", "AbortError");
    if (completion.status === "error") {
      workspaceReadError("bootstrap", completion.error);
      throw completion.error;
    }
    // Runtime setup awaits this result, including when its refresh was coalesced.
    return snapshot.value!.connections;
  }
  const runsGeneration = useRef(0);
  async function loadRuns() {
    const owner = ownerRef.current;
    if (!owner) return;
    let generation: number | undefined;
    const completion = await runsRead.execute(
      (signal, mode) => {
        // Composer advances this counter when publishing an accepted receipt.
        generation = ++runsGeneration.current;
        return readRoute(
          workspaceApi.runs,
          { query: { active: "1" } },
          source,
          signal,
          undefined,
          mode,
        );
      },
      (result) => {
        if (
          owner === ownerRef.current &&
          generation === runsGeneration.current
        ) {
          workspaceReadError("runs");
          setRuns(result);
        }
      },
    );
    if (
      completion.status === "error" &&
      completion.current() &&
      owner === ownerRef.current &&
      generation === runsGeneration.current
    ) {
      workspaceReadError("runs", completion.error);
      throw completion.error;
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
    setRevision,
    setCollectionRevisions,
    bootstrap,
    loadRuns,
    resultsVisible,
    loadResults,
  } = props;
  const source = useSourceId();
  useEffect(() => {
    if (session?.user) void refresh().catch((e) => setError(e.message));
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter, source]);
  useEffect(() => {
    if (!session?.user) return;
    const retry = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter, source]);
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
                ? [loadResults(false, false, false)]
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
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter, source]);
}
