import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlarmClock,
  Bookmark,
  BookmarkCheck,
  CircleAlert,
  Clock3,
  Copy,
  FileDiff,
  GitBranch,
  Link as LinkIcon,
  MessageSquareQuote,
  PencilLine,
  Reply,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import { api } from "./api";
import { RichText, Sheet } from "./components";
import { FileChangePanel } from "./ActivityPanels";
import type { Agent } from "../shared/types";
import {
  compactNumber,
  dayLabel,
  laterChoices,
  localInputValue,
  preview,
  timeLabel,
  type ChangeSummary,
} from "./threadView";

export type Action = {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** A bottom sheet of large, labelled actions: the mobile context menu. */
export function ActionSheet({
  title,
  actions,
  onClose,
  children,
}: {
  title: string;
  actions: Action[];
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Sheet title={title} onClose={onClose} className="action-sheet">
      {children}
      <div className="action-list" role="menu">
        {actions.map((action) => (
          <button
            key={action.id}
            role="menuitem"
            type="button"
            className={action.danger ? "danger" : ""}
            disabled={action.disabled}
            onClick={() => {
              onClose();
              action.onSelect();
            }}
          >
            {action.icon}
            <span>
              {action.label}
              {action.hint && <small>{action.hint}</small>}
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function messageActions({
  saved,
  canReply,
  canFork,
  onReply,
  onCopy,
  onSave,
  onLater,
  onFork,
  onReuse,
  onSnippet,
  onShare,
}: {
  saved: boolean;
  canReply: boolean;
  canFork: boolean;
  onReply: () => void;
  onCopy: () => void;
  onSave: () => void;
  onLater: () => void;
  onFork: () => void;
  onReuse: () => void;
  onSnippet: () => void;
  onShare: () => void;
}): Action[] {
  return [
    ...(canReply
      ? [{ id: "reply", label: "Reply", icon: <Reply size={20} />, onSelect: onReply }]
      : []),
    {
      id: "save",
      label: saved ? "Remove from Saved" : "Save",
      hint: saved ? undefined : "Keep it in Later → Saved",
      icon: saved ? <BookmarkCheck size={20} /> : <Bookmark size={20} />,
      onSelect: onSave,
    },
    {
      id: "later",
      label: "Remind me later",
      icon: <AlarmClock size={20} />,
      onSelect: onLater,
    },
    ...(canFork
      ? [
          {
            id: "fork",
            label: "Fork from here",
            hint: "Continue in a new thread from this point",
            icon: <GitBranch size={20} />,
            onSelect: onFork,
          },
        ]
      : []),
    {
      id: "reuse",
      label: "Reuse as new prompt",
      icon: <PencilLine size={20} />,
      onSelect: onReuse,
    },
    {
      id: "snippet",
      label: "Save as snippet",
      hint: "Type / in the composer to insert it",
      icon: <Sparkles size={20} />,
      onSelect: onSnippet,
    },
    { id: "copy", label: "Copy text", icon: <Copy size={20} />, onSelect: onCopy },
    {
      id: "share",
      label: "Share link",
      hint: "Opens this exact message on any paired device",
      icon: <LinkIcon size={20} />,
      onSelect: onShare,
    },
  ];
}

/** Snooze or remind: time presets, "when it finishes", "next time I open the project", or a custom time. */
export function LaterSheet({
  kind,
  targetId,
  title,
  running,
  project,
  onClose,
  onDone,
}: {
  kind: "conversation" | "artifact" | "message";
  targetId: string;
  title: string;
  running?: boolean;
  project?: { id: string; name: string };
  onClose: () => void;
  onDone: (label: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState(() =>
    localInputValue(Date.now() + 2 * 3600_000),
  );
  const choices = laterChoices(Date.now(), { running, project });
  async function save(
    condition: "time" | "run_finished" | "project_open",
    dueAt: number | undefined,
    label: string,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/later", {
        kind,
        targetId,
        condition,
        dueAt,
        projectId: condition === "project_open" ? project?.id : undefined,
      });
      window.dispatchEvent(new Event("loop-later-change"));
      onDone(label);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Remind me later" onClose={onClose} className="action-sheet">
      <p className="field-hint later-target">{title}</p>
      <div className="action-list">
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            disabled={busy}
            onClick={() =>
              void save(choice.condition, choice.dueAt, choice.label)
            }
          >
            <Clock3 size={20} />
            <span>
              {choice.label}
              {choice.hint && <small>{choice.hint}</small>}
            </span>
          </button>
        ))}
      </div>
      <label className="later-custom">
        Pick a time
        <span>
          <input
            type="datetime-local"
            value={custom}
            min={localInputValue(Date.now())}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            className="secondary"
            disabled={busy || !custom}
            onClick={() => {
              const at = new Date(custom).getTime();
              if (!(at > Date.now())) {
                setError("Choose a time in the future.");
                return;
              }
              void save(
                "time",
                at,
                `${dayLabel(at)} at ${timeLabel(at)}`,
              );
            }}
          >
            Set
          </button>
        </span>
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Sheet>
  );
}

type OutlineItem = {
  message_id: string;
  kind: "prompt" | "result" | "approval" | "failure" | "saved";
  preview: string;
  created_at: number;
};
const outlineIcon = {
  prompt: <User size={17} />,
  result: <MessageSquareQuote size={17} />,
  approval: <ShieldCheck size={17} />,
  failure: <CircleAlert size={17} />,
  saved: <Bookmark size={17} />,
};
const outlineLabel = {
  prompt: "You",
  result: "Result",
  approval: "Approval",
  failure: "Failed",
  saved: "Saved",
};

/** Table of contents for a long thread: your prompts plus its decision points. */
export function OutlineSheet({
  conversationId,
  onJump,
  onClose,
}: {
  conversationId: string;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | OutlineItem["kind"]>("all");
  useEffect(() => {
    let active = true;
    api<{ items: OutlineItem[] }>(`/conversations/${conversationId}/outline`)
      .then((result) => active && setItems(result.items))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [conversationId]);
  const visible = (items || []).filter(
    (item) => filter === "all" || item.kind === filter,
  );
  let previous: number | undefined;
  return (
    <Sheet title="Jump to…" onClose={onClose} className="outline-sheet">
      <div className="chip-row" role="group" aria-label="Show">
        {(
          [
            ["all", "Everything"],
            ["prompt", "Your prompts"],
            ["result", "Results"],
            ["saved", "Saved"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!items && !error && <p role="status">Loading outline…</p>}
      {items && !visible.length && (
        <p className="note">Nothing to show in this view yet.</p>
      )}
      <ol className="outline-list">
        {visible.map((item) => {
          const day =
            previous === undefined ||
            dayLabel(previous) !== dayLabel(item.created_at);
          previous = item.created_at;
          return (
            <li key={item.kind + item.message_id} data-kind={item.kind}>
              {day && <h3 className="day-label">{dayLabel(item.created_at)}</h3>}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onJump(item.message_id);
                }}
              >
                <span className="outline-icon" aria-hidden="true">
                  {outlineIcon[item.kind]}
                </span>
                <span className="outline-copy">
                  <small>
                    {outlineLabel[item.kind]} · {timeLabel(item.created_at)}
                  </small>
                  <span>{preview(item.preview, 160) || "(no text)"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** What happened besides applied changes, e.g. "1 proposed · 1 failed". */
function otherActivity(summary: ChangeSummary) {
  return [
    summary.proposed && `${summary.proposed} not applied`,
    summary.failed && `${summary.failed} failed`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One-line summary of a run's reported file activity. Opens the review. */
export function ChangesChip({
  summary,
  onOpen,
}: {
  summary: ChangeSummary;
  onOpen: () => void;
}) {
  if (!summary.files.length) return null;
  const other = otherActivity(summary);
  return (
    <button type="button" className="changes-chip" onClick={onOpen}>
      <FileDiff size={16} aria-hidden="true" />
      {summary.applied ? (
        <>
          <span>{plural(summary.applied, "file")} changed</span>
          <span className="diff-add-count">+{summary.additions}</span>
          <span className="diff-remove-count">−{summary.deletions}</span>
          {other && <span className="changes-other">· {other}</span>}
        </>
      ) : (
        <span>File activity · {other}</span>
      )}
    </button>
  );
}

const stateLabel = {
  applied: "Applied",
  proposed: "Not applied",
  failed: "Failed",
} as const;
const editLabel = {
  applied: "Applied",
  proposed: "Proposed",
  failed: "Failed",
  unknown: "Unconfirmed",
} as const;

/**
 * Phone-sized review of the file activity the agent's tools reported. Follow-
 * up actions are prompts to the agent that made the change: Loop never
 * applies, commits or reverts files itself, so the harness keeps ownership of
 * the working tree. Only applied edits are offered for review actions.
 */
export function ChangesSheet({
  summary,
  onClose,
  onAsk,
}: {
  summary: ChangeSummary;
  onClose: () => void;
  onAsk?: (prompt: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const paths = summary.files
    .filter((file) => file.state === "applied")
    .map((file) => file.path);
  const other = otherActivity(summary);
  const ask = (prompt: string) => {
    onClose();
    onAsk?.(prompt);
  };
  return (
    <Sheet title="Changes" wide onClose={onClose} className="changes-sheet">
      <p className="changes-total">
        {plural(summary.applied, "file")} changed ·{" "}
        <span className="diff-add-count">+{summary.additions}</span>{" "}
        <span className="diff-remove-count">−{summary.deletions}</span>
        {other && <> · {other}</>}
      </p>
      <p className="field-hint">
        As reported by the agent’s tools while it worked, edit by edit. This is
        not a diff of the working tree: changes made another way, such as by a
        shell command, are not included.
      </p>
      <ul className="changes-files" aria-label="Changed files">
        {summary.files.map((file) => (
          <li key={file.path} data-state={file.state}>
            <button
              type="button"
              aria-current={selected === file.path || undefined}
              onClick={() => {
                setSelected(file.path);
                refs.current
                  .get(file.path)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
            >
              <span className={"operation " + file.operation}>
                {file.operation[0].toUpperCase()}
              </span>
              <code>{file.path}</code>
              {file.state === "applied" ? (
                <>
                  <span className="diff-add-count">+{file.additions}</span>
                  <span className="diff-remove-count">−{file.deletions}</span>
                </>
              ) : (
                <span className="change-state">{stateLabel[file.state]}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {onAsk && paths.length > 0 && (
        <>
          <div className="changes-actions">
            <button
              type="button"
              className="primary"
              onClick={() =>
                ask(
                  "Looks good. Commit these changes with a clear message:\n" +
                    paths.map((path) => `- ${path}`).join("\n"),
                )
              }
            >
              Ask to commit
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                ask("Push these changes to a new branch and open a pull request.")
              }
            >
              Ask for a PR
            </button>
            <button
              type="button"
              className="secondary danger"
              onClick={() =>
                ask(
                  "Revert the changes you made to these files:\n" +
                    paths.map((path) => `- ${path}`).join("\n"),
                )
              }
            >
              Ask to revert
            </button>
          </div>
          <p className="field-hint">
            These cover the {plural(paths.length, "file")} with applied edits
            and fill in the composer so you can edit before sending. Loop never
            changes files itself.
          </p>
        </>
      )}
      {summary.files.map((file) => (
        <div
          key={file.path}
          ref={(node) => {
            if (node) refs.current.set(file.path, node);
            else refs.current.delete(file.path);
          }}
        >
          {file.edits.map((edit, index) => (
            <FileChangePanel
              key={index}
              {...edit}
              state={`${file.edits.length > 1 ? `Edit ${index + 1} of ${file.edits.length} · ` : ""}${editLabel[edit.state as keyof typeof editLabel] || "Unconfirmed"} · ${edit.operation}`}
              reason={
                edit.reason ||
                (edit.content !== "available" ? edit.content : undefined)
              }
            />
          ))}
        </div>
      ))}
    </Sheet>
  );
}

/** Fork a thread from one message into a new conversation. */
export function ForkSheet({
  conversationId,
  messageId,
  agents,
  defaultAgentId,
  onClose,
  onForked,
}: {
  conversationId: string;
  messageId: string;
  agents: Agent[];
  defaultAgentId?: string;
  onClose: () => void;
  onForked: (conversationId: string, agentId: string) => void;
}) {
  const choices = agents.filter((a) => a.connection_id && !a.retired_at);
  const [agentId, setAgentId] = useState(
    choices.find((a) => a.id === defaultAgentId)?.id || choices[0]?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title="Fork from here" onClose={onClose}>
      <p className="note">
        Starts a new thread with every message up to this point. The original
        thread is not changed.
      </p>
      <label>
        Continue with
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {choices.map((agent) => (
            <option key={agent.id} value={agent.id}>
              @{agent.name}
              {agent.id === defaultAgentId ? " (same agent)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">
        A different agent receives the copied messages as context when you send
        your next prompt.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || !agentId}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const result = await api<{ id: string; agentId: string }>(
              `/conversations/${conversationId}/fork`,
              { messageId, agentId },
            );
            onForked(result.id, result.agentId);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <GitBranch size={17} /> {busy ? "Forking…" : "Create fork"}
      </button>
    </Sheet>
  );
}

type ScheduledSend = {
  id: string;
  input: string;
  send_at: number;
  agent_id: string;
  state: "scheduled" | "failed";
  error: string | null;
  conversation_id: string | null;
  agent_name?: string | null;
  conversation_title?: string | null;
  folder_name?: string | null;
};

/** Change the text or time of a message that has not been sent yet. */
function EditScheduled({
  item,
  onClose,
  onSaved,
}: {
  item: ScheduledSend;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(item.input);
  const [at, setAt] = useState(localInputValue(item.send_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title="Edit scheduled message" onClose={onClose}>
      <label>
        Message
        <textarea
          value={text}
          rows={6}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label>
        Send at
        <input
          type="datetime-local"
          value={at}
          min={localInputValue(Date.now())}
          onChange={(e) => setAt(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !text.trim() || !at}
        onClick={async () => {
          setBusy(true);
          try {
            await api(
              "/scheduled-sends/" + item.id,
              { input: text, sendAt: new Date(at).getTime() },
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

/**
 * Scheduled messages that still need you: waiting to send (edit or cancel),
 * or not sent because Loop refused them when due (send now or dismiss).
 * In a thread they read like your own messages; owner-wide (Later) each also
 * names its recipient and where it goes.
 */
export function ScheduledSends({
  conversationId,
  revision,
  onOpen,
  failedOnly = false,
}: {
  conversationId?: string;
  revision: number;
  onOpen?: (conversationId: string) => void;
  /** Only messages that could not be sent (for Needs you). */
  failedOnly?: boolean;
}) {
  const [all, setItems] = useState<ScheduledSend[]>([]);
  // Older messages that could not be sent load a page at a time.
  const [failedNext, setFailedNext] = useState<string | null>(null);
  const items = failedOnly ? all.filter((item) => item.state === "failed") : all;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ScheduledSend | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  type Page = { items: ScheduledSend[]; failed_next: string | null };
  const query = (failedBefore?: string) => {
    const q = new URLSearchParams();
    if (conversationId) q.set("conversation", conversationId);
    if (failedBefore) q.set("failedBefore", failedBefore);
    return "/scheduled-sends" + (q.size ? "?" + q : "");
  };
  const load = () =>
    api<Page>(query())
      .then((result) => {
        setItems(result.items);
        setFailedNext(result.failed_next);
        setLoaded(true);
      })
      .catch((e) => setError((e as Error).message));
  const loadOlder = async () => {
    if (!failedNext) return;
    try {
      const page = await api<Page>(query(failedNext));
      setItems((old) => {
        const failed = old.filter((item) => item.state === "failed");
        return [
          ...failed,
          ...page.items.filter((item) => !failed.some((f) => f.id === item.id)),
          ...old.filter((item) => item.state !== "failed"),
        ];
      });
      setFailedNext(page.failed_next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    window.addEventListener("loop-scheduled-change", load);
    return () => window.removeEventListener("loop-scheduled-change", load);
  }, [conversationId, revision]);
  const act = async (item: ScheduledSend, action: "cancel" | "retry") => {
    setBusy(item.id);
    setError("");
    try {
      if (action === "cancel")
        await api("/scheduled-sends/" + item.id, undefined, "DELETE");
      else {
        const result = await api<{ run: { id: string } | null; row: ScheduledSend }>(
          `/scheduled-sends/${item.id}/retry`,
          {},
        );
        if (!result.run)
          setError(result.row.error || "Loop could not send this message.");
      }
      await load();
      window.dispatchEvent(new Event("loop-scheduled-change"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const global = !conversationId;
  if (failedOnly && !items.length) return null;
  if (global && !loaded) return <p className="section-empty">Loading…</p>;
  if (!items.length)
    return global ? (
      <p className="section-empty">
        Nothing scheduled. Use “Send later” in the composer to schedule a
        message.
      </p>
    ) : null;
  return (
    <section className="scheduled-sends" aria-label="Scheduled messages">
      {items.map((item) => {
        const failed = item.state === "failed";
        const where = [
          item.agent_name && "To @" + item.agent_name,
          item.folder_name,
          item.conversation_title || (global ? "New thread" : ""),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <article
            key={item.id}
            className={
              "message user scheduled-message" + (failed ? " not-sent" : "")
            }
          >
            <header className="message-meta">
              <span className="eyebrow">
                {failed ? "Not sent" : "You · Scheduled"}
              </span>
              <span className="message-meta-end">
                {failed ? (
                  <CircleAlert size={14} aria-hidden="true" />
                ) : (
                  <Clock3 size={14} aria-hidden="true" />
                )}
                <time dateTime={new Date(item.send_at).toISOString()}>
                  {failed ? "Was due" : "Sends"}{" "}
                  {dayLabel(item.send_at).toLowerCase()} at{" "}
                  {timeLabel(item.send_at)}
                </time>
              </span>
            </header>
            {global && where && <p className="field-hint">{where}</p>}
            <RichText content={item.input} />
            {failed && (
              <p className="error" role="status">
                Loop could not send this: {item.error || "it was refused."} Nothing
                was sent.
              </p>
            )}
            <div className="scheduled-actions">
              {failed ? (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy === item.id}
                  onClick={() => void act(item, "retry")}
                >
                  <Reply size={16} /> Send now
                </button>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  aria-label="Edit scheduled message"
                  onClick={() => setEditing(item)}
                >
                  <PencilLine size={16} /> Edit
                </button>
              )}
              <button
                type="button"
                className="text-button"
                aria-label={
                  failed ? "Dismiss message" : "Cancel scheduled message"
                }
                disabled={busy === item.id}
                onClick={() => void act(item, "cancel")}
              >
                <Trash2 size={16} /> {failed ? "Dismiss" : "Cancel"}
              </button>
              {global && item.conversation_id && onOpen && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onOpen(item.conversation_id!)}
                >
                  Open thread
                </button>
              )}
            </div>
          </article>
        );
      })}
      {failedNext && (
        <button
          type="button"
          className="secondary load-more"
          onClick={() => void loadOlder()}
        >
          More not sent
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {editing && (
        <EditScheduled
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void load();
            window.dispatchEvent(new Event("loop-scheduled-change"));
          }}
        />
      )}
    </section>
  );
}

export function UsageLine({
  usage,
}: {
  usage?: { input_tokens: number; output_tokens: number };
}) {
  if (!usage) return null;
  return (
    <p className="usage-line">
      {compactNumber(usage.input_tokens)} in ·{" "}
      {compactNumber(usage.output_tokens)} out tokens
    </p>
  );
}

/**
 * Long press (500ms, cancelled by movement) for touch context menus. Returns
 * pointer handlers; the click that follows a completed press is suppressed.
 */
export function useLongPress(
  onPress: () => void,
  enabled = true,
  { onControls = false }: { onControls?: boolean } = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  if (!enabled) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (
        e.button !== 0 ||
        (!onControls &&
          (e.target as HTMLElement).closest(
            "a,button,summary,input,textarea,select,pre,.table-scroll",
          ))
      )
        return;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        onPress();
      }, 500);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) >
        10
      )
        clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a,pre,code,img")) return;
      e.preventDefault();
      clear();
      fired.current = true;
      onPress();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

/**
 * Horizontal swipe on a row or message. Returns the live offset for styling and
 * pointer handlers. `onLeft`/`onRight` fire past 72px when the gesture is
 * clearly horizontal; vertical scrolling is never captured.
 */
export function useSwipe({
  onLeft,
  onRight,
}: {
  onLeft?: () => void;
  onRight?: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);
  // A horizontal drag must not also count as a tap on the row it moved.
  const dragged = useRef(false);
  const threshold = 72;
  const reset = () => {
    start.current = null;
    horizontal.current = null;
    setOffset(0);
  };
  return {
    offset,
    armed:
      offset >= threshold ? "right" : offset <= -threshold ? "left" : null,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === "mouse") return;
        if ((e.target as HTMLElement).closest("pre,.table-scroll,input,textarea"))
          return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        horizontal.current = null;
        dragged.current = false;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x,
          dy = e.clientY - s.y;
        if (horizontal.current === null && Math.hypot(dx, dy) > 10)
          horizontal.current = Math.abs(dx) > Math.abs(dy) * 1.5;
        if (!horizontal.current) return;
        dragged.current = true;
        const allowed = (dx > 0 && onRight) || (dx < 0 && onLeft);
        setOffset(allowed ? Math.max(-120, Math.min(120, dx)) : 0);
      },
      onPointerUp: () => {
        if (offset >= threshold) onRight?.();
        else if (offset <= -threshold) onLeft?.();
        reset();
      },
      onPointerCancel: reset,
      onClickCapture: (e: React.MouseEvent) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}

export function Chip({
  tone,
  children,
}: {
  tone: string;
  children: ReactNode;
}) {
  return <span className={"status-chip " + tone}>{children}</span>;
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Close"
      onClick={onClick}
    >
      <X size={20} />
    </button>
  );
}
