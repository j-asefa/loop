import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contractCardReader } from "../shared/card-client";
import type { CardPage, CardSelection } from "../shared/cards";
import { useProjectionRoute, useSourceId } from "./SourceContext";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { CardPager, type CardWindow } from "./card-pager";
import { surfaceFallback } from "./workspace-projections";
import { listenWorkspaceChanges } from "./workspace-changes";

const noItems: CardPage["items"] = [];

/** Every continuation captures one owner, source and normalized selection.
 * Polling updates the loaded window; it never restarts pagination. */
export function useCards(selection: CardSelection, revision = 0) {
  const source = useSourceId(),
    read = useProjectionRoute();
  const owner = viewOwner(),
    key = JSON.stringify([owner, source, selection]);
  const context = useMemo(() => ({ key, foreground: 0 }), [key]);
  const cacheKey = "cards:" + key;
  const restored = cachedView<CardWindow>(cacheKey);
  const current = useRef<typeof context | null>(context);
  current.current = context;
  const reader = useMemo(
    () => contractCardReader((contract, input) => read(contract, input)),
    [read],
  );
  const pager = useRef(new CardPager());
  const loaded = useRef(restored ? key : "");
  const [shown, setShown] = useState<{ key: string; page: CardPage } | null>(
    restored ? { key, page: restored.page } : null,
  );
  const [status, setStatus] = useState({ key, loading: !restored, error: "" });
  const load = useCallback(
    async (append = false) => {
      if (!owner || current.current !== context) return;
      if (pager.current.key !== key) {
        const saved = cachedView<CardWindow>(cacheKey);
        if (saved) {
          pager.current.restore(key, saved);
          loaded.current = key;
          setShown({ key, page: saved.page });
        }
      }
      const foreground = append || loaded.current !== key;
      if (foreground) context.foreground++;
      setStatus((old) => ({
        key,
        loading: context.foreground > 0,
        error: old.key === key ? old.error : "",
      }));
      try {
        const page = await pager.current.load(
          key,
          selection.view,
          append,
          (before) =>
            reader.list({ ...selection, ...(before ? { before } : {}) }),
          (after, through) => reader.changes({ ...selection, after, through }),
        );
        if (current.current === context && viewOwner() === owner) {
          loaded.current = key;
          if (page) setShown({ key, page });
          const saved = pager.current.snapshot();
          if (saved) cacheView(cacheKey, saved, owner);
          setStatus({ key, loading: context.foreground > 0, error: "" });
        }
      } catch (error) {
        if (current.current === context && viewOwner() === owner) {
          if ((error as { status?: number }).status === 409) {
            cacheView(cacheKey, undefined, owner);
            loaded.current = "";
            setShown(null);
          }
          setStatus({
            key,
            loading: context.foreground > 0,
            error: (error as Error).message,
          });
        }
      } finally {
        if (foreground) context.foreground--;
        if (current.current === context && viewOwner() === owner)
          setStatus((old) =>
            old.key === key ? { ...old, loading: context.foreground > 0 } : old,
          );
      }
    },
    [context, reader],
  );
  useEffect(() => {
    current.current = context;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const stopFallback = surfaceFallback([source], "results", 2000, refresh);
    const stopChanges = listenWorkspaceChanges(selection.view === "saved" ? "saved" : "results", refresh, source);
    window.addEventListener("loop-refresh", refresh);
    window.addEventListener("loop-later-change", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopFallback();
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
    loading: status.key !== key || status.loading,
    error: status.key === key ? status.error : "",
    load,
    key,
  };
}
