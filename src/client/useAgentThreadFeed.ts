import { useEffect, useRef, useState } from "react";
import { workspaceApi, type RouteInput } from "../shared/workspace-api";
import type { AgentThreadSummary } from "../shared/agent-thread-feed";
import { readRoute } from "./workspace-api";
import { cachedView, cacheView, viewGeneration, viewOwner } from "./viewCache";
import {
  listenWorkspaceChanges,
  workspaceChangeAffects,
} from "./workspace-changes";
import {
  feedItemOrder,
  refreshDonePage,
  type DoneRefresh,
} from "./feed-done-refresh";

export type SourcedAgentThread = AgentThreadSummary & { source: string };
// Status depends on runs and steering receipts; visibility and names depend on
// the linked conversations and teams. Those writes need not change mail rows.
export const AGENT_THREAD_SURFACES = ["mail", "runs", "feed"] as const;
type Row = SourcedAgentThread & {
  conversation_id: string;
  last_activity_at: number;
};
type Page = { items: Row[]; next: string | null };
type Query = NonNullable<
  RouteInput<typeof workspaceApi.agentThreadFeed>["query"]
>;

export function useAgentThreadFeed(
  sources: string[],
  enabled: boolean,
  query: Query,
) {
  const generation = viewGeneration();
  const key = JSON.stringify([sources, query, generation]);
  const [state, setState] = useState({
    key,
    items: [] as Row[],
    more: false,
    loading: enabled,
    error: "",
  });
  const actions = useRef({ refresh: () => {}, more: () => {} });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const owner = viewOwner();
    const current = () =>
      !controller.signal.aborted &&
      generation === viewGeneration() &&
      owner === viewOwner();
    const cacheKey = (source: string) =>
      "agent-thread-feed:" + JSON.stringify([source, query]);
    const pages = new Map(
      sources.map((source) => [
        source,
        cachedView<Page>(cacheKey(source)) ?? { items: [], next: null },
      ]),
    );
    const progress = new Map<string, DoneRefresh>();
    const errors = new Map<string, string>();
    let busy = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (!current()) return;
      setState({
        key,
        items: [...pages.values()]
          .flatMap((page) => page.items)
          .sort(feedItemOrder),
        more: [...pages.values()].some((page) => !!page.next),
        loading: busy,
        error: errors.size
          ? "Couldn’t load some agent threads. Try again."
          : "",
      });
    };
    const schedule = () => {
      pending = true;
      if (busy || timer || !current()) return;
      timer = setTimeout(() => void load(), 400);
    };
    const load = async (more = false) => {
      if (!current()) return;
      if (busy) {
        if (!more) pending = true;
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      busy = true;
      if (!more) pending = false;
      publish();
      await Promise.all(
        sources.map(async (source) => {
          const previous = pages.get(source)!;
          if (more && !previous.next) return;
          const read = async (before?: string): Promise<Page> => {
            const page = await readRoute(
              workspaceApi.agentThreadFeed,
              { query: { ...query, before } },
              source,
              controller.signal,
            );
            return {
              ...page,
              items: page.items.map((thread) => ({
                ...thread,
                source,
                conversation_id: thread.id,
                last_activity_at: thread.updated_at,
              })),
            };
          };
          try {
            let page: Page;
            if (more) {
              const incoming = await read(previous.next!);
              const known = new Set(incoming.items.map((thread) => thread.id));
              page = {
                ...incoming,
                items: [
                  ...previous.items.filter((thread) => !known.has(thread.id)),
                  ...incoming.items,
                ].sort(feedItemOrder),
              };
            } else {
              const refreshed = await refreshDonePage(
                read,
                previous,
                progress.get(source),
                current,
              );
              page = refreshed.page;
              if (refreshed.progress) progress.set(source, refreshed.progress);
              else progress.delete(source);
            }
            if (!current()) return;
            pages.set(source, page);
            cacheView(cacheKey(source), page, owner);
            errors.delete(source);
          } catch (error) {
            if (!current()) return;
            if ((error as { status?: number }).status === 404) {
              const empty = { items: [], next: null };
              pages.set(source, empty);
              cacheView(cacheKey(source), empty, owner);
              progress.delete(source);
              errors.delete(source);
            } else errors.set(source, (error as Error).message);
          }
        }),
      );
      if (!current()) return;
      busy = false;
      publish();
      if (pending || [...progress.keys()].some((source) => !errors.has(source)))
        schedule();
    };
    actions.current = {
      refresh: () => void load(),
      more: () => void load(true),
    };
    const stops = AGENT_THREAD_SURFACES.map((surface) =>
      listenWorkspaceChanges(surface, (event) => {
        if (
          sources.some((source) =>
            workspaceChangeAffects(event, surface, source),
          )
        )
          schedule();
      }),
    );
    const focus = () => schedule();
    window.addEventListener("focus", focus);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      window.removeEventListener("focus", focus);
      actions.current = { refresh: () => {}, more: () => {} };
    };
  }, [key, enabled]);
  const shown = enabled && state.key === key;
  return {
    items: shown ? state.items : [],
    hasMore: shown && state.more,
    loading: enabled && (!shown || state.loading),
    error: shown ? state.error : "",
    refresh: () => actions.current.refresh(),
    loadMore: () => actions.current.more(),
  };
}
