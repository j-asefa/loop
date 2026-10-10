import { CodeReviewStatus } from "./CodeReview";
import { useSourceApi, useSourceId } from "./SourceContext";
import { sourceUrl } from "./sourceRouting";
import { automationLabel } from "../shared/agent-mail";
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
import type { UploadedFile } from "../shared/uploads";
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
import { parse } from "./api";
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
  QuotePartSheet,
  ScheduledSends,
  UsageLine,
  messageActions,
  undoReminder,
  useLongPress,
  useSwipe,
  type ChangeContext,
} from "./ThreadTools";
import { notify } from "./toast";
import { HandoffSheet, shareLink } from "./Handoff";
import { EditQueued, type QueuedMessage } from "./Inbox";
import {
  compactNumber,
  dayLabel,
  mergeActivityRecords,
  preview,
  runStatus,
  startsNewDay,
  summarizeChanges,
  timeLabel,
  type ChangeSummary,
} from "./threadView";

type Usage = { input_tokens: number; output_tokens: number };
export type ThreadWork = {
  state: string;
  /** A reply now is delivered to the running task (steering). */
  steerable: boolean;
};

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
  readyKey,
  onReply,
  onUsePrompt,
  onRestoreDraft,
  onWithdraw,
  onSubmitted,
  onProfile,
  onAgentChanged,
  onNewConversation,
  onNotice,
  onShowLater,
  onWork,
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
  readyKey?: string;
  onReply: (context: ComposerContext) => void;
  onUsePrompt: (text: string) => void;
  /** Put a message back into the composer with its files (nothing is sent). */
  onRestoreDraft: (text: string, files: UploadedFile[]) => void;
  /** Take a queued message that has not started back into the composer. */
  onWithdraw: (runId: string) => Promise<void>;
  onSubmitted: () => void;
  onProfile: (agent: Agent) => void;
  onAgentChanged?: () => void;
  onNewConversation: (agent: Agent) => void;
  onNotice?: (text: string) => void;
  /** Open Later at a section, highlighting one item. */
  onShowLater?: (section: "reminders" | "scheduled", focusId?: string) => void;
  /**
   * The thread's current work, so the composer can say what a send does:
   * steer it, queue after it, or send later.
   */
  onWork?: (work: ThreadWork | null) => void;
}) {
  const api = useSourceApi();
  const readController = useRef<AbortController | null>(null);
  const sourceId = useSourceId();
  const [data, setData] = useState<{
      conversation: any;
      messages: ConversationMessage[];
      next: string | null;
      position_message_id?: string | null;
      saved?: string[];
      steerable_run_id?: string | null;
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
    [forkFrom, setForkFrom] = useState<ConversationMessage | null>(null),
    [quoteFrom, setQuoteFrom] = useState<ConversationMessage | null>(null),
    [changes, setChanges] = useState<{
      summary: ChangeSummary;
      context: ChangeContext;
    } | null>(null),
    [savedIds, setSavedIds] = useState<Set<string>>(new Set()),
    [usage, setUsage] = useState<{
      runs: Record<string, Usage>;
      total: Usage;
      memory?: string[];
    } | null>(null),
    [jump, setJump] = useState<string | null>(null),
    // How the current jump started: reopening at the reading position, or
    // going to a specific message (which is highlighted).
    [jumpKind, setJumpKind] = useState<"resume" | "jump">("jump"),
    // Where you were before going to a specific message, kept apart from
    // the saved reading position. null messageId: the latest messages.
    [origin, setOrigin] = useState<{ messageId: string | null } | null>(null),
    [resumed, setResumed] = useState(false),
    [editQueued, setEditQueued] = useState<QueuedMessage | null>(null);
  const activityHistory = useConversationActivities(
    id, (data?.messages || []).flatMap(message => message.run_id ? [message.run_id] : []),
    showToolActivity,
  );
  const activityItems = activityHistory.items;
  const allActivities = visibleActivities(activityItems);
  // The transcript shows only public messages. Tool calls, command output and
  // plan progress stay inspectable from the options menu; file changes have
  // their own per-run review.
  const toolActivities = allActivities.filter((item) =>
    ["tool", "output", "plan"].includes(item.record.kind),
  );
  // Older messages carry their activity in metadata rather than the live
  // activity store; include those records unless the store has them too.
  const toolRecords = () => {
    const live = toolActivities.map((item) => item.record);
    const same = (a: ActivityRecord, b: ActivityRecord) =>
      a.id === b.id &&
      a.kind === b.kind &&
      a.source.transport === b.source.transport &&
      a.source.harness === b.source.harness;
    const saved = (data?.messages || []).flatMap((m) => {
      const meta = parse<any>(m.metadata, {});
      return (
        (meta.activities || (meta.activity ? [meta.activity] : [])) as
          ActivityRecord[]
      ).filter(
        (record) =>
          ["tool", "output", "plan"].includes(record?.kind) &&
          !live.some((other) => same(other, record)),
      );
    });
    return [...live, ...saved];
  };
  const [newProvider, setNewProvider] = useState<Agent | null>(null);
  // The link target, a jump from the outline, or where you left off.
  const anchor = jump || messageId;
  // A link target or a jump is highlighted; resuming is not.
  const highlight =
    anchor && (anchor === messageId || jumpKind === "jump") ? anchor : null;
  const originRef = useRef(origin);
  originRef.current = origin;
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
  /**
   * Scroll the message list, and only it, to one message. scrollIntoView
   * would also scroll the sheet and the page behind it.
   */
  function scrollToMessage(message: HTMLElement, block: "center" | "start") {
    const messages = messagesRef.current;
    if (!messages) return;
    const offset =
      message.getBoundingClientRect().top -
      messages.getBoundingClientRect().top;
    messages.scrollTop +=
      block === "center"
        ? offset - (messages.clientHeight - message.offsetHeight) / 2
        : offset;
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
    // Inspecting a linked or searched-for message is not where you stopped
    // reading: the saved position stays until you go back or reach the end.
    if (originRef.current) return;
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
        undefined, undefined, readController.current?.signal,
      );
      if (initial && !anchor) {
        // Reopen where you stopped reading. Fetch the page around that
        // message if it is not loaded.
        const target = fresh.position_message_id || null;
        if (target) {
          if (!fresh.messages.some((m: Message) => m.id === target))
            fresh = await api(
              `/conversations/${id}?message=${encodeURIComponent(target)}`,
              undefined, undefined, readController.current?.signal,
            );
          if (fresh.messages.some((m: Message) => m.id === target)) {
            followLatest.current = false;
            setJumpKind("resume");
            setResumed(true);
            setJump(target);
          }
        }
      }
      if (current !== generation.current || ticket !== loadRequest.current)
        return;
      // Opened at a specific message (Saved, Search, a notification, the
      // Feed): remember the reading position to go back to.
      if (initial && messageId && anchor === messageId)
        setOrigin({ messageId: fresh.position_message_id || null });
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
    setJumpKind("jump");
    setOrigin(null);
    setResumed(false);
    positionSent.current = "";
  }, [id, messageId]);
  useEffect(() => {
    generation.current++;
    readController.current = new AbortController();
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
      readController.current?.abort();
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
        projectName: project?.name,
      });
  }, [id, readyKey, agent?.id, data?.conversation.title, imported, project?.name]);
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
    const block = highlight ? "center" : "start";
    const align = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!anchoring.current) return;
        scrollToMessage(message, block);
        setAwayFromLatest(
          messages.scrollHeight - messages.clientHeight - messages.scrollTop >= 48,
        );
        // Only a link or a jump focuses (and outlines) its message.
        if (!focused && highlight) message.focus({ preventScroll: true });
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
  }, [data?.conversation.id, id, anchor, highlight]);

  /** Go to one message from Jump to, remembering where you were. */
  function jumpTo(target: string) {
    if (!originRef.current)
      setOrigin({
        messageId: followLatest.current ? null : visibleMessageIds()[0] || null,
      });
    setResumed(false);
    goTo(target, "jump");
  }
  function goTo(target: string, kind: "resume" | "jump") {
    setJumpKind(kind);
    if (target === anchor) {
      const message = document.getElementById("message-" + target);
      if (message)
        scrollToMessage(message, kind === "jump" ? "center" : "start");
      return;
    }
    followLatest.current = false;
    setJump(target);
  }
  function goLatest() {
    anchoring.current = false;
    followLatest.current = true;
    setAwayFromLatest(false);
    setOrigin(null);
    setResumed(false);
    pinLatest();
    saveReadingPosition();
  }
  function markSaved(messageId: string, saved: boolean) {
    setSavedIds((old) => {
      const next = new Set(old);
      if (saved) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }
  async function setSavedOnServer(messageId: string, saved: boolean) {
    await api(
      `/messages/${messageId}/saved`,
      saved ? {} : undefined,
      saved ? "POST" : "DELETE",
    );
    window.dispatchEvent(new Event("loop-later-change"));
  }
  /**
   * Save at once, with Undo removing that save. Unsaving waits for the
   * toast to end, so Undo keeps the original save (and its place in Saved).
   */
  async function toggleSaved(message: Message) {
    const saved = savedIds.has(message.id);
    markSaved(message.id, !saved);
    if (saved) {
      notify({
        text: "Removed from Saved.",
        undo: () => markSaved(message.id, true),
        onExpire: () =>
          void setSavedOnServer(message.id, false).catch((e) => {
            markSaved(message.id, true);
            setError((e as Error).message);
          }),
      });
      return;
    }
    try {
      await setSavedOnServer(message.id, true);
      notify({
        text: "Saved. Find it in Later → Saved.",
        undo: async () => {
          await setSavedOnServer(message.id, false);
          markSaved(message.id, false);
        },
      });
    } catch (e) {
      markSaved(message.id, false);
      setError((e as Error).message);
    }
  }
  const latestRun = [...(data?.messages || [])]
    .reverse()
    .find((m) => m.run_id && m.run_state);
  // The thread's current work: a task in progress, else one waiting in the
  // queue, else its latest run. A newer cancelled or withdrawn follow-up
  // does not hide a task that is still running.
  const runOf = (states: string[]) =>
    [...(data?.messages || [])]
      .reverse()
      .find((m) => m.run_id && states.includes(m.run_state || ""));
  const currentRun =
    runOf(["running", "pausing", "paused", "awaiting_approval", "waiting_children"]) ||
    runOf(["queued"]) ||
    latestRun;
  const status = runStatus(currentRun?.run_state);
  const workState = currentRun?.run_state || "";
  // API, subscription, Codex, Claude and Pi turns take a message mid-task.
  // HAPI sessions and OpenCode and ACP turns queue every follow-up. The
  // server decides from the connection the current run started with.
  const steerable =
    ["running", "awaiting_approval"].includes(workState) &&
    !!currentRun?.run_id &&
    data?.steerable_run_id === currentRun.run_id;
  const workRef = useRef(onWork);
  workRef.current = onWork;
  useEffect(() => {
    const active = [
      "queued",
      "running",
      "pausing",
      "paused",
      "awaiting_approval",
      "waiting_children",
    ].includes(workState);
    workRef.current?.(active ? { state: workState, steerable } : null);
  }, [workState, steerable]);
  useEffect(() => () => workRef.current?.(null), []);
  // All file changes for a run, from live activities and saved history.
  // Every view of file changes merges recorded and live activity the same
  // way, so the run chip and the thread review count the same edits.
  function changeRecords(runId?: string) {
    // Each record keeps the run it belongs to: runs may reuse activity ids.
    const recorded = (data?.messages || [])
      .filter((m) => !runId || m.run_id === runId)
      .flatMap((m) => {
        const meta = parse<any>(m.metadata, {});
        return (
          (meta.activities ||
            (meta.activity ? [meta.activity] : [])) as ActivityRecord[]
        ).map((record) => ({ run: m.run_id ?? null, record }));
      });
    const live = allActivities
      .filter((a) => !runId || a.run === runId)
      .map((a) => ({ run: a.run, record: a.record }));
    return mergeActivityRecords(recorded, live);
  }
  /** Where reported changes were made, as far as Loop knows. */
  function changeContext(runId?: string): ChangeContext {
    // The run asked about, or every run in the thread that reported edits.
    const runs = runId
      ? [runId]
      : [
          ...new Set(
            (data?.messages || []).map((m) => m.run_id).filter(Boolean) as string[],
          ),
        ].filter(
          (run) =>
            summarizeChanges(changeRecords(run)).files.length > 0,
        );
    const starts = runs
      .map((run) =>
        Math.min(
          ...(data?.messages || [])
            .filter((m) => m.run_id === run)
            .map((m) => m.created_at),
        ),
      )
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return {
      agentName: agent?.name,
      projectName: project?.name,
      runStartedAt: starts,
      commands: changeRecords(runId)
        .filter((r) => r.kind === "output")
        .map((r) => {
          const output = r.data as {
            command?: string | null;
            cwd?: string | null;
            status?: string;
            exitCode?: number | null;
          };
          return {
            command: output.command || "",
            cwd: output.cwd,
            status: output.status,
            exitCode: output.exitCode,
          };
        })
        .filter((c) => c.command),
    };
  }
  const runChanges = (runId: string) => summarizeChanges(changeRecords(runId));
  const threadChanges = summarizeChanges(changeRecords());
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
      <CodeReviewStatus key={`${sourceId}:${id}`} conversationId={id} revision={revision} />
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
              label: "Remind me",
              icon: <AlarmClock size={20} />,
              onSelect: () =>
                setLaterFor({ kind: "conversation", id, title }),
            },
            ...(threadChanges.files.length
              ? [
                  {
                    id: "changes",
                    label: "Review reported changes",
                    hint: `${threadChanges.applied} files with applied edits · +${threadChanges.additions} −${threadChanges.deletions}`,
                    icon: <FileDiff size={20} />,
                    onSelect: () =>
                      setChanges({
                        summary: threadChanges,
                        context: changeContext(),
                      }),
                  },
                ]
              : []),
            {
              id: "tools",
              label: "Tool activity",
              icon: <Wrench size={20} />,
              onSelect: () => setShowToolActivity(true),
            },
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
                void shareLink(sourceUrl(sourceId, { conversation: id }), title).then(
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
          path={sourceUrl(sourceId, { conversation: id })}
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
            currentRun?.run_state || "",
          )}
          project={project ? { id: project.id, name: project.name } : undefined}
          onClose={() => setLaterFor(null)}
          onDone={(label, created) => {
            notify({
              text: `Reminder set: ${label.toLowerCase()}.`,
              link: onShowLater && {
                label: "View",
                onSelect: () => onShowLater("reminders", created.id),
              },
              undo: () => undoReminder(created, sourceId),
            });
            if (laterFor.kind === "conversation") onClose();
          }}
        />
      )}
      {menuFor && (() => {
        const menu = messageActions({
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
            onQuotePart: () => setQuoteFrom(menuFor),
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
            onFork: () => setForkFrom(menuFor),
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
                notify({
                  text: "Saved as a snippet. Type / in any composer to insert it.",
                });
              } catch (e) {
                setError((e as Error).message);
              }
            },
            onShare: () =>
              void shareLink(
                sourceUrl(sourceId, { conversation: id, message: menuFor.id }),
                title,
              ).then((text) => text && setNotice(text)),
          });
        return (
          <ActionSheet
            title={menuFor.role === "user" ? "Your message" : "Message"}
            onClose={() => setMenuFor(null)}
            primary={menu.primary}
            actions={menu.more}
            moreLabel="More"
          >
            <div className="action-preview">
              {preview(menuFor.content, 160) || "(no text)"}
            </div>
          </ActionSheet>
        );
      })()}
      {quoteFrom && agent && (
        <QuotePartSheet
          content={quoteFrom.content}
          onClose={() => setQuoteFrom(null)}
          onQuote={(excerpt) => {
            setQuoteFrom(null);
            onReply({
              agentId: agent.id,
              conversationId: id,
              messageId: quoteFrom.id,
              content: excerpt,
              excerpt: true,
              ...(quoteFrom.role === "user" ? { mine: true } : {}),
            });
          }}
        />
      )}
      {forkFrom && (
        <ForkSheet
          conversationId={id}
          messageId={forkFrom.id}
          source={forkFrom}
          projectName={project?.name}
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
          summary={changes.summary}
          context={changes.context}
          onClose={() => setChanges(null)}
          onAsk={agent && !imported ? onUsePrompt : undefined}
        />
      )}
      {showToolActivity && (
        <Sheet title="Tool activity" onClose={() => setShowToolActivity(false)}>
          <ActivityRecords records={toolRecords()} />
          {activityHistory.loading && <p role="status">Loading tool activity…</p>}
          {!activityHistory.loading && !activityHistory.error && !toolRecords().length && !activityHistory.hasEarlier && (
            <p className="field-hint">No tool activity yet.</p>
          )}
          {activityHistory.error && <p className="error" role="alert">{activityHistory.error}</p>}
          {activityHistory.hasEarlier && (
            <button type="button" disabled={activityHistory.loadingEarlier}
              onClick={() => { void activityHistory.loadEarlier(); }}>
              {activityHistory.loadingEarlier ? "Loading…" : "Load earlier activity"}
            </button>
          )}
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
            // Reading on to the latest messages ends the detour: there is
            // nothing to go back to, and the position may be saved again.
            if (following && originRef.current) {
              originRef.current = null;
              setOrigin(null);
            }
            if (following) setResumed(false);
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
                  anchored={highlight === m.id}
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
                        {m.role === "user"
                          ? automationLabel(
                              meta.automation?.kind,
                              agents.find(
                                (a) => a.id === meta.automation?.fromAgentId,
                              )?.name ?? meta.automation?.fromName,
                            )
                          : `@${agent?.name || "agent"}`}
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
                            // Only a message that has never started is taken back.
                            await onWithdraw(m.run_id!);
                            onSubmitted();
                            notify({ text: "Moved back to your draft. Nothing was sent." });
                            await load();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        Move to draft
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
                      <p className="field-hint queued-hint">
                        Starts after @{agent?.name || "the agent"}’s earlier
                        work. If that work pauses or waits for approval, this
                        stays held; if it fails or is cancelled, this starts
                        next. You can change it until it starts.
                      </p>
                    </div>
                  )}
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
                      {changed && (
                        <ChangesChip
                          summary={changed}
                          onOpen={() =>
                            setChanges({
                              summary: changed,
                              context: changeContext(m.run_id!),
                            })
                          }
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
                    !pendingAnswer &&
                    (usage?.memory?.includes(m.run_id) ||
                      (finalForRun && usage?.runs[m.run_id])) && (
                      <footer className="message-foot">
                        {usage?.memory?.includes(m.run_id) && (
                          <MemoryUsed runId={m.run_id} />
                        )}
                        {finalForRun && (
                          <UsageLine usage={usage?.runs[m.run_id]} />
                        )}
                      </footer>
                    )}
                </MessageShell>
              </div>
            );
          })}
          <ScheduledSends
            conversationId={id}
            revision={revision}
            onDraft={(item) =>
              onRestoreDraft(item.input, item.attachments || [])
            }
          />
        </div>
        {(origin || resumed || awayFromLatest) && (
          <div className="thread-return" role="group" aria-label="Thread position">
            {resumed && !origin && (
              <span className="thread-return-note" role="status">
                Resumed where you left off
              </span>
            )}
            {(awayFromLatest || resumed || origin) && (
              <button
                type="button"
                className="text-button conversation-latest"
                aria-label="Jump to latest messages"
                onClick={goLatest}
              >
                <ArrowDown size={16} aria-hidden="true" /> Latest
              </button>
            )}
          </div>
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
