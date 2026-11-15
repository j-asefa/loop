import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { viewGeneration } from "../viewCache";
import {
  sessionDraft,
  emptySharedDraft,
  type SharedDraft,
  type WorkspaceComposerDraft,
} from "../workspace-drafts";
import type { ComposerContext } from "../composerContext";
import type { ResultAction } from "../card-actions";
import type { AppNavigationInitial } from "./Navigation";

export function useComposerContextDraft({
  initial,
  owner,
  source,
  conversation,
}: {
  initial: AppNavigationInitial;
  owner: string | undefined;
  source: string;
  conversation: string | null;
}) {
  const [selected, setSelected] = useState("");
  const [replyContext, setReplyContext] = useState<ComposerContext | null>(
    null,
  );
  const [contextArtifact, setContextArtifact] = useState<ResultAction | null>(
    null,
  );
  const [folderChoice, setFolderChoice] = useState<string | undefined>(
    initial.folderChoice,
  );
  const [routePreview, setRoutePreview] = useState<any>(null);
  const [sharedDraft, setSharedDraft] = useState<SharedDraft>(
    initial.sharedDraft,
  );
  useEffect(() => {
    if (replyContext && selected !== replyContext.agentId)
      setReplyContext(null);
  }, [selected]);
  const globalComposer = useRef({
    selected,
    replyContext,
    contextArtifact,
    folderChoice,
  });
  const draftGeneration = viewGeneration();
  const composerStorage = useMemo(
    () => sessionDraft<WorkspaceComposerDraft>(owner, source, "composer"),
    [owner, source, draftGeneration],
  );
  const shareStorage = useMemo(
    () => sessionDraft<SharedDraft>(owner, source, "share"),
    [owner, source, draftGeneration],
  );
  const draftScope = JSON.stringify([composerStorage.key, draftGeneration]);
  const [hydratedDraftScope, setHydratedDraftScope] = useState("");
  const incomingShareClaimed = useRef(false);
  useLayoutEffect(() => {
    if (!owner) return;
    const saved = composerStorage.read();
    const firstOwner = !incomingShareClaimed.current;
    const incoming = firstOwner && initial.shareRequested;
    incomingShareClaimed.current = true;
    const restored = {
      selected: saved?.selected || "",
      replyContext: saved?.replyContext || null,
      folderChoice:
        saved?.folderChoice ?? (firstOwner ? initial.folderChoice : undefined),
      contextArtifact: null,
    };
    setSelected(restored.selected);
    setReplyContext(restored.replyContext);
    setFolderChoice(restored.folderChoice);
    setContextArtifact(null);
    setRoutePreview(null);
    globalComposer.current = restored;
    setSharedDraft(
      incoming
        ? initial.sharedDraft
        : shareStorage.read() || emptySharedDraft(),
    );
    setHydratedDraftScope(draftScope);
  }, [composerStorage, shareStorage, draftScope]);
  useEffect(() => {
    // The hydration render's stale values cannot overwrite the newly selected
    // owner's slot. Thread controls are stored by their existing thread owner.
    if (hydratedDraftScope !== draftScope || conversation) return;
    composerStorage.write({ selected, replyContext, folderChoice });
  }, [
    composerStorage,
    draftScope,
    hydratedDraftScope,
    conversation,
    selected,
    replyContext,
    folderChoice,
  ]);
  useEffect(() => {
    if (hydratedDraftScope === draftScope) shareStorage.write(sharedDraft);
  }, [shareStorage, draftScope, hydratedDraftScope, sharedDraft]);
  function captureGlobalComposer() {
    globalComposer.current = {
      selected,
      replyContext,
      contextArtifact,
      folderChoice,
    };
  }
  function restoreGlobalComposer() {
    const previous = globalComposer.current;
    setSelected(previous.selected);
    setReplyContext(previous.replyContext);
    setContextArtifact(previous.contextArtifact);
    setFolderChoice(previous.folderChoice);
  }
  return {
    selected,
    setSelected,
    replyContext,
    setReplyContext,
    contextArtifact,
    setContextArtifact,
    folderChoice,
    setFolderChoice,
    routePreview,
    setRoutePreview,
    sharedDraft,
    setSharedDraft,
    captureGlobalComposer,
    restoreGlobalComposer,
  };
}
