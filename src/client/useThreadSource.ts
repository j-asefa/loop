import { workspaceApi, type Bootstrap } from "../shared/workspace-api";
import { isRateLimited, RATE_LIMITED, readRoute } from "./api";
import { useCallback, useEffect, useState } from "react";
import { cacheView, cachedView, viewGeneration, viewOwner } from "./viewCache";
import { executionSourceId } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";
import { useCollectionRead } from "./CollectionRead";
import { broadWorkspaceChange } from "./workspace-changes";
import { beginWorkspaceRead } from "./workspace-read-recovery";

type Snapshot = { data: Bootstrap; capabilities: Capabilities };

// Keep the Feed's source and identity untouched. Only the open thread needs
// this source's agent settings, project choices and runtime capabilities.
export function useThreadSource(source: string | null, owner?: string) {
  const generation = viewGeneration();
  const key = JSON.stringify([generation, source, owner]);
  const cacheKey = "thread-source:" + JSON.stringify([source, owner]);
  const enabled = source !== null && source !== executionSourceId() && !!owner;
  const scope = JSON.stringify([key, enabled]);
  const { load, error, failure } = useCollectionRead(scope);
  const [waitingState, setWaitingState] = useState<{
    scope: string;
    signal: AbortSignal;
  }>();
  const [state, setState] = useState<{ key: string } & Snapshot>();
  const refresh = useCallback(
    (manual = false) => {
      if (!enabled || owner !== viewOwner()) return Promise.resolve();
      return load(
        async (signal, mode) => {
          const pair = new AbortController();
          const abort = () => pair.abort();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          let deadline = Date.now() + 20_000;
          let deadlineExpired = false;
          let timeout: ReturnType<typeof setTimeout>;
          const arm = () => {
            clearTimeout(timeout);
            timeout = setTimeout(
              () => {
                if (Date.now() < deadline) return arm();
                deadlineExpired = true;
                pair.abort(new Error("This workspace timed out. Try again."));
              },
              Math.min(2_147_483_647, Math.max(0, deadline - Date.now())),
            );
          };
          arm();
          const waiting = (error: unknown, delayMs: number) => {
            deadline = Math.max(deadline, Date.now() + delayMs + 20_000);
            arm();
            setWaitingState(
              isRateLimited(error) ? { scope, signal } : undefined,
            );
          };
          const settle = beginWorkspaceRead(source!, "thread-source", signal);
          try {
            const [data, capabilities] = await Promise.all([
              readRoute(
                workspaceApi.bootstrap,
                {},
                source!,
                pair.signal,
                waiting,
                mode,
              ),
              readRoute(
                workspaceApi.capabilities,
                {},
                source!,
                pair.signal,
                waiting,
                mode,
              ),
            ]);
            settle(false);
            return { data, capabilities };
          } catch (error) {
            const failure = error as { status?: number; network?: boolean };
            setWaitingState((previous) =>
              previous?.signal === signal ? undefined : previous,
            );
            settle(
              deadlineExpired ||
                failure.network === true ||
                (failure.status !== undefined && failure.status >= 500),
            );
            throw error;
          } finally {
            // A rejected read must cancel its sibling as well as its timeout.
            pair.abort();
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
          }
        },
        (snapshot) => {
          cacheView(cacheKey, snapshot, owner);
          setState({ key, ...snapshot });
          setWaitingState(undefined);
        },
        manual,
      );
    },
    [key, enabled, load],
  );
  useEffect(() => {
    if (!enabled) return;
    const recover = (event: Event) => {
      if (!broadWorkspaceChange(event)) return;
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (!sources || sources.includes(source!)) void refresh();
    };
    window.addEventListener("loop-workspace-change", recover);
    void refresh();
    return () => window.removeEventListener("loop-workspace-change", recover);
  }, [refresh, enabled]);
  const cached =
    owner === viewOwner() ? cachedView<Snapshot>(cacheKey) : undefined;
  const rateLimited =
    isRateLimited(failure) ||
    (waitingState?.scope === scope && !waitingState.signal.aborted);
  return {
    ...(state?.key === key ? state : cached),
    error: rateLimited ? RATE_LIMITED : error,
    rateLimited,
    retry: () => void refresh(true),
  };
}
