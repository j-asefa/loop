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
        error: manual && old.context === context ? old.error : "",
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
