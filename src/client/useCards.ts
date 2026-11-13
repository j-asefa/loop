import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contractCardReader } from "../shared/card-client";
import type { CardPage, CardSelection } from "../shared/cards";
import { useSourceId } from "./SourceContext";
import { cacheView, cachedView, viewOwner, viewGeneration } from "./viewCache";
import { CardPager, type CardWindow } from "./card-pager";
import { useCollectionRead } from "./CollectionRead";
import { readRoute } from "./api";
import { listenWorkspaceChanges } from "./workspace-changes";

const noItems: CardPage["items"] = [];

/** Every continuation captures one owner, source and normalized selection.
 * Polling updates the loaded window; it never restarts pagination. */
export function useCards(selection: CardSelection, revision = 0) {
  const source = useSourceId();
  const owner = viewOwner(),
    key = JSON.stringify([viewGeneration(), owner, source, selection]);
  const context = useMemo(
    () => ({ key, foreground: 0, pending: 0, retryAppend: false }),
    [key],
  );
  const cacheKey = "cards:" + key;
  const restored = cachedView<CardWindow>(cacheKey);
  const current = useRef<typeof context | null>(context);
  current.current = context;
  const pager = useRef(new CardPager());
  const loaded = useRef(restored ? key : "");
  const [shown, setShown] = useState<{ key: string; page: CardPage } | null>(
    restored ? { key, page: restored.page } : null,
  );
  const { load: execute, error, busy, isBusy } = useCollectionRead(key);
  const [, update] = useState(0);
  const load = useCallback(
    async (append = false, manual = false) => {
      if (!owner || current.current !== context) return;
      if (manual && isBusy()) return;
      if (pager.current.key !== key) {
        const saved = cachedView<CardWindow>(cacheKey);
        if (saved) {
          pager.current.restore(key, saved);
          loaded.current = key;
          setShown({ key, page: saved.page });
        }
      }
      const foreground = manual || append || loaded.current !== key;
      if (foreground) context.foreground++;
      context.pending++;
      update((value) => value + 1);
      try {
        await execute(
          async (signal, mode) => {
            const reader = contractCardReader((contract, input) =>
              readRoute(contract, input, source, signal, undefined, mode),
            );
            try {
              return await pager.current.load(
                key,
                selection.view,
                append,
                (before) =>
                  reader.list({ ...selection, ...(before ? { before } : {}) }),
                (after, through) =>
                  reader.changes({ ...selection, after, through }),
              );
            } catch (error) {
              if (!signal.aborted && current.current === context) {
                context.retryAppend = append;
                if ((error as { status?: number }).status === 409) {
                  cacheView(cacheKey, undefined, owner);
                  loaded.current = "";
                  setShown(null);
                }
              }
              throw error;
            }
          },
          (page) => {
            loaded.current = key;
            if (page) setShown({ key, page });
            const saved = pager.current.snapshot();
            if (saved) cacheView(cacheKey, saved, owner);
          },
          manual,
          append ? 1 : 0,
        );
      } finally {
        if (foreground) context.foreground--;
        context.pending--;
        if (current.current === context) update((value) => value + 1);
      }
    },
    [context, execute, isBusy],
  );
  useEffect(() => {
    current.current = context;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };
    const stopChanges = listenWorkspaceChanges(
      selection.view === "saved" ? "saved" : "results",
      refresh,
      source,
    );
    window.addEventListener("loop-refresh", refresh);
    window.addEventListener("loop-later-change", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopChanges();
      window.removeEventListener("loop-refresh", refresh);
      window.removeEventListener("loop-later-change", refresh);
      document.removeEventListener("visibilitychange", refresh);
      // Invalidate even on unmount with the same owner/source.
      if (current.current === context) current.current = null;
      loaded.current = "";
      pager.current.reset();
    };
  }, [load]);
  useEffect(() => {
    void load();
  }, [revision]);
  return {
    items: shown?.key === key ? shown.page.items : noItems,
    next: shown?.key === key ? shown.page.next : null,
    loading: (!error && loaded.current !== key) || context.foreground > 0,
    busy: busy || context.pending > 0,
    error,
    load,
    retry: () => load(context.retryAppend, true),
    key,
  };
}
