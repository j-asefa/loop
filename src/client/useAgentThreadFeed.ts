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
type CachedPage = Page & { progress?: DoneRefresh };
type Query = NonNullable<
  RouteInput<typeof workspaceApi.agentThreadFeed>["query"]
>;
type Window = {
  pages: Map<string, Page>;
  progress: Map<string, DoneRefresh>;
  errors: Map<string, string>;
  headErrors: Set<string>;
  next: string | null;
};
const historyContinuation = (page: Page, progress?: DoneRefresh) =>
  progress?.continuation !== undefined ? progress.continuation : page.next;
const appendCursor = (page: Page, progress?: DoneRefresh) =>
  historyContinuation(page, progress) ?? page.next;
const cursor = (
  pages: Map<string, Page>,
  progress = new Map<string, DoneRefresh>(),
) => {
  const next = [...pages]
    .map(([source, page]) => [source, appendCursor(page, progress.get(source))])
    .filter(([, next]) => next);
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
    const pages = new Map<string, CachedPage>(
      sources.map((source) => [
        source,
        cachedView<CachedPage>(cacheKey(source)) ?? { items: [], next: null },
      ]),
    );
    const progress = new Map(
      [...pages].flatMap(([source, page]) =>
        page.progress
          ? [[source, { ...page.progress, restart: true }] as const]
          : [],
      ),
    );
    return {
      pages,
      progress,
      errors: new Map(),
      headErrors: new Set(),
      next: cursor(pages, progress),
    };
  }, [key]);
  const reader = usePagedProjectionQuery<Window, string>({
    key,
    source: sources,
    enabled,
    empty,
    collections: AGENT_THREAD_SURFACES,
    events: ["focus", "loop-refresh"],
    restartOnRefresh: (page) => ({
      ...page,
      progress: new Map(
        [...page.progress].map(([source, progress]) => [
          source,
          { ...progress, restart: true },
        ]),
      ),
    }),
    invalidateHistory: (page) => ({
      ...page,
      progress: new Map(
        [...page.progress].map(([source, progress]) => [
          source,
          { ...progress, rescan: true },
        ]),
      ),
    }),
    coalesceDelay: 400,
    refreshDelay: () => 400,
    needsRefresh: (page) =>
      [...page.progress.keys()].some((source) => !page.errors.has(source)),
    read: async (previous, before, signal, mode, readComplete) => {
      const pages = new Map(previous.pages),
        progress = new Map(previous.progress),
        errors = new Map(previous.errors),
        headErrors = new Set(previous.headErrors);
      const current = () =>
        !signal.aborted &&
        generation === viewGeneration() &&
        owner === viewOwner();
      await Promise.all(
        sources.map(async (source) => {
          const old = pages.get(source)!;
          const older = appendCursor(old, progress.get(source));
          if (before !== undefined && !older) return;
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
              const incoming = await read(older!);
              const known = new Set(incoming.items.map((thread) => thread.id));
              page = {
                ...incoming,
                items: [
                  ...old.items.filter((thread) => !known.has(thread.id)),
                  ...incoming.items,
                ].sort(feedItemOrder),
              };
              const sweep = progress.get(source);
              if (sweep && older === historyContinuation(old, sweep))
                progress.set(source, {
                  ...sweep,
                  floor: page.items.at(-1),
                  continuation: incoming.next,
                });
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
              // A successful older-page append cannot repair a failed scan
              // of the loaded window. Keep this refresh error until that scan
              // succeeds, otherwise gaps could remain with no warning.
              if (refreshed.error && current()) {
                pages.set(source, page);
                cacheView(
                  cacheKey(source),
                  {
                    ...page,
                    progress: progress.get(source),
                  },
                  owner,
                );
                throw refreshed.error;
              }
            }
            if (!current()) return;
            pages.set(source, page);
            cacheView(
              cacheKey(source),
              {
                ...page,
                progress: progress.get(source),
              },
              owner,
            );
            if (before === undefined) headErrors.delete(source);
            if (!headErrors.has(source)) errors.delete(source);
          } catch (error) {
            if (current()) {
              if (before === undefined) headErrors.add(source);
              errors.set(source, (error as Error).message);
            }
          }
        }),
      );
      return {
        pages,
        progress,
        errors,
        headErrors,
        next: cursor(pages, progress),
      };
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
