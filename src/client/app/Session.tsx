import { LoopLogo } from "../LoopLogo";
import { executionSourceId, returnToLocalSource } from "../sourceRouting";
import { readRoute } from "../workspace-api";
import { workspaceApi } from "../../shared/workspace-api";
import { useEffect } from "react";

import { Pairing } from "../Pairing";

import type { AppModel } from "./AppController";

function discardPairingFragment() {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has("pair") || fragment.has("fleet"))
    history.replaceState(null, "", url.pathname + url.search);
}

export function createSessionCheck(props: {
  setSession(value: unknown): void;
}) {
  const { setSession } = props;
  async function check(signal = new AbortController().signal) {
    const source = executionSourceId();
    try {
      const result = await readRoute(
        workspaceApi.authSession,
        {},
        source.startsWith("peer:") ? "" : source,
        signal,
      );
      if (signal.aborted) return;
      if (result?.user) {
        // An already paired browser bypasses the pairing page. Discard a
        // newly opened capability without storing or redeeming either half.
        discardPairingFragment();
      }
      setSession(result);
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = error as { status?: number; redirected?: boolean };
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
  props: Pick<
    AppModel,
    | "session"
    | "check"
    | "setError"
    | "setSession"
    | "setData"
    | "setItems"
    | "setRuns"
    | "setSendNotice"
    | "setWorkspaceLoadErrors"
    | "setTeamSelection"
    | "setArchivedCard"
    | "setComposerExpanded"
    | "setDraft"
    | "setSelected"
    | "setFolderChoice"
    | "setSharedDraft"
    | "setProfile"
    | "setConversation"
    | "setActiveArtifact"
    | "setContextArtifact"
    | "setReplyContext"
    | "setRoutePreview"
    | "setFiling"
    | "setLaterCard"
    | "setSettingsParent"
    | "setSheet"
    | "composerFocusRequest"
    | "setBootstrapOwner"
  >,
) {
  const {
    check,
    setError,
    setSession,
    setData,
    setItems,
    setRuns,
    setSendNotice,
    setWorkspaceLoadErrors,
    setTeamSelection,
    setArchivedCard,
    setComposerExpanded,
    setDraft,
    setSelected,
    setFolderChoice,
    setSharedDraft,
    setProfile,
    setConversation,
    setActiveArtifact,
    setContextArtifact,
    setReplyContext,
    setRoutePreview,
    setFiling,
    setLaterCard,
    setSettingsParent,
    setSheet,
    composerFocusRequest,
    setBootstrapOwner,
  } = props;
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
    void check(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    const expire = () => {
      setSession(null);
      composerFocusRequest.current = null;
      setData({ agents: [], connections: [], folders: [] });
      setBootstrapOwner(undefined);
      setItems([]);
      setRuns([]);
      setSendNotice(null);
      setWorkspaceLoadErrors({});
      sessionStorage.clear();
      setTeamSelection([]);
      setArchivedCard(null);
      setComposerExpanded(false);
      setDraft("");
      setSelected("");
      setFolderChoice(undefined);
      setSharedDraft({
        url: "",
        title: "",
        excerpt: "",
        question: "",
        folderId: "",
      });
      setProfile(null);
      setConversation(null);
      setActiveArtifact(null);
      setContextArtifact(null);
      setReplyContext(null);
      setRoutePreview(null);
      setFiling(null);
      setLaterCard(null);
      setSettingsParent(false);
      setSheet("");
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
