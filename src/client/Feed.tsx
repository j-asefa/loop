import { useSourceApi, useSourceId } from "./SourceContext";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { automationLabel } from "../shared/agent-mail";
import {
  AlarmClock,
  Archive,
  ArrowDown,
  Bookmark,
  BookmarkCheck,
  ArrowUpRight,
  MoreHorizontal,
  ArrowUp,
  FileText,
  Container,
  Laptop,
  MessageCircleQuestion,
  MessageSquare,
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
import { apiInWorkspace } from "./api";
import { CheckoutChip, CheckoutSheet } from "./Checkout";
import { VerificationChip, VerificationSheet } from "./Verification";
import type { CheckoutSummary } from "../shared/checkout";
import type { VerificationSummary } from "../shared/verification";
import { sourceUrl } from "./sourceRouting";
import type {
  EnvironmentAgent,
  EnvironmentConnection,
  AgentSource,
} from "./agentSources";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { Avatar, RichText, Sheet } from "./components";
import {
  agentModelName,
  connectionLocation,
  runModelName,
  type ExecutionLocation,
} from "./modelChoices";
import type { Agent, Connection } from "../shared/types";
import {
  ActionSheet,
  Chip,
  LaterSheet,
  undoReminder,
  useLongPress,
  useSwipe,
  type Action,
} from "./ThreadTools";
import { shareLink } from "./Handoff";
import { threadDraft, sourceDraftId } from "./drafts";
import { Social } from "./Social";
import {
  feedNextAction,
  preview,
  relativeTime,
  runStatus,
  runTiming,
  type FeedNextAction,
} from "./threadView";
import { notify } from "./toast";

export type FeedFilter =
  | "all"
  | "done"
  | "working"
  | "queued"
  // Stories from the public feeds you added, not threads.
  | "social"
  // Project history views (no chip of their own).
  | "outcomes"
  | "unfinished";

export type FeedItem = {
  sourceId?: string;
  executionEnvironment?: string;
  conversation_id: string;
  done_card_key?: string;
  title: string;
  agent_id: string | null;
  connection_id: string | null;
  agent_name: string | null;
  provider: string | null;
  project_id: string | null;
  project_name: string | null;
  team_id: string | null;
  origin: string;
  last_activity_at: number;
  last_message: {
    id: string;
    role: string;
    preview: string;
    content?: string;
    created_at: number;
    automation?: string;
    automation_from?: string;
    /** In Later → Saved, itself or through its result card. */
    saved?: boolean;
  } | null;
  run: {
    id: string;
    state: string;
    error: string | null;
    input: string;
    connection_id: string | null;
    automation?: string;
    automation_from?: string | null;
    model: string | null;
    resolved_model: string | null;
    created_at: number;
    updated_at: number;
    queue_position: number | null;
    can_move_up?: boolean;
    can_move_down?: boolean;
    /** What Loop observed in the agent's worktree; null for API agents. */
    checkout?: CheckoutSummary | null;
    /** Test, type-check and lint commands Loop observed, with their exits. */
    verification?: VerificationSummary | null;
  } | null;
  queued_runs?: {
    id: string;
    input: string;
    created_at: number;
    queue_position: number | null;
    can_edit: boolean;
    can_move_up: boolean;
    can_move_down: boolean;
  }[];
  /** What a working agent has written so far. */
  live_preview?: string | null;
  pending_approvals: number;
  position_message_id: string | null;
  later: {
    id: string;
    due_at: number | null;
    condition: string;
    surfaced_at: number | null;
  } | null;
  /** The specific thing this thread waits for, and the message holding it. */
  next_action?: {
    kind: "approve" | "answer" | "result";
    message_id: string | null;
    run_id: string;
  } | null;
};
type Summary = {
  needs: number;
  working: number;
  queued: number;
  later_due: number;
  scheduled_failed?: number;
  scheduled_pending?: number;
  social_unread?: number;
};
type Brief = {
  sourceId?: string;
  conversation_id: string;
  title: string;
  agent_name: string | null;
  run_id: string;
  state: string;
  updated_at: number;
};

export const feedFilters: { id: FeedFilter; label: string }[] = [
  // Done holds only threads with nothing open; open work has its own chip.
  // What needs you has no chip: it stacks above the row (NeedsStack).
  { id: "done", label: "Done" },
  { id: "working", label: "Working" },
  { id: "queued", label: "Queued" },
  { id: "social", label: "Social" },
];

const isSocial = (filter: FeedFilter) => filter === "social";

const LAST_VISIT = "loop-last-visit";
const AWAY_AFTER = 30 * 60_000;

/**
 * A thread in the Feed, shown at the same size as a result card: agent
 * byline, status and project, the thread title and the latest message.
 */
// Run states whose prompt the Feed hides until the agent writes something.
const awaitingStates = ["running", "pausing", "waiting_children"];
const terminalStates = ["completed", "failed", "interrupted", "cancelled"];
function FeedCard({
  item,
  agent,
  model,
  environment,
  onOpen,
  onReply,
  onNext,
  onAgent,
  onMenu,
  onDismiss,
  dismissLabel = "Remove from Done",
  onLater,
  onCheckout,
  onVerification,
}: {
  item: FeedItem;
  agent?: EnvironmentAgent;
  model?: string;
  environment?: { kind: ExecutionLocation | null; label: string } | null;
  onOpen: () => void;
  onReply: () => void;
  /** Open exactly where the next action is. */
  onNext: (action: FeedNextAction) => void;
  onAgent?: () => void;
  onMenu: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  onLater: () => void;
  /** Open the checkout Loop observed for the card's run. */
  onCheckout?: () => void;
  /** Open the verification Loop observed for the card's run. */
  onVerification?: () => void;
}) {
  const scopedSource = useSourceId();
  const swipe = useSwipe({ onLeft: onDismiss });
  const press = useLongPress(onMenu);
  const status = runStatus(item.run?.state, item.pending_approvals);
  const merged = (name: string) => (e: any) => {
    (swipe.handlers as any)[name]?.(e);
    (press as any)[name]?.(e);
  };
  const draft = threadDraft(sourceDraftId(item.conversation_id, item.sourceId ?? scopedSource)).text;
  const next = feedNextAction(item.next_action, draft);
  const detail =
    status.tone === "working" && item.run
      ? runTiming(item.run)
      : status.tone === "queued" && item.run
        ? `${item.run.queue_position ? `#${item.run.queue_position} in queue · ` : ""}${runTiming(item.run)}`
        : status.tone === "failed" && item.run?.error
          ? item.run.error
          : "";
  const name = item.agent_name || agent?.name;
  return (
    <li
      className={
        "card-swipe inbox-card-wrap" +
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
        className="feed-card inbox-card"
        style={
          swipe.offset
            ? { transform: `translateX(${swipe.offset}px)` }
            : undefined
        }
        onPointerDown={merged("onPointerDown")}
        onPointerMove={merged("onPointerMove")}
        onPointerUp={merged("onPointerUp")}
        onPointerCancel={merged("onPointerCancel")}
        onPointerLeave={(press as any).onPointerLeave}
        onContextMenu={(press as any).onContextMenu}
        onClickCapture={merged("onClickCapture")}
      >
        <div className="card-byline">
          <button className="identity" disabled={!onAgent} onClick={onAgent}>
            <span className="inbox-avatar">
              <Avatar
                name={name || "Loop"}
                provider={(item.provider || agent?.provider) as any}
              />
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
          className="card-content inbox-row"
          role="button"
          tabIndex={0}
          aria-label={`${item.title}${status.label ? `, ${status.label}` : ""}`}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("a,button,summary,input"))
              onOpen();
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (["Enter", " "].includes(e.key)) {
              e.preventDefault();
              onOpen();
            }
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              onMenu();
            }
          }}
        >
          <span className="eyebrow inbox-eyebrow">
            {status.label && status.tone !== "done" ? (
              <Chip tone={status.tone}>{status.label}</Chip>
            ) : (
              "Thread"
            )}
            <span className="card-project">
              {" "}
              · {item.project_name || "Unfiled"}
            </span>
          </span>
          <h2>{item.title}</h2>
          {detail && <p className="field-hint inbox-detail">{detail}</p>}
          {item.run?.checkout && onCheckout && (
            <>
              <CheckoutChip summary={item.run.checkout} onOpen={onCheckout} />
              {(item.run.verification || terminalStates.includes(item.run.state)) && (
                <VerificationChip
                  summary={item.run.verification ?? null}
                  onOpen={item.run.verification ? onVerification : undefined}
                />
              )}
            </>
          )}
          {item.live_preview ? (
            // A working agent's output so far, as on the old Running cards.
            <div className="preview live-preview">
              <RichText content={item.live_preview} compact />
            </div>
          ) : item.run &&
            awaitingStates.includes(item.run.state) &&
            item.last_message?.role !== "assistant" ? (
            // The server hides the prompt while its run works; say whether
            // the agent has written anything yet, and who started the work.
            <p className="field-hint inbox-detail inbox-awaiting-update">
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
                  <span className="inbox-you">
                    {automationLabel(
                      item.last_message!.automation,
                      item.last_message!.automation_from,
                    )}
                  </span>
                )}
                <RichText
                  content={
                    item.last_message!.content ?? item.last_message!.preview
                  }
                  compact
                />
              </div>
            )
          )}
          {!!(item.last_message || item.run) && (
            <button className="text-button preview-open" onClick={onOpen}>
              Open thread <ArrowUpRight size={14} />
            </button>
          )}
          {draft && (
            <p className="inbox-draft">
              <em className="draft-label">Draft:</em> {preview(draft, 120)}
            </p>
          )}
        </div>
        <div className="card-actions">
          {next && (
            <button
              className="next-action"
              data-kind={next.kind}
              onClick={() => onNext(next)}
            >
              {nextIcon[next.kind]}
              {next.label}
            </button>
          )}
          {next?.kind !== "draft" && (
            <button onClick={onReply}>
              <MessageSquare size={16} />
              Reply
            </button>
          )}
          <button onClick={onLater}>
            <AlarmClock size={16} />
            Remind me
          </button>
        </div>
      </article>
    </li>
  );
}

