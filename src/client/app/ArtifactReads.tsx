import { useEffect, useMemo, type RefObject } from "react";
import { ArtifactId } from "../../shared/contract-ids.js";
import { contractCardReader } from "../../shared/card-client";
import { workspaceApi } from "../../shared/workspace-api";
import { CollectionReadNotice, useCollectionRead } from "../CollectionRead";
import { readRoute } from "../api";
import { resultAction, resultTarget, type ResultAction } from "../card-actions";
import type { ComposerContext } from "../composerContext";
import { parse } from "../json";
import { executionSourceId } from "../sourceRouting";
import { viewGeneration } from "../viewCache";

export function useArtifactReads({
  ownerRef,
  initialArtifact,
  onStartOpen,
  onOpen,
  onReply,
}: {
  ownerRef: RefObject<string | undefined>;
  initialArtifact?: string | null;
  onStartOpen(): void;
  onOpen(item: ResultAction): void;
  onReply(context: ComposerContext): void;
}) {
  const source = executionSourceId();
  const key = JSON.stringify([viewGeneration(), source]);
  const opening = useCollectionRead("artifact-open:" + key);
  const replying = useCollectionRead("artifact-reply:" + key);
  const context = useMemo(
    () => ({
      open: undefined as ResultAction | string | undefined,
      reply: undefined as ResultAction | undefined,
    }),
    [key],
  );
  const owner = ownerRef.current;

  async function openTarget(target: ResultAction | string, retry = false) {
    if (!retry) {
      if (!opening.cancel()) return;
      replying.cancel();
      context.reply = undefined;
    }
    const owner = ownerRef.current;
    if (
      !owner ||
      (typeof target !== "string" &&
        target.cardOwner &&
        target.cardOwner !== owner)
    )
      return;
    context.open = target;
    const selectedSource =
      typeof target === "string" ? source : (target.sourceId ?? source);
    if (selectedSource !== executionSourceId()) return;
    await opening.load(
      async (signal, mode) => {
        onStartOpen();
        let item: ResultAction =
          typeof target === "string"
            ? await readRoute(
                workspaceApi.artifactDetail,
                { params: { id: ArtifactId.parse(target) } },
                selectedSource,
                signal,
                undefined,
                mode,
              )
            : target;
        const reader = contractCardReader((contract, input) =>
          readRoute(contract, input, selectedSource, signal, undefined, mode),
        );
        try {
          const card = await reader.detail(
            item.card?.id ?? "a:" + resultTarget(item).id,
            signal,
          );
          if (card.type !== "result") throw new Error("Expected a result card");
          item = resultAction(card, selectedSource, owner);
        } catch (error) {
          // Files and search can open artifacts outside the public selections.
          if (item.card || (error as { status?: number }).status !== 404)
            throw error;
          item = await readRoute(
            workspaceApi.artifactDetail,
            { params: { id: resultTarget(item).id } },
            selectedSource,
            signal,
            undefined,
            mode,
          );
        }
        return item;
      },
      (item) => {
        if (
          owner === ownerRef.current &&
          selectedSource === executionSourceId()
        )
          onOpen(item);
      },
      true,
    );
  }

  async function replyToArtifact(item: ResultAction, retry = false) {
    if (!retry) {
      if (!replying.cancel()) return;
      opening.cancel();
      context.open = undefined;
    }
    const owner = ownerRef.current;
    if (!owner || (item.cardOwner && item.cardOwner !== owner)) return;
    context.reply = item;
    const selectedSource = item.sourceId ?? source;
    if (selectedSource !== executionSourceId()) return;
    await replying.load<ResultAction>(
      async (signal, mode) => {
        if (!item.card)
          return readRoute(
            workspaceApi.artifactDetail,
            { params: { id: resultTarget(item).id } },
            selectedSource,
            signal,
            undefined,
            mode,
          );
        const reader = contractCardReader((contract, input) =>
          readRoute(contract, input, selectedSource, signal, undefined, mode),
        );
        const card = await reader.detail(item.card.id, signal);
        if (card.type !== "result") throw new Error("Expected a result card");
        return resultAction(card, selectedSource, owner);
      },
      (original) => {
        if (
          owner !== ownerRef.current ||
          selectedSource !== executionSourceId()
        )
          return;
        const target = resultTarget(original);
        const imported = original.card
          ? original.card.role === "import"
          : parse<any>(original.metadata, {}).origin === "import";
        if (!target.agent_id || !target.conversation_id || imported)
          return void openTarget(original);
        onReply({
          agentId: target.agent_id,
          conversationId: target.conversation_id,
          messageId: original.card
            ? original.card.source.message_id || undefined
            : parse<any>(original.metadata, {}).messageId,
          artifactId: target.id,
          title: target.title,
          content: target.content,
        });
      },
      true,
    );
  }

  useEffect(() => {
    if (owner && initialArtifact) void openTarget(initialArtifact);
  }, [owner, initialArtifact]);
  return {
    open: (item: ResultAction) => openTarget(item),
    replyToArtifact: (item: ResultAction) => replyToArtifact(item),
    opening: {
      error: opening.error,
      busy: opening.busy,
      dismiss: () => {
        if (opening.cancel()) context.open = undefined;
      },
      retry: () => {
        if (context.open) void openTarget(context.open, true);
      },
    },
    replying: {
      error: replying.error,
      busy: replying.busy,
      dismiss: () => {
        if (replying.cancel()) context.reply = undefined;
      },
      retry: () => {
        if (context.reply) void replyToArtifact(context.reply, true);
      },
    },
  };
}

export function renderArtifactReadNotice(
  reads: Pick<ReturnType<typeof useArtifactReads>, "opening" | "replying">,
) {
  if (!reads.opening.error && !reads.replying.error) return null;
  return (
    <>
      <CollectionReadNotice {...reads.opening} />
      <CollectionReadNotice {...reads.replying} />
    </>
  );
}
