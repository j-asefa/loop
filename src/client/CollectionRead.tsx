import { useCallback, useEffect, useMemo, useState } from "react";
import { readRoute, type ReadMode } from "./api";
import type {
  RouteContract,
  RouteInput,
  RouteResponse,
} from "../shared/workspace-api";
import { viewGeneration } from "./viewCache";
import {
  broadWorkspaceChange,
  listenWorkspaceChanges,
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
  input: RouteInput<C>,
  {
    source,
    conversation,
    collections = [],
    events = [],
    revision = 0,
    enabled = true,
  }: QueryOptions,
) {
  const key = JSON.stringify([
    viewGeneration(),
    source,
    contract.path,
    input,
    enabled,
  ]);
  const context = useMemo(() => ({ contract, input, source, enabled }), [key]);
  const { load, error, busy } = useCollectionRead(key);
  const [result, setResult] = useState<{
    context: typeof context;
    value: RouteResponse<C>;
  }>();
  const refresh = useCallback(
    (manual = false) => {
      if (!context.enabled) return Promise.resolve();
      return load(
        (signal, mode) =>
          readRoute(
            context.contract,
            context.input,
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
    if (!collections.length)
      window.addEventListener("loop-workspace-change", recover);
    for (const event of events) window.addEventListener(event, update);
    void refresh();
    return () => {
      for (const stop of stops) stop();
      if (!collections.length)
        window.removeEventListener("loop-workspace-change", recover);
      for (const event of events) window.removeEventListener(event, update);
    };
  }, [refresh, subscriptions, revision]);
  const data = result?.context === context ? result.value : undefined;
  return {
    data,
    error,
    busy,
    loading: enabled && data === undefined && !error,
    refresh,
    retry: () => refresh(true),
  };
}

type PagedOptions<P, C> = {
  key: string;
  source: string;
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
  const identity = JSON.stringify([generation, options.source, options.key]);
  const context = useMemo(
    () => ({ options, more: () => {}, retry: () => {} }),
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
    const { source, empty, collections, read, queueMore, refreshDelay } =
      context.options;
    const controller = new AbortController();
    const stale = () =>
      controller.signal.aborted || generation !== viewGeneration();
    let current = empty,
      busy = false,
      appendPending = false,
      pending = false,
      urgent = false,
      refreshAfter = 0;
    let retryBefore: C | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      pending = true;
      if (busy || timer || stale()) return;
      timer = setTimeout(
        () => void load(),
        urgent ? 0 : Math.max(0, refreshAfter - Date.now()),
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
      }
      setState((old) => ({
        ...old,
        context,
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
      if (sources && !sources.includes(source)) return;
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
    const stops = (collections ?? []).map((collection) =>
      listenWorkspaceChanges(collection, refresh, source),
    );
    window.addEventListener("loop-refresh", refresh);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      window.removeEventListener("loop-refresh", refresh);
    };
  }, [context]);
  return {
    ...(state.context === context
      ? state
      : { page: options.empty, loading: true, appending: false, error: "" }),
    more: () => context.more(),
    retry: () => context.retry(),
  };
}

/** Read failures belong to this owner/source/selection, independently of actions.
 * Signals start the normal bounded read; a button tries just one more read. */
export function useCollectionRead(key: string) {
  const owner = viewGeneration();
  const context = useMemo(
    () => ({
      controller: undefined as AbortController | undefined,
      active: true,
      running: false,
      queued: undefined as (() => Promise<void>) | undefined,
    }),
    [key, owner],
  );
  const [state, setState] = useState({ context, error: "", busy: false });
  useEffect(() => {
    context.active = true;
    return () => {
      context.active = false;
      context.running = false;
      context.queued = undefined;
      context.controller?.abort();
    };
  }, [context]);
  const load = useCallback(
    async function load<T>(
      read: (signal: AbortSignal, mode: ReadMode) => Promise<T>,
      receive: (value: T) => void,
      manual = false,
    ): Promise<void> {
      if (!context.active || owner !== viewGeneration()) return;
      // Recovery or event bursts must let a healthy slow read finish. Keep
      // one trailing refresh so changes during that read are not lost.
      if (context.running && !manual) {
        context.queued = () => load(read, receive);
        return;
      }
      context.queued = undefined;
      context.running = true;
      context.controller?.abort();
      const controller = new AbortController();
      context.controller = controller;
      const current = () =>
        context.active &&
        !controller.signal.aborted &&
        context.controller === controller &&
        owner === viewGeneration();
      setState((old) => ({
        context,
        error: old.context === context ? old.error : "",
        busy: true,
      }));
      try {
        const value = await read(
          controller.signal,
          manual ? "manual" : "automatic",
        );
        if (!current()) return;
        receive(value);
        setState({ context, error: "", busy: false });
      } catch (error) {
        if (!current()) return;
        setState({
          context,
          error:
            error instanceof Error
              ? error.message
              : "The workspace is unavailable.",
          busy: false,
        });
      } finally {
        if (context.controller === controller) {
          context.running = false;
          // Another load can queue a refresh across the await above.
          const queued = context.queued as (() => Promise<void>) | undefined;
          context.queued = undefined;
          if (current()) void queued?.();
        }
      }
    },
    [context, owner],
  );
  return {
    load,
    error: state.context === context ? state.error : "",
    busy: state.context === context && state.busy,
  };
}

export function CollectionReadNotice({
  error,
  busy = false,
  retry,
}: {
  error: string;
  busy?: boolean;
  retry: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error collection-read-error" role="alert">
      This view may be out of date. {error}{" "}
      <button className="text-button" disabled={busy} onClick={retry}>
        Retry connection
      </button>
    </div>
  );
}
