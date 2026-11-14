import { LoopLogo } from "../LoopLogo";
import { executionSourceId, returnToLocalSource } from "../sourceRouting";
import { readRoute } from "../api";
import { workspaceApi } from "../../shared/workspace-api";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { replaceConversationLocation } from "./Navigation";
import { ownerSession, type BrowserSession } from "../ownerSession";

import { Pairing } from "../Pairing";

import type { AppModel } from "./AppController";

export function useOwnerSession() {
  const { session, owner, generation } = useSyncExternalStore(
    ownerSession.subscribe,
    () => ownerSession.current,
  );
  const scope = useMemo(
    () => ({ owner, generation, active: true }),
    [owner, generation],
  );
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const ownerRef = useMemo(
    () => ({
      get current() {
        return scope.active &&
          ownerSession.current.generation === scope.generation
          ? scope.owner
          : undefined;
      },
    }),
    [scope],
  );
  return { session, generation, ownerRef, setSession: ownerSession.setSession };
}

function discardPairingFragment() {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has("pair") || fragment.has("fleet"))
    history.replaceState(null, "", url.pathname + url.search);
}

export function createSessionCheck(props: {
  setSession(value: BrowserSession): void;
}) {
  const { setSession } = props;
  async function check(signal = new AbortController().signal) {
    const started = ownerSession.current;
    const source = executionSourceId();
    try {
      const result = await readRoute(
        workspaceApi.authSession,
        {},
        source.startsWith("peer:") ? "" : source,
        signal,
      );
      if (signal.aborted || ownerSession.current !== started) return;
      if (result?.user) {
        // An already paired browser bypasses the pairing page. Discard a
        // newly opened capability without storing or redeeming either half.
        discardPairingFragment();
      }
      setSession(result);
    } catch (error) {
      const failure = error as {
        status?: number;
        redirected?: boolean;
        expiredGeneration?: number;
      };
      const current = ownerSession.current;
      const sameOwner =
        current.owner === started.owner &&
        current.generation === started.generation;
      const ownExpiry =
        !current.owner &&
        failure.expiredGeneration !== undefined &&
        failure.expiredGeneration === current.generation;
      if (!sameOwner && !ownExpiry) return;
      if (signal.aborted) throw error;
      if (failure.redirected) {
        location.reload();
        return;
      }
      if (failure.status === 401 && source && !source.startsWith("peer:")) {
        returnToLocalSource();
        return;
      }
      throw error;
    }
  }
  return check;
}

export function useSessionLifecycle(
  props: Pick<AppModel, "session" | "check" | "setError" | "setSession">,
) {
  const { check, setError, setSession } = props;
  useEffect(() => {
    if (!props.session?.user) return;
    // Opening another fragment at this origin can be a same-document
    // navigation; it does not mount Pairing or fetch the session again.
    discardPairingFragment();
    window.addEventListener("hashchange", discardPairingFragment);
    return () =>
      window.removeEventListener("hashchange", discardPairingFragment);
  }, [props.session?.user]);
  useEffect(() => {
    const controller = new AbortController();
    if (props.session === undefined)
      void check(controller.signal).catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    const expire = () => {
      sessionStorage.clear();
      replaceConversationLocation(executionSourceId(), null);
      setSession(null);
    };
    window.addEventListener("loop-auth-expired", expire);
    return () => {
      controller.abort();
      window.removeEventListener("loop-auth-expired", expire);
    };
  }, []);
}

export function renderSessionGate(
  props: Pick<AppModel, "session" | "error" | "check">,
) {
  const { session, error, check } = props;
  if (session === undefined)
    return (
      <div className="loading">
        <LoopLogo size={32} className="spin" />
        <p>{error || "Opening your workspace…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </div>
    );
  if (!session?.user) return <Pairing onDone={() => void check()} />;
  return null;
}
