import {
  useConversationActivities,
  visibleActivities,
  recordedSessionControls,
} from "./activityView";
import { ActivityRecords } from "./ActivityRecords";
import { SessionActivityControls } from "./SessionActivityControls";
import type { ActivityRecord } from "../agent-activities";
import {
  mergeConversationMessages,
  conversationRefreshCursor,
  type ConversationMessage,
} from "./conversationMessages";
import { AgentModelSettings } from "./AgentModelSettings";
import { agentModelName } from "./modelChoices";
import { AttachmentList } from "./Attachments";
import type { ComposerContext } from "./composerContext";
import { NativeDecisions } from "./NativeControls";
import { Approvals } from "./Approvals";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlarmClock,
  ArrowDown,
  Bookmark,
  Cpu,
  FileDiff,
  ListTree,
  MonitorSmartphone,
  MoreHorizontal,
  Reply,
  Share2,
  Users,
  Wrench,
} from "lucide-react";
import { api, parse } from "./api";
import { Sheet, RichText, Avatar } from "./components";
import type { Agent, Connection, Folder, Message, Team } from "../shared/types";
import { RunStatus } from "./RunStatus";
import { RunFiles } from "./PublishedFiles";
import { NativeConversation, MemoryUsed } from "./Memory";
import {
  ActionSheet,
  ChangesChip,
  ChangesSheet,
  Chip,
  ForkSheet,
  LaterSheet,
  OutlineSheet,
  ScheduledSends,
  UsageLine,
  messageActions,
  useLongPress,
  useSwipe,
} from "./ThreadTools";
import { HandoffSheet, shareLink } from "./Handoff";
import { EditQueued, type QueuedMessage } from "./Inbox";
import {
  compactNumber,
  dayLabel,
  preview,
  runStatus,
  startsNewDay,
  summarizeChanges,
  timeLabel,
  type ChangeSummary,
} from "./threadView";

// Keep the transcript focused on public messages and plans. Raw tool calls and
// command output are available from the options menu; file changes collapse
// into one "N files changed" summary per run that opens the change review.
const conversationActivity = (record: ActivityRecord) =>
  record.kind !== "tool" &&
  record.kind !== "output" &&
  record.kind !== "file_change";

type Usage = { input_tokens: number; output_tokens: number };

/** One message with swipe-right to reply and long-press for its menu. */
function MessageShell({
  id,
  className,
  anchored,
  onReply,
  onMenu,
  children,
}: {
  id: string;
  className: string;
  anchored: boolean;
  onReply?: () => void;
  onMenu?: () => void;
  children: ReactNode;
}) {
  const swipe = useSwipe({ onRight: onReply });
  const press = useLongPress(() => onMenu?.(), Boolean(onMenu));
  const both =
    (name: string) =>
    (e: any): void => {
      (swipe.handlers as any)[name]?.(e);
      (press as any)[name]?.(e);
    };
  return (
    <article
      id={"message-" + id}
      tabIndex={-1}
      className={className + (anchored ? " anchored" : "")}
      data-message-id={id}
      style={
        swipe.offset
          ? { transform: `translateX(${swipe.offset}px)` }
          : undefined
      }
      onPointerDown={both("onPointerDown")}
      onPointerMove={both("onPointerMove")}
      onPointerUp={both("onPointerUp")}
      onPointerCancel={both("onPointerCancel")}
      onPointerLeave={(press as any).onPointerLeave}
      onContextMenu={(press as any).onContextMenu}
      onClickCapture={both("onClickCapture")}
    >
      {swipe.offset > 0 && (
        <span
          className={"swipe-reply-hint" + (swipe.armed ? " armed" : "")}
          aria-hidden="true"
          style={{ left: -swipe.offset }}
        >
          <Reply size={18} />
        </span>
      )}
      {children}
    </article>
  );
}

