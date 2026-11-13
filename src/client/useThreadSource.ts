import { workspaceApi, type Bootstrap } from "../shared/workspace-api";
import { isRateLimited, RATE_LIMITED, readRoute, retryAfter } from "./api";
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
  const { load, error, failure } = useCollectionRead(
    JSON.stringify([key, enabled]),
  );
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
          let timeout = setTimeout(abort, 20_000);
          const waiting = (error: unknown) => {
            if (!isRateLimited(error)) return;
            deadline = Math.max(
              deadline,
              Date.now() + retryAfter(error) + 20_000,
            );
            clearTimeout(timeout);
            timeout = setTimeout(
              abort,
              Math.min(2_147_483_647, deadline - Date.now()),
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
            settle(
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
  const rateLimited = isRateLimited(failure);
  return {
    ...(state?.key === key ? state : cached),
    error: rateLimited ? RATE_LIMITED : error,
    rateLimited,
    retry: () => void refresh(true),
  };
}
