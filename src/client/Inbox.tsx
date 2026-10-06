import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { automationLabel } from "../shared/agent-mail";
import {
  AlarmClock,
  Archive,
  ArrowDown,
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
} from "lucide-react";
import { api } from "./api";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { Avatar, RichText, Sheet } from "./components";
import {
  agentModelName,
  connectionEnvironments,
  executionLocationLabels,
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
import { threadDraft } from "./drafts";
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

export type InboxFilter =
  | "all"
  | "done"
  | "needs"
  | "working"
  | "queued"
  // Stories from the public feeds you added, not threads.
  | "social"
  // Project history views (no chip of their own).
  | "outcomes"
  | "unfinished";

export type InboxItem = {
  conversation_id: string;
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
};
type Brief = {
  conversation_id: string;
  title: string;
  agent_name: string | null;
  run_id: string;
  state: string;
  updated_at: number;
};

export const inboxFilters: { id: InboxFilter; label: string }[] = [
  // Done holds only threads with nothing open; open work has its own chip.
  { id: "done", label: "Done" },
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "queued", label: "Queued" },
  { id: "social", label: "Social" },
];

const isSocial = (filter: InboxFilter) => filter === "social";

const LAST_VISIT = "loop-last-visit";
const AWAY_AFTER = 30 * 60_000;

/**
 * A thread in the Feed, shown at the same size as a result card: agent
 * byline, status and project, the thread title and the latest message.
 */
