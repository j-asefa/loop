import { useCallback, useEffect, useMemo, useState } from "react";
import { readRoute } from "./api";
import {
  createReadExecutor,
  type ReadMode,
  type ReadState,
} from "./read-executor";
import type {
  RouteContract,
  RouteInput,
  RouteResponse,
} from "../shared/workspace-api";
import { viewGeneration } from "./viewCache";
import {
  broadWorkspaceChange,
  listenWorkspaceChanges,
  workspaceChangeAffects,
} from "./workspace-changes";

type QueryOptions = {
  source: string;
  conversation?: string;
  collections?: readonly Parameters<typeof listenWorkspaceChanges>[0][];
  events?: readonly string[];
  revision?: string | number;
  enabled?: boolean;
};

/** Inputs identify a snapshot; revisions invalidate it without hiding its rows. */
export function useProjectionQuery<C extends RouteContract & { method: "GET" }>(
  contract: C,
  input: RouteInput<C> | undefined,
  {
    source,
    conversation,
    collections = [],
    events = [],
    revision = 0,
    enabled: requestedEnabled = true,
  }: QueryOptions,
) {
  const enabled = requestedEnabled && input !== undefined;
  const key = JSON.stringify([
    viewGeneration(),
    source,
    contract.path,
    input,
    enabled,
  ]);
  const context = useMemo(() => ({ contract, input, source, enabled }), [key]);
  const { load, error, busy, cancel } = useCollectionRead(key);
  const [result, setResult] = useState<{
    context: typeof context;
    value: RouteResponse<C>;
  }>();
  const refresh = useCallback(
    (manual = false) => {
      const input = context.input;
      if (!context.enabled || input === undefined) return Promise.resolve();
      return load(
        (signal, mode) =>
          readRoute(
            context.contract,
            input,
            context.source,
            signal,
            undefined,
            mode,
          ),
        (value) => setResult({ context, value }),
        manual,
      );
    },
    [context, load],
  );
  const subscriptions = JSON.stringify([collections, events, conversation]);
  useEffect(() => {
    if (!enabled) return;
    const update = (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (!sources || sources.includes(source)) void refresh();
    };
    // A notification during the initial snapshot must queue another read.
    const stops = collections.map((collection) =>
      listenWorkspaceChanges(collection, update, source, conversation),
    );
    // The shared watcher broadcasts recovery after consuming failed-read
    // interest, even when a detail query has no collection subscription.
    const recover = (event: Event) => {
      if (broadWorkspaceChange(event)) update(event);
    };
    const recoverBroad =
      !collections.length && !events.includes("loop-workspace-change");
    if (recoverBroad) window.addEventListener("loop-workspace-change", recover);
    for (const event of events) window.addEventListener(event, update);
    void refresh();
    return () => {
      for (const stop of stops) stop();
      if (recoverBroad)
        window.removeEventListener("loop-workspace-change", recover);
      for (const event of events) window.removeEventListener(event, update);
    };
  }, [refresh, subscriptions, revision]);
  const data = result?.context === context ? result.value : undefined;
  const replace = useCallback(
    (value: RouteResponse<C>) => {
      if (context.enabled && cancel()) setResult({ context, value });
    },
    [cancel, context],
  );
  return {
    data,
    error,
    busy,
    loading: enabled && data === undefined && !error,
    refresh,
    retry: () => refresh(true),
    replace,
  };
}

type PagedOptions<P, C> = {
  key: string;
  source: string | readonly string[];
  enabled?: boolean;
  events?: readonly string[];
  coalesceDelay?: number;
  revision?: string | number;
  requireAdvance?: boolean;
  needsRefresh?: (page: P) => boolean;
  empty: P;
  collections: QueryOptions["collections"];
  read: (
    current: P,
    before: C | undefined,
    signal: AbortSignal,
    mode: ReadMode,
    readComplete: () => void,
  ) => Promise<P>;
  queueMore?: boolean;
  refreshDelay: (reads: number) => number;
};

/** A refresh commits the loaded range together, keeping rows and scroll stable. */
export function usePagedProjectionQuery<
  P extends { next: C | null },
  C extends string | number,
