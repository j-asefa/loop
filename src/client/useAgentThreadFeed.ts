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
  refreshSources?: readonly string[];
  pages: Map<string, Page>;
  progress: Map<string, DoneRefresh>;
  errors: Map<string, string>;
  headErrors: Set<string>;
  next: string | null;
};
const historyContinuation = (page: Page, progress?: DoneRefresh) =>
  progress?.continuation !== undefined ? progress.continuation : page.next;
const appendCursor = (page: Page, progress?: DoneRefresh) =>
  progress?.gapUntil || progress?.rescanGap
    ? page.next
    : historyContinuation(page, progress);
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
      refreshSources: undefined,
      progress: new Map(
        [...page.progress].map(([source, progress]) => [
          source,
          { ...progress, restart: true },
        ]),
      ),
    }),
    invalidateHistory: (page, sources) => ({
      ...page,
      refreshSources: [
        ...new Set([
          ...sources,
          ...[...(page.refreshSources ?? page.progress.keys())].filter(
            (source) => !page.errors.has(source),
          ),
        ]),
      ],
      progress: new Map(
        [...page.progress].map(([source, progress]) => [
          source,
          sources.includes(source)
            ? { ...progress, rescan: true, invalidated: true }
            : progress,
        ]),
      ),
    }),
    coalesceDelay: 400,
    refreshDelay: () => 400,
    needsRefresh: (page) =>
      !!page.refreshSources?.some((source) => !page.errors.has(source)),
    read: async (previous, before, signal, mode, readComplete) => {
      const pages = new Map(previous.pages),
        progress = new Map(previous.progress),
        errors = new Map(previous.errors),
        headErrors = new Set(previous.headErrors);
      const refreshSources = new Set(
        previous.refreshSources ?? progress.keys(),
      );
      const current = () =>
        !signal.aborted &&
        generation === viewGeneration() &&
        owner === viewOwner();
      const requested =
        before === undefined
          ? undefined
          : new Map(JSON.parse(before) as [string, string][]);
      await Promise.all(
        sources.map(async (source) => {
          if (
            before === undefined &&
            mode !== "manual" &&
            previous.refreshSources &&
            !previous.refreshSources.includes(source)
          )
            return;
          const old = pages.get(source)!;
          let older = requested?.get(source);
          if (
            before !== undefined &&
            (!older || (!old.next && !progress.has(source)))
          )
            return;
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
              let incoming = await read(older!);
              const continuation = appendCursor(old, progress.get(source));
              const visible = new Set(old.items.map((thread) => thread.id));
              // A refreshed head can already contain the interrupted page.
              // Finish that More intent at the new cursor instead of making
              // the user repeat a click that only returned duplicate rows.
              if (
                current() &&
                continuation &&
                continuation !== older &&
                incoming.items.every((thread) => visible.has(thread.id))
              ) {
                older = continuation;
                incoming = await read(older);
              }
              const known = new Set(incoming.items.map((thread) => thread.id));
              page = {
                ...incoming,
                items: [
                  ...old.items.filter((thread) => !known.has(thread.id)),
                  ...incoming.items,
                ].sort(feedItemOrder),
              };
              let sweep = progress.get(source);
              const floor = page.items.at(-1);
              const oldFloor = old.items.at(-1);
              if (
                older !== appendCursor(old, sweep) &&
                (!floor || !oldFloor || feedItemOrder(floor, oldFloor) <= 0)
              )
                page.next = old.next;
              if (sweep && older === old.next) {
                const last = incoming.items.at(-1);
                const exhaustedFloor =
                  sweep.continuation === null ? sweep.floor : undefined;
                const covered = (boundary: DoneRefresh["gapUntil"]) => {
                  const target =
                    boundary &&
                    exhaustedFloor &&
                    feedItemOrder(exhaustedFloor, boundary) > 0
                      ? exhaustedFloor
                      : boundary;
                  return (
                    !incoming.next ||
                    (last && target && feedItemOrder(last, target) >= 0)
                  );
                };
                sweep = {
                  ...sweep,
                  gapUntil: covered(sweep.gapUntil)
                    ? undefined
                    : sweep.gapUntil,
                  rescanGap: covered(sweep.rescanGap)
                    ? undefined
                    : sweep.rescanGap,
                };
                progress.set(source, sweep);
              }
              if (
                sweep &&
                (older === historyContinuation(old, sweep) ||
                  (sweep.continuation === null &&
                    older === old.next &&
                    incoming.items.at(-1) &&
                    sweep.floor &&
                    feedItemOrder(incoming.items.at(-1)!, sweep.floor) >= 0) ||
                  (floor &&
                    sweep.floor &&
                    feedItemOrder(floor, sweep.floor) > 0))
              ) {
                if ((sweep.gapUntil || sweep.rescanGap) && older !== old.next)
                  page.next = old.next;
                progress.set(source, {
                  ...sweep,
                  floor: page.items.at(-1),
                  continuation: incoming.next,
                });
              }
              if (progress.has(source)) refreshSources.add(source);
            } else {
              const priorProgress = progress.get(source);
              const refreshed = await refreshDonePage(
                read,
                old,
                priorProgress,
                current,
              );
              page = refreshed.page;
              if (refreshed.progress) {
                progress.set(source, refreshed.progress);
                // Finish this sweep and its known gap. Only an external
                // invalidation starts another full reconciliation sweep.
                if (
                  priorProgress &&
                  !priorProgress.restart &&
                  !priorProgress.invalidated &&
                  !refreshed.progress.settleGap &&
                  feedItemOrder(
                    refreshed.progress.after,
                    priorProgress.after,
                  ) <= 0
                )
                  refreshSources.delete(source);
                else refreshSources.add(source);
              } else {
                progress.delete(source);
                refreshSources.delete(source);
              }
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
        refreshSources: [...refreshSources].filter(
          (source) => !errors.has(source),
        ),
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