const nextIcon = {
  approve: <ShieldCheck size={16} />,
  answer: <MessageCircleQuestion size={16} />,
  result: <FileText size={16} />,
  draft: <PencilLine size={16} />,
};

/** "While you were away": what finished, failed or needs you since the last visit. */
function AwaySummary({
  onFilter,
  onNeeds,
  onOpen,
  sources,
}: {
  onFilter: (filter: FeedFilter) => void;
  /** Show everything waiting on you (the expanded NeedsStack). */
  onNeeds: () => void;
  onOpen: (conversation: string, sourceId: string) => void;
  sources: AgentSource[];
}) {
  const [away, setAway] = useState<{
    completed: Brief[];
    needs: Brief[];
    failed: Brief[];
  } | null>(null);
  const previousVisit = useRef<number | null>(null);
  const sourceKey = sources.map((source) => source.id).join(",");
  useEffect(() => {
    if (previousVisit.current === null) {
      try {
        previousVisit.current = Number(localStorage.getItem(LAST_VISIT) || 0);
      } catch {
        previousVisit.current = 0;
      }
    }
    const since = previousVisit.current;
    const record = () => {
      try {
        localStorage.setItem(LAST_VISIT, String(Date.now()));
      } catch {}
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
          result: await apiInWorkspace<{
            completed: Brief[];
            needs: Brief[];
            failed: Brief[];
          }>("/feed/away?since=" + since, source.id),
        })),
      ).then((settled) => {
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
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", record);
    };
  }, [sourceKey]);
  if (!away) return null;
  const parts = [
    away.completed.length && `${away.completed.length} finished`,
    away.needs.length && `${away.needs.length} need you`,
    away.failed.length && `${away.failed.length} failed`,
  ].filter(Boolean);
  // A summary only: the threads themselves are the full cards below. One
  // thread opens directly; several show where they wait. Failed runs wait in
  // the Needs you stack.
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
    // The card leaves, so bring the threads it summarized into view.
    requestAnimationFrame(() =>
      document
        .querySelector(attention ? ".needs-stack" : ".inbox-filters")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  return (
    <section className="away-card" aria-label="While you were away">
      <div className="away-head">
        <button type="button" className="away-toggle" onClick={show}>
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
            await apiInWorkspace(
              "/runs/" + message.id,
              message.sourceId ?? scopedSource,
              { input: text },
              "PATCH",
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
            const result = await apiInWorkspace<{ conversation_id: string }>(
              `/runs/${message.id}/move`,
              message.sourceId ?? scopedSource,
              {
                agentId,
                idempotencyKey: key.current,
              },
            );
            onMoved(result.conversation_id);
            onClose();
          } catch (e) {
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
  ".approval-card, .native-decision, .scheduled-message, .inbox-card-wrap";

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
  // Acting on the last cards folds the list back into a stack.
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
  agent,
  onScheduled,
  onShowReminder,
  onAsk,
  sources,
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
  onReply?: (conversation: string, sourceId?: string) => void;
  agent?: string;
  /** Open Later → Scheduled. */
  onScheduled?: () => void;
  /** Open Later → Reminders at one reminder. */
  onShowReminder?: (id: string) => void;
  /** Start a new message with this text (a news card's "Ask an agent"). */
  onAsk?: (text: string) => void;
  /** Present only for the combined top-level Feed. */
  sources?: AgentSource[];
}) {
  const api = useSourceApi();
  const scopedSource = useSourceId();
  type Shown = { items: FeedItem[]; next: string | null; summary: Summary };
  const activeSources =
    sources && !project && !teams && !agent
      ? sources
      : [{ id: scopedSource, name: "" }];
  const sourceKey = JSON.stringify(
    activeSources.map((source) => source.id).sort(),
  );
  const shownKey = () =>
    "feed:" + JSON.stringify([filter, project, agent, teams, sourceKey]);
  // Going back shows the list as you left it while it refreshes.
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
  // One badge per card. A linked Docker server is Docker by definition;
  // on the laptop source, the connection's recorded location decides.
  const cardEnvironment = (
    source: string,
    connectionId: string | null,
    label: string | undefined,
  ) => {
    const recorded = environments.get(`${source}:${connectionId}`);
    const kind: ExecutionLocation | null = source.startsWith("docker:")
      ? "docker"
      : (recorded?.kind ?? null);
    const text =
      kind && !source ? recorded?.label : label || null;
    return text ? { kind, label: text } : null;
  };
  const [items, setItems] = useState<FeedItem[]>(shown?.items || []);
  const [summary, setSummary] = useState<Summary | null>(
    shown?.summary || null,
  );
  const [next, setNext] = useState<string | null>(shown?.next || null);
  const [loading, setLoading] = useState(!shown);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<FeedItem | null>(null);
  const [later, setLater] = useState<FeedItem | null>(null);
  const [checkout, setCheckout] = useState<{
    runId: string;
    sourceId: string;
  } | null>(null);
  const [verification, setVerification] = useState<{
    runId: string;
    sourceId: string;
  } | null>(null);
  const [editing, setEditing] = useState<QueuedMessage | null>(null);
  const [moving, setMoving] = useState<QueuedMessage | null>(null);
  // Threads waiting on you, whichever filter is shown, for the stack above
  // the filters.
  const needsKey = () =>
    "feed-needs:" + JSON.stringify([project, agent, teams, sourceKey]);
  const [needs, setNeeds] = useState<FeedItem[]>(
    () => cachedView<FeedItem[]>(needsKey()) || [],
  );
  const [needsOpen, setNeedsOpen] = useState(false);
  const needsRequest = useRef(0);
  const request = useRef(0);
  const query = (before?: string, which: string = filter) => {
    const q = new URLSearchParams({
      // Social is not a thread filter; the request only keeps the chip
      // counts current, from the smallest list.
      filter: isSocial(which as FeedFilter) ? "needs" : which,
    });
    if (project) q.set("folder", project);
    if (agent) q.set("agent", agent);
    if (teams) q.set("teams", teams);
    if (before) q.set("before", before);
    return "/feed?" + q;
  };
  const inFlight = useRef(false);
  const sourcePages = useRef<{ key: string; pages: Map<string, Shown> }>({
    key: "",
    pages: new Map(),
  });
  async function loadNeeds() {
    if (hideFilters) return;
    const ticket = ++needsRequest.current;
    const owner = viewOwner();
    const key = needsKey();
    const combined = !!sources && !project && !teams && !agent;
    const settled = await Promise.allSettled(
      activeSources.map(async (source) => {
        const page = combined
          ? await apiInWorkspace<{ items: FeedItem[] }>(
              query(undefined, "needs"),
              source.id,
            )
          : await api<{ items: FeedItem[] }>(query(undefined, "needs"));
        return combined
          ? page.items.map((item) => ({
              ...item,
              sourceId: source.id,
              executionEnvironment: source.id ? source.name : undefined,
            }))
          : page.items;
      }),
    );
    if (ticket !== needsRequest.current || owner !== viewOwner()) return;
    // The Feed's own error covers an unreachable source; keep what loaded.
    if (settled.every((entry) => entry.status === "rejected")) return;
    const loaded = settled
      .flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))
      .sort((a, b) => b.last_activity_at - a.last_activity_at);
    cacheView(key, loaded, owner);
    setNeeds(loaded);
  }
  async function load(append = false, background = false) {
    if (!append) void loadNeeds();
    // Background refreshes never overlap; filter changes and actions always load.
    if (background && inFlight.current) return;
    inFlight.current = true;
    const ticket = ++request.current;
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    // Loading placeholders belong to the first read of a filter. An empty
    // result is loaded content too; polling must keep its empty state visible.
    try {
      type Page = { items: FeedItem[]; next: string | null; summary: Summary };
      let result: Page;
      let partialError = "";
      if (sources && !project && !teams && !agent) {
        const cursors: Record<string, string> =
          append && next ? JSON.parse(next) : {};
        const pending = append
          ? activeSources.filter((source) => cursors[source.id])
          : activeSources;
        const settled = await Promise.allSettled(
          pending.map(async (source) => ({
            source,
            page: await apiInWorkspace<Page>(
              query(append ? cursors[source.id] : undefined),
              source.id,
            ),
          })),
        );
        if (ticket !== request.current || owner !== viewOwner()) return;
        const loaded = settled.flatMap((entry) =>
          entry.status === "fulfilled" ? [entry.value] : [],
        );
        if (!loaded.length && settled.length)
          throw new Error("Couldn’t load the Feed from any environment.");
        partialError = settled.some((entry) => entry.status === "rejected")
          ? "Some environments could not refresh. Showing their last loaded threads."
          : "";
        if (!append) {
          const key = JSON.stringify([owner, shownKey()]);
          if (sourcePages.current.key !== key)
            sourcePages.current = { key, pages: new Map() };
          for (const { source, page } of loaded)
            sourcePages.current.pages.set(source.id, page);
          settled.forEach((entry, index) => {
            const source = pending[index];
            const previous = sourcePages.current.pages.get(source.id);
            if (entry.status === "rejected" && previous)
              loaded.push({ source, page: previous });
          });
        }
        const nextCursors: Record<string, string> = append
          ? { ...cursors }
          : {};
        for (const { source, page } of loaded) {
          if (page.next) nextCursors[source.id] = page.next;
          else delete nextCursors[source.id];
        }
        result = {
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
          summary: loaded.reduce(
            (sum, { page }) => ({
              needs: sum.needs + page.summary.needs,
              working: sum.working + page.summary.working,
              queued: sum.queued + page.summary.queued,
              later_due: sum.later_due + page.summary.later_due,
              scheduled_failed:
                (sum.scheduled_failed || 0) +
                (page.summary.scheduled_failed || 0),
              scheduled_pending:
                (sum.scheduled_pending || 0) +
                (page.summary.scheduled_pending || 0),
              // Social feeds belong to the paired app, so the count is one
              // workspace's, not the sum of every source's.
              social_unread: Math.max(
                sum.social_unread || 0,
                page.summary.social_unread || 0,
              ),
            }),
            { needs: 0, working: 0, queued: 0, later_due: 0 } as Summary,
          ),
        };
      } else {
        result = await api<Page>(query(append ? next || undefined : undefined));
      }
      if (ticket !== request.current || owner !== viewOwner()) return;
      const key = shownKey();
      setItems((old) => {
        const merged = append
          ? [
              ...old,
              ...result.items.filter(
                (item) =>
                  !old.some(
                    (o) =>
                      o.conversation_id === item.conversation_id &&
                      (o.sourceId || "") === (item.sourceId || ""),
                  ),
              ),
            ]
          : result.items;
        if (sources)
          merged.sort(
            (a, b) =>
              b.last_activity_at - a.last_activity_at ||
              `${a.sourceId}:${a.conversation_id}`.localeCompare(
                `${b.sourceId}:${b.conversation_id}`,
              ),
          );
        cacheView<Shown>(
          key,
          { items: merged, next: result.next, summary: result.summary },
          owner,
        );
        return merged;
      });
      setNext(result.next);
      if (!append) setSummary(result.summary);
      setError(partialError);
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    } finally {
      if (ticket === request.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }
  const firstLoad = useRef(true);
  useEffect(() => {
    setNeedsOpen(false);
    const cached = cachedView<Shown>(shownKey());
    // The first render already shows the cached list; a filter change swaps
    // to that filter's cached list, or a loader.
    if (!firstLoad.current) {
      setItems(cached?.items || []);
      setNext(cached?.next || null);
      setSummary(cached?.summary || null);
      setNeeds(cachedView<FeedItem[]>(needsKey()) || []);
      setLoading(!cached);
    }
    firstLoad.current = false;
    void load();
  }, [filter, project, teams, agent, sourceKey]);
  useEffect(() => {
    void load(false, true);
  }, [revision]);
  useEffect(() => {
    // Explicit refreshes supersede an older read: dropping one while polling
    // is in flight can leave a completed action or connection retry unseen.
    // The request ticket prevents the older response from replacing this one.
    const update = () => void load();
    window.addEventListener("loop-later-change", update);
    // Reading a story changes the Social chip's count.
    window.addEventListener("loop-social-read", update);
    // "Retry connection" asks every source-backed view to reload now.
    window.addEventListener("loop-source-refresh", update);
    // Workspace events already bump `revision`; this is only a fallback.
    const timer = setInterval(() => void load(false, true), 30_000);
    return () => {
      window.removeEventListener("loop-later-change", update);
      window.removeEventListener("loop-social-read", update);
      window.removeEventListener("loop-source-refresh", update);
      clearInterval(timer);
    };
    // Re-arm with every input `load` reads, so the fallback refresh never
    // replaces the Feed using a stale filter or source list.
  }, [filter, project, teams, agent, sourceKey]);
  async function runAction(
    runId: string,
    action: string,
    sourceId: string,
    body = {},
  ) {
    const owner = viewOwner();
    try {
      await apiInWorkspace(`/runs/${runId}/${action}`, sourceId, body);
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
  async function dismissDoneCard(item: FeedItem) {
    if (filter !== "done" || !item.done_card_key) return;
    try {
      const source = item.sourceId ?? scopedSource;
      await apiInWorkspace(
        `/feed/${item.conversation_id}`,
        source,
        { hidden: true, cardKey: item.done_card_key },
        "PATCH",
      );
      setItems((old) =>
        old.filter(
          (row) =>
            row.conversation_id !== item.conversation_id ||
            (row.sourceId || "") !== (item.sourceId || "") ||
            row.done_card_key !== item.done_card_key,
        ),
      );
      notify({
        text: "Removed from Done.",
        undo: async () => {
          await apiInWorkspace(
            `/feed/${item.conversation_id}`,
            source,
            { hidden: false, cardKey: item.done_card_key },
            "PATCH",
          );
          await load();
        },
      });
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function markSaved(item: FeedItem, saved: boolean) {
    setItems((old) =>
      old.map((row) =>
        row.conversation_id === item.conversation_id &&
        (row.sourceId || "") === (item.sourceId || "") &&
        row.last_message
          ? { ...row, last_message: { ...row.last_message, saved } }
          : row,
      ),
    );
  }
  async function setSavedOnServer(
    item: FeedItem,
    messageId: string,
    saved: boolean,
  ) {
    await apiInWorkspace(
      `/messages/${messageId}/saved`,
      item.sourceId ?? scopedSource,
      saved ? {} : undefined,
      saved ? "POST" : "DELETE",
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
    const saved = !!message.saved;
    markSaved(item, !saved);
    if (saved) {
      notify({
        text: "Removed from Saved.",
        undo: () => markSaved(item, true),
        onExpire: () =>
          void setSavedOnServer(item, message.id, false).catch((e) => {
            markSaved(item, true);
            setError((e as Error).message);
          }),
      });
      return;
    }
    try {
      await setSavedOnServer(item, message.id, true);
      notify({
        text: "Saved. Find it in Later → Saved.",
        undo: async () => {
          await setSavedOnServer(item, message.id, false);
          markSaved(item, false);
        },
      });
    } catch (e) {
      markSaved(item, false);
      setError((e as Error).message);
    }
  }
  function actionsFor(item: FeedItem): Action[] {
    const agent = agents.find(
      (a) =>
        a.id === item.agent_id &&
        (a.sourceId || "") === (item.sourceId ?? scopedSource),
    );
    const source = item.sourceId ?? scopedSource;
    const state = item.run?.state || "";
    const actions: Action[] = [
      // Nothing written yet is nothing to keep.
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
    if (
      state &&
      !["completed", "failed", "cancelled", "interrupted"].includes(state)
    )
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
  function card(item: FeedItem, inNeeds = false) {
    const source = item.sourceId ?? scopedSource;
    const dismissFailure =
      inNeeds && item.run &&
      ["failed", "interrupted"].includes(item.run.state);
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
        key={`${source}:${item.conversation_id}`}
        item={item}
        agent={agent}
        model={model}
        environment={cardEnvironment(
          source,
          connectionId,
          agent?.executionEnvironment || item.executionEnvironment,
        )}
        onOpen={() => onOpen(item.conversation_id, undefined, source)}
        onReply={() =>
          onReply
            ? onReply(item.conversation_id, source)
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
        onMenu={() => setMenu(item)}
        onDismiss={
          dismissFailure
            ? () => void runAction(item.run!.id, "dismiss", source)
            : filter === "done" && item.done_card_key
              ? () => void dismissDoneCard(item)
              : undefined
        }
        dismissLabel={dismissFailure ? "Dismiss from Needs you" : undefined}
        onLater={() => setLater(item)}
        onCheckout={
          item.run?.checkout
            ? () => setCheckout({ runId: item.run!.id, sourceId: source })
            : undefined
        }
        onVerification={() =>
          setVerification({ runId: item.run!.id, sourceId: source })
        }
      />
    );
  }
  // Approvals and native decisions from this workspace have their own cards
  // in the stack (needsSlot); other threads waiting on you show as threads.
  const needsThreads = needs.filter(
    (item) =>
      !(
        needsSlot &&
        (item.sourceId ?? scopedSource) === scopedSource &&
        (item.next_action?.kind === "approve" ||
          item.next_action?.kind === "answer")
      ),
  );
  const counts: Partial<Record<FeedFilter, number>> = summary
    ? {
        working: summary.working,
        queued: summary.queued,
        social: summary.social_unread,
      }
    : {};
  function selectFilter(nextFilter: FeedFilter) {
    setNeedsOpen(false);
    onFilter(nextFilter);
  }
  return (
    <section className="inbox" aria-label="Feed">
      {!hideFilters && (
        <AwaySummary
          sources={activeSources}
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
            <ul className="inbox-list feed">
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
        <div
          className="chip-row inbox-filters"
          role="tablist"
          aria-label="Show"
        >
          {feedFilters.map((f) => (
            <button
              key={f.id}
              role="tab"
              type="button"
              aria-selected={!needsOpen && filter === f.id}
              className="chip"
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
      {(!isSocial(filter) || needsOpen) && error && (
        <div className="error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {(!isSocial(filter) || needsOpen) && notice && (
        <p role="status" className="field-hint">
          {notice}
        </p>
      )}
      {/* Keep the selected feed mounted so collapsing Needs you restores it. */}
      <div className="inbox-results" hidden={needsOpen}>
        {isSocial(filter) ? (
          <Social onAsk={onAsk} agents={agents} />
        ) : (
          <>
            {loading && !items.length ? (
              <div
                className="feed-loading"
                role="status"
                aria-label="Loading feed"
              >
                <span />
                <span />
                <span />
              </div>
            ) : items.length ? (
              <ul className="inbox-list feed">{items.map((item) => card(item))}</ul>
            ) : (
              !error && (
                <div className="inbox-empty">
                  <p>
                    <strong>
                      {filter === "all"
                        ? "Nothing here yet."
                        : filter === "done"
                          ? "Nothing finished yet."
                          : filter === "working"
                            ? "No agents are working right now."
                            : filter === "outcomes"
                              ? "No finished work here yet."
                              : filter === "unfinished"
                                ? "Nothing unfinished here."
                                : "Nothing is queued."}
                    </strong>
                  </p>
                  {(filter === "all" || filter === "done") && emptyAction}
                </div>
              )
            )}
            {next && (
              <button
                className="secondary load-more"
                onClick={() => void load(true)}
              >
                Load more
              </button>
            )}
          </>
        )}
      </div>
      {verification && (
        <VerificationSheet
          runId={verification.runId}
          load={(runId) =>
            apiInWorkspace(`/runs/${runId}/verifications`, verification.sourceId)
          }
          onClose={() => setVerification(null)}
        />
      )}
      {checkout && (
        <CheckoutSheet
          runId={checkout.runId}
          load={(runId) =>
            apiInWorkspace(`/runs/${runId}/checkout`, checkout.sourceId)
          }
          onClose={() => setCheckout(null)}
        />
      )}
      {menu && (
        <ActionSheet
          title={menu.title}
          onClose={() => setMenu(null)}
          actions={actionsFor(menu)}
        >
          {menu.run && (
            <p className="field-hint">
              {runStatus(menu.run.state, menu.pending_approvals).label} ·{" "}
              {runTiming(menu.run)}
            </p>
          )}
        </ActionSheet>
      )}
      {later && (
        <LaterSheet
          kind="conversation"
          targetId={later.conversation_id}
          sourceId={later.sourceId ?? scopedSource}
          title={later.title}
          running={[
            "queued",
            "running",
            "pausing",
            "waiting_children",
          ].includes(later.run?.state || "")}
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
                await undoReminder(
                  created,
                  later.sourceId ?? scopedSource,
                );
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
              onOpen(
                conversation,
                undefined,
                moving.sourceId ?? scopedSource,
              );
          }}
        />
      )}
    </section>
  );
}
