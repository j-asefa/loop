import { ConversationId, RunId } from "../shared/contract-ids.js";
import { feedItemOrder } from "../shared/feed-order";
import { doneCardId } from "../shared/done-card-id";
import {
  WORKING_RUN_DISPLAY_STATES,
  PENDING_RUN_DISPLAY_STATES,
  isTerminalRunState,
} from "../shared/run-state";
import { lastVisit, recordVisit } from "./deviceHistory";
import { proseEntry } from "./textEntry";
import { isExecutionRefused } from "./api";
import { operationBlockReason } from "./sourceAvailability";
import {
  doneReadVersion,
  doneThreadReadVersions,
  writeDoneReadState,
  writeDoneUnreadState,
} from "./doneReadState";
import type { CardReadTransport } from "../shared/card-client";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { callRoute, readRoute } from "./api";
import { CollectionReadNotice } from "./CollectionRead";
import { sourceReadQueue } from "./source-read-queue";
import { DoneCardsReader } from "./feed-cards";
import {
  DoneFeedFilters,
  doneAgentKey,
  type DoneReadFilter,
} from "./DoneFeedFilters";
import {
  useDoneThreads,
  OrganizeCards,
  DoneThreadReader,
  type SourcedDoneThread,
  type ThreadSelection,
} from "./DoneThreads";
import { DoneCardMenu, DoneCardPicker } from "./DoneCardMenu";
import {
  useAgentThreadFeed,
  type SourcedAgentThread,
} from "./useAgentThreadFeed";
import { AgentThreadCard, AgentThreadReader } from "./AgentThreadCard";
import {
  useDoneCardGestures,
  type CardDragSession,
} from "./useDoneCardGestures";
import type { CardWindow } from "./card-pager";
import { compareCardOrder, type Card, type CardEntry } from "../shared/cards";
import { CardBody } from "./ContentCard";
import {
  SourceProvider,
  useSourceCapabilities,
  useSourceId,
} from "./SourceContext";
import { ResultIdentity } from "./ResultIdentity";
import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { automationLabel } from "../shared/agent-mail";
import {
  Clock3,
  AlarmClock,
  Archive,
  ArrowDown,
  Bookmark,
  BookmarkCheck,
  ArrowUpRight,
  MoreHorizontal,
  ArrowUp,
  FileText,
  Layers,
  ListChecks,
  FolderInput,
  Container,
  Laptop,
  MessageCircleQuestion,
  MessageSquare,
  Mail,
  ShieldCheck,
  Pause,
  PencilLine,
  Play,
  Share2,
  Square,
  UserRound,
  Users,
  X,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import { ConversationPulls } from "./ConversationPulls";
import { sourceUrl } from "./sourceRouting";
import type {
  EnvironmentAgent,
  EnvironmentConnection,
  AgentSource,
} from "./agentSources";
import { cacheView, cachedView, viewOwner, viewGeneration } from "./viewCache";
import { Avatar, InlineMarkdown, RichText, Sheet } from "./components";
import {
  agentModelName,
  connectionLocation,
  runModelName,
  type ExecutionLocation,
} from "./modelChoices";
import type { Agent } from "../shared/types";
import {
  ActionSheet,
  Chip,
  LaterSheet,
  undoReminder,
  type Action,
} from "./ThreadTools";
import { shareLink } from "./Handoff";
import { threadDraft, sourceDraftId } from "./drafts";
import {
  feedNextAction,
  feedReplyQuote,
  type FeedReplyQuote,
  preview,
  relativeTime,
  runStatus,
  runTiming,
  type FeedNextAction,
} from "./threadView";
import { notify } from "./toast";
import { refreshDonePage, type DoneRefresh } from "./feed-done-refresh";
import { FeedProjectionReader } from "./feed-projection";
import { FeedReadRecovery } from "./feed-read-recovery";
import { listenProjectionFrames } from "./workspace-projections";
import {
  listenWorkspaceChanges,
  workspaceChangeAffects,
} from "./workspace-changes";

import {
  feedCategories,
  type FeedView as FeedFilter,
} from "../shared/feed-categories";

export type FeedItem = RouteResponse<
  typeof workspaceApi.feed
>["items"][number] & {
  card?: Card;
  cardOrder?: CardEntry["order"];
  sourceId?: string;
  executionEnvironment?: string;
};
type Summary = RouteResponse<typeof workspaceApi.feed>["summary"];
const combineSummaries = (summaries: Summary[]) =>
  summaries.reduce(
    (sum, summary) => ({
      needs: sum.needs + summary.needs,
      working: sum.working + summary.working,
      queued: sum.queued + summary.queued,
      replies_unread: (sum.replies_unread || 0) + (summary.replies_unread || 0),
      done_unread: (sum.done_unread || 0) + (summary.done_unread || 0),
      later_due: sum.later_due + summary.later_due,
      scheduled_failed:
        (sum.scheduled_failed || 0) + (summary.scheduled_failed || 0),
      scheduled_pending:
        (sum.scheduled_pending || 0) + (summary.scheduled_pending || 0),
      // Social belongs to the paired app, not each linked workspace.
      social_unread: Math.max(
        sum.social_unread || 0,
        summary.social_unread || 0,
      ),
    }),
    { needs: 0, working: 0, queued: 0, later_due: 0 } as Summary,
  );
type AwayItem = RouteResponse<
  typeof workspaceApi.feedAway
>["completed"][number] & { sourceId?: string };

// A thread can have several Done cards; source and result identity must both
// survive pagination, refreshes and React reconciliation.
const feedItemKey = (item: FeedItem, source = item.sourceId || "") =>
  JSON.stringify([
    source,
    item.conversation_id,
    item.reply_card_key ?? item.done_card_key ?? null,
  ]);

const AWAY_AFTER = 30 * 60_000;

/**
 * A thread in the Feed, shown at the same size as a result card: agent
 * byline, status and project, the thread title and the latest message.
 */
// Run states whose prompt the Feed hides until the agent writes something.

function FeedCard({
  item,
  agent,
  model,
  environment,
  onOpen,
  onReply,
  onRead,
  onReadingChange,
  onQuestion,
  onNext,
  onAgent,
  onMenu,
  onDismiss,
  dismissLabel = "Remove from Done",
  onLater,
  readAsCard,
  sourceCapabilities,
  aggregationId,
  dragSession,
  onAggregate,
  groupCount,
  selected,
  onSelect,
}: {
  sourceCapabilities?: import("../shared/capabilities").Capabilities;
  item: FeedItem;
  agent?: EnvironmentAgent;
  model?: string;
  environment?: { kind: ExecutionLocation | null; label: string } | null;
  onOpen: () => void;
  onReply: () => void;
  onRead?: () => void;
  onReadingChange?: (open: boolean) => void;
  onQuestion?: () => void;
  /** Open exactly where the next action is. */
  onNext: (action: FeedNextAction) => void;
  onAgent?: () => void;
  onMenu: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  onLater: () => void;
  readAsCard: boolean;
  aggregationId?: string;
  dragSession: RefObject<CardDragSession | null>;
  onAggregate: (source: string, target: string) => void;
  groupCount?: number;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const scopedSource = useSourceId();
  const inheritedCapabilities = useSourceCapabilities();
  const capabilities = sourceCapabilities || inheritedCapabilities;
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [readError, setReadError] = useState("");
  const swipe = useDoneCardGestures({
    id: aggregationId,
    session: dragSession,
    onMenu,
    onAggregate,
    onDismiss,
  });
  const taskStatus = runStatus(item.run?.state, item.pending_approvals);
  const status = item.reply ? { label: "Reply", tone: "done" } : taskStatus;
  const draft = threadDraft(
    sourceDraftId(item.conversation_id, item.sourceId ?? scopedSource),
  ).text;
  const next = feedNextAction(item.next_action, draft);
  const detail =
    item.reply && item.run
      ? `Task: ${taskStatus.label}`
      : status.tone === "working" && item.run
        ? runTiming(item.run)
        : status.tone === "queued" && item.run
          ? `${item.run.queue_position ? `#${item.run.queue_position} in queue · ` : ""}${runTiming(item.run)}`
          : status.tone === "failed" && item.run?.error
            ? item.run.error
            : "";
  const name = item.agent_name || agent?.name;
  const awaitingUpdate =
    item.run &&
    WORKING_RUN_DISPLAY_STATES.includes(item.run.state) &&
    item.last_message?.role !== "assistant";
  const messageId = item.last_message?.id;
  useEffect(() => {
    if (
      !reading ||
      !messageId ||
      item.card ||
      item.live_preview ||
      awaitingUpdate
    )
      return;
    const controller = new AbortController();
    setReadError("");
    void callRoute(
      workspaceApi.messageDetail,
      { params: { id: messageId } },
      item.sourceId ?? scopedSource,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setMessage(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setReadError(
            "Couldn’t load the full message. Open the conversation to read it.",
          );
      });
    return () => controller.abort();
  }, [
    reading,
    item.card,
    messageId,
    item.sourceId,
    scopedSource,
    !!item.live_preview,
    !!awaitingUpdate,
  ]);
  const content =
    item.live_preview ||
    (awaitingUpdate
      ? ""
      : message?.id === messageId
        ? (message?.content ?? "")
        : (item.last_message?.content ?? item.last_message?.preview ?? ""));
  const openReading = () => {
    if (onSelect) {
      onSelect();
      return;
    }
    if (readAsCard) onReadingChange?.(true);
    onRead?.();
    if (readAsCard) setReading(true);
    else onOpen();
  };
  const closeReading = () => {
    setReading(false);
    onReadingChange?.(false);
  };
  const leaveReading = (action: () => void) => {
    closeReading();
    action();
  };
  return (
    <li
      className={
        "card-swipe feed-item-wrap" +
        (swipe.armed ? " armed-" + swipe.armed : "") +
        (swipe.offset ? " swiping" : "")
      }
    >
      {onDismiss && (
        <span className="swipe-under right" aria-hidden="true">
          <Archive size={20} /> {dismissLabel}
        </span>
      )}
      <article
        className={
          "feed-card feed-item-card" +
          (aggregationId ? " done-card-interactive" : "") +
          (selected ? " card-selected" : "") +
          (swipe.lifted || swipe.dragging ? " card-dragging" : "")
        }
        style={
          swipe.offset
            ? { transform: `translateX(${swipe.offset}px)` }
            : undefined
        }
        {...swipe.handlers}
      >
        <div className="card-byline">
          {onSelect && (
            <input
              type="checkbox"
              aria-label={`Select ${item.title}`}
              checked={!!selected}
              onChange={onSelect}
            />
          )}
          <button className="identity" disabled={!onAgent} onClick={onAgent}>
            <span className="feed-avatar">
              <Avatar name={name || "Loop"} />
            </span>
            <span>
              <strong>{name ? "@" + name : "Your workspace"}</strong>
              <span className="subline">
                {model && <span className="card-model">{model}</span>}
                {environment && (
                  <span
                    className={
                      "card-environment" +
                      (environment.kind
                        ? ` agent-environment ${environment.kind}`
                        : "")
                    }
                  >
                    {environment.kind === "laptop" ? (
                      <Laptop size={12} aria-hidden="true" />
                    ) : environment.kind === "docker" ? (
                      <Container size={12} aria-hidden="true" />
                    ) : null}
                    {environment.label}
                  </span>
                )}
                <time dateTime={new Date(item.last_activity_at).toISOString()}>
                  {relativeTime(item.last_activity_at)}
                </time>
              </span>
            </span>
          </button>
          <button
            className="icon-button"
            aria-label="Thread actions"
            onClick={onMenu}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
        <div
          className="card-content feed-row"
          role="button"
          tabIndex={0}
          aria-label={`${item.title}${status.label ? `, ${status.label}` : ""}`}
          aria-pressed={onSelect ? !!selected : undefined}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("a,button,summary,input"))
              openReading();
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (["Enter", " "].includes(e.key)) {
              e.preventDefault();
              openReading();
            }
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              onMenu();
            }
          }}
        >
          <span className="eyebrow feed-eyebrow">
            {groupCount ? (
              <>
                <Layers size={14} /> Thread · {groupCount} cards
                {item.read_at === null && <Chip tone="working">Unread</Chip>}
              </>
            ) : item.reply ? (
              <>
                Reply
                {item.reply.read_at === null && (
                  <Chip tone="working">Unread</Chip>
                )}
              </>
            ) : status.label && status.tone !== "done" ? (
              <Chip tone={status.tone}>{status.label}</Chip>
            ) : item.read_at === null ? (
              <>
                Thread<Chip tone="working">Unread</Chip>
              </>
            ) : (
              "Thread"
            )}
            <span className="card-project">
              {" "}
              · {item.project_name || "Unfiled"}
            </span>
          </span>
          <h2>
            <InlineMarkdown content={item.title} />
          </h2>
          {detail && <p className="field-hint feed-detail">{detail}</p>}
          {item.live_preview ? (
            <div className="preview live-preview">
              <RichText content={item.live_preview} compact />
            </div>
          ) : item.run &&
            WORKING_RUN_DISPLAY_STATES.includes(item.run.state) &&
            item.last_message?.role !== "assistant" ? (
            // The server hides the prompt while its run works; say whether
            // the agent has written anything yet, and who started the work.
            <p className="field-hint feed-detail feed-awaiting-update">
              {item.run.automation
                ? automationLabel(
                    item.run.automation,
                    item.run.automation_from,
                  ) + " · "
                : ""}
              {status.tone === "working"
                ? "Waiting for agent update…"
                : "No agent update yet."}
            </p>
          ) : (
            !!(
              item.last_message?.content ?? item.last_message?.preview
            )?.trim() && (
              <div className="preview">
                {item.last_message!.role === "user" && (
                  <span className="feed-you">
                    {automationLabel(
                      item.last_message!.automation,
                      item.last_message!.automation_from,
                    )}
                  </span>
                )}
                {item.card ? (
                  <SourceProvider
                    sourceId={item.sourceId ?? scopedSource}
                    capabilities={capabilities}
                  >
                    <CardBody card={item.card} compact />
                  </SourceProvider>
                ) : (
                  <RichText
                    content={
                      item.last_message!.content ?? item.last_message!.preview
                    }
                    compact
                  />
                )}
              </div>
            )
          )}
          {!!(item.last_message || item.run) && !onSelect && (
            <button className="text-button preview-open" onClick={openReading}>
              {readAsCard
                ? item.reply
                  ? "Read reply"
                  : "Read update"
                : "Open thread"}{" "}
              <ArrowUpRight size={14} />
            </button>
          )}
          {draft && (
            <p className="feed-draft">
              <em className="draft-label">Draft:</em> {preview(draft, 120)}
            </p>
          )}
        </div>
        <div className="card-actions">
          {onSelect ? (
            <button onClick={onSelect}>
              {selected ? "Deselect card" : "Select card"}
            </button>
          ) : (
            <>
              {next && (
                <button
                  className="next-action"
                  data-kind={next.kind}
                  onClick={() =>
                    next.kind === "result" && readAsCard
                      ? openReading()
                      : onNext(next)
                  }
                >
                  {nextIcon[next.kind]}
                  {next.label}
                </button>
              )}
              {next?.kind !== "draft" && (
                <button onClick={onReply}>
                  <MessageSquare size={16} />
                  {groupCount ? "Reply to latest" : "Reply"}
                </button>
              )}
              {!groupCount && (
                <button onClick={onLater}>
                  <AlarmClock size={16} />
                  Remind me
                </button>
              )}
            </>
          )}
        </div>
      </article>
      {swipe.lifted &&
        createPortal(
          <div className="card-drag-hint" role="status">
            {swipe.dragging
              ? "Drop onto another Done card to combine"
              : "Release for options · Drag onto another card to combine"}
          </div>,
          document.body,
        )}
      {/* Keep sheet gestures outside the feed card's swipe-to-dismiss region. */}
      {reading &&
        createPortal(
          <SourceProvider
            sourceId={item.sourceId ?? scopedSource}
            capabilities={capabilities}
          >
            <Sheet
              wide
              swipeToClose
              className="result-sheet feed-reading-sheet"
              title={item.title}
              onClose={closeReading}
              heading={
                <div className="result-header">
                  <ResultIdentity
                    name={name || undefined}
                    model={model}
                    createdAt={
                      item.last_message?.created_at ?? item.last_activity_at
                    }
                    onProfile={
                      onAgent ? () => leaveReading(onAgent) : undefined
                    }
                  />
                  <button
                    className="icon-button"
                    aria-label="Thread actions"
                    onClick={onMenu}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                </div>
              }
            >
              <div className="result-content">
                {!item.reply && (
                  <h3 className="result-title">
                    <InlineMarkdown content={item.title} />
                  </h3>
                )}
                {item.reply && (
                  <section
                    className="reply-question"
                    aria-label="Your original message"
                  >
                    <div className="reply-question-header">
                      <span>
                        <MessageSquare size={15} aria-hidden="true" /> Replying
                        to you
                      </span>
                      {onQuestion && (
                        <button
                          className="text-button"
                          onClick={() => leaveReading(onQuestion)}
                        >
                          View message{" "}
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <blockquote>
                      <RichText content={item.reply.content} />
                    </blockquote>
                  </section>
                )}
                {item.reply && (
                  <h3 className="reply-answer-label">
                    {name
                      ? `Reply from @${name.replace(/^@/, "")}`
                      : "Agent reply"}
                  </h3>
                )}
                {status.tone !== "done" && (
                  <p className="field-hint">
                    {status.label}
                    {detail ? ` · ${detail}` : ""}
                  </p>
                )}
                <div className="artifact-body">
                  {content ? (
                    item.card ? (
                      <CardBody card={item.card} />
                    ) : (
                      <RichText content={content} />
                    )
                  ) : (
                    <p className="field-hint">
                      {status.tone === "working"
                        ? "Waiting for agent update…"
                        : "No agent update yet."}
                    </p>
                  )}
                </div>
                {readError && (
                  <p className="error" role="alert">
                    {readError}{" "}
                    <button
                      className="text-button"
                      onClick={() => leaveReading(onOpen)}
                    >
                      Open conversation
                    </button>
                  </p>
                )}
                {item.live_preview && item.live_preview.length >= 4000 && (
                  <button
                    className="text-button"
                    onClick={() => leaveReading(onOpen)}
                  >
                    Continue reading in conversation <ArrowUpRight size={14} />
                  </button>
                )}
                <ConversationPulls conversationId={item.conversation_id} />
                {draft && (
                  <section aria-label="Draft message">
                    <p className="draft-label">Draft:</p>
                    <RichText content={draft} />
                  </section>
                )}
              </div>
              <div className="result-edit-actions">
                <button
                  className="primary"
                  onClick={() => leaveReading(onReply)}
                >
                  {draft ? (
                    <PencilLine size={18} />
                  ) : (
                    <MessageSquare size={18} />
                  )}
                  {draft ? "Continue draft" : "Reply"}
                </button>
              </div>
            </Sheet>
          </SourceProvider>,
          document.body,
        )}
    </li>
  );
}

