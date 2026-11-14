import { FolderId, parseId } from "../shared/contract-ids.js";
import { useEffect, useMemo, useState } from "react";
import { workspaceApi } from "../shared/workspace-api";
import { createReadExecutor, type ReadState } from "./read-executor";
import { readRoute } from "./api";
import {
  listenWorkspaceChanges,
  workspaceChangeAffects,
} from "./workspace-changes";
import { viewGeneration } from "./viewCache";

// Read the server's full-scope counts, independently of paginated cards and
// whichever Feed filter or other navigation tab is currently open.
export function useFeedBadge(
  enabled: boolean,
  sources: string[],
  folder?: string,
  teams?: string,
) {
  const generation = viewGeneration();
  const key = JSON.stringify([
    generation,
    enabled,
    sources.slice().sort(),
    folder,
    teams,
  ]);
  const context = useMemo(() => ({ retry: () => {} }), [key]);
  const [state, setState] = useState<{
    key: string;
    counts: Record<string, number>;
    reads: Record<string, ReadState>;
  }>({ key, counts: {}, reads: {} });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const current = () => active && generation === viewGeneration();
    const failures = new Set<string>();
    const readers = new Map(
      [...new Set(sources)].map((source) => [
        source,
        createReadExecutor({
          current,
          changed: (value) => {
            if (value.error) failures.add(source);
            else failures.delete(source);
            setState((old) => ({
              key,
              counts: old.key === key ? old.counts : {},
              reads: { ...(old.key === key ? old.reads : {}), [source]: value },
            }));
          },
        }),
      ]),
    );
    const load = (selected = sources, manual = false) => {
      for (const source of selected) {
        const reader = readers.get(source);
        if (!reader) continue;
        void reader.load(
          (signal, mode) =>
            readRoute(
              workspaceApi.feed,
              {
                query: {
                  filter: "needs",
                  ...(folder ? { folder: parseId(FolderId, folder) } : {}),
                  ...(teams ? { teams } : {}),
                },
              },
              source,
              signal,
              undefined,
              mode,
            ),
          ({ summary }) =>
            setState((old) => ({
              key,
              reads: old.key === key ? old.reads : {},
              counts: {
                ...(old.key === key ? old.counts : {}),
                [source]:
                  summary.working +
                  summary.queued +
                  (summary.replies_unread ?? 0) +
                  (summary.done_unread ?? 0),
              },
            })),
          manual,
        );
      }
    };
    context.retry = () => load([...failures], true);
    const stop = listenWorkspaceChanges("feed", (event) =>
      load(
        sources.filter((source) =>
          workspaceChangeAffects(event, "feed", source),
        ),
      ),
    );
    const update = () => load();
    window.addEventListener("loop-source-refresh", update);
    window.addEventListener("loop-later-change", update);
    load();
    return () => {
      active = false;
      readers.forEach((reader) => reader.dispose());
      context.retry = () => {};
      stop();
      window.removeEventListener("loop-source-refresh", update);
      window.removeEventListener("loop-later-change", update);
    };
  }, [context]);
  const reads = state.key === key ? Object.values(state.reads) : [];
  return {
    count:
      state.key === key
        ? Object.values(state.counts).reduce((sum, count) => sum + count, 0)
        : 0,
    error: reads.find((read) => read.error)?.error ?? "",
    busy: reads.some((read) => read.error && read.busy),
    retry: () => context.retry(),
  };
}
