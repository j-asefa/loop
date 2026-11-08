import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadMode } from "./api";
import { viewGeneration } from "./viewCache";

/** Read failures belong to this owner/source/selection, independently of actions.
 * Signals start the normal bounded read; a button tries just one more read. */
export function useCollectionRead(key: string) {
  const owner = viewGeneration();
  const context = useMemo(
    () => ({
      controller: undefined as AbortController | undefined,
      active: true,
    }),
    [key, owner],
  );
  const [state, setState] = useState({ context, error: "", busy: false });
  useEffect(() => {
    context.active = true;
    return () => {
      context.active = false;
      context.controller?.abort();
    };
  }, [context]);
  const load = useCallback(
    async <T,>(
      read: (signal: AbortSignal, mode: ReadMode) => Promise<T>,
      receive: (value: T) => void,
      manual = false,
      background = false,
    ) => {
      if (!context.active || owner !== viewGeneration()) return;
      // Background fallback ticks must not cancel a slow request or its bounded
      // backoff. An actual change or manual retry can still supersede it.
      if (background && context.controller) return;
      // A newer signal supersedes an old attempt and its pending backoff.
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
        error:
          (manual || background) && old.context === context ? old.error : "",
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
        controller.abort();
        if (context.controller === controller) context.controller = undefined;
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
