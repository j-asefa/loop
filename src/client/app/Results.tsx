import { ProjectId, parseId } from "../../shared/contract-ids.js";
import { workspaceApi, type ResultItem } from "../../shared/workspace-api";
import { ContentCard } from "../ContentCard";
import { resultAction, type ResultAction } from "../card-actions";
import { CardPager, type CardWindow } from "../card-pager";
import { CollectionReadNotice, useCollectionRead } from "../CollectionRead";
import { contractCardReader } from "../../shared/card-client";
import { executionSourceId } from "../sourceRouting";
import { cacheView, cachedView } from "../viewCache";
import { ResultsPager } from "../results";
import type { SavedMessage } from "../card-actions";

import { parse } from "../json";
import { callRoute, readRoute } from "../api";
import { Empty, ArtifactCard } from "../components";
import type { Agent } from "../../shared/types";

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AppModel } from "./AppController";

type ResultsProps = {
  ownerRef: RefObject<string | undefined>;
  profile: Agent | null;
  view: string;
  teamKey: string;
  projectFilter: string;
  resultsContext: RefObject<string>;
  resultsSelection: RefObject<{
    key: string;
    retryAppend?: boolean;
    pending?: number;
    foreground?: number;
    failed?: boolean;
    notify?: boolean;
  }>;
  resultsPager: RefObject<ResultsPager<ResultItem>>;
  cardsPager: RefObject<CardPager>;
  setItems(value: ResultItem[] | ResultAction[]): void;
  setNext(value: string | number | null): void;
  setResultsLoading(value: boolean): void;
  setRevision: Dispatch<SetStateAction<number>>;
};