>(options: PagedOptions<P, C>) {
  const generation = viewGeneration();
  const identity = JSON.stringify([
    generation,
    options.source,
    options.key,
    options.enabled !== false,
  ]);
  const context = useMemo(
    () => ({
      options,
      more: () => {},
      retry: () => {},
      refresh: (_manual = false) => {},
    }),
    [identity],
  );
  const [state, setState] = useState({
    context,
    page: options.empty,
    loading: true,
    appending: false,
    error: "",
  });
  useEffect(() => {
    const {
      source,
      empty,
      collections,
      read,
      queueMore,
      refreshDelay,
      enabled = true,
      events = ["loop-refresh"],
      coalesceDelay = 0,
      needsRefresh,
      requireAdvance = false,
    } = context.options;
    if (!enabled) return;
    const sourceList = typeof source === "string" ? [source] : source;
    const controller = new AbortController();
    const stale = () =>
      controller.signal.aborted || generation !== viewGeneration();
    let current = empty,
      busy = false,
      appendPending = false,
      pending = false,
      urgent = false,
      pendingManual = false,
      refreshAfter = 0;
    let retryBefore: C | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      pending = true;
      if (busy || timer || stale()) return;
      timer = setTimeout(
        () => void load(undefined, pendingManual),
        urgent ? 0 : Math.max(coalesceDelay, refreshAfter - Date.now()),
      );
    };
    const load = async (before?: C, manual = false) => {
      if (busy || stale()) return;
      clearTimeout(timer);
      timer = undefined;
      busy = true;
      retryBefore = before;
      if (before === undefined) {
        pending = false;
        urgent = false;
        pendingManual = false;
      }
      setState((old) => ({
        ...old,
        context,
        page: old.context === context ? old.page : empty,
        loading: true,
        appending: before !== undefined || appendPending,
        error: "",
      }));
      let reads = 0,
        complete = false;
      try {
        const page = await read(
          current,
          before,
          controller.signal,
          manual ? "manual" : "automatic",
          () => {
            reads++;
          },
        );
        if (stale()) return;
        if (requireAdvance && before !== undefined && page.next === before)
          throw new Error("Pagination did not advance");
        current = page;
        complete = true;
        setState({
          context,
          page: current,
          loading: false,
          appending: false,
          error: "",
        });
      } catch (error) {
        if (!stale())
          setState((old) => ({
            ...old,
            context,
            loading: false,
            appending: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        busy = false;
        if (before === undefined || !queueMore)
          refreshAfter = urgent ? 0 : Date.now() + refreshDelay(reads);
        if (!stale()) {
          if (complete && needsRefresh?.(current)) pending = true;
          const append = complete && appendPending ? current.next : null;
          if (complete) appendPending = false;
          if (append !== null) void load(append);
          else if (pending) schedule();
        }
      }
    };
    const refresh = (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (sources && !sourceList.some((item) => sources.includes(item))) return;
      if (event.type === "loop-refresh") {
        urgent = true;
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    };
    context.more = () => {
      if (current.next === null || stale()) return;
      if (busy && queueMore) {
        appendPending = true;
        setState((old) => ({ ...old, appending: true }));
      } else void load(current.next);
    };
    context.retry = () => void load(retryBefore, true);
    context.refresh = (manual = false) => {
      if (busy) {
        pendingManual ||= manual;
        urgent ||= manual;
        schedule();
      } else void load(undefined, manual);
    };
    const stops = (collections ?? []).map((collection) =>
      listenWorkspaceChanges(collection, (event) => {
        if (
          sourceList.some((item) =>
            workspaceChangeAffects(event, collection, item),
          )
        )
          refresh(event);
      }),
    );
    for (const event of events) window.addEventListener(event, refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      for (const event of events) window.removeEventListener(event, refresh);
    };
  }, [context]);
  useEffect(() => {
    if (options.enabled !== false) context.refresh();
  }, [context, options.revision]);
  return {
    ...(options.enabled === false
      ? { page: options.empty, loading: false, appending: false, error: "" }
      : state.context === context
        ? state
        : { page: options.empty, loading: true, appending: false, error: "" }),
    more: () => context.more(),
    retry: () => context.retry(),
    refresh: (manual = false) => context.refresh(manual),
  };
}

/** Read failures belong to this owner/source/selection, independently of actions.
 * Signals start the normal bounded read; a button tries just one more read. */
export function useCollectionRead(key: string) {
  const owner = viewGeneration();
  const [state, setState] = useState<{
    reader: ReturnType<typeof createReadExecutor>;
    value: ReadState;
  }>();
  const reader: ReturnType<typeof createReadExecutor> = useMemo(
    () =>
      createReadExecutor({
        current: () => owner === viewGeneration(),
        changed: (value) => setState({ reader, value }),
      }),
    [key, owner],
  );
  useEffect(() => {
    reader.activate();
    return () => reader.dispose();
  }, [reader]);
  const value = state?.reader === reader ? state.value : undefined;
  return {
    load: reader.load,
    execute: reader.execute,
    request: reader.request,
    cancel: reader.cancel,
    isBusy: reader.isBusy,
    error: value?.error ?? "",
    failure: value?.failure,
    busy: value?.busy ?? false,
  };
}

export function CollectionReadNotice({
  error,
  busy = false,
  retry,
  dismiss,
}: {
  error: string;
  busy?: boolean;
  retry: () => void;
  dismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error collection-read-error" role="alert">
      This view may be out of date. {error}{" "}
      <button className="text-button" disabled={busy} onClick={retry}>
        Retry connection
      </button>
      {dismiss && (
        <button type="button" className="text-button" onClick={dismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