export function Conversation({
  id,
  messageId,
  revision,
  agents,
  connections,
  teams,
  folders = [],
  onClose,
  onContinue,
  composer,
  onReady,
  onReply,
  onUsePrompt,
  onSubmitted,
  onProfile,
  onAgentChanged,
  onNewConversation,
  onNotice,
}: {
  id: string;
  messageId?: string | null;
  revision: number;
  agents: Agent[];
  connections: Connection[];
  teams: Team[];
  folders?: Folder[];
  onClose: () => void;
  onContinue: (id: string) => void;
  composer: ReactNode;
  onReady: (context: ComposerContext) => void;
  onReply: (context: ComposerContext) => void;
  onUsePrompt: (text: string) => void;
  onSubmitted: () => void;
  onProfile: (agent: Agent) => void;
  onAgentChanged?: () => void;
  onNewConversation: (agent: Agent) => void;
  onNotice?: (text: string) => void;
}) {
  const activityItems = useConversationActivities(id);
  const allActivities = visibleActivities(activityItems);
  const activities = allActivities.filter((item) =>
    conversationActivity(item.record),
  );
  const toolActivities = allActivities.filter(
    (item) => item.record.kind === "tool" || item.record.kind === "output",
  );
  const [data, setData] = useState<{
      conversation: any;
      messages: ConversationMessage[];
      next: string | null;
      position_message_id?: string | null;
      saved?: string[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [transfer, setTransfer] = useState(false),
    [destination, setDestination] = useState(""),
    [included, setIncluded] = useState<string[]>([]),
    [editingModel, setEditingModel] = useState(false),
    [showToolActivity, setShowToolActivity] = useState(false),
    [options, setOptions] = useState(false),
    [outline, setOutline] = useState(false),
    [handoff, setHandoff] = useState(false),
    [titleOpen, setTitleOpen] = useState(false),
    [menuFor, setMenuFor] = useState<ConversationMessage | null>(null),
    [laterFor, setLaterFor] = useState<{
      kind: "conversation" | "message";
      id: string;
      title: string;
    } | null>(null),
    [forkFrom, setForkFrom] = useState<string | null>(null),
    [changes, setChanges] = useState<ChangeSummary | null>(null),
    [savedIds, setSavedIds] = useState<Set<string>>(new Set()),
    [usage, setUsage] = useState<{
      runs: Record<string, Usage>;
      total: Usage;
    } | null>(null),
    [jump, setJump] = useState<string | null>(null),
    [editQueued, setEditQueued] = useState<QueuedMessage | null>(null);
  const [newProvider, setNewProvider] = useState<Agent | null>(null);
  // The link target, a jump from the outline, or where you left off.
  const anchor = jump || messageId;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const generation = useRef(0);
  const anchoring = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const initialScroll = useRef<string | null>(null);
  const followLatest = useRef(!anchor);
  const pinnedSize = useRef({ height: 0, viewport: 0 });
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const retryKeys = useRef(new Map<string, string>());
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryBusy = useRef(false);
  const paging = useRef(false);
  const loadRequest = useRef(0);
  const refreshRequest = useRef<{
    generation: number;
    queued: boolean;
  } | null>(null);
  const seenRevision = useRef(revision);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const positionSent = useRef("");
  const dataRef = useRef(data);
  dataRef.current = data;
  const agent = agents.find((a) => a.id === data?.conversation.agent_id),
    imported = data?.conversation.origin?.endsWith("-import");
  const project = folders.find(
    (f) => f.id === data?.conversation.project_id && f.kind === "project",
  );
  function pinLatest() {
    const messages = messagesRef.current;
    if (!messages) return;
    pinnedSize.current = {
      height: messages.scrollHeight,
      viewport: messages.clientHeight,
    };
    messages.scrollTop = messages.scrollHeight;
  }
  /** Messages currently inside the scroll viewport, top to bottom. */
  function visibleMessageIds() {
    const box = messagesRef.current?.getBoundingClientRect();
    if (!box) return [];
    return [
      ...(messagesRef.current?.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      ) || []),
    ]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > box.top + 24 && rect.top < box.bottom - 24;
      })
      .map((node) => node.dataset.messageId!);
  }
  /** Remember where you stopped reading, to reopen this thread there. */
  function saveReadingPosition() {
    const current = dataRef.current;
    if (!current?.messages.length || current.conversation.id !== id) return;
    const visible = visibleMessageIds();
    // At the latest output there is no position to keep: the thread opens
    // at its latest messages anyway.
    const body = {
      positionMessageId:
        followLatest.current || !visible.length ? null : visible[0],
    };
    const signature = JSON.stringify(body);
    if (positionSent.current === signature) return;
    positionSent.current = signature;
    void api(`/conversations/${id}/position`, body, "PUT").catch(() => {
      positionSent.current = "";
    });
  }
  async function load(initial = false) {
    if (paging.current) return;
    const current = generation.current;
    if (refreshRequest.current?.generation === current) {
      refreshRequest.current.queued = true;
      return;
    }
    const request = { generation: current, queued: false };
    refreshRequest.current = request;
    const ticket = ++loadRequest.current;
    if (initial) setLoading(true);
    try {
      let fresh = await api(
        "/conversations/" +
          id +
          (initial && anchor ? "?message=" + anchor : ""),
      );
      if (initial && !anchor) {
        // Reopen where you stopped reading. Fetch the page around that
        // message if it is not loaded.
        const target = fresh.position_message_id || null;
        if (target) {
          if (!fresh.messages.some((m: Message) => m.id === target))
            fresh = await api(
              `/conversations/${id}?message=${encodeURIComponent(target)}`,
            );
          if (fresh.messages.some((m: Message) => m.id === target)) {
            followLatest.current = false;
            setJump(target);
          }
        }
      }
      if (current !== generation.current || ticket !== loadRequest.current)
        return;
      setLoadError("");
      if (fresh.saved) setSavedIds(new Set(fresh.saved));
      setData((old) =>
        !initial && old
          ? {
              ...fresh,
              messages: mergeConversationMessages(old.messages, fresh.messages),
              next: conversationRefreshCursor(
                old.messages,
                fresh.messages,
                old.next,
                fresh.next,
              ),
            }
          : fresh,
      );
      if (initial)
        setIncluded(
          fresh.messages
            .filter(
              (m: Message) =>
                parse<any>(m.metadata, {}).activeBranch !== false &&
                !parse<any>(m.metadata, {}).progress,
            )
            .map((m: Message) => m.id),
        );
    } catch (e) {
      if (current === generation.current && ticket === loadRequest.current)
        setLoadError((e as Error).message);
    } finally {
      if (current === generation.current && ticket === loadRequest.current)
        setLoading(false);
      if (refreshRequest.current === request) {
        refreshRequest.current = null;
        if (current === generation.current && request.queued) void load();
      }
    }
  }
  useEffect(() => {
    setJump(null);
    positionSent.current = "";
  }, [id, messageId]);
  useEffect(() => {
    generation.current++;
    anchoring.current = false;
    followLatest.current = !anchor;
    setAwayFromLatest(false);
    if (!jump) setData(null);
    setTransfer(false);
    setShowToolActivity(false);
    setError("");
    setNotice("");
    // A jump inside a loaded thread only needs the anchor effect below.
    if (!jump || !dataRef.current?.messages.some((m) => m.id === jump))
      void load(true);
    const update = () => void load();
    const timer = setInterval(update, 5000);
    window.addEventListener("loop-workspace-change", update);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", update);
    };
  }, [id, anchor]);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    void load();
  }, [revision]);
  useEffect(() => {
    let active = true;
    api(`/conversations/${id}/usage`)
      .then((result) => active && setUsage(result))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id, revision, data?.messages.length]);
  useEffect(() => {
    if (!imported && agent && data?.conversation.id === id)
      readyRef.current({
        agentId: agent.id,
        conversationId: id,
        title: data.conversation.title,
      });
  }, [id, agent?.id, data?.conversation.title, imported]);
  useLayoutEffect(() => {
    if (data?.conversation.id !== id) return;
    const messages = messagesRef.current;
    if (!messages) return;
    if (followLatest.current) pinLatest();
    initialScroll.current = id;
  }, [data, id, anchor]);
  // Record the reading position while following the latest output and when
  // the thread closes.
  useEffect(() => {
    if (!data || data.conversation.id !== id) return;
    const timer = setTimeout(() => {
      if (followLatest.current) saveReadingPosition();
    }, 1200);
    return () => clearTimeout(timer);
  }, [data, id]);
  // The reading position is saved shortly after scrolling stops, so it is
  // already stored when the app is hidden or closed; a request fired during
  // page unload would only be cancelled. Closing the thread in the app saves too.
  const scrollSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scrollSave.current) clearTimeout(scrollSave.current);
      saveReadingPosition();
    },
    [id],
  );
  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    // Keep the current output in view when the composer or mobile keyboard
    // changes the available height, unless the user is reading older messages.
    const observer = new ResizeObserver(() => {
      if (followLatest.current && initialScroll.current === id) pinLatest();
    });
    observer.observe(messages);
    return () => observer.disconnect();
  }, [id]);
  useEffect(() => {
    if (!anchor || data?.conversation.id !== id) return;
    const messages = messagesRef.current;
    const message = document.getElementById("message-" + anchor);
    if (!messages || !message) return;
    anchoring.current = true;
    followLatest.current = false;
    let frame = 0;
    let focused = false;
    // Links and outline jumps centre their message; resuming starts at the
    // top of the saved reading position so it reads naturally.
    const block = anchor === messageId ? "center" : "start";
    const align = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!anchoring.current) return;
        message.scrollIntoView({ block });
        setAwayFromLatest(
          messages.scrollHeight - messages.clientHeight - messages.scrollTop >= 48,
        );
        // Only an explicit link focuses (and outlines) its message.
        if (!focused && anchor === messageId)
          message.focus({ preventScroll: true });
        focused = true;
      });
    };
    // Opening the composer and rendering a diagram can change the scrollport
    // after the first frame. Keep the link target visible until the user takes over.
    const observer = new ResizeObserver(align);
    observer.observe(messages);
    observer.observe(message);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      anchoring.current = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const input of inputs) messages.removeEventListener(input, stop);
    };
    for (const input of inputs)
      messages.addEventListener(input, stop, { passive: true });
    align();
    return stop;
  }, [data?.conversation.id, id, anchor]);

  function jumpTo(target: string) {
    if (target === anchor) {
      document
        .getElementById("message-" + target)
        ?.scrollIntoView({ block: "center" });
      return;
    }
    followLatest.current = false;
    setJump(target);
  }
  async function toggleSaved(message: Message) {
    const saved = savedIds.has(message.id);
    setSavedIds((old) => {
      const next = new Set(old);
      if (saved) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
    try {
      await api(
        `/messages/${message.id}/saved`,
        saved ? undefined : {},
        saved ? "DELETE" : "POST",
      );
      setNotice(saved ? "Removed from Saved." : "Saved. Find it in Later.");
      window.dispatchEvent(new Event("loop-later-change"));
    } catch (e) {
      setSavedIds((old) => {
        const next = new Set(old);
        if (saved) next.add(message.id);
        else next.delete(message.id);
        return next;
      });
      setError((e as Error).message);
    }
  }
  const latestRun = [...(data?.messages || [])]
    .reverse()
    .find((m) => m.run_id && m.run_state);
  const status = runStatus(latestRun?.run_state);
  // All file changes for a run, from live activities and saved history.
  function runChanges(runId: string) {
    const saved = (data?.messages || [])
      .filter((m) => m.run_id === runId)
      .flatMap((m) => {
        const meta = parse<any>(m.metadata, {});
        return (meta.activities ||
          (meta.activity ? [meta.activity] : [])) as ActivityRecord[];
      });
    const live = allActivities
      .filter((a) => a.run === runId)
      .map((a) => a.record);
    const keys = new Set(live.map((r) => r.kind + ":" + r.id));
    return summarizeChanges([
      ...saved.filter((r) => !keys.has(r.kind + ":" + r.id)),
      ...live,
    ]);
  }
  const threadChanges = summarizeChanges(
    allActivities.map((a) => a.record).concat(
      (data?.messages || []).flatMap((m) => {
        const meta = parse<any>(m.metadata, {});
        return (meta.activities || []) as ActivityRecord[];
      }),
    ),
  );
  const title = data?.conversation.title || "Conversation";
  let previousAt: number | undefined;
  const heading = (
    <div className="thread-head">
      {agent ? (
        <button
          type="button"
          className="thread-avatar"
          aria-label={`Open @${agent.name} profile`}
          onClick={() => onProfile(agent)}
        >
          <Avatar name={agent.name} provider={agent.provider} />
        </button>
      ) : (
        <span className="thread-avatar" />
      )}
      <button
        type="button"
        className={"thread-title" + (titleOpen ? " open" : "")}
        aria-expanded={titleOpen}
        onClick={() => setTitleOpen((v) => !v)}
      >
        <h2>{title}</h2>
        <small>
          {agent ? `@${agent.name}` : loading ? "Loading…" : "Agent unavailable"}
          {status.label && <Chip tone={status.tone}>{status.label}</Chip>}
        </small>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Jump to…"
        onClick={() => setOutline(true)}
      >
        <ListTree size={20} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Conversation options"
        onClick={() => setOptions(true)}
      >
        <MoreHorizontal size={20} />
      </button>
    </div>
  );
  return (
    <Sheet
      wide
      swipeToClose
      className="conversation-sheet"
      title={title}
      heading={heading}
      onClose={onClose}
    >
      {titleOpen && agent && (
        <p className="thread-details">
          {title}
          <small>
            {agentModelName(agent, connections)}
            {project ? ` · ${project.name}` : ""}
            {usage?.total && usage.total.input_tokens + usage.total.output_tokens
              ? ` · ${compactNumber(usage.total.input_tokens + usage.total.output_tokens)} tokens`
              : ""}
          </small>
        </p>
      )}
      {options && (
        <ActionSheet
          title="Conversation"
          onClose={() => setOptions(false)}
          actions={[
            {
              id: "jump",
              label: "Jump to…",
              hint: "Your prompts, results and saved messages",
              icon: <ListTree size={20} />,
              onSelect: () => setOutline(true),
            },
            {
              id: "later",
              label: "Remind me later",
              icon: <AlarmClock size={20} />,
              onSelect: () =>
                setLaterFor({ kind: "conversation", id, title }),
            },
            ...(threadChanges.files.length
              ? [
                  {
                    id: "changes",
                    label: "Review changes",
                    hint: `${threadChanges.files.length} files · +${threadChanges.additions} −${threadChanges.deletions}`,
                    icon: <FileDiff size={20} />,
                    onSelect: () => setChanges(threadChanges),
                  },
                ]
              : []),
            ...(toolActivities.length
              ? [
                  {
                    id: "tools",
                    label: "Tool activity",
                    icon: <Wrench size={20} />,
                    onSelect: () => setShowToolActivity(true),
                  },
                ]
              : []),
            ...(agent
              ? [
                  {
                    id: "model",
                    label: "Change model",
                    hint: agentModelName(agent, connections),
                    icon: <Cpu size={20} />,
                    onSelect: () => {
                      setError("");
                      setEditingModel(true);
                    },
                  },
                ]
              : []),
            {
              id: "transfer",
              label: "Continue with another agent",
              icon: <Users size={20} />,
              onSelect: () => {
                setError("");
                setTransfer(true);
              },
            },
            {
              id: "share",
              label: "Share link",
              icon: <Share2 size={20} />,
              onSelect: () =>
                void shareLink(`/?conversation=${id}`, title).then(
                  (text) => text && setNotice(text),
                ),
            },
            {
              id: "handoff",
              label: "Open on another device",
              hint: "Show a code to scan with your computer or phone",
              icon: <MonitorSmartphone size={20} />,
              onSelect: () => setHandoff(true),
            },
          ]}
        >
          <div className="conversation-options-extra">
            <NativeConversation id={id} />
            <SessionActivityControls
              key={id}
              conversationId={id}
              recorded={recordedSessionControls(activityItems)}
            />
            {usage?.total &&
              usage.total.input_tokens + usage.total.output_tokens > 0 && (
                <p className="field-hint">
                  Token use reported by the provider:{" "}
                  {compactNumber(usage.total.input_tokens)} in ·{" "}
                  {compactNumber(usage.total.output_tokens)} out
                </p>
              )}
          </div>
        </ActionSheet>
      )}
      {outline && (
        <OutlineSheet
          conversationId={id}
          onJump={jumpTo}
          onClose={() => setOutline(false)}
        />
      )}
      {handoff && (
        <HandoffSheet
          path={`/?conversation=${id}`}
          title={title}
          onClose={() => setHandoff(false)}
        />
      )}
      {laterFor && (
        <LaterSheet
          kind={laterFor.kind}
          targetId={laterFor.id}
          title={laterFor.title}
          running={["queued", "running", "pausing", "waiting_children"].includes(
            latestRun?.run_state || "",
          )}
          project={project ? { id: project.id, name: project.name } : undefined}
          onClose={() => setLaterFor(null)}
          onDone={(label) => {
            const text = `Snoozed: ${label.toLowerCase()}.`;
            setNotice(text);
            if (laterFor.kind === "conversation") {
              onNotice?.(text);
              onClose();
            }
          }}
        />
      )}
      {menuFor && (
        <ActionSheet
          title={menuFor.role === "user" ? "Your message" : "Message"}
          onClose={() => setMenuFor(null)}
          actions={messageActions({
            saved: savedIds.has(menuFor.id),
            canReply: Boolean(
              agent && !imported && menuFor.content.trim() !== "",
            ),
            canFork: agents.some((a) => a.connection_id && !a.retired_at),
            onReply: () =>
              agent &&
              onReply({
                agentId: agent.id,
                conversationId: id,
                messageId: menuFor.id,
                content: menuFor.content,
                ...(menuFor.role === "user" ? { mine: true } : {}),
              }),
            onCopy: async () => {
              try {
                await navigator.clipboard.writeText(menuFor.content);
                setNotice("Message copied.");
              } catch {
                setError("Could not copy. Select the message text and copy it.");
              }
            },
            onSave: () => void toggleSaved(menuFor),
            onLater: () =>
              setLaterFor({
                kind: "message",
                id: menuFor.id,
                title: preview(menuFor.content, 90),
              }),
            onFork: () => setForkFrom(menuFor.id),
            onReuse: () => onUsePrompt(menuFor.content),
            onSnippet: async () => {
              try {
                await api("/artifacts", {
                  title: "Snippet: " + preview(menuFor.content, 60),
                  content: menuFor.content,
                  kind: "markdown",
                  metadata: { snippet: true },
                });
                onSubmitted();
                setNotice("Saved as a snippet. Type / in the composer to use it.");
              } catch (e) {
                setError((e as Error).message);
              }
            },
            onShare: () =>
              void shareLink(
                `/?conversation=${id}&message=${menuFor.id}`,
                title,
              ).then((text) => text && setNotice(text)),
          })}
        >
          <div className="action-preview">
            {preview(menuFor.content, 160) || "(no text)"}
          </div>
        </ActionSheet>
      )}
      {forkFrom && (
        <ForkSheet
          conversationId={id}
          messageId={forkFrom}
          agents={agents}
          defaultAgentId={agent?.id}
          onClose={() => setForkFrom(null)}
          onForked={(next) => {
            setForkFrom(null);
            onSubmitted();
            onContinue(next);
          }}
        />
      )}
      {editQueued && (
        <EditQueued
          message={editQueued}
          onClose={() => setEditQueued(null)}
          onSaved={() => {
            onSubmitted();
            setNotice("Queued message updated.");
            void load();
          }}
        />
      )}
      {changes && (
        <ChangesSheet
          summary={changes}
          onClose={() => setChanges(null)}
          onAsk={agent && !imported ? onUsePrompt : undefined}
        />
      )}
      {showToolActivity && (
        <Sheet title="Tool activity" onClose={() => setShowToolActivity(false)}>
          <ActivityRecords
            records={toolActivities.map((item) => item.record)}
          />
        </Sheet>
      )}
      {editingModel && agent && (
        <AgentModelSettings
          agent={agent}
          connections={connections}
          onClose={() => {
            setEditingModel(false);
            if (newProvider) onNewConversation(newProvider);
          }}
          onSaved={(saved) => {
            onAgentChanged?.();
            if (saved.connection_id !== agent.connection_id || newProvider)
              setNewProvider(saved);
            else setNotice("Model updated for your next message.");
          }}
        />
      )}
      <div className="conversation-message-area">
        <div
          className="messages"
          ref={messagesRef}
          aria-busy={loading}
          onScroll={(event) => {
            if (anchoring.current) return;
            const el = event.currentTarget;
            // A composer resize can emit the preceding programmatic scroll
            // event with new dimensions. It is not a request to stop following.
            if (
              followLatest.current &&
              (pinnedSize.current.height !== el.scrollHeight ||
                pinnedSize.current.viewport !== el.clientHeight)
            ) {
              pinLatest();
              return;
            }
            const following =
              el.scrollHeight - el.clientHeight - el.scrollTop < 48;
            followLatest.current = following;
            setAwayFromLatest(!following);
            if (scrollSave.current) clearTimeout(scrollSave.current);
            scrollSave.current = setTimeout(saveReadingPosition, following ? 0 : 800);
          }}
        >
          {loading && (
            <p role="status" className="muted">
              Loading conversation…
            </p>
          )}
          {loadError && (
            <div role="alert" className="error">
              {loadError}
              <button className="text-button" onClick={() => void load(!data)}>
                Try again
              </button>
            </div>
          )}
          {data?.next && (
            <button
              className="text-button load-earlier"
              disabled={loadingEarlier}
              onClick={async () => {
                if (paging.current) return;
                paging.current = true;
                loadRequest.current++;
                setLoadingEarlier(true);
                const current = generation.current;
                try {
                  const older = await api(
                    "/conversations/" + id + "?before=" + data.next,
                  );
                  if (current !== generation.current) return;
                  setData((previous) =>
                    previous
                      ? {
                          ...previous,
                          messages: mergeConversationMessages(
                            previous.messages,
                            older.messages,
                          ),
                          next: older.next,
                        }
                      : previous,
                  );
                  if (older.saved)
                    setSavedIds(
                      (old) => new Set([...old, ...older.saved]),
                    );
                  setError("");
                } catch (e) {
                  if (current === generation.current)
                    setError((e as Error).message);
                } finally {
                  paging.current = false;
                  if (current === generation.current) {
                    setLoadingEarlier(false);
                    void load();
                  }
                }
              }}
            >
              Load earlier messages
            </button>
          )}
          <ActivityRecords
            records={activities.filter((a) => !a.run).map((a) => a.record)}
          />
          {data?.messages.map((m) => {
            const meta = parse<any>(m.metadata, {});
            const pendingAnswer =
              m.role === "assistant" &&
              !meta.progress &&
              (meta.partial === true || !m.content.trim());
            // Current runtimes stream public text as message traces. Older
            // records may only have partial answer text; display it if there is
            // no trace for that run, without duplicating the current stream.
            const showContent =
              m.content &&
              (meta.partial !== true ||
                !data.messages.some(
                  (other) =>
                    other.run_id === m.run_id &&
                    parse<any>(other.metadata, {}).progress,
                ));
            const newDay = startsNewDay(m.created_at, previousAt);
            previousAt = m.created_at;
            // Any finished message can be quoted: the agent's or your own.
            const canReply =
              ["assistant", "user"].includes(m.role) &&
              agent &&
              !imported &&
              !pendingAnswer &&
              m.content.trim() !== "";
            const reply = canReply
              ? () =>
                  onReply({
                    agentId: agent!.id,
                    conversationId: id,
                    messageId: m.id,
                    content: m.content,
                    ...(m.role === "user" ? { mine: true } : {}),
                  })
              : undefined;
            const finalForRun =
              m.run_id &&
              !meta.progress &&
              (
                data.messages
                  .filter(
                    (other) =>
                      other.run_id === m.run_id &&
                      other.role === "assistant" &&
                      !parse<any>(other.metadata, {}).progress,
                  )
                  .at(-1) ||
                data.messages.find(
                  (other) =>
                    other.run_id === m.run_id &&
                    !parse<any>(other.metadata, {}).progress,
                )
              )?.id === m.id;
            const changed = finalForRun ? runChanges(m.run_id!) : null;
            return (
              <div key={m.id} className="message-slot">
                {newDay && (
                  <div className="day-separator" role="separator">
                    <span>{dayLabel(m.created_at)}</span>
                  </div>
                )}
                <MessageShell
                  id={m.id}
                  anchored={messageId === m.id}
                  onReply={reply}
                  onMenu={
                    !meta.progress && !pendingAnswer
                      ? () => setMenuFor(m)
                      : undefined
                  }
                  className={
                    "message " +
                    m.role +
                    (pendingAnswer ? " pending-answer" : "") +
                    (meta.progress ? " agent-progress" : "")
                  }
                >
                  {(!pendingAnswer || showContent) && (
                    <header className="message-meta">
                      <span className="eyebrow">
                        {m.role === "user" ? "You" : `@${agent?.name || "agent"}`}
                        {meta.progress ? " · Update" : ""}
                        {meta.activeBranch === false ? " · alternate branch" : ""}
                      </span>
                      <span className="message-meta-end">
                        {savedIds.has(m.id) && (
                          <Bookmark
                            size={14}
                            className="saved-mark"
                            aria-label="Saved"
                          />
                        )}
                        <time
                          dateTime={new Date(m.created_at).toISOString()}
                          title={new Date(m.created_at).toLocaleString()}
                        >
                          {timeLabel(m.created_at)}
                        </time>
                        {reply && (
                          <button
                            type="button"
                            className="icon-button message-icon"
                            aria-label="Reply"
                            onClick={reply}
                          >
                            <Reply size={16} />
                          </button>
                        )}
                        {!meta.progress && !pendingAnswer && (
                          <button
                            type="button"
                            className="icon-button message-icon"
                            aria-label="Message actions"
                            onClick={() => setMenuFor(m)}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                      </span>
                    </header>
                  )}
                  {m.role === "user" && meta.replyTo && (
                    <details className="message-reply-context">
                      <summary>
                        {meta.replyTo.mine
                          ? "Replying to your message"
                          : `Replying to @${meta.replyTo.name}`}
                        {" · View quoted message"}
                      </summary>
                      <RichText content={meta.replyTo.content} />
                    </details>
                  )}
                  {showContent && <RichText content={m.content} />}
                  {m.role === "user" && m.run_id && m.run_state === "queued" && (
                    <div className="queued-controls" role="group" aria-label="Queued message">
                      <span className="status-chip queued">Queued</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setEditQueued({
                            id: m.run_id!,
                            input: m.content,
                            agentId: agent?.id,
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={async () => {
                          try {
                            await api(`/runs/${m.run_id}/cancel`, {});
                            onSubmitted();
                            setNotice("Queued message cancelled.");
                            await load();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <ActivityRecords
                    records={(
                      meta.activities || (meta.activity ? [meta.activity] : [])
                    ).filter(
                      (record: ActivityRecord) =>
                        conversationActivity(record) &&
                        !activities.some(
                          (a) =>
                            a.run === m.run_id &&
                            a.record.id === record.id &&
                            a.record.kind === record.kind &&
                            a.record.source.transport ===
                              record.source.transport &&
                            a.record.source.harness === record.source.harness,
                        ),
                    )}
                  />
                  <AttachmentList files={meta.attachments || []} />
                  {meta.steeringId && (
                    <p
                      className={
                        meta.delivery === "failed" ? "error" : "field-hint"
                      }
                      role="status"
                    >
                      {meta.delivery === "failed"
                        ? meta.deliveryError
                        : meta.delivery === "delivered"
                          ? "Sent to the active run"
                          : "Sending to the active run…"}
                    </p>
                  )}
                  {finalForRun && (
                    <>
                      <ActivityRecords
                        records={activities
                          .filter((a) => a.run === m.run_id)
                          .map((a) => a.record)}
                      />
                      {changed && (
                        <ChangesChip
                          summary={changed}
                          onOpen={() => setChanges(changed)}
                        />
                      )}
                      <RunStatus
                        state={m.run_state}
                        error={m.run_error}
                        empty={
                          m.role === "assistant"
                            ? !m.content || meta.partial === true
                            : true
                        }
                      />
                      {m.run_state === "awaiting_approval" && (
                        <Approvals
                          runId={m.run_id!}
                          revision={0}
                          onChange={() => {
                            onSubmitted();
                            void load();
                          }}
                          onConversation={() => {}}
                        />
                      )}
                      {["failed", "interrupted"].includes(
                        m.run_state || "",
                      ) && (
                        <button
                          className="text-button"
                          disabled={!!retrying}
                          onClick={async () => {
                            if (retryBusy.current) return;
                            retryBusy.current = true;
                            setRetrying(m.run_id);
                            const key =
                              retryKeys.current.get(m.run_id!) ||
                              crypto.randomUUID();
                            retryKeys.current.set(m.run_id!, key);
                            try {
                              await api(`/runs/${m.run_id}/retry`, {
                                idempotencyKey: key,
                              });
                              onSubmitted();
                              await load();
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              retryBusy.current = false;
                              setRetrying(null);
                            }
                          }}
                        >
                          {retrying === m.run_id
                            ? "Queuing retry…"
                            : "Retry as a new run"}
                        </button>
                      )}
                    </>
                  )}
                  {!meta.progress && m.role === "assistant" && (
                    <RunFiles
                      runId={m.run_id}
                      active={m.run_state === "running"}
                    />
                  )}
                  {m.role === "assistant" &&
                    m.run_id &&
                    !meta.progress &&
                    !pendingAnswer && (
                      <footer className="message-foot">
                        <MemoryUsed runId={m.run_id} />
                        {finalForRun && (
                          <UsageLine usage={usage?.runs[m.run_id]} />
                        )}
                      </footer>
                    )}
                </MessageShell>
              </div>
            );
          })}
          <ScheduledSends conversationId={id} revision={revision} />
        </div>
        {awayFromLatest && (
          <button
            className="text-button conversation-latest"
            aria-label="Jump to latest messages"
            onClick={() => {
              anchoring.current = false;
              followLatest.current = true;
              setAwayFromLatest(false);
              pinLatest();
              saveReadingPosition();
            }}
          >
            <ArrowDown size={16} aria-hidden="true" /> Latest messages
          </button>
        )}
      </div>
      {transfer && (
        <Sheet
          title="Continue with another agent"
          onClose={() => {
            setTransfer(false);
            setError("");
          }}
        >
          <div className="transfer-panel">
            <label>
              Continue with
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="">Choose a connected agent</option>
                {agents
                  .filter((a) => a.connection_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      @{a.name} · {a.provider} · {a.model}
                    </option>
                  ))}
              </select>
            </label>
            <p className="field-hint">
              Tip: “Fork from here” in any message’s menu copies everything up
              to that point.
            </p>
            <fieldset className="transfer-messages">
              <legend>Messages to include</legend>
              {data?.messages
                .filter(
                  (m) => m.content && !parse<any>(m.metadata, {}).progress,
                )
                .map((m) => (
                  <label className="checkbox-row" key={m.id}>
                    <input
                      type="checkbox"
                      checked={included.includes(m.id)}
                      onChange={(e) =>
                        setIncluded((old) =>
                          e.target.checked
                            ? [...old, m.id]
                            : old.filter((id) => id !== m.id),
                        )
                      }
                    />
                    <span>
                      {m.role === "user" ? "You" : "Agent"}:{" "}
                      {m.content.slice(0, 180)}
                    </span>
                  </label>
                ))}
            </fieldset>
            <p className="note">
              Only the {included.length} selected messages will be copied. They
              will be sent to the selected provider when you send your next
              prompt. Other archive conversations stay private.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button
              className="primary"
              disabled={busy || !destination || !included.length}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  const r = await api(`/conversations/${id}/continue`, {
                    agentId: destination,
                    messageIds: included,
                  });
                  setTransfer(false);
                  onContinue(r.id);
                  onSubmitted();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create continuation
            </button>
          </div>
        </Sheet>
      )}
      {!editingModel && !transfer && (error || notice) && (
        <div className="conversation-feedback">
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : (
            <p role="status">{notice}</p>
          )}
          <button
            className="text-button"
            aria-label="Dismiss message"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <NativeDecisions conversation={id} />
      {!imported && agent && (
        <div className="conversation-composer">{composer}</div>
      )}
    </Sheet>
  );
}