// Run states whose prompt the Feed hides until the agent writes something.
const awaitingStates = ["running", "pausing", "waiting_children"];
function InboxCard({
  item,
  agent,
  model,
  environment,
  onOpen,
  onReply,
  onNext,
  onAgent,
  onMenu,
  onArchive,
  onLater,
}: {
  item: InboxItem;
  agent?: Agent;
  model?: string;
  environment?: ExecutionLocation | null;
  onOpen: () => void;
  onReply: () => void;
  /** Open exactly where the next action is. */
  onNext: (action: FeedNextAction) => void;
  onAgent?: () => void;
  onMenu: () => void;
  onArchive: () => void;
  onLater: () => void;
}) {
  const swipe = useSwipe({ onLeft: onArchive });
  const press = useLongPress(onMenu);
  const status = runStatus(item.run?.state, item.pending_approvals);
  const merged = (name: string) => (e: any) => {
    (swipe.handlers as any)[name]?.(e);
    (press as any)[name]?.(e);
  };
  const draft = threadDraft(item.conversation_id).text;
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
      <span className="swipe-under right" aria-hidden="true">
        <Archive size={20} /> Archive
      </span>
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
                  <span className={`agent-environment ${environment}`}>
                    {environment === "laptop" ? (
                      <Laptop size={12} aria-hidden="true" />
                    ) : (
                      <Container size={12} aria-hidden="true" />
                    )}
                    {executionLocationLabels[environment]}
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
  onOpen,
}: {
  onFilter: (filter: InboxFilter) => void;
  onOpen: (conversation: string) => void;
}) {
  const [away, setAway] = useState<{
    completed: Brief[];
    needs: Brief[];
    failed: Brief[];
  } | null>(null);
  useEffect(() => {
    let since = 0;
    try {
      since = Number(localStorage.getItem(LAST_VISIT) || 0);
    } catch {}
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
      void api("/inbox/away?since=" + since)
        .then((result) => {
          if (
            result.completed.length ||
            result.needs.length ||
            result.failed.length
          )
            setAway(result);
        })
        .catch(() => {});
    record();
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", record);
    };
  }, []);
  if (!away) return null;
  const parts = [
    away.completed.length && `${away.completed.length} finished`,
    away.needs.length && `${away.needs.length} need you`,
    away.failed.length && `${away.failed.length} failed`,
  ].filter(Boolean);
  // A summary only: the threads themselves are the full cards below. One
  // thread opens directly; several show the filter that holds them. Failed
  // runs wait in Needs you.
  const threads = [
    ...new Set(
      [...away.needs, ...away.failed, ...away.completed].map(
        (item) => item.conversation_id,
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
      onOpen(single.conversation_id);
      return;
    }
    onFilter(attention ? "needs" : "done");
    // The card leaves, so bring the threads it summarized into view.
    requestAnimationFrame(() =>
      document
        .querySelector(".inbox-filters")
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
            await api("/runs/" + message.id, { input: text }, "PATCH");
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
  const choices = agents.filter(
    (a) => a.connection_id && !a.retired_at && a.id !== message.agentId,
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
            const result = await api(`/runs/${message.id}/move`, {
              agentId,
              idempotencyKey: key.current,
            });
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

export function Inbox({
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
}: {
  filter: InboxFilter;
  onFilter: (filter: InboxFilter) => void;
  project?: string;
  teams?: string;
  revision: number;
  agents: Agent[];
  onOpen: (conversation: string, message?: string) => void;
  onAgent: (agent: Agent) => void;
  onChanged: () => void;
  header?: ReactNode;
  needsSlot?: ReactNode;
  emptyAction?: ReactNode;
  hideFilters?: boolean;
  connections?: Connection[];
  onReply?: (conversation: string) => void;
  agent?: string;
  /** Open Later → Scheduled. */
  onScheduled?: () => void;
  /** Open Later → Reminders at one reminder. */
  onShowReminder?: (id: string) => void;
  /** Start a new message with this text (a news card's "Ask an agent"). */
  onAsk?: (text: string) => void;
}) {
  type Shown = { items: InboxItem[]; next: string | null; summary: Summary };
  const shownKey = () =>
    "inbox:" + JSON.stringify([filter, project, agent, teams]);
  // Going back shows the list as you left it while it refreshes.
  const shown = cachedView<Shown>(shownKey());
  const environments = useMemo(
    () => connectionEnvironments(connections || []),
    [connections],
  );
  const [items, setItems] = useState<InboxItem[]>(shown?.items || []);
  const [summary, setSummary] = useState<Summary | null>(
    shown?.summary || null,
  );
  const [next, setNext] = useState<string | null>(shown?.next || null);
  const [loading, setLoading] = useState(!shown);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<InboxItem | null>(null);
  const [later, setLater] = useState<InboxItem | null>(null);
  const [editing, setEditing] = useState<QueuedMessage | null>(null);
  const [moving, setMoving] = useState<QueuedMessage | null>(null);
  const request = useRef(0);
  const query = (before?: string) => {
    const q = new URLSearchParams({
      // Social is not a thread filter; the request only keeps the chip
      // counts current, from the smallest list.
      filter: isSocial(filter) ? "needs" : filter,
    });
    if (project) q.set("folder", project);
    if (agent) q.set("agent", agent);
    if (teams) q.set("teams", teams);
    if (before) q.set("before", before);
    return "/inbox?" + q;
  };
  const inFlight = useRef(false);
  async function load(append = false, background = false) {
    // Background refreshes never overlap; filter changes and actions always load.
    if (background && inFlight.current) return;
    inFlight.current = true;
    const ticket = ++request.current;
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    if (!append && !items.length) setLoading(true);
    try {
      const result = await api<{
        items: InboxItem[];
        next: string | null;
        summary: Summary;
      }>(query(append ? next || undefined : undefined));
      if (ticket !== request.current || owner !== viewOwner()) return;
      const key = shownKey();
      setItems((old) => {
        const merged = append
          ? [
              ...old,
              ...result.items.filter(
                (item) =>
                  !old.some((o) => o.conversation_id === item.conversation_id),
              ),
            ]
          : result.items;
        cacheView<Shown>(
          key,
          { items: merged, next: result.next, summary: result.summary },
          owner,
        );
        return merged;
      });
      setNext(result.next);
      setSummary(result.summary);
      setError("");
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    } finally {
      inFlight.current = false;
      if (ticket === request.current) setLoading(false);
    }
  }
  const firstLoad = useRef(true);
  useEffect(() => {
    const cached = cachedView<Shown>(shownKey());
    // The first render already shows the cached list; a filter change swaps
    // to that filter's cached list, or a loader.
    if (!firstLoad.current) {
      setItems(cached?.items || []);
      setNext(cached?.next || null);
      setSummary(cached?.summary || null);
      setLoading(!cached);
    }
    firstLoad.current = false;
    void load();
  }, [filter, project, teams, agent]);
  useEffect(() => {
    void load(false, true);
  }, [revision]);
  useEffect(() => {
    const update = () => void load(false, true);
    window.addEventListener("loop-later-change", update);
    // Workspace events already bump `revision`; this is only a fallback.
    const timer = setInterval(update, 30_000);
    return () => {
      window.removeEventListener("loop-later-change", update);
      clearInterval(timer);
    };
  }, [filter, project, teams]);
  async function runAction(runId: string, action: string, body = {}) {
    try {
      await api(`/runs/${runId}/${action}`, body);
      onChanged();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function archive(item: InboxItem) {
    try {
      await api(`/inbox/${item.conversation_id}`, { hidden: true }, "PATCH");
      setItems((old) => old.filter((row) => row.conversation_id !== item.conversation_id));
      notify({
        text: "Archived from feed. Still in history and search.",
        undo: async () => {
          await api(`/inbox/${item.conversation_id}`, { hidden: false }, "PATCH");
          await load();
        },
      });
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function actionsFor(item: InboxItem): Action[] {
    const agent = agents.find((a) => a.id === item.agent_id);
    const state = item.run?.state || "";
    const actions: Action[] = [
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
      const message = { id: q.id, input: q.input, agentId: item.agent_id };
      if (q.can_move_up)
        actions.push({
          id: "up-" + q.id,
          label: `Move up in queue${which}`,
          icon: <ArrowUp size={20} />,
          onSelect: () => void runAction(q.id, "reorder", { direction: "up" }),
        });
      if (q.can_move_down)
        actions.push({
          id: "down-" + q.id,
          label: `Move down in queue${which}`,
          icon: <ArrowDown size={20} />,
          onSelect: () =>
            void runAction(q.id, "reorder", { direction: "down" }),
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
          onSelect: () => void runAction(q.id, "cancel"),
        });
    }
    if (["queued", "running"].includes(state))
      actions.push({
        id: "pause",
        label: "Pause",
        icon: <Pause size={20} />,
        onSelect: () => void runAction(item.run!.id, "pause"),
      });
    if (state === "paused")
      actions.push({
        id: "resume",
        label: "Resume",
        icon: <Play size={20} />,
        onSelect: () => void runAction(item.run!.id, "resume"),
      });
    if (["failed", "interrupted"].includes(state))
      actions.push({
        id: "dismiss",
        label: "Dismiss from Needs you",
        icon: <X size={20} />,
        onSelect: () => void runAction(item.run!.id, "dismiss"),
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
        onSelect: () => void runAction(item.run!.id, "cancel"),
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
          `/?conversation=${item.conversation_id}`,
          item.title,
        ).then((text) => text && setNotice(text)),
    });
    return actions;
  }
  const counts: Partial<Record<InboxFilter, number>> = summary
    ? {
        // Messages that could not be sent need you too.
        needs: summary.needs + (summary.scheduled_failed || 0),
        working: summary.working,
        queued: summary.queued,
      }
    : {};
  return (
    <section className="inbox" aria-label="Feed">
      {!hideFilters && (
        <AwaySummary onFilter={onFilter} onOpen={(id) => onOpen(id)} />
      )}
      {header}
      {!hideFilters && (
        <div
          className="chip-row inbox-filters"
          role="tablist"
          aria-label="Show"
        >
          {inboxFilters.map((f) => (
            <button
              key={f.id}
              role="tab"
              type="button"
              aria-selected={filter === f.id}
              className={
                "chip" + (f.id === "needs" && counts.needs ? " attention" : "")
              }
              onClick={() => onFilter(f.id)}
            >
              {f.label}
              {!!counts[f.id] && (
                <span className="chip-count">{counts[f.id]}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {filter === "needs" && !!summary?.scheduled_failed && (
        <p className="scheduled-summary" role="status">
          <strong>
            {summary.scheduled_failed} scheduled{" "}
            {summary.scheduled_failed === 1 ? "message" : "messages"} not sent
          </strong>
          {!!summary.scheduled_pending && (
            <span> · {summary.scheduled_pending} still waiting to send</span>
          )}
          {onScheduled && (
            <button type="button" className="text-button" onClick={onScheduled}>
              Open Scheduled
            </button>
          )}
        </p>
      )}
      {filter === "needs" && needsSlot}
      {isSocial(filter) ? (
        <Social onAsk={onAsk} />
      ) : (
      <>
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="text-button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="field-hint">
            {notice}
          </p>
        )}
        {loading && !items.length ? (
          <div className="feed-loading" role="status" aria-label="Loading feed">
            <span />
            <span />
            <span />
          </div>
        ) : items.length ? (
          <ul className="inbox-list feed">
            {items.map((item) => {
              const agent = agents.find((a) => a.id === item.agent_id);
              // Both badges describe the connection that ran (or will run)
              // this thread, so an agent reconfiguration doesn't relabel it.
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
                      connections,
                    )
                  : agent
                    ? agentModelName(
                        { connection_id: connectionId, model: agent.model },
                        connections,
                      )
                    : undefined;
              return (
                <InboxCard
                  key={item.conversation_id}
                  item={item}
                  agent={agent}
                  model={model}
                  environment={
                    connectionId ? environments.get(connectionId) : null
                  }
                  onOpen={() => onOpen(item.conversation_id)}
                  onReply={() => (onReply || onOpen)(item.conversation_id)}
                  onNext={(action) =>
                    action.kind === "draft"
                      ? (onReply || onOpen)(item.conversation_id)
                      : onOpen(item.conversation_id, action.message_id || undefined)
                  }
                  onAgent={agent ? () => onAgent(agent) : undefined}
                  onMenu={() => setMenu(item)}
                  onArchive={() => void archive(item)}
                  onLater={() => setLater(item)}
                />
              );
            })}
          </ul>
        ) : (
          !error && (
            <div className="inbox-empty">
              <p>
                <strong>
                  {filter === "all"
                    ? "Nothing here yet."
                    : filter === "done"
                      ? "Nothing finished yet."
                      : filter === "needs"
                        ? "Nothing needs you right now."
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
              link: onShowReminder && {
                label: "View",
                onSelect: () => onShowReminder(created.id),
              },
              undo: async () => {
                await undoReminder(created);
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
            if (conversation) onOpen(conversation);
          }}
        />
      )}
    </section>
  );
}
