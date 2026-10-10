import { useSourceApi, useSourceId } from "./SourceContext";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlarmClock,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  FileDiff,
  GitBranch,
  Link as LinkIcon,
  MessageSquareQuote,
  MoreHorizontal,
  PencilLine,
  Reply,
  Search,
  ShieldCheck,
  Sparkles,
  TextQuote,
  Trash2,
  User,
  X,
} from "lucide-react";
import { apiInWorkspace } from "./api";
import { executionSourceId } from "./sourceRouting";
import { RichText, Sheet } from "./components";
import { FileChangePanel } from "./ActivityPanels";
import type { Agent } from "../shared/types";
import type { UploadedFile } from "../shared/uploads";
import {
  compactNumber,
  dayLabel,
  laterChoices,
  localInputValue,
  preview,
  timeLabel,
  changePrompts,
  commandOutcome,
  displayCommand,
  type ChangeContext,
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

/**
 * A bottom sheet of large, labelled actions: the mobile context menu.
 * `primary` actions sit in a row at the top; with `moreLabel` the other
 * actions stay behind a visible "More" control until it is opened.
 */
export function ActionSheet({
  title,
  actions,
  primary,
  moreLabel,
  onClose,
  children,
}: {
  title: string;
  actions: Action[];
  primary?: Action[];
  moreLabel?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [more, setMore] = useState(!moreLabel);
  const select = (action: Action) => {
    onClose();
    action.onSelect();
  };
  return (
    <Sheet title={title} onClose={onClose} className="action-sheet">
      {children}
      {!!primary?.length && (
        <div className="action-primary" role="group" aria-label="Main actions">
          {primary.map((action) => (
            <button
              key={action.id}
              type="button"
              className={action.danger ? "danger" : ""}
              disabled={action.disabled}
              onClick={() => select(action)}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
      {moreLabel && (
        <button
          type="button"
          className="action-more-toggle"
          aria-expanded={more}
          aria-controls="action-more-list"
          onClick={() => setMore((open) => !open)}
        >
          <MoreHorizontal size={20} aria-hidden="true" />
          <span>{moreLabel}</span>
          <ChevronDown size={18} aria-hidden="true" className="toggle-caret" />
        </button>
      )}
      {more && (
        <div className="action-list" role="menu" id="action-more-list">
          {actions.map((action) => (
            <button
              key={action.id}
              role="menuitem"
              type="button"
              className={action.danger ? "danger" : ""}
              disabled={action.disabled}
              onClick={() => select(action)}
            >
              {action.icon}
              <span>
                {action.label}
                {action.hint && <small>{action.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/**
 * A message's menu. Reply, Save and Remind me are the main actions; the rest
 * sit under More, each saying at the point of use what it does.
 */
export function messageActions({
  saved,
  canReply,
  canFork,
  onReply,
  onQuotePart,
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
  onQuotePart: () => void;
  onCopy: () => void;
  onSave: () => void;
  onLater: () => void;
  onFork: () => void;
  onReuse: () => void;
  onSnippet: () => void;
  onShare: () => void;
}): { primary: Action[]; more: Action[] } {
  return {
    primary: [
      ...(canReply
        ? [
            {
              id: "reply",
              label: "Reply",
              icon: <Reply size={20} />,
              onSelect: onReply,
            },
          ]
        : []),
      {
        id: "save",
        label: saved ? "Unsave" : "Save",
        icon: saved ? <BookmarkCheck size={20} /> : <Bookmark size={20} />,
        onSelect: onSave,
      },
      {
        id: "later",
        label: "Remind me",
        icon: <AlarmClock size={20} />,
        onSelect: onLater,
      },
    ],
    more: [
      ...(canReply
        ? [
            {
              id: "quote-part",
              label: "Reply to part",
              hint: "Highlight the lines you mean. Only those are quoted to the agent.",
              icon: <TextQuote size={20} />,
              onSelect: onQuotePart,
            },
          ]
        : []),
      ...(canFork
        ? [
            {
              id: "fork",
              label: "Fork from here",
              hint: "New thread with the conversation up to this message. Files are not rewound.",
              icon: <GitBranch size={20} />,
              onSelect: onFork,
            },
          ]
        : []),
      {
        id: "reuse",
        label: "Reuse as prompt",
        hint: "Puts this text in an editable draft. Nothing is sent until you send it.",
        icon: <PencilLine size={20} />,
        onSelect: onReuse,
      },
      {
        id: "snippet",
        label: "Save as snippet",
        hint: "Stores it as reusable instructions. Type / in any composer to insert it.",
        icon: <Sparkles size={20} />,
        onSelect: onSnippet,
      },
      {
        id: "copy",
        label: "Copy text",
        icon: <Copy size={20} />,
        onSelect: onCopy,
      },
      {
        id: "share",
        label: "Share link",
        hint: "Opens this exact message on any paired device",
        icon: <LinkIcon size={20} />,
        onSelect: onShare,
      },
    ],
  };
}

/**
 * Reply to part of a message: the text is selectable as written, so the
 * excerpt is exactly what the message contains and the server can verify it.
 */
export function QuotePartSheet({
  content,
  onClose,
  onQuote,
}: {
  content: string;
  onClose: () => void;
  onQuote: (excerpt: string) => void;
}) {
  const [excerpt, setExcerpt] = useState("");
  const pick = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    setExcerpt(content.slice(t.selectionStart, t.selectionEnd).trim());
  };
  return (
    <Sheet title="Reply to part" onClose={onClose}>
      <p className="field-hint">
        Highlight the lines you mean. Only those are quoted to the agent.
      </p>
      <textarea
        className="quote-part-text"
        aria-label="Message text"
        readOnly
        rows={10}
        value={content}
        onSelect={pick}
      />
      <button
        className="primary"
        disabled={!excerpt}
        onClick={() => onQuote(excerpt)}
      >
        <TextQuote size={18} /> Reply to selection
      </button>
    </Sheet>
  );
}

/** A reminder Loop created, for the confirmation's link and Undo. */
export type CreatedReminder = { id: string; replaced: string | null };

/**
 * Remind me: time presets, "when it finishes", "next time I open the
 * project", or a custom time. A reminder only brings the item back to you;
 * nothing is sent to an agent. With `itemId` it snoozes that reminder again.
 */
export function LaterSheet({
  kind,
  targetId,
  itemId,
  title,
  running,
  project,
  sourceId,
  onClose,
  onDone,
}: {
  kind: "conversation" | "artifact" | "message" | "story";
  targetId: string;
  /** Snooze this existing reminder again instead of creating one. */
  itemId?: string;
  title: string;
  running?: boolean;
  project?: { id: string; name: string };
  sourceId?: string;
  onClose: () => void;
  onDone: (label: string, created: CreatedReminder) => void;
}) {
  const scopedSource = useSourceId();
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
    const trigger = {
      condition,
      dueAt,
      projectId: condition === "project_open" ? project?.id : undefined,
    };
    try {
      const row = await apiInWorkspace<{
        id: string;
        replaced?: string | null;
      }>(
        itemId ? `/later/${itemId}/snooze` : "/later",
        sourceId ?? scopedSource,
        itemId ? trigger : { kind, targetId, ...trigger },
      );
      window.dispatchEvent(new Event("loop-later-change"));
      onDone(label, { id: row.id, replaced: row.replaced ?? null });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={itemId ? "Snooze again" : "Remind me"}
      onClose={onClose}
      className="action-sheet"
    >
      <p className="later-target">
        <strong>{title}</strong>
        <small>
          Brings this back to you in Later → Reminders. Nothing is sent to an
          agent.
        </small>
      </p>
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
              void save("time", at, `${dayLabel(at)} at ${timeLabel(at)}`);
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

/**
 * Undo a reminder Loop just created: cancel it, and reopen the reminder it
 * replaced, if any. Both are true reversals: nothing was sent anywhere.
 */
export async function undoReminder(
  created: CreatedReminder,
  sourceId = executionSourceId(),
) {
  await apiInWorkspace("/later/" + created.id, sourceId, undefined, "DELETE");
  if (created.replaced)
    await apiInWorkspace(
      `/later/${created.replaced}/reopen`,
      sourceId,
      {},
    ).catch(() => {});
  window.dispatchEvent(new Event("loop-later-change"));
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

type ThreadMatch = {
  message_id: string;
  kind: "prompt" | "response" | "update" | "result" | "failure";
  saved: boolean;
  preview: string;
  created_at: number;
};
const matchLabel = {
  prompt: "You",
  response: "Agent",
  update: "Update",
  result: "Result",
  failure: "Failed",
};
const matchIcon = {
  prompt: <User size={17} />,
  response: <MessageSquareQuote size={17} />,
  update: <MessageSquareQuote size={17} />,
  result: <MessageSquareQuote size={17} />,
  failure: <CircleAlert size={17} />,
};
const outlineFilters = [
  ["all", "Everything"],
  ["prompt", "Your prompts"],
  ["result", "Results"],
  ["approval", "Approvals"],
  ["failure", "Failures"],
  ["saved", "Saved"],
] as const;

/**
 * Table of contents for a long thread: your prompts plus its decision
 * points, and a search across the text of every message in it.
 */
export function OutlineSheet({
  conversationId,
  onJump,
  onClose,
}: {
  conversationId: string;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const api = useSourceApi();
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | OutlineItem["kind"]>("all");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ThreadMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchAttempt, setSearchAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api<{ items: OutlineItem[] }>(`/conversations/${conversationId}/outline`)
      .then((result) => active && setItems(result.items))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [conversationId]);
  // Searching waits for a pause in typing; the newest query wins.
  useEffect(() => {
    const text = query.trim();
    setMatches(null);
    setSearchError("");
    if (!text) {
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ matches: ThreadMatch[] }>(
        `/conversations/${conversationId}/outline?q=${encodeURIComponent(text)}`,
      )
        .then((result) => active && setMatches(result.matches))
        .catch((e) => active && setSearchError((e as Error).message))
        .finally(() => active && setSearching(false));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [conversationId, query, searchAttempt]);
  const visible = (items || []).filter(
    (item) => filter === "all" || item.kind === filter,
  );
  const filterName =
    outlineFilters.find(([value]) => value === filter)?.[1] || "Everything";
  const jump = (messageId: string) => {
    onClose();
    onJump(messageId);
  };
  let previous: number | undefined;
  return (
    <Sheet title="Jump to…" onClose={onClose} className="outline-sheet">
      <form
        className="search-box outline-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearchAttempt((attempt) => attempt + 1);
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          enterKeyHint="search"
          aria-label="Search this thread"
          placeholder="Search this thread"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      {query.trim() ? (
        <>
          <p className="outline-status" role="status">
            {searching || (!matches && !searchError)
              ? "Searching…"
              : searchError
                ? "Search unavailable"
                : `${plural(matches!.length, "match", "matches")} for “${query.trim()}”`}
          </p>
          {searchError && (
            <div>
              <p role="alert" className="error">
                {searchError}
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => setSearchAttempt((attempt) => attempt + 1)}
              >
                Try again
              </button>
            </div>
          )}
          <ol className="outline-list">
            {(matches || []).map((match) => (
              <li key={match.kind + match.message_id} data-kind={match.kind}>
                <button type="button" onClick={() => jump(match.message_id)}>
                  <span className="outline-icon" aria-hidden="true">
                    {matchIcon[match.kind]}
                  </span>
                  <span className="outline-copy">
                    <small>
                      {matchLabel[match.kind]}
                      {match.saved ? " · Saved" : ""} ·{" "}
                      {dayLabel(match.created_at)} {timeLabel(match.created_at)}
                    </small>
                    <span>{match.preview || "(no text)"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <div className="chip-row" role="group" aria-label="Show">
            {outlineFilters.map(([value, label]) => (
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
          {/* The chips can scroll out of view; this line always says what is shown. */}
          {items && (
            <p className="outline-status" role="status">
              Showing {filterName.toLowerCase()} · {visible.length}
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
                  {day && (
                    <h3 className="day-label">{dayLabel(item.created_at)}</h3>
                  )}
                  <button type="button" onClick={() => jump(item.message_id)}>
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
        </>
      )}
      {!query.trim() && error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Sheet>
  );
}

const plural = (count: number, word: string, multiple = `${word}s`) =>
  `${count} ${count === 1 ? word : multiple}`;

/** What happened besides applied changes, e.g. "1 not applied · 1 failed". */
function otherActivity(summary: ChangeSummary) {
  return [
    summary.proposed && `${summary.proposed} not applied`,
    summary.failed && `${summary.failed} failed`,
    summary.unavailable && `${summary.unavailable} unconfirmed`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One-line summary of a run's reported file activity. Opens the review. */
export type { ChangeContext };

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

const sections = [
  ["applied", "Applied"],
  ["proposed", "Proposed, not applied"],
  ["failed", "Failed"],
  ["unavailable", "Outcome not reported"],
] as const;
const editLabel = {
  applied: "Applied",
  proposed: "Proposed",
  failed: "Failed",
  unknown: "Outcome not reported",
} as const;

/**
 * Phone-sized review of the file activity the agent's tools reported. It is
 * reported activity, not a diff of the repository. Follow-up actions fill in
 * an editable prompt to the agent that made the change: Loop never applies,
 * commits or reverts files itself, so the harness keeps ownership of the
 * working tree. Only applied edits are offered for review actions.
 */
export function ChangesSheet({
  summary,
  context,
  onClose,
  onAsk,
}: {
  summary: ChangeSummary;
  context?: ChangeContext;
  onClose: () => void;
  onAsk?: (prompt: string) => void;
}) {
  const paths = summary.files
    .filter((file) => file.state === "applied")
    .map((file) => file.path);
  const other = otherActivity(summary);
  const prompts = changePrompts(paths, context);
  const ask = (prompt: string) => {
    onClose();
    onAsk?.(prompt);
  };
  const commands = context?.commands || [];
  const folders = [
    ...new Set(commands.map((c) => c.cwd).filter(Boolean)),
  ] as string[];
  const failedCommands = commands.filter(
    (c) => commandOutcome(c).failed,
  ).length;
  const starts = context?.runStartedAt || [];
  const meta = [
    context?.agentName && `@${context.agentName}`,
    context?.projectName || "Unfiled",
    starts.length === 1
      ? `started ${dayLabel(starts[0]).toLowerCase()} at ${timeLabel(starts[0])}`
      : starts.length > 1 && `${starts.length} runs`,
  ].filter(Boolean);
  // A few files read best expanded; a long list starts collapsed.
  const expanded = summary.files.length <= 3;
  return (
    <Sheet
      title="Reported file activity"
      wide
      onClose={onClose}
      className="changes-sheet"
    >
      <div className="changes-head">
        <p className="changes-total">
          {summary.applied
            ? `${plural(summary.applied, "file")} with applied edits`
            : "No applied edits"}{" "}
          <span className="diff-add-count">+{summary.additions}</span>{" "}
          <span className="diff-remove-count">−{summary.deletions}</span>
          {other && <span className="changes-other"> · {other}</span>}
        </p>
        <p className="changes-meta">
          {meta.join(" · ")}
          {folders.length === 1 && (
            <>
              {" · in "}
              <code>{folders[0]}</code>
            </>
          )}
        </p>
      </div>
      {sections.map(([state, label]) => {
        const files = summary.files.filter((file) => file.state === state);
        if (!files.length) return null;
        return (
          <section
            key={state}
            className="changes-group"
            data-state={state}
            aria-label={label + " files"}
          >
            <h3>
              {label} · {files.length}
            </h3>
            {files.map((file) => (
              <details
                key={file.path}
                className="changes-diff"
                data-state={file.state}
                open={expanded || undefined}
              >
                <summary>
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className="changes-toggle"
                  />
                  <span
                    className={"operation " + file.operation}
                    title={file.operation}
                  >
                    {file.operation[0].toUpperCase()}
                  </span>
                  <FilePath path={file.path} />
                  {file.edits.length > 1 && (
                    <span className="change-state">×{file.edits.length}</span>
                  )}
                  {file.state === "applied" && (
                    <span className="changes-counts">
                      <span className="diff-add-count">+{file.additions}</span>
                      <span className="diff-remove-count">
                        −{file.deletions}
                      </span>
                    </span>
                  )}
                </summary>
                {file.edits.map((edit, index) => (
                  <FileChangePanel
                    key={index}
                    {...edit}
                    showPath={!!edit.oldPath}
                    label={
                      file.edits.length > 1
                        ? `Edit ${index + 1} of ${file.edits.length}`
                        : "Edit"
                    }
                    state={`${editLabel[edit.state as keyof typeof editLabel] || "Outcome not reported"} · ${edit.operation}`}
                    reason={
                      edit.reason ||
                      (edit.content !== "available"
                        ? `Content ${edit.content}`
                        : undefined)
                    }
                  />
                ))}
              </details>
            ))}
          </section>
        );
      })}
      {onAsk && paths.length > 0 && (
        <>
          <div className="changes-actions">
            <button
              type="button"
              className="primary"
              onClick={() => ask(prompts.commit)}
            >
              Ask to commit
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => ask(prompts.pr)}
            >
              Ask for a PR
            </button>
            <button
              type="button"
              className="secondary danger"
              onClick={() => ask(prompts.revert)}
            >
              Ask to revert
            </button>
          </div>
          <p className="field-hint">
            Fills in an editable prompt asking @
            {context?.agentName || "the agent"} to check the full diff first.
            Nothing is sent until you send it.
          </p>
        </>
      )}
      {commands.length > 0 && (
        <details className="changes-commands">
          <summary>
            Commands run · {commands.length}
            {failedCommands > 0 && (
              <span className="changes-failed"> · {failedCommands} failed</span>
            )}
          </summary>
          <ul>
            {commands.slice(-COMMAND_LIMIT).map((c, index) => {
              const outcome = commandOutcome(c);
              return (
                <li key={index}>
                  <code title={c.command}>{displayCommand(c.command)}</code>
                  <span
                    className="command-outcome"
                    data-failed={outcome.failed || undefined}
                  >
                    {outcome.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {commands.length > COMMAND_LIMIT && (
            <p className="field-hint">
              Latest {COMMAND_LIMIT} of {commands.length}.
            </p>
          )}
        </details>
      )}
      <p className="field-hint changes-note">
        Edits as the agent’s tools reported them while working, not a diff of
        the repository: changes made another way, such as by a shell command,
        are not included.
      </p>
    </Sheet>
  );
}

const COMMAND_LIMIT = 8;

/** A path with its folder muted, so the file name stays readable. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <code className="file-path">
      {/* Truncates from the left; bdi keeps the folder's slashes in order. */}
      {cut > 0 && (
        <span className="file-dir">
          <bdi>{path.slice(0, cut)}</bdi>
        </span>
      )}
      <span className="file-name">{path.slice(cut)}</span>
    </code>
  );
}

/**
 * Fork a thread from one message into a new conversation. Before it is
 * created, the sheet shows the message, the agent and the project, and that
 * only the conversation is copied: files are not rewound.
 */
export function ForkSheet({
  conversationId,
  messageId,
  source,
  projectName,
  agents,
  defaultAgentId,
  onClose,
  onForked,
}: {
  conversationId: string;
  messageId: string;
  /** The message the fork copies through. */
  source: { role: string; content: string; created_at: number };
  projectName?: string;
  agents: Agent[];
  defaultAgentId?: string;
  onClose: () => void;
  onForked: (conversationId: string, agentId: string) => void;
}) {
  const api = useSourceApi();
  const choices = agents.filter((a) => a.connection_id && !a.retired_at);
  const [agentId, setAgentId] = useState(
    choices.find((a) => a.id === defaultAgentId)?.id || choices[0]?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title="Fork from here" onClose={onClose}>
      <figure className="fork-source">
        <figcaption>
          Copies the conversation through this{" "}
          {source.role === "user" ? "prompt of yours" : "message"} ·{" "}
          {dayLabel(source.created_at)} {timeLabel(source.created_at)}
        </figcaption>
        <blockquote>{preview(source.content, 220) || "(no text)"}</blockquote>
      </figure>
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
      <p className="fork-project">
        Project: <strong>{projectName || "Unfiled"}</strong>
      </p>
      <ul className="fork-notes">
        <li>
          The new thread starts with the messages up to this point. The original
          thread is not changed.
        </li>
        <li>
          <strong>Files are not rewound.</strong> The fork copies conversation
          context only; the agent works with files as they are now.
        </li>
        {agentId !== defaultAgentId && (
          <li>
            @{choices.find((a) => a.id === agentId)?.name || "The agent"}{" "}
            receives the copied messages as context with your next prompt.
          </li>
        )}
      </ul>
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

export type ScheduledSend = {
  id: string;
  /** The message's files, for putting it back into a draft. */
  attachments?: UploadedFile[];
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

/**
 * Change the text or time of a message that has not been sent yet. A
 * message that could not be sent is scheduled again at the new time.
 */
function EditScheduled({
  item,
  onClose,
  onSaved,
}: {
  item: ScheduledSend;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useSourceApi();
  const failed = item.state === "failed";
  const [text, setText] = useState(item.input);
  const [at, setAt] = useState(
    localInputValue(failed ? Date.now() + 3600_000 : item.send_at),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet
      title={failed ? "Edit and schedule again" : "Edit scheduled message"}
      onClose={onClose}
    >
      <p className="field-hint">
        To {item.agent_name ? "@" + item.agent_name : "the agent"}
        {item.folder_name ? ` · ${item.folder_name}` : ""} ·{" "}
        {item.conversation_title || "New thread"}
      </p>
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
      {failed && (
        <p className="field-hint">
          Nothing was sent before. It sends once, at the new time, if Loop
          accepts it then.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !text.trim() || !at}
        onClick={async () => {
          if (busy) return;
          const sendAt = new Date(at).getTime();
          if (!(sendAt > Date.now())) {
            setError("Choose a time in the future.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await api(
              "/scheduled-sends/" + item.id,
              { input: text, sendAt },
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
        {failed ? "Schedule again" : "Save"}
      </button>
    </Sheet>
  );
}

/**
 * Scheduled messages that still need you: waiting to send (edit or cancel),
 * or not sent because Loop refused them when due (edit, send now, move to a
 * draft or dismiss). In a thread they read like your own messages;
 * owner-wide (Later) each also names its recipient and where it goes.
 */
export function ScheduledSends({
  conversationId,
  revision,
  onOpen,
  onDraft,
  focusId,
  failedOnly = false,
}: {
  conversationId?: string;
  revision: number;
  onOpen?: (conversationId: string) => void;
  /** Put a message that could not be sent back into a draft. */
  onDraft?: (item: ScheduledSend) => void;
  /** Highlight this item: the one a confirmation linked to. */
  focusId?: string | null;
  /** Only messages that could not be sent (for Needs you). */
  failedOnly?: boolean;
}) {
  const api = useSourceApi();
  const [all, setItems] = useState<ScheduledSend[]>([]);
  // Older messages that could not be sent load a page at a time.
  const [failedNext, setFailedNext] = useState<string | null>(null);
  const items = failedOnly
    ? all.filter((item) => item.state === "failed")
    : all;
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
  // Scroll to the item a confirmation linked to, once it is listed.
  useEffect(() => {
    if (!focusId || !items.some((item) => item.id === focusId)) return;
    const node = document.getElementById("scheduled-" + focusId);
    node?.scrollIntoView({ block: "center" });
    node?.focus({ preventScroll: true });
  }, [focusId, items.length]);
  const act = async (item: ScheduledSend, action: "cancel" | "retry") => {
    if (busy) return;
    setBusy(item.id);
    setError("");
    try {
      if (action === "cancel")
        await api("/scheduled-sends/" + item.id, undefined, "DELETE");
      else {
        const result = await api<{
          run: { id: string } | null;
          row: ScheduledSend;
        }>(`/scheduled-sends/${item.id}/retry`, {});
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
        message to an agent.
      </p>
    ) : null;
  return (
    <section className="scheduled-sends" aria-label="Scheduled messages">
      {items.map((item) => {
        const failed = item.state === "failed";
        const where = [
          item.agent_name && "To @" + item.agent_name,
          item.folder_name || "Unfiled",
          item.conversation_title || "New thread",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <article
            key={item.id}
            id={"scheduled-" + item.id}
            tabIndex={-1}
            className={
              "message user scheduled-message" +
              (failed ? " not-sent" : "") +
              (focusId === item.id ? " anchored" : "")
            }
          >
            <header className="message-meta">
              <span className="eyebrow">
                {failed ? "Not sent" : "You · Waiting to send"}
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
            {global && <p className="field-hint">{where}</p>}
            <RichText content={item.input} />
            {failed && (
              <p className="error" role="status">
                Loop could not send this: {item.error || "it was refused."}{" "}
                Nothing was sent, and Loop will not retry it on its own.
              </p>
            )}
            <div className="scheduled-actions">
              <button
                type="button"
                className="text-button"
                aria-label={
                  failed ? "Edit and schedule again" : "Edit scheduled message"
                }
                onClick={() => setEditing(item)}
              >
                <PencilLine size={16} /> Edit
              </button>
              {failed && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy === item.id}
                  onClick={() => void act(item, "retry")}
                >
                  <Reply size={16} /> Send now
                </button>
              )}
              {failed && onDraft && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onDraft(item)}
                >
                  <MessageSquareQuote size={16} /> Copy to a draft
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
    armed: offset >= threshold ? "right" : offset <= -threshold ? "left" : null,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        // Any new press, even a mouse click after a touch swipe, is a tap
        // until it drags.
        dragged.current = false;
        if (e.pointerType === "mouse") return;
        if (
          (e.target as HTMLElement).closest("pre,.table-scroll,input,textarea")
        )
          return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        horizontal.current = null;
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
