import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SocialStoryId } from "../shared/contract-ids.js";
import {
  feedCatalog,
  type FeedEntry,
  type SocialResponse,
} from "../shared/news";
import {
  socialStoryToStreamItem,
  type StreamItem,
} from "../shared/stream-item";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute, readRoute } from "./api";
import { emitClientEvent, listenClientEvent } from "./clientEvents";
import { createReadExecutor, type ReadState } from "./read-executor";
import { notify } from "./toast";
import { cacheView, cachedView, viewGeneration, viewOwner } from "./viewCache";
import {
  listenWorkspaceChanges,
  workspaceChangeAffects,
} from "./workspace-changes";

type SocialStreamSnapshot = SocialResponse & {
  added: string[];
  own: FeedEntry[];
  images: boolean;
};

const CACHE_KEY = "feed-social-stream";

const EMPTY_READ: ReadState = { error: "", busy: false, failure: null };

/**
 * Loads the owner's followed RSS feeds as unified StreamItems for Loop's main
 * Feed. Failures stay isolated here so degraded RSS reads never disrupt agent
 * Done cards.
 */
export function useSocialStream(enabled: boolean) {
  const generation = viewGeneration();
  const owner = viewOwner();
  const scopeKey = JSON.stringify([generation, owner]);
  const [state, setState] = useState<{
    scope: string;
    snapshot: SocialStreamSnapshot | null;
    read: ReadState;
  }>(() => ({
    scope: scopeKey,
    snapshot: cachedView<SocialStreamSnapshot>(CACHE_KEY) ?? null,
    read: EMPTY_READ,
  }));

  const snapshot = state.scope === scopeKey ? state.snapshot : null;
  const readState = state.scope === scopeKey ? state.read : EMPTY_READ;

  const loadRef = useRef<
    (options?: { force?: boolean; manual?: boolean }) => void
  >(() => {});
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const current = () =>
      active && generation === viewGeneration() && owner === viewOwner();

    const executor = createReadExecutor({
      current,
      changed: (read) =>
        setState((prev) => ({
          scope: scopeKey,
          snapshot: prev.scope === scopeKey ? prev.snapshot : null,
          read,
        })),
    });

    const load = (options: { force?: boolean; manual?: boolean } = {}) => {
      if (options.force) executor.cancel();
      void executor.load(
        async (signal, mode) => {
          const [{ added, own }, social, preferences] = await Promise.all([
            readRoute(
              workspaceApi.socialFeeds,
              {},
              "",
              signal,
              undefined,
              mode,
            ),
            readRoute(
              workspaceApi.socialList,
              { query: { refresh: options.force ? "1" : "0" } },
              "",
              signal,
              undefined,
              mode,
            ),
            readRoute(
              workspaceApi.socialPreferences,
              {},
              "",
              signal,
              undefined,
              mode,
            ),
          ]);
          return {
            ...social,
            added,
            own,
            images: preferences.images,
          };
        },
        (next) => {
          cacheView(CACHE_KEY, next, owner);
          setState((prev) => ({
            scope: scopeKey,
            snapshot: next,
            read: prev.scope === scopeKey ? prev.read : EMPTY_READ,
          }));
        },
        options.manual,
      );
    };

    loadRef.current = load;
    cancelRef.current = () => executor.cancel();
    load();

    const stopSocialEvent = listenClientEvent("loop-social-read", () => load());
    const stopRefresh = listenClientEvent("loop-refresh", () =>
      load({ force: true, manual: true }),
    );
    const stopWorkspace = listenWorkspaceChanges("social", (event) => {
      if (workspaceChangeAffects(event, "social", "")) load();
    });

    return () => {
      active = false;
      executor.dispose();
      loadRef.current = () => {};
      cancelRef.current = () => {};
      stopSocialEvent();
      stopRefresh();
      stopWorkspace();
    };
  }, [enabled, scopeKey, generation, owner]);

  const items = useMemo<StreamItem[]>(() => {
    if (!snapshot) return [];
    const known = new Map<string, FeedEntry>(
      [...feedCatalog, ...snapshot.own].map((feed) => [feed.id, feed]),
    );
    const result: StreamItem[] = [];
    for (const story of snapshot.stories) {
      const feed = known.get(story.feed);
      if (!feed) continue;
      result.push(socialStoryToStreamItem(story, feed));
    }
    return result;
  }, [snapshot]);

  const markRead = useCallback(
    async (rawId: string, read: boolean) => {
      const targetOwner = owner;
      const targetGen = generation;
      cancelRef.current();
      setState((prev) => {
        if (prev.scope !== scopeKey || !prev.snapshot) return prev;
        const nextSnapshot: SocialStreamSnapshot = {
          ...prev.snapshot,
          stories: prev.snapshot.stories.map((story) =>
            story.id === rawId ? { ...story, read } : story,
          ),
        };
        cacheView(CACHE_KEY, nextSnapshot, targetOwner);
        return { ...prev, snapshot: nextSnapshot };
      });
      try {
        const { unread } = await callRoute(
          read ? workspaceApi.socialRead : workspaceApi.socialUnreadSet,
          { body: { stories: SocialStoryId.array().parse([rawId]) } },
          "",
        );
        if (targetGen !== viewGeneration() || targetOwner !== viewOwner())
          return;
        setState((prev) => {
          if (prev.scope !== scopeKey || !prev.snapshot) return prev;
          const nextSnapshot = { ...prev.snapshot, unread };
          cacheView(CACHE_KEY, nextSnapshot, targetOwner);
          return { ...prev, snapshot: nextSnapshot };
        });
        emitClientEvent("loop-social-read");
      } catch (error) {
        notify({
          text:
            (error as Error).message || "Could not update story read state.",
          tone: "error",
        });
        loadRef.current();
      }
    },
    [scopeKey, owner, generation],
  );

  const dismiss = useCallback(
    async (rawId: string) => {
      const targetOwner = owner;
      const targetGen = generation;
      cancelRef.current();
      setState((prev) => {
        if (prev.scope !== scopeKey || !prev.snapshot) return prev;
        const nextSnapshot: SocialStreamSnapshot = {
          ...prev.snapshot,
          stories: prev.snapshot.stories.filter((story) => story.id !== rawId),
        };
        cacheView(CACHE_KEY, nextSnapshot, targetOwner);
        return { ...prev, snapshot: nextSnapshot };
      });
      try {
        const { unread } = await callRoute(
          workspaceApi.socialDismiss,
          { body: { stories: SocialStoryId.array().parse([rawId]) } },
          "",
        );
        if (targetGen !== viewGeneration() || targetOwner !== viewOwner())
          return;
        setState((prev) => {
          if (prev.scope !== scopeKey || !prev.snapshot) return prev;
          const nextSnapshot = { ...prev.snapshot, unread };
          cacheView(CACHE_KEY, nextSnapshot, targetOwner);
          return { ...prev, snapshot: nextSnapshot };
        });
        emitClientEvent("loop-social-read");
        notify({
          text: "Removed from Feed",
          undo: async () => {
            if (targetGen !== viewGeneration() || targetOwner !== viewOwner())
              return;
            try {
              cancelRef.current();
              await callRoute(
                workspaceApi.socialRestore,
                { body: { stories: SocialStoryId.array().parse([rawId]) } },
                "",
              );
              emitClientEvent("loop-social-read");
              loadRef.current();
            } catch (undoError) {
              notify({
                text:
                  (undoError as Error).message || "Could not restore story.",
                tone: "error",
              });
            }
          },
        });
      } catch (error) {
        notify({
          text: (error as Error).message || "Could not remove story.",
          tone: "error",
        });
        loadRef.current();
      }
    },
    [scopeKey, owner, generation],
  );

  const hasFollowedFeeds = Boolean(
    snapshot && (snapshot.added.length > 0 || snapshot.own.length > 0),
  );

  return {
    items,
    loading: enabled && !snapshot && readState.busy,
    busy: readState.busy,
    error: readState.error,
    images: snapshot?.images ?? false,
    hasFollowedFeeds,
    pendingCount: snapshot?.pending.length ?? 0,
    unreadCount: snapshot?.unread ?? 0,
    markRead,
    dismiss,
    retry: () => loadRef.current({ manual: true }),
    refresh: () => loadRef.current({ force: true, manual: true }),
  };
}
