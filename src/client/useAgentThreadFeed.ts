import { feedItemOrder } from "../shared/feed-order";
import { useMemo } from "react";
import { workspaceApi, type RouteInput } from "../shared/workspace-api";
import type { AgentThreadSummary } from "../shared/agent-thread-feed";
import { readRoute } from "./api";
import { cachedView, cacheView, viewGeneration, viewOwner } from "./viewCache";
import { refreshDonePage, type DoneRefresh } from "./feed-done-refresh";
import { usePagedProjectionQuery } from "./CollectionRead";

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
type Window = {
  pages: Map<string, Page>;
  progress: Map<string, DoneRefresh>;
  errors: Map<string, string>;
  next: string | null;
};
const cursor = (pages: Map<string, Page>) => {
  const next = [...pages]
    .filter(([, page]) => page.next)
    .map(([source, page]) => [source, page.next]);
  return next.length ? JSON.stringify(next) : null;
};

export function useAgentThreadFeed(
  sources: string[],
  enabled: boolean,
  query: Query,
) {
  const generation = viewGeneration(),
    owner = viewOwner();
  const key = JSON.stringify([sources, query, enabled, generation]);
  const cacheKey = (source: string) =>
    "agent-thread-feed:" + JSON.stringify([source, query]);
  const empty = useMemo<Window>(() => {
    const pages = new Map(
      sources.map((source) => [
        source,
        cachedView<Page>(cacheKey(source)) ?? { items: [], next: null },
      ]),
    );
    return {
      pages,
      progress: new Map(),
      errors: new Map(),
      next: cursor(pages),
    };
  }, [key]);
  const reader = usePagedProjectionQuery<Window, string>({
    key,
    source: sources,
    enabled,
    empty,
    collections: AGENT_THREAD_SURFACES,
    events: ["focus"],
    coalesceDelay: 400,
    refreshDelay: () => 400,
    needsRefresh: (page) =>
      [...page.progress.keys()].some((source) => !page.errors.has(source)),
    read: async (previous, before, signal, mode, readComplete) => {
      const pages = new Map(previous.pages),
        progress = new Map(previous.progress),
        errors = new Map(previous.errors);
      const current = () =>
        !signal.aborted &&
        generation === viewGeneration() &&
        owner === viewOwner();
      await Promise.all(
        sources.map(async (source) => {
          const old = pages.get(source)!;
          if (before !== undefined && !old.next) return;
          const read = async (before?: string): Promise<Page> => {
            const page = await readRoute(
              workspaceApi.agentThreadFeed,
              { query: { ...query, before } },
              source,
              signal,
              undefined,
              mode,
            );
            readComplete();
            if (before && page.next === before)
              throw new Error("The page did not advance. Try again.");
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
            if (before !== undefined) {
              const incoming = await read(old.next!);
              const known = new Set(incoming.items.map((thread) => thread.id));
              page = {
                ...incoming,
                items: [
                  ...old.items.filter((thread) => !known.has(thread.id)),
                  ...incoming.items,
                ].sort(feedItemOrder),
              };
            } else {
              const refreshed = await refreshDonePage(
                read,
                old,
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
            if (current()) errors.set(source, (error as Error).message);
          }
        }),
      );
      return { pages, progress, errors, next: cursor(pages) };
    },
  });
  const items = useMemo(
    () =>
      enabled
        ? [...reader.page.pages.values()]
            .flatMap((page) => page.items)
            .sort(feedItemOrder)
        : [],
    [enabled, reader.page.pages],
  );
  return {
    items,
    hasMore: enabled && reader.page.next !== null,
    loading: enabled && reader.loading,
    error: enabled
      ? reader.error ||
        (reader.page.errors.size
          ? "Couldn’t load some agent threads. Try again."
          : "")
      : "",
    refresh: () => reader.refresh(true),
    loadMore: reader.more,
  };
}
