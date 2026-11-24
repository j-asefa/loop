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
  const [extraRecipients, setExtraRecipients] = useState<string[]>([]);
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
  useEffect(() => {
    if (conversation) return;
    setExtraRecipients((current) => {
      if (selected === "__route__") return current.length ? [] : current;
      const next = current.filter((id) => id !== selected);
      return next.length === current.length ? current : next;
    });
  }, [selected, conversation]);
  const globalComposer = useRef({
    selected,
    extraRecipients,
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
      extraRecipients: Array.isArray(saved?.extraRecipients)
        ? saved.extraRecipients.filter(
            (id): id is string =>
              typeof id === "string" &&
              Boolean(id) &&
              id !== saved?.selected &&
              id !== "__route__",
          )
        : [],
      replyContext: saved?.replyContext || null,
      folderChoice:
        saved?.folderChoice ?? (firstOwner ? initial.folderChoice : undefined),
      contextArtifact: null,
    };
    setSelected(restored.selected);
    setExtraRecipients(restored.extraRecipients);
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
    composerStorage.write({
      selected,
      ...(extraRecipients.length ? { extraRecipients } : {}),
      replyContext,
      folderChoice,
    });
  }, [
    composerStorage,
    draftScope,
    hydratedDraftScope,
    conversation,
    selected,
    extraRecipients,
    replyContext,
    folderChoice,
  ]);
  useEffect(() => {
    if (hydratedDraftScope === draftScope) shareStorage.write(sharedDraft);
  }, [shareStorage, draftScope, hydratedDraftScope, sharedDraft]);
  /**
   * Remove one extra recipient once its send was accepted. The saved
   * composer is updated now, not after the next render, so a reload during
   * the rest of the batch does not offer that recipient again.
   */
  function dropExtraRecipient(id: string) {
    setExtraRecipients((current) => current.filter((entry) => entry !== id));
    if (hydratedDraftScope !== draftScope || conversation) return;
    const saved = composerStorage.read();
    if (!saved) return;
    const remaining = (saved.extraRecipients ?? []).filter(
      (entry) => entry !== id,
    );
    const { extraRecipients: _previous, ...rest } = saved;
    composerStorage.write(
      remaining.length ? { ...rest, extraRecipients: remaining } : rest,
    );
  }
  function captureGlobalComposer() {
    globalComposer.current = {
      selected,
      extraRecipients,
      replyContext,
      contextArtifact,
      folderChoice,
    };
  }
  function restoreGlobalComposer() {
    const previous = globalComposer.current;
    setSelected(previous.selected);
    setExtraRecipients(previous.extraRecipients);
    setReplyContext(previous.replyContext);
    setContextArtifact(previous.contextArtifact);
    setFolderChoice(previous.folderChoice);
  }
  return {
    selected,
    setSelected,
    extraRecipients,
    setExtraRecipients,
    dropExtraRecipient,
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
