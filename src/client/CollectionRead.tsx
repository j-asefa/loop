import { ErrorNotice } from "./ErrorNotice";
import { listenClientEvent, type ClientEvents } from "./clientEvents";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isRateLimited, readRoute } from "./api";
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

type QueryEvent = keyof ClientEvents | "focus";
function listenQueryEvent(name: QueryEvent, receive: (event: Event) => void) {
  if (name === "focus") {
    window.addEventListener(name, receive);
    return () => window.removeEventListener(name, receive);
  }
  return listenClientEvent(name, (_detail, event) => receive(event));
}

type QueryOptions = {
  source: string;
  conversation?: string;
  collections?: readonly Parameters<typeof listenWorkspaceChanges>[0][];
  events?: readonly QueryEvent[];
  revision?: string | number;
  resetOnRevision?: boolean;
  enabled?: boolean;
  reportRetries?: boolean | "transient";
  mode?: "once";
};

/** Revisions retain rows unless the caller explicitly resets its snapshot. */
export function useProjectionQuery<C extends RouteContract & { method: "GET" }>(
  contract: C,
  input: RouteInput<C> | undefined,
  {
    source,
    conversation,
    collections = [],
    events = [],
    revision = 0,
    resetOnRevision = false,
    reportRetries = false,
    mode: requestedMode,
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
    reportRetries,
    requestedMode,
    resetOnRevision ? revision : undefined,
  ]);
  const context = useMemo(
    () => ({ contract, input, source, enabled, reportRetries, requestedMode }),
    [key],
  );
  const { load, error, busy, cancel } = useCollectionRead(key);
  const [result, setResult] = useState<{
    context: typeof context;
    value: RouteResponse<C>;
  }>();
  const [retryFailure, setRetryFailure] = useState<{
    context: typeof context;
    message: string;
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
            context.reportRetries
              ? (failure) => {
                  if (
                    !signal.aborted &&
                    (context.reportRetries !== "transient" ||
                      !isRateLimited(failure))
                  )
                    setRetryFailure({
                      context,
                      message: (failure as Error).message,
                    });
                }
              : undefined,
            context.requestedMode ?? mode,
          ),
        (value) => {
          setResult({ context, value });
          setRetryFailure(undefined);
        },
        manual,
      );
    },
    [context, load],
  );
  const subscriptions = JSON.stringify([collections, events, conversation]);
  useEffect(() => {
    if (!enabled) return;
    const update = (event: Event) => {
      const sources = (
        event as CustomEvent<ClientEvents["loop-workspace-change"]>
      ).detail?.sources;
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
    if (recoverBroad)
      stops.push(listenQueryEvent("loop-workspace-change", recover));
    for (const event of events) stops.push(listenQueryEvent(event, update));
    void refresh();
    return () => {
      for (const stop of stops) stop();
    };
  }, [refresh, subscriptions, revision]);
  const data = result?.context === context ? result.value : undefined;
  const replace = useCallback(
    (
      value:
        | RouteResponse<C>
        | ((previous: RouteResponse<C> | undefined) => RouteResponse<C>),
    ) => {
      if (!context.enabled || !cancel()) return;
      setRetryFailure(undefined);
      setResult((previous) => ({
        context,
        value:
          typeof value === "function"
            ? (
                value as (
                  previous: RouteResponse<C> | undefined,
                ) => RouteResponse<C>
              )(previous?.context === context ? previous.value : undefined)
            : value,
      }));
    },
    [cancel, context],
  );
  return {
    data,
    error:
      error || (retryFailure?.context === context ? retryFailure.message : ""),
    busy,
    loading:
      enabled &&
      data === undefined &&
      !error &&
      retryFailure?.context !== context,
    refresh,
    retry: () => refresh(true),
    replace,
  };
}

type PagedOptions<P, C> = {
  key: string;
  source: string | readonly string[];
  enabled?: boolean;
  // WebKit can tear down the document before passive cleanup runs.
  pauseOnPageHide?: boolean;
  events?: readonly QueryEvent[];
  coalesceDelay?: number;
  revision?: string | number;
  requireAdvance?: boolean;
  needsRefresh?: (page: P) => boolean;
  /** An explicit pull can cancel a stalled read and restart reconciliation
   * from the retained window. Background notifications remain coalesced. */
  restartOnRefresh?: (page: P) => P;
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
    options.pauseOnPageHide === true,
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
      pauseOnPageHide = false,
      enabled = true,
      events = ["loop-refresh"],
      coalesceDelay = 0,
      needsRefresh,
      restartOnRefresh,
      requireAdvance = false,
    } = context.options;
    if (!enabled) return;
    const sourceList = typeof source === "string" ? [source] : source;
    let active = true,
      paused = false,
      requestEpoch = 0;
    const stale = () => !active || paused || generation !== viewGeneration();
    const reader = createReadExecutor({
      current: () => !stale(),
      changed: () => {},
    });
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
      const epoch = requestEpoch;
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
        const page = await reader.request(
          (signal, mode) =>
            read(current, before, signal, mode, () => {
              reads++;
            }),
          { mode: manual ? "manual" : "automatic" },
        );
        if (stale() || epoch !== requestEpoch) return;
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
        if (!stale() && epoch === requestEpoch)
          setState((old) => ({
            ...old,
            context,
            loading: false,
            appending: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        // A resumed read may already own busy/pending when the cancelled one settles.
        if (epoch === requestEpoch) {
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
      }
    };
    const refresh = (event: Event) => {
      const sources = (
        event as CustomEvent<ClientEvents["loop-workspace-change"]>
      ).detail?.sources;
      if (sources && !sourceList.some((item) => sources.includes(item))) return;
      if (event.type === "loop-refresh") {
        urgent = true;
        clearTimeout(timer);
        timer = undefined;
        if (restartOnRefresh && !stale()) {
          const resumeAppend =
            appendPending || (busy && retryBefore !== undefined);
          requestEpoch++;
          reader.cancel();
          busy = false;
          appendPending = resumeAppend;
          current = restartOnRefresh(current);
          void load();
          return;
        }
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
    const hide = () => {
      paused = true;
      requestEpoch++;
      reader.dispose();
      clearTimeout(timer);
      timer = undefined;
      busy = false;
      pending = false;
      pendingManual = false;
      urgent = false;
      appendPending = false;
      setState((old) => ({ ...old, loading: false, appending: false }));
    };
    const show = () => {
      if (!paused || !active || generation !== viewGeneration()) return;
      paused = false;
      reader.activate();
      void load(undefined);
    };
    if (pauseOnPageHide) {
      window.addEventListener("pagehide", hide);
      window.addEventListener("pageshow", show);
    }
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
    for (const event of events) stops.push(listenQueryEvent(event, refresh));
    return () => {
      active = false;
      reader.dispose();
      clearTimeout(timer);
      if (pauseOnPageHide) {
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", show);
      }
      stops.forEach((stop) => stop());
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
    <ErrorNotice as="div" className="error collection-read-error" role="alert">
      This view may be out of date. {error}{" "}
      <button className="text-button" disabled={busy} onClick={retry}>
        Retry connection
      </button>
      {dismiss && (
        <button type="button" className="text-button" onClick={dismiss}>
          Dismiss
        </button>
      )}
    </ErrorNotice>
  );
}