const nextIcon = {
  approve: <ShieldCheck size={16} />,
  answer: <MessageCircleQuestion size={16} />,
  result: <FileText size={16} />,
  draft: <PencilLine size={16} />,
};

function AwaySummary({
  onFilter,
  onNeeds,
  onOpen,
  sources,
}: {
  onFilter: (filter: FeedFilter) => void;
  onNeeds: () => void;
  onOpen: (conversation: string, sourceId: string) => void;
  sources: AgentSource[];
}) {
  const [away, setAway] = useState<{
    completed: AwayItem[];
    needs: AwayItem[];
    failed: AwayItem[];
  } | null>(null);
  const owner = viewOwner();
  const generation = viewGeneration();
  const previousVisit = useRef<{
    owner: string | undefined;
    at: number;
  } | null>(null);
  const sourceKey = sources.map((source) => source.id).join(",");
  useEffect(() => {
    let active = true;
    const current = () => active && generation === viewGeneration();
    if (previousVisit.current === null || previousVisit.current.owner !== owner)
      previousVisit.current = { owner, at: lastVisit(owner) };
    const since = previousVisit.current.at;
    const record = () => {
      if (current()) recordVisit(owner, Date.now());
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") record();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", record);
    if (since && Date.now() - since > AWAY_AFTER)
      void Promise.allSettled(
        sources.map(async (source) => ({
          source,
          result: await callRoute(
            workspaceApi.feedAway,
            { query: { since: String(since) } },
            source.id,
          ),
        })),
      ).then((settled) => {
        if (!current()) return;
        const loaded = settled.flatMap((entry) =>
          entry.status === "fulfilled" ? [entry.value] : [],
        );
        const result = {
          completed: loaded.flatMap(({ source, result }) =>
            result.completed.map((item) => ({ ...item, sourceId: source.id })),
          ),
          needs: loaded.flatMap(({ source, result }) =>
            result.needs.map((item) => ({ ...item, sourceId: source.id })),
          ),
          failed: loaded.flatMap(({ source, result }) =>
            result.failed.map((item) => ({ ...item, sourceId: source.id })),
          ),
        };
        if (
          result.completed.length ||
          result.needs.length ||
          result.failed.length
        )
          setAway(result);
      });
    record();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", record);
    };
  }, [sourceKey, owner, generation]);
  if (!away) return null;
  const parts = [
    away.completed.length && `${away.completed.length} finished`,
    away.needs.length && `${away.needs.length} need you`,
    away.failed.length && `${away.failed.length} failed`,
  ].filter(Boolean);
  const threads = [
    ...new Set(
      [...away.needs, ...away.failed, ...away.completed].map(
        (item) => `${item.sourceId || "laptop"}:${item.conversation_id}`,
      ),
    ),
  ];
  const attention = away.needs.length + away.failed.length > 0;
  const single =
    threads.length === 1
      ? [...away.needs, ...away.failed, ...away.completed][0]
      : undefined;
  const show = () => {
    setAway(null);
    if (single) {
      onOpen(single.conversation_id, single.sourceId || "");
      return;
    }
    if (attention) onNeeds();
    else onFilter("done");
    requestAnimationFrame(() =>
      document
        .querySelector(attention ? ".needs-stack" : ".feed-tabs")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  return (
    <section className="away-card" aria-label="While you were away">
      <div className="away-head">
        <button type="button" className="away-toggle" onClick={show}>
          <Clock3 size={18} aria-hidden="true" />
          <strong>While you were away</strong>
          <span>{parts.join(" · ")}</span>
          <span className="away-link">
            {single
              ? `Open “${
                  single.title.length > 40
                    ? single.title.slice(0, 39).trimEnd() + "…"
                    : single.title
                }”`
              : attention
                ? "Review what needs you"
                : "Show what finished"}
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss summary"
          onClick={() => setAway(null)}
        >
          <X size={18} />
        </button>
      </div>
    </section>
  );
}

/** One queued message, independent of the thread's current run. */
export type QueuedMessage = {
  id: string;
  input: string;
  agentId?: string | null;
  sourceId?: string;
};

export function EditQueued({
  message,
  onClose,
  onSaved,
}: {
  message: QueuedMessage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const scopedSource = useSourceId();
  const [text, setText] = useState(message.input);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Edit queued message" onClose={onClose}>
      <p className="field-hint">
        You can change a message until the agent starts it.
      </p>
      <textarea
        {...proseEntry}
        aria-label="Queued message"
        value={text}
        rows={6}
        onChange={(e) => setText(e.target.value)}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await callRoute(
              workspaceApi.runUpdate,
              {
                params: { id: RunId.parse(message.id) },
                body: { input: text },
              },
              message.sourceId ?? scopedSource,
            );
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save
      </button>
    </Sheet>
  );
}

function MoveQueued({
  message,
  agents,
  onClose,
  onMoved,
}: {
  message: QueuedMessage;
  agents: Agent[];
  onClose: () => void;
  onMoved: (conversation?: string) => void;
}) {
  const scopedSource = useSourceId();
  const choices = agents.filter(
    (a) =>
      a.connection_id &&
      !a.retired_at &&
      a.id !== message.agentId &&
      ((a as EnvironmentAgent).sourceId || "") ===
        (message.sourceId ?? scopedSource),
  );
  const [agentId, setAgentId] = useState(choices[0]?.id || "");
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  return (
    <Sheet title="Move to another agent" onClose={onClose}>
      <p className="field-hint">
        Cancels the queued task here and sends the same message to a new
        conversation with the agent you choose.
      </p>
      <label>
        Agent
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={!agentId}
        onClick={async () => {
          setError("");
          try {
            const result = await callRoute(
              workspaceApi.runMove,
              {
                params: { id: RunId.parse(message.id) },
                body: { agentId, idempotencyKey: key.current },
              },
              message.sourceId ?? scopedSource,
            );
            onMoved(result.conversation_id ?? undefined);
            onClose();
          } catch (e) {
            if (isExecutionRefused(e)) key.current = crypto.randomUUID();
            setError((e as Error).message);
          }
        }}
      >
        Move task
      </button>
    </Sheet>
  );
}

// Every card that waits on you, whichever component renders it.
const NEEDS_CARDS =
  ".approval-card, .native-decision, .scheduled-message, .feed-item-wrap";

/**
 * What needs you, above the Feed filters. One card shows with the rest
 * stacked behind it, so acting on it brings up the next; "Show all" lists
 * every card. The cards come from separate components that load their own
 * requests, so the stack counts what they render.
 */
function NeedsStack({
  open,
  onOpen,
  children,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const cards = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    const root = cards.current!;
    const mark = () => {
      const found = [...root.querySelectorAll(NEEDS_CARDS)];
      found.forEach((card, i) =>
        card.toggleAttribute("data-stack-rest", i > 0),
      );
      setCount(found.length);
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (count < 2 && open) onOpen(false);
  }, [count, open]);
  const stacked = count > 1 && !open;
  return (
    <section
      className={"needs-stack" + (stacked ? " stacked" : "")}
      aria-label="Needs you"
      hidden={!count && !open}
    >
      <div className="needs-heading">
        <span aria-hidden="true" />
        <h2>Needs you</h2>
        <span className="needs-count">{count}</span>
      </div>
      {open && count > 1 && (
        <div className="needs-stack-bar">
          <strong>{count} need you</strong>
          <button
            type="button"
            className="text-button"
            onClick={() => onOpen(false)}
          >
            Collapse <ChevronUp size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="needs-stack-cards" ref={cards}>
        {children}
      </div>
      {stacked && (
        <div className="needs-stack-bar">
          <span>
            {count - 1} more {count === 2 ? "needs" : "need"} you
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => onOpen(true)}
          >
            Show all <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

export function Feed({
  filter,
  onFilter,
  project,
  teams,
  revision,
  agents,
  onOpen,
  onAgent,
  onChanged,
  header,
  needsSlot,
  emptyAction,
  hideFilters = false,
  connections,
  onReply,
  agent: scopedAgent,
  onScheduled,
  onShowReminder,
  onAsk,
  sources,
  sourcesLoading = false,
}: {
  filter: FeedFilter;
  onFilter: (filter: FeedFilter) => void;
  project?: string;
  teams?: string;
  revision: number;
  agents: EnvironmentAgent[];
  onOpen: (conversation: string, message?: string, sourceId?: string) => void;
  onAgent: (agent: Agent) => void;
  onChanged: () => void;
  header?: ReactNode;
  /** Approval, decision and unsent-message cards for the Needs you stack. */
  needsSlot?: ReactNode;
  emptyAction?: ReactNode;
  hideFilters?: boolean;
  connections?: EnvironmentConnection[];
  /** A Done card passes the result it shows, to quote in the reply. */
  onReply?: (
    conversation: string,
    sourceId?: string,
    quote?: FeedReplyQuote,
  ) => void;
  agent?: string;
  /** Open Later → Scheduled. */
  onScheduled?: () => void;
  /** Open Later → Reminders at one reminder. */
  onShowReminder?: (id: string) => void;
  /** Start a new message with this text (a news card's "Ask an agent"). */
  onAsk?: (text: string) => void;
  /** Present only for the combined top-level Feed. */
  sources?: AgentSource[];
  /** Initial discovery has not established the combined Feed's destinations. */
  sourcesLoading?: boolean;
}) {
  const scopedSource = useSourceId();
  const scopedCapabilities = useSourceCapabilities();
  // Browsable histories retain loaded pages while new activity arrives.
  const retainHistory = ["done", "replies", "threads"].includes(filter);
  type Shown = {
    items: FeedItem[];
    next: string | null;
    summary: Summary;
    sourceSummaries?: Record<string, Summary>;
  };
  const generation = viewGeneration();
  const selectionScope = JSON.stringify([
    generation,
    scopedSource,
    project,
    teams,
    scopedAgent,
  ]);
  const [doneSelection, setDoneSelection] = useState({
    scope: selectionScope,
    read: "all" as DoneReadFilter,
    agent: "",
  });
  const selection =
    doneSelection.scope === selectionScope
      ? doneSelection
      : { scope: selectionScope, read: "all" as const, agent: "" };
  const clearDoneFilters = () =>
    setDoneSelection({
      scope: selectionScope,
      read: "all",
      agent: "",
    });
  const combined = !!sources && !project && !teams && !scopedAgent;
  const allSources: AgentSource[] = combined
    ? sources
    : [{ id: scopedSource, name: "", capabilities: scopedCapabilities }];
  const needsSourceKey = JSON.stringify(
    allSources.map((source) => source.id).sort(),
  );
  const doneAgents = agents.filter(
    (item) =>
      allSources.some(
        (source) => source.id === (item.sourceId ?? scopedSource),
      ) &&
      (!scopedAgent || item.id === scopedAgent),
  );
  const selectedAgent = doneAgents.find(
    (item) => doneAgentKey(item, scopedSource) === selection.agent,
  );
  const doneAgent = filter === "done" ? selectedAgent : undefined;
  const agent = doneAgent?.id ?? scopedAgent;
  const doneRead = filter === "done" ? selection.read : "all";
  const doneFiltered = filter === "done" && (doneRead !== "all" || !!doneAgent);
  const readRecovery = useRef(
    new FeedReadRecovery<RouteResponse<typeof workspaceApi.feed>>(),
  );
  const recoverSource = useRef<(source: string) => void>(() => {});
  const readSnapshot = (
    source: string,
    query: NonNullable<RouteInput<typeof workspaceApi.feed>["query"]>,
    purpose = "",
    manual = false,
  ) => {
    const { known: _known, ...page } = query;
    const context = activeView.current;
    return readRecovery.current.read(
      source,
      purpose + JSON.stringify(page),
      (signal, onRetry) =>
        readRoute(
          workspaceApi.feed,
          { query },
          source,
          signal,
          onRetry,
          manual ? "manual" : "automatic",
        ),
      () => {
        if (generation === viewGeneration() && context === activeView.current)
          recoverSource.current(source);
      },
    );
  };
  const projectionPages = useRef(new FeedProjectionReader<FeedItem, Shown>());
  const readProjectionPage = (
    source: string,
    query: NonNullable<RouteInput<typeof workspaceApi.feed>["query"]>,
    manual = false,
  ) => {
    const read = (known?: string) =>
      readSnapshot(source, { ...query, known }, "", manual);
    return projectionPages.current.read(source, JSON.stringify(query), read);
  };
  const activeSources: AgentSource[] = doneAgent
    ? allSources.filter(
        (source) => source.id === (doneAgent.sourceId ?? scopedSource),
      )
    : allSources;
  const sourceKey = JSON.stringify(
    activeSources.map((source) => source.id).sort(),
  );
  const shownKey = () =>
    "feed:" +
    JSON.stringify([filter, project, agent, teams, sourceKey, doneRead]);
  // Discovery can add sources after the first cards arrive. Retain those
  // sources' pages only within the same owner and selection.
  const pagesKey = () =>
    JSON.stringify([viewOwner(), filter, project, agent, teams, doneRead]);
  const activeView = useRef<string | null>(null);
  activeView.current = JSON.stringify([viewOwner(), shownKey()]);
  const shown = cachedView<Shown>(shownKey());
  // Recorded locations, keyed by source and connection id: ids from
  // different sources can collide.
  const environments = useMemo(
    () =>
      new Map(
        (connections || []).map((connection) => [
          `${connection.sourceId || ""}:${connection.id}`,
          connectionLocation(connection, connection.executionEnvironment),
        ]),
      ),
    [connections],
  );
  // Each source records the execution location on its connection.
  const cardEnvironment = (
    source: string,
    connectionId: string | null,
    label: string | undefined,
  ) => {
    const recorded = environments.get(`${source}:${connectionId}`);
    const kind: ExecutionLocation | null = recorded?.kind ?? null;
    const text = kind && !source ? recorded?.label : label || null;
    return text ? { kind, label: text } : null;
  };
  const [items, setItems] = useState<FeedItem[]>(shown?.items || []);
  const itemsSelection = useRef(shownKey());
  const sourcePages = useRef<{
    key: string;
    pages: Map<string, Shown>;
    failures: Set<string>;
  }>({
    key: "",
    pages: new Map(),
    failures: new Set(),
  });
  // Render and the selection effect must retain the same pages so discovery
  // cannot unmount existing cards before the effect adopts its new view key.
  const retainedItems = () =>
    sourcePages.current.key === pagesKey()
      ? activeSources.flatMap((source) =>
          (sourcePages.current.pages.get(source.id)?.items || []).map(
            (item) => ({
              ...item,
              sourceId: source.id,
              executionEnvironment: source.id ? source.name : undefined,
            }),
          ),
        )
      : [];
  const [next, setNext] = useState<string | null>(shown?.next || null);
  const [loadedKey, setLoadedKey] = useState<string | null>(
    shown ? shownKey() : null,
  );
  const markLoaded = (key: string) => setLoadedKey(key);
  // Derive this during render so discovery cannot briefly show an empty feed
  // before the effect starts reading newly discovered sources.
  const loading = loadedKey !== shownKey() && !shown;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<FeedItem | null>(null);
  const dragSession = useRef<CardDragSession | null>(null);
  const grouping = useDoneThreads(
    activeSources.map((source) => source.id),
    filter === "done" || filter === "threads",
    {
      project: project || undefined,
      agent: agent || undefined,
      teams: teams || undefined,
    },
  );
  const mailThreads = useAgentThreadFeed(
    activeSources.map((source) => source.id),
    (filter === "done" && doneRead === "all") || filter === "threads",
    {
      view: filter === "done" ? "done" : "threads",
      project: project || undefined,
      agent: agent || undefined,
      teams: teams || undefined,
    },
  );
  const [readingMail, setReadingMail] = useState<
    (SourcedAgentThread & { generation: number }) | null
  >(null);
  const [menuThread, setMenuThread] = useState<SourcedDoneThread | null>(null);
  const [readingThread, setReadingThread] = useState<
    (SourcedDoneThread & { generation: number }) | null
  >(null);
  const [aggregate, setAggregate] = useState<ThreadSelection | null>(null);
  const [combineFrom, setCombineFrom] = useState<string | null>(null);
  const [selectedCards, setSelectedCards] = useState<string[] | null>(null);
  const [bulkReadBusy, setBulkReadBusy] = useState(false);
  const [readingCard, setReadingCard] = useState<{
    item: FeedItem;
    view: string;
  } | null>(null);
  const aggregatable = (item: FeedItem) =>
    filter === "done" &&
    grouping.supported.includes(item.sourceId ?? scopedSource) &&
    !!item.done_card_key &&
    item.last_message?.role === "assistant";
  const doneId = (item: FeedItem) =>
    item.card?.id ?? doneCardId(item.done_card_key!);
  type VisibleCard = {
    item: FeedItem;
    thread?: SourcedDoneThread;
    key: string;
  };
  // Reading marks a result read immediately. Keep its mounted reader until it
  // closes even after the server removes that card from the Unread selection.
  const heldCard =
    readingCard?.view === shownKey() ? readingCard.item : undefined;
  const shownItems =
    itemsSelection.current === shownKey()
      ? items
      : (shown?.items ?? retainedItems());
  const readerItems =
    heldCard &&
    !shownItems.some((item) => feedItemKey(item) === feedItemKey(heldCard))
      ? [...shownItems, heldCard]
      : shownItems;
  const visibleCards: VisibleCard[] = readerItems.flatMap((item) => {
    const source = item.sourceId ?? scopedSource;
    const thread =
      filter === "done"
        ? grouping.threads.find(
            (thread) =>
              thread.source === source && thread.cardIds.includes(doneId(item)),
          )
        : undefined;
    const matchesRead =
      doneRead === "all" ||
      (doneRead === "unread"
        ? item.read_at === null
        : typeof item.read_at === "number") ||
      (heldCard && feedItemKey(item) === feedItemKey(heldCard));
    return thread || !matchesRead
      ? []
      : [{ item, key: feedItemKey(item, source) }];
  });
  if (filter === "threads" || filter === "done") {
    // Card threads have their own identity and preview. They remain visible even
    // when members are dismissed, have newer work or are beyond the loaded page.
    for (const thread of grouping.threads) {
      if (!thread.preview) continue;
      if (
        doneRead !== "all" &&
        (thread.unread === undefined ||
          (doneRead === "unread" ? thread.unread === 0 : thread.unread > 0))
      )
        continue;
      const card = thread.preview;
      visibleCards.push({
        thread,
        key: JSON.stringify([thread.source, "thread", thread.id]),
        item: {
          ...card.display,
          done_card_key: card.display.done_card_key ?? undefined,
          // The thread is unread while any member is; its preview alone is not.
          read_at: thread.unread ? null : undefined,
          sourceId: thread.source,
          pending_approvals: 0,
          position_message_id: null,
          card,
        },
      });
    }
    visibleCards.sort(
      (a, b) => feedItemOrder(a.item, b.item) || a.key.localeCompare(b.key),
    );
  }
  const feedRows: (
    | { kind: "card"; card: VisibleCard; key: string; time: number }
    | { kind: "mail"; thread: SourcedAgentThread; key: string; time: number }
  )[] = [
    ...visibleCards.map((row) => ({
      kind: "card" as const,
      card: row,
      key: row.key,
      time: row.item.last_activity_at,
    })),
    ...mailThreads.items.map((thread) => ({
      kind: "mail" as const,
      thread,
      key: JSON.stringify([thread.source, "mail", thread.id]),
      time: thread.updated_at,
    })),
  ];
  if (mailThreads.items.length)
    feedRows.sort(
      (a, b) =>
        b.time - a.time ||
        (a.kind === "card" && b.kind === "card"
          ? feedItemOrder(a.card.item, b.card.item)
          : a.key.localeCompare(b.key)),
    );
  const selectionFor = (rows: VisibleCard[]): ThreadSelection | null => {
    if (!rows.length) return null;
    const source = rows[0].item.sourceId ?? scopedSource;
    if (rows.some((row) => (row.item.sourceId ?? scopedSource) !== source)) {
      setError("Choose cards from the same workspace to make a thread.");
      return null;
    }
    const latest = [...rows].sort(
      (a, b) => b.item.last_activity_at - a.item.last_activity_at,
    )[0];
    return {
      source,
      cardIds: [
        ...new Set(
          rows.flatMap((row) => row.thread?.cardIds ?? [doneId(row.item)]),
        ),
      ],
      title: latest.thread?.title ?? latest.item.title,
      previews: rows.map((row) => ({
        title: row.thread?.title ?? row.item.title,
        author: row.item.agent_name ?? undefined,
      })),
    };
  };
  const combineCards = (source: string, target: string) => {
    const from = visibleCards.find((row) => row.key === source),
      to = visibleCards.find((row) => row.key === target);
    if (
      !from ||
      !to ||
      from === to ||
      !aggregatable(from.item) ||
      !aggregatable(to.item)
    )
      return;
    const selection = selectionFor([from, to]);
    if (selection) {
      setCombineFrom(null);
      setAggregate({ ...selection, target: to.thread?.id });
    }
  };
  const toggleSelection = (key: string) =>
    setSelectedCards((previous) =>
      previous?.includes(key)
        ? previous.filter((id) => id !== key)
        : [...(previous ?? []), key],
    );
  const organizeSelection = (keys: string[]) => {
    const selection = selectionFor(
      visibleCards.filter((row) => keys.includes(row.key)),
    );
    if (selection) setAggregate(selection);
  };
  const ungroup = async (thread: SourcedDoneThread) => {
    try {
      await callRoute(
        workspaceApi.doneThreadRemove,
        { params: { id: thread.id } },
        thread.source,
      );
      if (generation !== viewGeneration()) return;
      grouping.refresh();
      notify({ text: "Cards ungrouped." });
    } catch (error) {
      if (generation === viewGeneration()) setError((error as Error).message);
    }
  };
  useEffect(() => {
    setMenu(null);
    setMenuThread(null);
    setReadingThread(null);
    setReadingMail(null);
    setReadingCard(null);
    setAggregate(null);
    setCombineFrom(null);
    setSelectedCards(null);
  }, [filter, project, agent, teams, sourceKey, doneRead, generation]);
  const [later, setLater] = useState<FeedItem | null>(null);
  // Finished cards have their own message; work in progress keeps thread reminders.
  const reminderMessage =
    later &&
    (later.done_card_key ||
      later.reply_card_key ||
      !later.run ||
      later.run.state === "completed")
      ? later.last_message
      : null;
  const [editing, setEditing] = useState<QueuedMessage | null>(null);
  const [moving, setMoving] = useState<QueuedMessage | null>(null);
  // Threads waiting on you, whichever filter is shown, for the stack above
  // the filters.
  const needsKey = () =>
    "feed-needs:" +
    JSON.stringify([project, scopedAgent, teams, needsSourceKey]);
  // Tab badges and scheduled failures share Needs you's scope, independently
  // of the selected Done agent, read state and paginated result windows.
  const summaryKey = "feed-summary:" + JSON.stringify([generation, needsKey()]);
  const [operational, setOperational] = useState(() => ({
    key: summaryKey,
    sources: cachedView<Record<string, Summary>>(summaryKey) ?? {},
  }));
  const summaries =
    operational.key === summaryKey
      ? operational.sources
      : (cachedView<Record<string, Summary>>(summaryKey) ?? {});
  const summary = combineSummaries(
    allSources.flatMap((source) =>
      summaries[source.id] ? [summaries[source.id]] : [],
    ),
  );
  const [needs, setNeeds] = useState<FeedItem[]>(
    () => cachedView<FeedItem[]>(needsKey()) || [],
  );
  const [needsOpen, setNeedsOpen] = useState(false);
  const needsRequest = useRef(0);
  const needsSourceRequests = useRef(new Map<string, number>());
  const needsReads = useRef<
    | {
        key: string;
        enqueue: (sources: string[], manual: boolean) => boolean;
        settled: Promise<unknown>;
      }
    | undefined
  >(undefined);
  const request = useRef(0);
  const query = (
    before?: string,
    which: FeedFilter | "needs" = filter,
  ): NonNullable<RouteInput<typeof workspaceApi.feed>["query"]> => {
    const selectedAgent = which === "needs" ? scopedAgent : agent;
    return {
      filter: which === "threads" ? "all" : which,
      ...(project ? { folder: project } : {}),
      ...(selectedAgent ? { agent: selectedAgent } : {}),
      ...(teams ? { teams } : {}),
      ...(before ? { before } : {}),
    };
  };
  const inFlight = useRef(false);
  const refreshReadingSources = useRef<
    ((sources: string[]) => void) | undefined
  >(undefined);
  const deferredUnsaves = useRef(new Map<string, object>());
  const savedKey = (source: string, message: string) =>
    JSON.stringify([viewOwner(), source, message]);
  const pendingUnsaves = (rows: FeedItem[], source = scopedSource) => {
    if (!deferredUnsaves.current.size) return rows;
    return rows.map((item) => {
      const message = item.last_message;
      if (
        !message ||
        !deferredUnsaves.current.has(
          savedKey(item.sourceId ?? source, message.id),
        )
      )
        return item;
      const last_message = { ...message, saved: false };
      return {
        ...item,
        last_message,
        ...(item.card?.type === "done"
          ? {
              card: {
                ...item.card,
                saved: false,
                display: {
                  ...item.card.display,
                  last_message: item.card.display.last_message
                    ? { ...item.card.display.last_message, saved: false }
                    : null,
                },
              },
            }
          : {}),
      };
    });
  };
  const doneCatchup = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      activeView.current = null;
      clearTimeout(doneCatchup.current);
      ++request.current;
    },
    [],
  );
  const doneCards = useRef(new Map<string, DoneCardsReader>());
  const doneRefresh = useRef<{
    key: string;
    sources: Map<string, DoneRefresh>;
  }>({
    key: "",
    sources: new Map(),
  });
  async function loadNeeds(onlySources?: string[], manual = false) {
    if (hideFilters || generation !== viewGeneration()) return;
    const ticketGeneration = needsRequest.current;
    const owner = viewOwner();
    const key = needsKey();
    const requested = allSources.filter(
      (source) => !onlySources || onlySources.includes(source.id),
    );
    const ids = requested.map((source) => source.id);
    if (!ids.length) return;
    const queueKey = JSON.stringify([owner, generation, ticketGeneration, key]);
    const existing = needsReads.current;
    if (existing?.key === queueKey && existing.enqueue(ids, manual))
      return existing.settled;
    const current = () =>
      ticketGeneration === needsRequest.current &&
      generation === viewGeneration() &&
      owner === viewOwner();
    const options = new Map<string, boolean>();
    const retain = (sources: string[], manually: boolean) => {
      for (const source of sources) {
        needsSourceRequests.current.set(
          source,
          (needsSourceRequests.current.get(source) ?? 0) + 1,
        );
        options.set(source, manually || options.get(source) === true);
      }
    };
    retain(ids, manual);
    // Needs and operational counts publish one source at a time. Overlapping
    // invalidations share the same four readers and one trailing read per source.
    const queue = sourceReadQueue(
      ids,
      async (id) => {
        const source = allSources.find((source) => source.id === id);
        if (!source || !current()) return;
        const ticket = needsSourceRequests.current.get(id);
        const manually = options.get(id) ?? false;
        options.delete(id);
        const page = await readSnapshot(
          combined ? id : scopedSource,
          query(undefined, "needs"),
          "",
          manually,
        );
        if (!current() || ticket !== needsSourceRequests.current.get(id))
          return;
        const items: FeedItem[] = combined
          ? page.items.map((item) => ({
              ...item,
              sourceId: id,
              executionEnvironment: id ? source.name : undefined,
            }))
          : page.items;
        const selected = new Set(allSources.map((source) => source.id));
        // A failed source keeps its cached page. A successful source replaces only
        // its own rows, including an empty page, without waiting for another peer.
        const retained = (cachedView<FeedItem[]>(key) ?? []).filter(
          (item) =>
            selected.has(item.sourceId ?? scopedSource) &&
            (item.sourceId ?? scopedSource) !== id,
        );
        const loaded = [...retained, ...items].sort(
          (a, b) =>
            b.last_activity_at - a.last_activity_at ||
            (a.sourceId ?? scopedSource).localeCompare(
              b.sourceId ?? scopedSource,
            ) ||
            feedItemOrder(a, b),
        );
        cacheView(key, loaded, owner);
        setNeeds(loaded);
        const summaries = Object.fromEntries(
          Object.entries(
            cachedView<Record<string, Summary>>(summaryKey) ?? {},
          ).filter(([source]) => selected.has(source)),
        );
        summaries[id] = page.summary;
        cacheView(summaryKey, summaries, owner);
        setOperational({ key: summaryKey, sources: summaries });
      },
      current,
    );
    const reading = {
      key: queueKey,
      settled: queue.settled,
      enqueue(sources: string[], manually: boolean) {
        if (!queue.enqueue(sources)) return false;
        retain(sources, manually);
        return true;
      },
    };
    needsReads.current = reading;
    try {
      await queue.settled;
    } finally {
      if (needsReads.current === reading) needsReads.current = undefined;
    }
  }
  const pendingRefresh = useRef({ key: "", sources: new Set<string>() });
  const headSources = useRef(new Set<string>());
  function schedulePendingRefresh() {
    clearTimeout(doneCatchup.current);
    doneCatchup.current = undefined;
    const owner = viewOwner(),
      context = JSON.stringify([owner, shownKey()]);
    if (
      pendingRefresh.current.key !== context ||
      !pendingRefresh.current.sources.size
    )
      return;
    const ticket = request.current;
    doneCatchup.current = setTimeout(() => {
      if (
        ticket === request.current &&
        owner === viewOwner() &&
        activeView.current === context
      )
        void load(false, true, [...pendingRefresh.current.sources]);
    }, 100);
  }
  const [readError, setReadError] = useState("");
  const [readBusy, setReadBusy] = useState(false);
  const [partialReadPending, setPartialReadPending] = useState(false);
  type ReadAttempt = {
    append: boolean;
    before?: string;
    doneSummary?: boolean;
  };
  const retryPages = useRef(new Map<string, ReadAttempt>());
  const retryRead = () => {
    if (inFlight.current) return;
    const failed = [...retryPages.current];
    for (const [source] of failed) readRecovery.current.reset(source);
    void load(
      failed.length > 0 && failed.every(([, page]) => page.append),
      false,
      failed.length ? failed.map(([source]) => source) : undefined,
      true,
    );
  };
  async function load(
    append = false,
    background = false,
    onlySources?: string[],
    manual = false,
  ) {
    const refreshContext = JSON.stringify([viewOwner(), shownKey()]);
    // A completed action may still hold the load function for an old view.
    // Reject it before it can supersede the current view's request ticket.
    if (
      generation !== viewGeneration() ||
      activeView.current !== refreshContext
    )
      return;
    // Background refreshes never overlap; filter changes and actions always load.
    // Remember the final notification during a read, even if no later event
    // follows it (for example Working -> Done while Load more is pending).
    if (pendingRefresh.current.key !== refreshContext) {
      pendingRefresh.current = { key: refreshContext, sources: new Set() };
      headSources.current.clear();
    }
    const requestedSources = activeSources
      .filter((source) => !onlySources || onlySources.includes(source.id))
      .map((source) => source.id);
    // Capture each failed operation before any source succeeds and clears it.
    // A partial retry must neither advance a healthy source nor borrow a later
    // cursor from another read. Head and append failures can coexist.
    const cursors: Record<string, string> =
      combined && append && next ? JSON.parse(next) : {};
    const pages = new Map<string, ReadAttempt>(
      activeSources.map((source) => [
        source.id,
        (manual && retryPages.current.get(source.id)) || {
          append,
          before: append
            ? combined
              ? cursors[source.id]
              : next || undefined
            : undefined,
        },
      ]),
    );
    const pending = pendingRefresh.current.sources;
    if (background && inFlight.current) {
      for (const source of requestedSources) pending.add(source);
      refreshReadingSources.current?.(requestedSources);
      return;
    }
    // A superseded head read has not reconciled its sources. Appending cannot
    // consume any head notification; a scoped head consumes only its sources.
    if (inFlight.current)
      for (const source of headSources.current) pending.add(source);
    headSources.current = new Set(
      requestedSources.filter((source) => !pages.get(source)!.append),
    );
    if (headSources.current.size) {
      for (const source of headSources.current) pending.delete(source);
      void loadNeeds(background ? [...headSources.current] : undefined, manual);
    }
    if (!manual && !background) setReadError("");
    clearTimeout(doneCatchup.current);
    inFlight.current = true;
    setReadBusy(true);
    setPartialReadPending(false);
    const followup = new Set<string>();
    const ticket = ++request.current;
    refreshReadingSources.current = undefined;
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    const isCurrent = () =>
      ticket === request.current &&
      generation === viewGeneration() &&
      owner === viewOwner() &&
      activeView.current === refreshContext;
    // Loading placeholders belong to the first read of a filter. An empty
    // result is loaded content too; polling must keep its empty state visible.
    try {
      type Page = Shown;
      let result: Page;
      let partialError = "";
      let cached = cachedView<Shown>(shownKey());
      let previous = retainHistory ? cached : undefined;
      const hadVisibleItems = !!cached?.items.length;
      // A cold roster can reveal individual results before every first page
      // arrives, but it has no complete paging window to replace yet.
      const hasPagingWindow = activeSources.every(
        (source) => cached?.sourceSummaries?.[source.id],
      );
      const refreshKey = JSON.stringify([owner, shownKey()]);
      if (doneRefresh.current.key !== refreshKey)
        doneRefresh.current = { key: refreshKey, sources: new Map() };
      const readPage = async (
        read: (before?: string) => Promise<Page>,
        source: string,
        before?: string,
      ) => {
        const appending = pages.get(source)!.append;
        const cardKey =
          "feed-cards:" + JSON.stringify([owner, shownKey(), source]);
        let priorItems =
          cached?.items.filter(
            (item) => (item.sourceId ?? scopedSource) === source,
          ) ?? [];
        const order = (item: FeedItem): [number, string] =>
          item.cardOrder ?? [
            item.last_activity_at,
            item.conversation_id + "\u001f" + (item.done_card_key ?? ""),
          ];
        if (filter === "done") {
          let reader = doneCards.current.get(cardKey);
          if (!reader) {
            reader = new DoneCardsReader(
              cardKey,
              cachedView<CardWindow>(cardKey),
            );
            reader.discardPrior =
              cachedView<boolean>(cardKey + ":reset") ?? false;
            doneCards.current.set(cardKey, reader);
            if (doneCards.current.size > 40)
              doneCards.current.delete(doneCards.current.keys().next().value!);
          }
          const transport: CardReadTransport = (contract, input, signal) =>
            callRoute(
              contract,
              input,
              combined ? source : scopedSource,
              signal,
            );
          const boundary = reader.pager.snapshot()?.boundary;
          const catchUp =
            boundary &&
            priorItems.some(
              (item) => compareCardOrder(order(item), boundary) < 0,
            );
          const resetVersion = reader.resetVersion;
          let window: CardWindow | null;
          try {
            // A successful card append already advanced its cursor. If only
            // its summary failed, publish the current committed window without
            // asking for another page. Actions may have edited that window.
            const summaryOnly = pages.get(source)!.doneSummary;
            window = summaryOnly ? reader.pager.snapshot() : null;
            if (!window)
              window = await reader.load(
                transport,
                {
                  view: "done",
                  project: project || undefined,
                  agent: agent || undefined,
                  teams: teams || undefined,
                  ...(doneRead !== "all" ? { read: doneRead } : {}),
                },
                !summaryOnly && (appending || !!catchUp),
              );
          } finally {
            if (
              reader.discardPrior &&
              ticket === request.current &&
              owner === viewOwner()
            ) {
              if (reader.resetVersion !== resetVersion)
                cacheView(cardKey, undefined, owner);
              cacheView(cardKey + ":reset", true, owner);
              priorItems = [];
              // A revision-domain replacement invalidates every retained row
              // from this source, even if the fresh list/summary then fails.
              const keep = (item: FeedItem) =>
                (item.sourceId ?? scopedSource) !== source;
              const saved = cachedView<Shown>(shownKey());
              if (saved) {
                const cursors = combined ? JSON.parse(saved.next || "{}") : {};
                delete cursors[source];
                cached = {
                  ...saved,
                  items: saved.items.filter(keep),
                  next:
                    combined && Object.keys(cursors).length
                      ? JSON.stringify(cursors)
                      : null,
                };
                previous = cached;
                cacheView(shownKey(), cached, owner);
                setNext(cached.next);
              }
              if (sourcePages.current.key === pagesKey()) {
                const page = sourcePages.current.pages.get(source);
                if (page)
                  sourcePages.current.pages.set(source, {
                    ...page,
                    items: [],
                    next: null,
                  });
              }
              setItems((items) => items.filter(keep));
            }
          }
          if (reader.discardPrior) priorItems = [];
          if (
            reader.hasMore ||
            (window.boundary &&
              priorItems.some(
                (item) => compareCardOrder(order(item), window.boundary!) < 0,
              ))
          )
            followup.add(source);
          if (ticket === request.current && owner === viewOwner())
            cacheView(cardKey, window, owner);
          // Counters remain conversation-based operational Feed state.
          pages.set(source, { ...pages.get(source)!, doneSummary: true });
          const operational = await callRoute(
            workspaceApi.feed,
            { query: query(undefined, "needs") },
            source,
          );
          // Only a failed operational read needs a summary-only retry. A
          // trailing notification in this queue must read newer card changes.
          pages.set(source, { ...pages.get(source)!, doneSummary: false });
          if (ticket === request.current && owner === viewOwner()) {
            reader.discardPrior = false;
            cacheView(cardKey + ":reset", undefined, owner);
          }
          const typedItems = window.page.items.flatMap(
            ({ card, order: cardOrder }) =>
              card.type === "done"
                ? [
                    {
                      ...card.display,
                      done_card_key: card.display.done_card_key ?? undefined,
                      pending_approvals: 0,
                      position_message_id: null,
                      card,
                      cardOrder,
                    },
                  ]
                : [],
          );
          const known = new Set(
            typedItems.map((item) => feedItemKey(item, source)),
          );
          return {
            items: [
              ...priorItems.filter(
                (item) =>
                  !known.has(feedItemKey(item, source)) &&
                  window.boundary &&
                  compareCardOrder(order(item), window.boundary) < 0,
              ),
              ...typedItems,
            ].sort(feedItemOrder),
            next: window.page.next,
            summary: operational.summary,
          };
        }
        if (appending || !previous) {
          const page = await read(before);
          if (appending && retainHistory && cached) {
            const earlier = cached.items.filter(
              (item) => (item.sourceId ?? scopedSource) === source,
            );
            const incoming = new Set(
              page.items.map((item) => feedItemKey(item, source)),
            );
            return {
              ...page,
              items: [
                ...earlier.filter(
                  (item) => !incoming.has(feedItemKey(item, source)),
                ),
                ...page.items,
              ].sort(feedItemOrder),
            };
          }
          return page;
        }
        const current = () =>
          ticket === request.current && owner === viewOwner();
        const result = await refreshDonePage<FeedItem, Page>(
          read,
          {
            items: previous.items.filter(
              (item) => (item.sourceId ?? scopedSource) === source,
            ),
            next: combined
              ? (JSON.parse(previous.next || "{}")[source] ?? null)
              : previous.next,
          },
          doneRefresh.current.sources.get(source),
          current,
        );
        if (current()) {
          if (result.progress)
            doneRefresh.current.sources.set(source, result.progress);
          else doneRefresh.current.sources.delete(source);
        }
        return result.page;
      };
      if (combined) {
        const pending = activeSources.filter(
          (source) =>
            (!pages.get(source.id)!.append || pages.get(source.id)!.before) &&
            (!onlySources || onlySources.includes(source.id)),
        );
        const key = pagesKey();
        if (sourcePages.current.key !== key) {
          sourcePages.current = { key, pages: new Map(), failures: new Set() };
        }
        // Restore complete per-source pages before refresh or append, including
        // a source that disappeared and returned while this selection stayed open.
        for (const source of activeSources) {
          if (sourcePages.current.pages.has(source.id)) continue;
          const summary = cached?.sourceSummaries?.[source.id];
          if (!cached || !summary) continue;
          sourcePages.current.pages.set(source.id, {
            items: cached.items.filter(
              (item) => (item.sourceId ?? scopedSource) === source.id,
            ),
            next: JSON.parse(cached.next || "{}")[source.id] ?? null,
            summary,
          });
        }
        const activeIds = new Set(activeSources.map((source) => source.id));
        for (const id of sourcePages.current.failures)
          if (!activeIds.has(id)) sourcePages.current.failures.delete(id);
        // Initial pages may be visible before a combined view can be cached.
        // Keep a bounded fallback when discovery temporarily removes a source.
        const inactive = [...sourcePages.current.pages.keys()].filter(
          (id) => !activeIds.has(id),
        );
        for (const id of inactive.slice(0, -40))
          sourcePages.current.pages.delete(id);
        const assemble = (
          loaded: { source: (typeof activeSources)[number]; page: Page }[],
          nextCursors: Record<string, string>,
        ): Page => {
          const activePages = [...sourcePages.current.pages].filter(([id]) =>
            activeIds.has(id),
          );
          return {
            items: loaded.flatMap(({ source, page }) =>
              page.items.map((item) => ({
                ...item,
                sourceId: source.id,
                executionEnvironment: source.id ? source.name : undefined,
              })),
            ),
            next: Object.keys(nextCursors).length
              ? JSON.stringify(nextCursors)
              : null,
            sourceSummaries: Object.fromEntries(
              activePages.map(([id, page]) => [id, page.summary]),
            ),
            summary: combineSummaries(
              activePages.map(([, page]) => page.summary),
            ),
          };
        };
        const readSource = async (source: (typeof activeSources)[number]) => {
          if (!isCurrent())
            throw new DOMException("Feed read superseded", "AbortError");
          const incoming = await readPage(
            (before) => readProjectionPage(source.id, query(before), manual),
            source.id,
            pages.get(source.id)!.before,
          );
          if (!isCurrent()) return { source, page: incoming };
          const page = {
            ...incoming,
            items: pendingUnsaves(incoming.items, source.id),
          };
          if (!pages.get(source.id)!.append) {
            const earlier = sourcePages.current.pages.get(source.id);
            const known = new Set(
              page.items.map((item) => feedItemKey(item, source.id)),
            );
            // An incomplete Working/Queued head keeps its loaded history
            // and cursor together. An exhaustive head is authoritative for
            // that source now, including an empty result; a slow peer cannot
            // retain rows that this source has already removed.
            const visible =
              earlier && !retainHistory && page.next
                ? {
                    ...page,
                    next: earlier.next,
                    items: [
                      ...page.items,
                      ...earlier.items.filter(
                        (item) => !known.has(feedItemKey(item, source.id)),
                      ),
                    ],
                  }
                : page;
            sourcePages.current.pages.set(source.id, visible);
            const loaded = activeSources.flatMap((source) => {
              const page = sourcePages.current.pages.get(source.id);
              return page ? [{ source, page }] : [];
            });
            const cursors = Object.fromEntries(
              loaded.flatMap(({ source, page }) =>
                page.next ? [[source.id, page.next]] : [],
              ),
            );
            const partial = assemble(loaded, cursors);
            partial.items.sort(
              (a, b) =>
                b.last_activity_at - a.last_activity_at ||
                (a.sourceId || "").localeCompare(b.sourceId || "") ||
                feedItemOrder(a, b),
            );
            if (hasPagingWindow) {
              cached = partial;
              previous = retainHistory ? partial : undefined;
              cacheView(shownKey(), partial, owner);
              setNext(partial.next);
            }
            setItems(partial.items);
            setPartialReadPending(hadVisibleItems && !partial.items.length);
          }
          return { source, page };
        };
        let settled: PromiseSettledResult<
          Awaited<ReturnType<typeof readSource>>
        >[];
        if (pages.size && [...pages.values()].every((page) => !page.append)) {
          const queue = sourceReadQueue(
            pending.map((source) => source.id),
            async (id) => {
              if (!isCurrent())
                throw new DOMException("Feed read superseded", "AbortError");
              const source = activeSources.find((source) => source.id === id)!;
              pendingRefresh.current.sources.delete(id);
              headSources.current.add(id);
              return readSource(source);
            },
            isCurrent,
          );
          const enqueue = (ids: string[]) => {
            if (!isCurrent()) return;
            const selected = activeSources.filter((source) =>
              ids.includes(source.id),
            );
            for (const source of selected)
              if (!pending.some((item) => item.id === source.id))
                pending.push(source);
            void loadNeeds(
              selected.map((source) => source.id),
              manual,
            );
            queue.enqueue(selected.map((source) => source.id));
          };
          refreshReadingSources.current = enqueue;
          try {
            const results = await queue.settled;
            settled = pending.map(
              (source) =>
                results.get(source.id) ?? {
                  status: "rejected",
                  reason: new DOMException(
                    "Feed read superseded",
                    "AbortError",
                  ),
                },
            );
          } finally {
            if (refreshReadingSources.current === enqueue)
              refreshReadingSources.current = undefined;
          }
        } else settled = await Promise.allSettled(pending.map(readSource));
        if (!isCurrent()) return;
        settled.forEach((entry, index) => {
          const id = pending[index].id;
          if (entry.status === "rejected") {
            if (entry.reason?.name !== "AbortError") {
              sourcePages.current.failures.add(id);
              retryPages.current.set(id, pages.get(id)!);
            }
          } else {
            sourcePages.current.failures.delete(id);
            retryPages.current.delete(id);
          }
        });
        const loaded = settled.flatMap((entry) =>
          entry.status === "fulfilled"
            ? [
                {
                  ...entry.value,
                  page: {
                    ...entry.value.page,
                    items: pendingUnsaves(
                      entry.value.page.items,
                      entry.value.source.id,
                    ),
                  },
                },
              ]
            : [],
        );
        if (onlySources)
          for (const source of activeSources) {
            if (pending.some((item) => item.id === source.id)) continue;
            const page = sourcePages.current.pages.get(source.id);
            if (page) loaded.push({ source, page });
          }
        for (const entry of loaded) {
          const { source, page } = entry;
          // The outage fallback must include pages appended by Load more.
          const earlier =
            pages.get(source.id)!.append && !retainHistory
              ? sourcePages.current.pages.get(source.id)?.items
              : undefined;
          const known = new Set(
            earlier?.map((item) => feedItemKey(item, source.id)),
          );
          entry.page = {
            ...page,
            items: earlier
              ? [
                  ...earlier,
                  ...page.items.filter(
                    (item) => !known.has(feedItemKey(item, source.id)),
                  ),
                ]
              : page.items,
          };
          sourcePages.current.pages.set(source.id, entry.page);
        }
        if (
          !loaded.length &&
          settled.length &&
          settled.every(
            (entry) =>
              entry.status === "rejected" &&
              entry.reason?.name === "AbortError",
          )
        )
          throw new DOMException("Feed read superseded", "AbortError");
        if (!loaded.length && settled.length)
          throw new Error(
            settled.length === 1 && settled[0].status === "rejected"
              ? settled[0].reason.message
              : "Couldn’t load the Feed from any environment.",
          );
        partialError = sourcePages.current.failures.size
          ? "Some environments could not refresh. Showing their last loaded threads."
          : "";
        if (!append || retainHistory) {
          settled.forEach((entry, index) => {
            const source = pending[index];
            if (entry.status !== "rejected") return;
            const page = sourcePages.current.pages.get(source.id);
            if (page) loaded.push({ source, page });
          });
        }
        if (append && retainHistory) {
          for (const source of activeSources) {
            if (loaded.some((item) => item.source.id === source.id)) continue;
            const page = sourcePages.current.pages.get(source.id);
            if (page) loaded.push({ source, page });
          }
        }
        const nextCursors: Record<string, string> = append
          ? { ...cursors }
          : {};
        for (const { source, page } of loaded) {
          if (page.next) nextCursors[source.id] = page.next;
          else delete nextCursors[source.id];
        }
        result = assemble(loaded, nextCursors);
      } else {
        result = await readPage(
          (before) => readProjectionPage(scopedSource, query(before), manual),
          scopedSource,
          pages.get(scopedSource)!.before,
        );
        if (isCurrent()) retryPages.current.delete(scopedSource);
      }
      if (!isCurrent()) return;
      const key = shownKey();
      setItems((old) => {
        const merged = pendingUnsaves(
          append && !retainHistory
            ? [
                ...old,
                ...result.items.filter(
                  (item) =>
                    !old.some((o) => feedItemKey(o) === feedItemKey(item)),
                ),
              ]
            : result.items,
        );
        if (sources)
          merged.sort(
            (a, b) =>
              b.last_activity_at - a.last_activity_at ||
              (a.sourceId || "").localeCompare(b.sourceId || "") ||
              feedItemOrder(a, b),
          );
        cacheView<Shown>(
          key,
          {
            items: merged,
            next: result.next,
            summary: result.summary,
            sourceSummaries: result.sourceSummaries,
          },
          owner,
        );
        return merged;
      });
      setNext(result.next);
      setReadError(partialError);
    } catch (e) {
      if (isCurrent() && (e as Error).name !== "AbortError") {
        if (!combined)
          retryPages.current.set(scopedSource, pages.get(scopedSource)!);
        setReadError((e as Error).message);
      }
    } finally {
      if (ticket === request.current) {
        inFlight.current = false;
        setReadBusy(false);
        setPartialReadPending(false);
      }
      if (isCurrent()) {
        markLoaded(shownKey());
        headSources.current.clear();
        for (const source of followup) pending.add(source);
        schedulePendingRefresh();
      }
    }
  }
  recoverSource.current = (source) => {
    if (activeSources.some((item) => item.id === source))
      void load(false, true, [source]);
    else if (allSources.some((item) => item.id === source))
      void loadNeeds([source]);
  };
  const firstLoad = useRef(true);
  useEffect(() => {
    setNeedsOpen(false);
    setReadError("");
    retryPages.current.clear();
    itemsSelection.current = shownKey();
    const cached = cachedView<Shown>(shownKey());
    // The first render already shows the cached list; a filter change swaps
    // to that filter's cached list, or a loader.
    if (!firstLoad.current) {
      setItems(cached?.items || retainedItems());
      setNext(cached?.next || null);
      setNeeds(cachedView<FeedItem[]>(needsKey()) || []);
    }
    firstLoad.current = false;
    // Subscribe before the first snapshot. Invalidations during a request are
    // a bounded trailing read; each retained page owns its own delta cursor.
    const stopFrames = activeSources.map((source) =>
      listenProjectionFrames(source.id, (frame) => {
        if (frame.type !== "reset") return;
        projectionPages.current.reset(source.id);
        readRecovery.current.reset(source.id);
        retryPages.current.delete(source.id);
        if (inFlight.current) pendingRefresh.current.sources.add(source.id);
      }),
    );
    void load();
    return () => {
      stopFrames.forEach((stop) => stop());
      readRecovery.current.reset();
      ++request.current;
      ++needsRequest.current;
      needsSourceRequests.current.clear();
      pendingRefresh.current = { key: "", sources: new Set() };
      headSources.current.clear();
      inFlight.current = false;
      refreshReadingSources.current = undefined;
      setReadBusy(false);
    };
  }, [
    filter,
    project,
    teams,
    agent,
    sourceKey,
    needsSourceKey,
    doneRead,
    generation,
  ]);
  useEffect(() => {
    // Explicit refreshes supersede an older read: dropping one while polling
    // is in flight can leave a completed action or connection retry unseen.
    // The request ticket prevents the older response from replacing this one.
    const update = () => void load();
    window.addEventListener("loop-later-change", update);
    window.addEventListener("loop-social-read", update);
    // Source discovery and completed actions refresh the head with its normal
    // retry budget. Only this view's notice retries the failed operation once.
    window.addEventListener("loop-source-refresh", update);
    const stopChanges = listenWorkspaceChanges("feed", (event) => {
      const affected = activeSources
        .filter((source) => workspaceChangeAffects(event, "feed", source.id))
        .map((source) => source.id);
      if (affected.length) {
        if (
          [...retryPages.current.keys()].every((source) =>
            affected.includes(source),
          )
        )
          setReadError("");
        void load(false, true, affected);
      }
      const needsOnly = allSources
        .filter(
          (source) =>
            !activeSources.some((active) => active.id === source.id) &&
            workspaceChangeAffects(event, "feed", source.id),
        )
        .map((source) => source.id);
      if (needsOnly.length) void loadNeeds(needsOnly);
    });
    return () => {
      window.removeEventListener("loop-later-change", update);
      window.removeEventListener("loop-social-read", update);
      window.removeEventListener("loop-source-refresh", update);
      stopChanges();
      clearTimeout(doneCatchup.current);
    };
    // Re-arm with every input `load` reads, so the fallback refresh never
    // replaces the Feed using a stale filter or source list.
  }, [
    filter,
    project,
    teams,
    agent,
    sourceKey,
    needsSourceKey,
    doneRead,
    generation,
  ]);
  async function runAction(
    runId: string,
    ...command:
      | [
          action: "reorder",
          sourceId: string,
          body: RouteInput<typeof workspaceApi.runReorder>["body"],
        ]
      | [action: "cancel" | "pause" | "resume" | "dismiss", sourceId: string]
  ) {
    const id = RunId.parse(runId);
    const [action, sourceId, body] = command;
    const owner = viewOwner();
    try {
      if (action === "reorder")
        await callRoute(
          workspaceApi.runReorder,
          { params: { id }, body },
          sourceId,
        );
      else
        await callRoute(
          workspaceApi.runAction,
          { params: { id, action }, body: {} },
          sourceId,
        );
      if (owner !== viewOwner()) return;
      if (action === "dismiss") {
        // Discard an older Needs read and remove exactly the acknowledged
        // failure while the fresh lists load. The server keeps its history.
        ++needsRequest.current;
        setNeeds((old) => {
          const remaining = old.filter(
            (item) =>
              item.run?.id !== runId ||
              (item.sourceId ?? scopedSource) !== sourceId,
          );
          cacheView(needsKey(), remaining, owner);
          return remaining;
        });
        notify({ text: "Dismissed from Needs you." });
      }
      onChanged();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function dismissFeedCard(item: FeedItem) {
    const cardKey = item.reply_card_key ?? item.done_card_key;
    if (!cardKey || !["done", "replies"].includes(filter)) return;
    const owner = viewOwner(),
      key = shownKey();
    const source = item.sourceId ?? scopedSource;
    const current = () =>
      owner === viewOwner() &&
      doneRefresh.current.key === JSON.stringify([owner, key]);
    const setHidden = (hidden: boolean) =>
      item.reply
        ? callRoute(
            workspaceApi.replyState,
            {
              params: { id: item.last_message!.id },
              body: { archived: hidden },
            },
            source,
          )
        : callRoute(
            workspaceApi.feedUpdate,
            {
              params: { id: ConversationId.parse(item.conversation_id) },
              body: { hidden, cardKey },
            },
            source,
          );
    const updateCard = (hidden: boolean) => {
      if (!item.card) return;
      const cardKey = "feed-cards:" + JSON.stringify([owner, key, source]);
      const reader = doneCards.current.get(cardKey);
      const window =
        reader?.pager.snapshot() ?? cachedView<CardWindow>(cardKey);
      if (!window) return;
      const items = window.page.items.filter(
        (entry) => entry.card.id !== item.card!.id,
      );
      if (!hidden)
        items.push({
          card: item.card,
          order: item.cardOrder ?? [
            item.last_activity_at,
            item.conversation_id + "\u001f" + (item.done_card_key ?? ""),
          ],
          saved: null,
        });
      const changed = { ...window, page: { ...window.page, items } };
      reader?.invalidateForAction();
      reader?.pager.restore(cardKey, changed);
      cacheView(cardKey, changed, owner);
    };
    const update = (change: (items: FeedItem[]) => FeedItem[]) => {
      if (owner !== viewOwner()) return;
      const cached = cachedView<Shown>(key);
      if (cached)
        cacheView(key, { ...cached, items: change(cached.items) }, owner);
      const page =
        sourcePages.current.key === pagesKey()
          ? sourcePages.current.pages.get(source)
          : undefined;
      if (page)
        sourcePages.current.pages.set(source, {
          ...page,
          items: change(
            page.items.map((row) => ({ ...row, sourceId: source })),
          ),
        });
      if (current()) {
        ++request.current; // A read started before the action cannot restore it.
        setItems(change);
      }
    };
    try {
      await setHidden(true);
      if (owner !== viewOwner()) return;
      updateCard(true);
      update((old) =>
        old.filter(
          (row) =>
            feedItemKey(row, row.sourceId ?? scopedSource) !==
            feedItemKey(item, source),
        ),
      );
      notify({
        text: item.reply ? "Reply archived." : "Removed from Done.",
        undo: async () => {
          if (owner !== viewOwner()) return;
          await setHidden(false);
          updateCard(false);
          update((old) =>
            [
              ...old.filter((row) => feedItemKey(row) !== feedItemKey(item)),
              item,
            ].sort(feedItemOrder),
          );
          if (current()) await load();
        },
      });
      if (current()) void load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function markReplyRead(item: FeedItem) {
    if (!item.reply || item.reply.read_at !== null || !item.last_message)
      return;
    const owner = viewOwner(),
      source = item.sourceId ?? scopedSource;
    try {
      await callRoute(
        workspaceApi.replyState,
        { params: { id: item.last_message.id }, body: { read: true } },
        source,
      );
      if (owner === viewOwner()) await load();
    } catch (error) {
      if (owner === viewOwner()) setError((error as Error).message);
    }
  }
  async function markDoneRead(item: FeedItem, bulk = false) {
    // Opening again is a later read choice even while an unread write is pending.
    const cardKey = item.done_card_key;
    if (item.read_at === undefined || !cardKey) return;
    const generation = viewGeneration(),
      source = item.sourceId ?? scopedSource;
    if (
      operationBlockReason(
        source,
        allSources.find((entry) => entry.id === source)?.capabilities,
        workspaceApi.feedRead,
      )
    )
      return;
    try {
      await writeDoneReadState(source, () =>
        callRoute(
          workspaceApi.feedRead,
          {
            params: { id: ConversationId.parse(item.conversation_id) },
            body: {
              cardKey,
              unreadVersion: doneReadVersion(
                source,
                doneCardId(cardKey),
                item.unread_version,
              ),
            },
          },
          source,
        ),
      );
      if (!bulk && generation === viewGeneration()) await load();
    } catch (error) {
      if (bulk) throw error;
      if (generation === viewGeneration()) setError((error as Error).message);
    }
  }
  async function markUnread(
    item: FeedItem,
    thread?: SourcedDoneThread,
    bulk = false,
  ) {
    const generation = viewGeneration();
    const cardKey = item.done_card_key,
      source = item.sourceId ?? scopedSource;
    try {
      if (thread) {
        await writeDoneUnreadState(
          thread.source,
          () =>
            callRoute(
              workspaceApi.doneThreadUnread,
              { params: { id: thread.id } },
              thread.source,
            ),
          thread.id,
        );
      } else if (cardKey) {
        await writeDoneUnreadState(source, () =>
          callRoute(
            workspaceApi.feedUnread,
            {
              params: { id: ConversationId.parse(item.conversation_id) },
              body: { cardKey },
            },
            source,
          ),
        );
      } else return;
      if (!bulk && generation === viewGeneration()) {
        grouping.refresh();
        await load();
      }
    } catch (error) {
      if (bulk) throw error;
      if (generation === viewGeneration()) setError((error as Error).message);
    }
  }
  async function markSelectedRead(unread: boolean) {
    if (bulkReadBusy) return;
    const currentGeneration = viewGeneration();
    const rows = visibleCards.filter((row) => selectedCards?.includes(row.key));
    setBulkReadBusy(true);
    const failed: string[] = [];
    try {
      for (const row of rows) {
        if (currentGeneration !== viewGeneration()) return;
        const source = row.thread?.source ?? row.item.sourceId ?? scopedSource;
        const route = row.thread
          ? unread
            ? workspaceApi.doneThreadUnread
            : workspaceApi.doneThreadRead
          : unread
            ? workspaceApi.feedUnread
            : workspaceApi.feedRead;
        try {
          const reason = operationBlockReason(
            source,
            allSources.find((entry) => entry.id === source)?.capabilities,
            route,
          );
          if (reason) throw new Error(reason);
          if (unread) await markUnread(row.item, row.thread, true);
          else if (row.thread) await markThreadRead(row.thread, true);
          else await markDoneRead(row.item, true);
        } catch {
          failed.push(row.key);
        }
      }
      if (currentGeneration !== viewGeneration()) return;
      setSelectedCards(failed.length ? failed : null);
      if (failed.length)
        setError(
          `${failed.length} cards could not be marked ${unread ? "unread" : "read"}. Select the action again to retry.`,
        );
      grouping.refresh();
      await load();
    } finally {
      setBulkReadBusy(false);
    }
  }
  function openThread(thread: SourcedDoneThread) {
    setReadingThread({ ...thread, generation });
    if (thread.unread !== undefined) void markThreadRead(thread);
  }
  async function markThreadRead(thread: SourcedDoneThread, bulk = false) {
    const generation = viewGeneration();
    if (
      operationBlockReason(
        thread.source,
        allSources.find((entry) => entry.id === thread.source)?.capabilities,
        workspaceApi.doneThreadRead,
      )
    )
      return;
    try {
      await writeDoneReadState(thread.source, () =>
        callRoute(
          workspaceApi.doneThreadRead,
          {
            params: { id: thread.id },
            body:
              thread.unreadVersions === undefined
                ? {}
                : {
                    unreadVersions: doneThreadReadVersions(
                      thread.source,
                      thread.id,
                      thread.unreadVersions,
                    ),
                  },
          },
          thread.source,
        ),
      );
      if (!bulk && generation === viewGeneration()) {
        grouping.refresh();
        await load();
      }
    } catch (error) {
      if (bulk) throw error;
      if (generation === viewGeneration()) setError((error as Error).message);
    }
  }
  function markSaved(item: FeedItem, saved: boolean, active = true) {
    const change = (old: FeedItem[]) =>
      old.map((row) =>
        row.last_message?.id === item.last_message?.id &&
        (row.sourceId || "") === (item.sourceId || "") &&
        row.last_message
          ? { ...row, last_message: { ...row.last_message, saved } }
          : row,
      );
    const cached = cachedView<Shown>(shownKey());
    if (cached)
      cacheView(
        shownKey(),
        { ...cached, items: change(cached.items) },
        viewOwner(),
      );
    const source = item.sourceId ?? scopedSource;
    const page =
      sourcePages.current.key === pagesKey()
        ? sourcePages.current.pages.get(source)
        : undefined;
    if (page)
      sourcePages.current.pages.set(source, {
        ...page,
        items: change(page.items.map((row) => ({ ...row, sourceId: source }))),
      });
    const owner = viewOwner();
    const cardKey = "feed-cards:" + JSON.stringify([owner, shownKey(), source]);
    const reader = doneCards.current.get(cardKey);
    const window = reader?.pager.snapshot() ?? cachedView<CardWindow>(cardKey);
    if (window) {
      const changed = {
        ...window,
        page: {
          ...window.page,
          items: window.page.items.map((entry) => {
            const card = entry.card;
            if (
              card.type !== "done" ||
              card.source.message_id !== item.last_message?.id
            )
              return entry;
            return {
              ...entry,
              card: {
                ...card,
                saved,
                display: {
                  ...card.display,
                  last_message: card.display.last_message
                    ? { ...card.display.last_message, saved }
                    : null,
                },
              },
            };
          }),
        },
      };
      reader?.invalidateForAction();
      reader?.pager.restore(cardKey, changed);
      cacheView(cardKey, changed, owner);
      if (active) {
        ++request.current;
        inFlight.current = false;
        setReadBusy(false);
        for (const source of headSources.current)
          pendingRefresh.current.sources.add(source);
        headSources.current.clear();
        schedulePendingRefresh();
        setLoadedKey(shownKey());
      }
    }
    if (active) setItems(change);
  }
  async function setSavedOnServer(
    item: FeedItem,
    messageId: string,
    saved: boolean,
  ) {
    await callRoute(
      saved ? workspaceApi.messageSave : workspaceApi.messageUnsave,
      {
        params: { id: messageId },
        body: saved ? {} : undefined,
      },
      item.sourceId ?? scopedSource,
    );
    window.dispatchEvent(new Event("loop-later-change"));
  }
  /**
   * Save the card: its latest message, and the result card that message
   * produced, so Saved shows the one thing once. As in a thread, unsaving
   * waits for the toast to end so Undo keeps the original save.
   */
  async function toggleSaved(item: FeedItem) {
    const message = item.last_message;
    if (!message) return;
    const owner = viewOwner(),
      key = JSON.stringify([owner, shownKey()]);
    const current = () => owner === viewOwner() && activeView.current === key;
    const restore = (saved: boolean) => {
      if (owner !== viewOwner()) return;
      markSaved(item, saved, current());
      if (current()) void load();
    };
    const saved = !!message.saved;
    const pendingKey = savedKey(item.sourceId ?? scopedSource, message.id);
    const pending = {};
    const clearPending = () => {
      if (deferredUnsaves.current.get(pendingKey) === pending)
        deferredUnsaves.current.delete(pendingKey);
    };
    if (saved) deferredUnsaves.current.set(pendingKey, pending);
    else deferredUnsaves.current.delete(pendingKey);
    markSaved(item, !saved);
    if (saved) {
      notify({
        text: "Removed from Saved.",
        undo: () => {
          clearPending();
          restore(true);
        },
        onExpire: () => {
          if (
            owner !== viewOwner() ||
            deferredUnsaves.current.get(pendingKey) !== pending
          )
            return;
          void setSavedOnServer(item, message.id, false)
            .then(clearPending)
            .catch((e) => {
              clearPending();
              restore(true);
              if (current()) setError((e as Error).message);
            });
        },
      });
      // Reconcile other environments immediately; the deferred item stays
      // unsaved locally until Undo or the eventual server write settles.
      if (current()) void load();
      return;
    }
    try {
      await setSavedOnServer(item, message.id, true);
      if (owner !== viewOwner()) return;
      notify({
        text: "Saved. Find it in Later → Saved.",
        undo: async () => {
          if (owner !== viewOwner()) return;
          await setSavedOnServer(item, message.id, false);
          restore(false);
        },
      });
    } catch (e) {
      restore(false);
      if (current()) setError((e as Error).message);
    }
  }
  function actionsFor(
    item: FeedItem,
    thread?: SourcedDoneThread | null,
  ): Action[] {
    const unreadSource = thread?.source ?? item.sourceId ?? scopedSource;
    const unreadReason = operationBlockReason(
      unreadSource,
      allSources.find((source) => source.id === unreadSource)?.capabilities,
      thread ? workspaceApi.doneThreadUnread : workspaceApi.feedUnread,
    );
    // An open reader in the Unread selection retains its original card while
    // the read write removes it from that selection. Allow marking it unread
    // even when this retained snapshot still says it is unread.
    const unread: Action[] = (
      thread
        ? thread.unread !== undefined
        : item.done_card_key && item.read_at !== undefined
    )
      ? [
          {
            id: "mark-unread",
            label: "Mark unread",
            icon: <Mail size={20} />,
            disabled: !!unreadReason,
            hint: unreadReason,
            onSelect: () => void markUnread(item, thread ?? undefined),
          },
        ]
      : [];
    const key = thread
      ? JSON.stringify([thread.source, "thread", thread.id])
      : feedItemKey(item, item.sourceId ?? scopedSource);
    const organize: Action[] = aggregatable(item)
      ? [
          {
            id: "select-cards",
            label: "Select cards",
            icon: <ListChecks size={20} />,
            onSelect: () => setSelectedCards([key]),
          },
          {
            id: "move-to",
            label: "Move to…",
            icon: <FolderInput size={20} />,
            onSelect: () => organizeSelection([key]),
          },
          {
            id: "combine",
            label: "Combine with another card",
            icon: <Layers size={20} />,
            hint: "One thread. The whole conversation.",
            disabled: !visibleCards.some(
              (row) => row.key !== key && aggregatable(row.item),
            ),
            onSelect: () => setCombineFrom(key),
          },
        ]
      : [];
    if (thread)
      return [
        {
          id: "open-thread",
          label: "Open thread",
          icon: <MessageSquare size={20} />,
          onSelect: () => openThread(thread),
        },
        ...unread,
        ...organize,
        {
          id: "ungroup",
          label: "Ungroup cards",
          hint: "Return each card to Done",
          icon: <Layers size={20} />,
          onSelect: () => void ungroup(thread),
        },
      ];
    const agent = agents.find(
      (a) =>
        a.id === item.agent_id &&
        (a.sourceId || "") === (item.sourceId ?? scopedSource),
    );
    const source = item.sourceId ?? scopedSource;
    const state = item.run?.state || "";
    const actions: Action[] = [
      ...(filter === "done"
        ? [
            {
              id: "reply",
              label: "Reply",
              icon: <MessageSquare size={20} />,
              onSelect: () =>
                onReply
                  ? onReply(
                      item.conversation_id,
                      source,
                      feedReplyQuote(item) ?? undefined,
                    )
                  : onOpen(item.conversation_id, item.last_message?.id, source),
            },
          ]
        : []),
      ...unread,
      ...(item.reply
        ? [
            {
              id: "archive-reply",
              label: "Archive reply",
              icon: <Archive size={20} />,
              onSelect: () => void dismissFeedCard(item),
            },
          ]
        : []),
      ...(item.last_message
        ? [
            {
              id: "save",
              label: item.last_message.saved ? "Remove from Saved" : "Save",
              hint: item.last_message.saved
                ? undefined
                : "Keeps this card's latest message in Later → Saved",
              icon: item.last_message.saved ? (
                <BookmarkCheck size={20} />
              ) : (
                <Bookmark size={20} />
              ),
              onSelect: () => void toggleSaved(item),
            },
          ]
        : []),
      {
        id: "later",
        label: "Remind me",
        icon: <AlarmClock size={20} />,
        onSelect: () => setLater(item),
      },
    ];
    actions.push(...organize);
    if (filter === "done" && item.done_card_key)
      actions.push({
        id: "remove-done",
        label: "Remove from Done",
        icon: <Archive size={20} />,
        onSelect: () => void dismissFeedCard(item),
      });
    // Queued follow-ups have their own controls, separate from the thread's
    // current run; a thread can hold a running task and queued messages.
    const queued = item.queued_runs || [];
    for (const q of queued) {
      const which =
        queued.length > 1 || (item.run && item.run.id !== q.id)
          ? ` “${preview(q.input, 32)}”`
          : "";
      const message = {
        id: q.id,
        input: q.input,
        agentId: item.agent_id,
        sourceId: source,
      };
      if (q.can_move_up)
        actions.push({
          id: "up-" + q.id,
          label: `Move up in queue${which}`,
          icon: <ArrowUp size={20} />,
          onSelect: () =>
            void runAction(q.id, "reorder", source, { direction: "up" }),
        });
      if (q.can_move_down)
        actions.push({
          id: "down-" + q.id,
          label: `Move down in queue${which}`,
          icon: <ArrowDown size={20} />,
          onSelect: () =>
            void runAction(q.id, "reorder", source, { direction: "down" }),
        });
      if (q.can_edit)
        actions.push(
          {
            id: "edit-" + q.id,
            label: `Edit queued message${which}`,
            icon: <PencilLine size={20} />,
            onSelect: () => setEditing(message),
          },
          {
            id: "move-" + q.id,
            label: `Move to another agent${which}`,
            icon: <Users size={20} />,
            onSelect: () => setMoving(message),
          },
        );
      if (item.run?.id !== q.id)
        actions.push({
          id: "cancel-" + q.id,
          label: `Cancel queued message${which}`,
          danger: true,
          icon: <Square size={18} />,
          onSelect: () => void runAction(q.id, "cancel", source),
        });
    }
    if (["queued", "running"].includes(state))
      actions.push({
        id: "pause",
        label: "Pause",
        icon: <Pause size={20} />,
        onSelect: () => void runAction(item.run!.id, "pause", source),
      });
    if (state === "paused")
      actions.push({
        id: "resume",
        label: "Resume",
        icon: <Play size={20} />,
        onSelect: () => void runAction(item.run!.id, "resume", source),
      });
    if (["failed", "interrupted"].includes(state))
      actions.push({
        id: "dismiss",
        label: "Dismiss from Needs you",
        icon: <X size={20} />,
        onSelect: () => void runAction(item.run!.id, "dismiss", source),
      });
    if (state && !isTerminalRunState(state))
      actions.push({
        id: "cancel",
        label:
          state !== "queued" && queued.length
            ? "Cancel current task"
            : "Cancel task",
        danger: true,
        icon: <Square size={18} />,
        onSelect: () => void runAction(item.run!.id, "cancel", source),
      });
    if (agent)
      actions.push({
        id: "agent",
        label: `Open @${agent.name}`,
        icon: <UserRound size={20} />,
        onSelect: () => onAgent(agent),
      });
    actions.push({
      id: "share",
      label: "Share link",
      icon: <Share2 size={20} />,
      onSelect: () =>
        void shareLink(
          sourceUrl(source, { conversation: item.conversation_id }),
          item.title,
        ).then((text) => text && setNotice(text)),
    });
    return actions;
  }
  function card(item: FeedItem, inNeeds = false, thread?: SourcedDoneThread) {
    const displayKey = thread
      ? JSON.stringify([thread.source, "thread", thread.id])
      : feedItemKey(item, item.sourceId ?? scopedSource);
    const source = item.sourceId ?? scopedSource;
    // The reading sheet identifies agent output. A thread whose latest
    // content is a prompt opens the conversation with its original author.
    const threadOutput =
      !!item.live_preview || item.last_message?.role === "assistant";
    const dismissFailure =
      inNeeds && item.run && ["failed", "interrupted"].includes(item.run.state);
    const agent = agents.find(
      (a) => a.id === item.agent_id && (a.sourceId || "") === source,
    );
    // Both badges describe the connection that ran (or will run)
    // this thread on its own source, so an agent reconfiguration
    // doesn't relabel it.
    const sourceConnections = (connections || []).filter(
      (connection) => (connection.sourceId || "") === source,
    );
    const connectionId =
      item.run?.connection_id ||
      item.connection_id ||
      agent?.connection_id ||
      null;
    const model = !connections
      ? undefined
      : item.run?.model
        ? runModelName(
            {
              model: item.run.model,
              resolvedModel: item.run.resolved_model,
              connectionId,
            },
            sourceConnections,
          )
        : agent
          ? agentModelName(
              { connection_id: connectionId, model: agent.model },
              sourceConnections,
            )
          : undefined;
    return (
      <FeedCard
        key={displayKey}
        item={
          thread
            ? { ...item, title: thread.title, next_action: undefined }
            : item
        }
        groupCount={thread?.cardIds.length}
        selected={
          !inNeeds && selectedCards
            ? selectedCards.includes(displayKey)
            : undefined
        }
        onSelect={
          !inNeeds && selectedCards && aggregatable(item)
            ? () => {
                if (!bulkReadBusy) toggleSelection(displayKey);
              }
            : undefined
        }
        aggregationId={!inNeeds && aggregatable(item) ? displayKey : undefined}
        dragSession={dragSession}
        onAggregate={combineCards}
        sourceCapabilities={
          allSources.find((entry) => entry.id === source)?.capabilities
        }
        readAsCard={
          !inNeeds &&
          !thread &&
          (["done", "replies", "working", "queued"].includes(filter) ||
            (filter === "threads" && threadOutput))
        }
        agent={agent}
        model={model}
        environment={cardEnvironment(
          source,
          connectionId,
          agent?.executionEnvironment ||
            (source && allSources.find((item) => item.id === source)?.name) ||
            item.executionEnvironment,
        )}
        onRead={
          item.reply
            ? () => void markReplyRead(item)
            : item.read_at !== undefined && !thread
              ? () => void markDoneRead(item)
              : undefined
        }
        onReadingChange={
          !inNeeds && !thread && doneRead === "unread"
            ? (open) => setReadingCard(open ? { item, view: shownKey() } : null)
            : undefined
        }
        onQuestion={
          item.reply
            ? () => onOpen(item.conversation_id, item.reply!.message_id, source)
            : undefined
        }
        onOpen={() =>
          thread
            ? openThread(thread)
            : onOpen(
                item.conversation_id,
                item.reply ? item.last_message?.id : undefined,
                source,
              )
        }
        onReply={() =>
          onReply
            ? onReply(
                item.conversation_id,
                source,
                feedReplyQuote(item) ?? undefined,
              )
            : onOpen(item.conversation_id, undefined, source)
        }
        onNext={(action) =>
          action.kind === "draft"
            ? onReply
              ? onReply(item.conversation_id, source)
              : onOpen(item.conversation_id, undefined, source)
            : onOpen(
                item.conversation_id,
                action.message_id || undefined,
                source,
              )
        }
        onAgent={agent ? () => onAgent(agent) : undefined}
        onMenu={() => {
          setMenu(item);
          setMenuThread(thread ?? null);
        }}
        onDismiss={
          thread || selectedCards
            ? undefined
            : dismissFailure
              ? () => void runAction(item.run!.id, "dismiss", source)
              : (filter === "done" && item.done_card_key) ||
                  (filter === "replies" && item.reply_card_key)
                ? () => void dismissFeedCard(item)
                : undefined
        }
        dismissLabel={
          dismissFailure
            ? "Dismiss from Needs you"
            : item.reply
              ? "Archive reply"
              : undefined
        }
        onLater={() => setLater(item)}
      />
    );
  }
  // Approvals and native decisions from this workspace have their own cards
  // in the stack (needsSlot); other threads waiting on you show as threads.
  // A stopped run must stay visible even if a cached source snapshot reports
  // a stale approval as its next action. Its approval card cannot be answered.
  const needsThreads = needs.filter(
    (item) =>
      !(
        needsSlot &&
        item.run?.state === "awaiting_approval" &&
        (item.sourceId ?? scopedSource) === scopedSource &&
        (item.next_action?.kind === "approve" ||
          item.next_action?.kind === "answer")
      ),
  );
  const counts: Partial<Record<FeedFilter, number>> = summary
    ? {
        working: summary.working,
        queued: summary.queued,
        replies: summary.replies_unread,
        done: summary.done_unread,
      }
    : {};
  function selectFilter(nextFilter: FeedFilter) {
    setNeedsOpen(false);
    onFilter(nextFilter);
  }
  return (
    <section className="feed-view" aria-label="Feed">
      {!hideFilters && (
        <AwaySummary
          sources={allSources}
          onFilter={selectFilter}
          onNeeds={() => setNeedsOpen(true)}
          onOpen={(id, source) => onOpen(id, undefined, source)}
        />
      )}
      {header}
      {!hideFilters && (
        <NeedsStack open={needsOpen} onOpen={setNeedsOpen}>
          {needsSlot}
          {!!needsThreads.length && (
            <ul className="feed-list feed">
              {needsThreads.map((item) => card(item, true))}
            </ul>
          )}
          {needsOpen && !!summary?.scheduled_failed && onScheduled && (
            <p className="scheduled-summary" role="status">
              <strong>
                {summary.scheduled_failed} scheduled{" "}
                {summary.scheduled_failed === 1 ? "message" : "messages"} not
                sent
              </strong>
              {!!summary.scheduled_pending && (
                <span>
                  {" "}
                  · {summary.scheduled_pending} still waiting to send
                </span>
              )}
              <button
                type="button"
                className="text-button"
                onClick={onScheduled}
              >
                Open Scheduled
              </button>
            </p>
          )}
        </NeedsStack>
      )}
      {!hideFilters && (
        <div className="chip-row feed-tabs" role="tablist" aria-label="Show">
          {feedCategories.map((f) => (
            <button
              key={f.id}
              role="tab"
              type="button"
              aria-selected={!needsOpen && filter === f.id}
              className="chip"
              data-filter={f.id}
              onClick={() => selectFilter(f.id)}
            >
              {f.label}
              {!!counts[f.id] && (
                <span className="chip-count">{counts[f.id]}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <CollectionReadNotice
        error={readError}
        busy={readBusy}
        retry={retryRead}
      />
      {error && (
        <div className="error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError("");
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="field-hint">
          {notice}
        </p>
      )}
      {grouping.error && (
        <p className="error" role="alert">
          {grouping.error}
          <button onClick={grouping.refresh}>Retry</button>
        </p>
      )}
      {mailThreads.error && (
        <p className="error" role="alert">
          {mailThreads.error}
          <button onClick={mailThreads.refresh}>Retry agent threads</button>
        </p>
      )}
      {selectedCards && (
        <div
          className="done-selection-bar"
          role="region"
          aria-label="Selected cards"
        >
          <strong>{selectedCards.length} selected</strong>
          <button
            disabled={bulkReadBusy || !selectedCards.length}
            onClick={() => void markSelectedRead(false)}
          >
            Mark read
          </button>
          <button
            disabled={bulkReadBusy || !selectedCards.length}
            onClick={() => void markSelectedRead(true)}
          >
            Mark unread
          </button>
          <button
            className="primary"
            disabled={bulkReadBusy || !selectedCards.length}
            onClick={() => organizeSelection(selectedCards)}
          >
            Move to…
          </button>
          <button
            disabled={bulkReadBusy}
            onClick={() => setSelectedCards(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {/* Keep the selected feed mounted so collapsing Needs you restores it. */}
      <div className="feed-results" hidden={needsOpen}>
        {!hideFilters && filter === "done" && (
          <DoneFeedFilters
            read={selection.read}
            agent={selectedAgent ? selection.agent : ""}
            agents={doneAgents}
            source={scopedSource}
            onRead={(read) => setDoneSelection({ ...selection, read })}
            onAgent={(agent) => setDoneSelection({ ...selection, agent })}
            onClear={clearDoneFilters}
          />
        )}
        <>
          {(loading ||
            partialReadPending ||
            mailThreads.loading ||
            (combined && sourcesLoading)) &&
          !feedRows.length ? (
            <div
              className="feed-loading"
              role="status"
              aria-label="Loading feed"
            >
              <span />
              <span />
              <span />
            </div>
          ) : feedRows.length ? (
            <ul className="feed-list feed">
              {feedRows.map((row) =>
                row.kind === "card" ? (
                  card(row.card.item, false, row.card.thread)
                ) : (
                  <AgentThreadCard
                    key={row.key}
                    thread={row.thread}
                    environment={
                      row.thread.source
                        ? activeSources.find(
                            (source) => source.id === row.thread.source,
                          )?.name
                        : undefined
                    }
                    onOpen={() => setReadingMail({ ...row.thread, generation })}
                  />
                ),
              )}
            </ul>
          ) : (
            !error &&
            !readError && (
              <div className="feed-empty">
                <p>
                  <strong>
                    {doneFiltered
                      ? "No results match these filters."
                      : filter === "all"
                        ? "Nothing here yet."
                        : filter === "threads"
                          ? "No threads yet."
                          : filter === "done"
                            ? "Nothing finished yet."
                            : filter === "replies"
                              ? "Replies to messages you send during a task will appear here."
                              : filter === "working"
                                ? "No agents are working right now."
                                : filter === "outcomes"
                                  ? "No finished work here yet."
                                  : filter === "unfinished"
                                    ? "Nothing unfinished here."
                                    : "Nothing is queued."}
                  </strong>
                </p>
                {!doneFiltered &&
                  ["all", "done", "threads"].includes(filter) &&
                  emptyAction}
              </div>
            )
          )}
          {(next || mailThreads.hasMore) && (
            <button
              className="secondary load-more"
              onClick={() => {
                if (next) void load(true);
                if (mailThreads.hasMore) mailThreads.loadMore();
              }}
            >
              Load more
            </button>
          )}
        </>
      </div>
      {menu &&
        (menuThread || (filter === "done" && menu.done_card_key) ? (
          <DoneCardMenu
            title={menuThread?.title ?? menu.title}
            subtitle={[
              menu.agent_name && `@${menu.agent_name}`,
              menu.project_name,
            ]
              .filter(Boolean)
              .join(" · ")}
            threadCount={menuThread?.cardIds.length}
            actions={actionsFor(menu, menuThread)}
            onClose={() => setMenu(null)}
          />
        ) : (
          <ActionSheet
            title={menu.title}
            onClose={() => setMenu(null)}
            actions={actionsFor(menu, menuThread)}
          >
            {!menuThread && menu.run && (
              <p className="field-hint">
                {runStatus(menu.run.state, menu.pending_approvals).label} ·{" "}
                {runTiming(menu.run)}
              </p>
            )}
          </ActionSheet>
        ))}
      {combineFrom && (
        <DoneCardPicker
          onClose={() => setCombineFrom(null)}
          actions={visibleCards
            .filter((row) => row.key !== combineFrom && aggregatable(row.item))
            .map((row) => ({
              id: row.key,
              label: row.thread?.title ?? row.item.title,
              hint: row.thread
                ? `${row.thread.cardIds.length} cards`
                : (row.item.agent_name ?? undefined),
              icon: <Layers size={20} />,
              onSelect: () => combineCards(combineFrom, row.key),
            }))}
        />
      )}
      {aggregate && (
        <OrganizeCards
          selection={aggregate}
          threads={grouping.threads}
          onClose={() => setAggregate(null)}
          onDone={() => {
            grouping.refresh();
            setSelectedCards(null);
          }}
        />
      )}
      {readingThread?.generation === generation && (
        <DoneThreadReader
          key={JSON.stringify([
            generation,
            readingThread.source,
            readingThread.id,
          ])}
          thread={readingThread}
          onClose={() => setReadingThread(null)}
          onOpen={onOpen}
          onChanged={grouping.refresh}
        />
      )}
      {readingMail?.generation === generation && (
        <AgentThreadReader
          key={JSON.stringify([generation, readingMail.source, readingMail.id])}
          thread={readingMail}
          onClose={() => setReadingMail(null)}
          onOpen={onOpen}
        />
      )}
      {later && (
        <LaterSheet
          kind={reminderMessage ? "message" : "conversation"}
          targetId={reminderMessage?.id ?? later.conversation_id}
          sourceId={later.sourceId ?? scopedSource}
          title={later.title}
          running={PENDING_RUN_DISPLAY_STATES.includes(later.run?.state || "")}
          project={
            later.project_id && later.project_name
              ? { id: later.project_id, name: later.project_name }
              : undefined
          }
          onClose={() => setLater(null)}
          onDone={(label, created) => {
            notify({
              text: `Reminder set: ${label.toLowerCase()}.`,
              link:
                onShowReminder &&
                (later.sourceId ?? scopedSource) === scopedSource
                  ? {
                      label: "View",
                      onSelect: () => onShowReminder(created.id),
                    }
                  : undefined,
              undo: async () => {
                await undoReminder(created, later.sourceId ?? scopedSource);
                void load();
              },
            });
            void load();
          }}
        />
      )}
      {editing && (
        <EditQueued
          message={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            onChanged();
            void load();
          }}
        />
      )}
      {moving && (
        <MoveQueued
          message={moving}
          agents={agents}
          onClose={() => setMoving(null)}
          onMoved={(conversation) => {
            onChanged();
            void load();
            if (conversation)
              onOpen(conversation, undefined, moving.sourceId ?? scopedSource);
          }}
        />
      )}
    </section>
  );
}
