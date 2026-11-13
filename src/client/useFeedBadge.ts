import { FolderId, parseId } from "../shared/contract-ids.js";
import { useEffect, useState } from "react";
import { workspaceApi } from "../shared/workspace-api";
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
  const [state, setState] = useState<{
    key: string;
    counts: Record<string, number>;
  }>({ key, counts: {} });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    const tickets = new Map<string, number>();
    const load = (selected = sources) => {
      for (const source of selected) {
        const ticket = (tickets.get(source) ?? 0) + 1;
        tickets.set(source, ticket);
        void readRoute(
          workspaceApi.feed,
          {
            query: {
              filter: "needs",
              ...(folder ? { folder: parseId(FolderId, folder) } : {}),
              ...(teams ? { teams } : {}),
            },
          },
          source,
          controller.signal,
        )
          .then(({ summary }) => {
            if (
              !active ||
              generation !== viewGeneration() ||
              tickets.get(source) !== ticket
            )
              return;
            const count =
              summary.working +
              summary.queued +
              (summary.replies_unread ?? 0) +
              (summary.done_unread ?? 0);
            setState((old) => ({
              key,
              counts: {
                ...(old.key === key ? old.counts : {}),
                [source]: count,
              },
            }));
          })
          .catch(() => {});
      }
    };
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
      controller.abort();
      stop();
      window.removeEventListener("loop-source-refresh", update);
      window.removeEventListener("loop-later-change", update);
    };
  }, [key]);
  return state.key === key
    ? Object.values(state.counts).reduce((sum, count) => sum + count, 0)
    : 0;
}
