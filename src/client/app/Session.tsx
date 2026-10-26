import { executionSourceId, returnToLocalSource, sourceApiPath } from "../sourceRouting";
import { useEffect } from "react";
import { Orbit } from "lucide-react";

import { Auth } from "../Auth";

import type { AppModel } from "./AppController";

export function createSessionCheck(props: { setSession(value: unknown): void }) {
  const {
    setSession,
  } = props;
  async function check() {
    const r = await fetch(sourceApiPath("/api/auth/get-session"), {
      cache: "no-store",
    });
    if (
      r.redirected &&
      !r.headers.get("content-type")?.includes("application/json")
    ) {
      location.reload();
      return;
    }
    const result = await r.json();
    if (r.status === 401 && executionSourceId()) {
      returnToLocalSource();
      return;
    }
    if (!r.ok)
      throw new Error(result.error || "Could not open your workspace.");
    setSession(
      result ? { ...result, mode: result.mode || "multi-user" } : null,
    );
  }
  return check;
}

export function useSessionLifecycle(props: Pick<AppModel,
  "check" | "setError" | "personalWorkspace" | "setSession" | "setData" |
  "setItems" | "setRuns" | "setSendNotice" | "setWorkspaceLoadErrors" | "setTeamSelection" |
  "setArchivedCard" | "setComposerExpanded" | "setDraft" | "setSelected" | "setFolderChoice" |
  "setSharedDraft" | "setProfile" | "setConversation" | "setActiveArtifact" | "setContextArtifact" |
  "setReplyContext" | "setRoutePreview" | "setFiling" | "setLaterCard" | "setSettingsParent" |
  "setSheet"
>) {
  const {
    check, setError, personalWorkspace, setSession, setData,
    setItems, setRuns, setSendNotice, setWorkspaceLoadErrors, setTeamSelection,
    setArchivedCard, setComposerExpanded, setDraft, setSelected, setFolderChoice,
    setSharedDraft, setProfile, setConversation, setActiveArtifact, setContextArtifact,
    setReplyContext, setRoutePreview, setFiling, setLaterCard, setSettingsParent,
    setSheet,
  } = props;
  useEffect(() => {
    void check().catch((e) => setError(e.message));
    const expire = () => {
      if (personalWorkspace.current) {
        location.reload();
        return;
      }
      setSession(null);
      setData({ agents: [], connections: [], folders: [] });
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
    return () => window.removeEventListener("loop-auth-expired", expire);
  }, []);
}

export function renderSessionGate(props: Pick<AppModel,
  "session" | "error" | "check"
>) {
  const {
    session, error, check,
  } = props;
  if (session === undefined)
    return (
      <div className="loading">
        <Orbit className="spin" />
        <p>{error || "Opening your workspace…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </div>
    );
  if (!session?.user) return <Auth onDone={() => void check()} />;
  return null;
}