export function useResultsLoader(props: ResultsProps) {
  const {
    ownerRef,
    profile,
    view,
    teamKey,
    projectFilter,
    resultsContext,
    resultsSelection,
    resultsPager,
    cardsPager,
    setItems,
    setNext,
    setResultsLoading,
    setRevision,
  } = props;
  const scope = JSON.stringify([
    ownerRef.current,
    executionSourceId(),
    profile?.id,
    view,
    teamKey,
    projectFilter,
  ]);
  const { load: execute, error } = useCollectionRead(scope);
  async function loadResults(append = false, notify = true, manual = false) {
    if (manual) append = resultsSelection.current.retryAppend ?? false;
    const owner = ownerRef.current,
      source = executionSourceId(),
      key = JSON.stringify([
        owner,
        source,
        profile?.id,
        view,
        teamKey,
        projectFilter,
      ]);
    if (!owner || key !== resultsContext.current) return;
    const cacheKey = "app-cards:" + key;
    if (resultsSelection.current.key !== key) {
      // Both transports publish into the same list. Restore only this exact
      // owner/source/selection's committed window before reconciling changes.
      resultsSelection.current = { key };
      resultsPager.current = new ResultsPager<ResultItem>();
      cardsPager.current.reset();
      const saved = view !== "files" && cachedView<CardWindow>(cacheKey);
      if (saved) {
        cardsPager.current.restore(key, saved);
        setItems(
          saved.page.items.flatMap((entry) =>
            entry.card.type === "result"
              ? [resultAction(entry.card, source, owner)]
              : [],
          ),
        );
        setNext(saved.page.next);
      }
    }
    const selectionContext = resultsSelection.current;
    selectionContext.pending = (selectionContext.pending || 0) + 1;
    selectionContext.notify ||= notify;
    const missing =
      (view === "files" ? resultsPager.current : cardsPager.current).key !==
        key ||
      (view !== "files" && !cardsPager.current.snapshot());
    const foreground =
      manual || append || (missing && !selectionContext.failed);
    if (foreground)
      selectionContext.foreground = (selectionContext.foreground ?? 0) + 1;
    setResultsLoading((selectionContext.foreground ?? 0) > 0);
    if (missing && !selectionContext.failed) {
      setItems([]);
      setNext(null);
    }
    try {
      await execute(
        async (signal, mode) => {
          try {
            const query = () => {
              const q = new URLSearchParams({
                view: ["traces", "messages", "threads"].includes(view)
                  ? "all"
                  : view,
                teams: profile ? "" : teamKey,
              });
              if (profile) q.set("agent", profile.id);
              if (projectFilter && !profile) q.set("folder", projectFilter);
              return q;
            };
            const reader = contractCardReader((contract, input) =>
              readRoute(contract, input, source, signal, undefined, mode),
            );
            const selection = {
              view: "results" as const,
              agent: profile?.id,
              teams: profile ? undefined : teamKey || undefined,
              project: parseId(
                ProjectId,
                !profile && projectFilter ? projectFilter : undefined,
              ),
            };
            const cardPage =
              view !== "files"
                ? await cardsPager.current.load(
                    key,
                    "results",
                    append,
                    (before) =>
                      reader.list({
                        ...selection,
                        ...(before ? { before } : {}),
                      }),
                    (after, through) =>
                      reader.changes({ ...selection, after, through }),
                  )
                : null;
            const result =
              view !== "files"
                ? cardPage && {
                    ...cardPage,
                    items: cardPage.items.flatMap((entry) =>
                      entry.card.type === "result"
                        ? [resultAction(entry.card, source, owner)]
                        : [],
                    ),
                  }
                : await resultsPager.current.load(
                    key,
                    append,
                    async (before) => {
                      const q = query();
                      if (before !== null) q.set("before", String(before));
                      return readRoute(
                        workspaceApi.results,
                        { query: Object.fromEntries(q) },
                        source,
                        signal,
                        undefined,
                        mode,
                      );
                    },
                    async (after, through) => {
                      const q = query();
                      q.set("after", String(after));
                      q.set("through", String(through));
                      return readRoute(
                        workspaceApi.resultUpdates,
                        {
                          query: {
                            ...Object.fromEntries(q),
                            after: String(after),
                            through: String(through),
                            view: "files",
                          },
                        },
                        source,
                        signal,
                        undefined,
                        mode,
                      );
                    },
                  );
            return result;
          } catch (failure) {
            if (
              !signal.aborted &&
              selectionContext === resultsSelection.current &&
              owner === ownerRef.current &&
              key === resultsContext.current
            ) {
              selectionContext.failed = true;
              selectionContext.retryAppend = append;
              if (
                view !== "files" &&
                (failure as { status?: number }).status === 409
              ) {
                cacheView(cacheKey, undefined, owner);
                setItems([]);
                setNext(null);
              }
            }
            throw failure;
          }
        },
        (result) => {
          if (view !== "files") {
            const saved = cardsPager.current.snapshot();
            if (saved) cacheView(cacheKey, saved, owner);
          }
          selectionContext.failed = false;
          delete selectionContext.retryAppend;
          if (!result) return;
          setItems(result.items);
          setNext(result.next);
          if (selectionContext.notify) setRevision((v) => v + 1);
        },
        manual,
        append ? 1 : 0,
      );
    } finally {
      selectionContext.pending!--;
      if (foreground) selectionContext.foreground!--;
      if (!selectionContext.pending) selectionContext.notify = false;
      if (
        selectionContext === resultsSelection.current &&
        key === resultsContext.current
      )
        setResultsLoading((selectionContext.foreground ?? 0) > 0);
    }
  }
  return { loadResults, error };
}

export function renderResults(
  props: Pick<
    AppModel,
    | "beginReply"
    | "setConversation"
    | "open"
    | "replyToArtifact"
    | "archiveCard"
    | "setLaterCard"
    | "setFiling"
    | "data"
    | "setProfile"
    | "ownerRef"
    | "changed"
    | "setError"
    | "openCard"
    | "resultsError"
    | "items"
    | "loadResults"
    | "resultsLoading"
    | "profile"
    | "view"
    | "projectFilter"
    | "teamSelection"
    | "profileWork"
    | "next"
  >,
) {
  const {
    beginReply,
    setConversation,
    open,
    replyToArtifact,
    archiveCard,
    setLaterCard,
    setFiling,
    data,
    setProfile,
    ownerRef,
    changed,
    setError,
    openCard,
    resultsError,
    items,
    loadResults,
    resultsLoading,
    profile,
    view,
    projectFilter,
    teamSelection,
    profileWork,
    next,
  } = props;
  const replySaved = (message: SavedMessage) =>
    message.agent_id
      ? beginReply({
          agentId: message.agent_id,
          conversationId: message.conversation_id,
          messageId: message.message_id,
          content: message.content,
          ...((message.personal ?? message.role === "user")
            ? { mine: true }
            : {}),
        })
      : setConversation(message.conversation_id, message.message_id);
  // Result cards look and act the same in the feed, projects and Saved.
  const resultCard = (
    item: ResultAction & { team_id?: string | null },
    inSaved = false,
    onUnsave?: () => void,
  ) =>
    item.card ? (
      <ContentCard
        key={item.card.id}
        card={item.card}
        onOpen={() => void open(item)}
        onReply={() => void replyToArtifact(item)}
        onArchive={
          inSaved
            ? undefined
            : () =>
                void archiveCard(
                  item.card.source.artifact_id!,
                  true,
                  item.sourceId,
                )
        }
        onLater={() => setLaterCard(item)}
        onFile={() => setFiling(item)}
        onProfile={
          data.agents.some((a) => a.id === item.card.author.id)
            ? () =>
                setProfile(
                  data.agents.find((a) => a.id === item.card.author.id) || null,
                )
            : undefined
        }
        onSave={async () => {
          if (onUnsave && item.card.saved) return onUnsave();
          const source = item.sourceId ?? executionSourceId(),
            owner = ownerRef.current;
          if (item.cardOwner && item.cardOwner !== owner) return;
          try {
            await callRoute(
              workspaceApi.artifactUpdate,
              {
                params: { id: item.card.source.artifact_id! },
                body: { pinned: !item.card.saved, version: item.card.version },
              },
              source,
            );
            if (source === executionSourceId() && owner === ownerRef.current)
              await changed();
            window.dispatchEvent(new Event("loop-later-change"));
          } catch (error) {
            if (source === executionSourceId() && owner === ownerRef.current)
              setError((error as Error).message);
          }
        }}
      />
    ) : (
      <ArtifactCard
        key={item.id}
        item={item}
        connections={data.connections}
        project={[
          data.teams?.find((t) => t.id === item.team_id)?.name,
          data.folders.find((f) => f.id === item.folder_id)?.name || "Unfiled",
        ]
          .filter(Boolean)
          .join(" · ")}
        onOpen={() => openCard(item)}
        onArtifact={() => void open(item)}
        onReply={() => void replyToArtifact(item)}
        onArchive={inSaved ? undefined : () => void archiveCard(item.id)}
        onLater={() => setLaterCard(item)}
        onProfile={() =>
          setProfile(data.agents.find((a) => a.id === item.agent_id) || null)
        }
        onFile={() => setFiling(item)}
        onPin={async () => {
          // In Saved, unsaving waits for its Undo (see SavedList).
          if (onUnsave && item.pinned) return onUnsave();
          try {
            await callRoute(
              workspaceApi.artifactUpdate,
              {
                params: { id: item.id },
                body: { pinned: !item.pinned, version: item.version },
              },
              executionSourceId(),
            );
            await changed();
            window.dispatchEvent(new Event("loop-later-change"));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    );
  const resultsList = (
    <div className="feed">
      <CollectionReadNotice
        error={resultsError}
        busy={resultsLoading}
        retry={() => void loadResults(false, false, true)}
      />
      {resultsLoading && !items.length ? (
        <div
          className="feed-loading"
          role="status"
          aria-label="Loading activity"
        >
          <span />
          <span />
          <span />
        </div>
      ) : resultsError && !items.length ? null : items.length ? (
        items
          // Typed cards already carry public selection membership. Retained
          // Files rows keep their existing snippet filter.
          .filter((item) => item.card || !parse<any>(item.metadata, {}).snippet)
          .map((item) => resultCard(item))
      ) : (
        <Empty
          title={
            profile
              ? view === "files"
                ? "No files yet."
                : "No results yet."
              : projectFilter || teamSelection.length
                ? "No results in this view yet."
                : "No results yet."
          }
        >
          {profile
            ? profileWork.length
              ? "Your agent’s work is shown above. Open its thread to follow along."
              : "Send a message to this agent to get started."
            : "Finished work from your agents appears here."}
        </Empty>
      )}
      {next && (
        <button
          className="secondary load-more"
          onClick={() => void loadResults(true)}
        >
          Earlier results
        </button>
      )}
    </div>
  );
  return { replySaved, resultCard, resultsList };
}
