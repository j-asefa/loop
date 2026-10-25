import { plainPreview } from "../shared/text";
import { SESSION_KINDS } from "../agent-activities";
import type { ActivityRecord } from "../agent-activities";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short relative time for rows and status lines: "Just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(at: number, now = Date.now()) {
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return "Just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Duration without the "ago": "45s", "12m", "2h 5m", "3d". */
export function duration(ms: number) {
  const value = Math.max(0, ms);
  if (value < MINUTE) return `${Math.max(1, Math.floor(value / 1000))}s`;
  if (value < HOUR) return `${Math.floor(value / MINUTE)}m`;
  if (value < DAY) {
    const minutes = Math.floor((value % HOUR) / MINUTE);
    return `${Math.floor(value / HOUR)}h${minutes ? ` ${minutes}m` : ""}`;
  }
  return `${Math.floor(value / DAY)}d`;
}

function startOfDay(at: number) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Day label: "Today", "Yesterday", "Tomorrow", or a short weekday date. */
export function dayLabel(at: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days === -1) return "Tomorrow";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(new Date(at).getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

export function timeLabel(at: number) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Returns true when `at` starts a new calendar day relative to `previous`. */
export function startsNewDay(at: number, previous?: number) {
  return previous === undefined || startOfDay(at) !== startOfDay(previous);
}

/** "Started 2h ago · last update 3m ago" for queued and running work. */
export function runTiming(
  run: { created_at: number; updated_at: number; state: string },
  now = Date.now(),
) {
  const started = `${run.state === "queued" ? "Queued" : "Started"} ${relativeTime(run.created_at, now).toLowerCase()}`;
  if (run.state === "queued" || run.updated_at - run.created_at < MINUTE)
    return started;
  return `${started} · last update ${relativeTime(run.updated_at, now).toLowerCase()}`;
}

export type RunTone = "needs" | "working" | "queued" | "done" | "failed" | "idle";

/** One status vocabulary for Feed rows, thread headers and run cards. */
export function runStatus(
  state: string | null | undefined,
  pendingApprovals = 0,
): { label: string; tone: RunTone } {
  if (pendingApprovals > 0 || state === "awaiting_approval")
    return { label: "Needs approval", tone: "needs" };
  switch (state) {
    case "paused":
      return { label: "Paused", tone: "needs" };
    case "running":
    case "waiting_children":
      return { label: "Working", tone: "working" };
    case "pausing":
      return { label: "Pausing", tone: "working" };
    case "queued":
      return { label: "Queued", tone: "queued" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "interrupted":
      return { label: "Interrupted", tone: "failed" };
    case "completed":
      return { label: "Done", tone: "done" };
    case "cancelled":
      return { label: "Cancelled", tone: "idle" };
    default:
      return { label: "", tone: "idle" };
  }
}

/** An activity record with the run it was reported in (from trusted context). */
export type RunActivity = { run: string | null; record: ActivityRecord };

// The record's durable identity, as the server's activityKey(): session kinds
// live for the whole conversation, every other kind within its own run, so
// two runs may reuse an activity id for different edits.
const recordKey = ({ run, record }: RunActivity) =>
  [
    record.kind,
    record.source?.transport,
    record.source?.origin,
    SESSION_KINDS.includes(record.kind) ? "session" : run,
    record.id,
  ].join(":");

/**
 * Recorded activity (saved on messages) and live activity for the same runs,
 * merged for the tool activity view. Only copies of the same record
 * (same run and producer) collapse: a record saved on
 * several messages appears once, as its latest copy, and a live record
 * replaces its recorded copy.
 */
export function mergeActivityRecords(
  recorded: RunActivity[],
  live: RunActivity[],
) {
  const merged = new Map<string, RunActivity>();
  for (const item of [...recorded, ...live]) {
    const key = recordKey(item);
    merged.delete(key);
    merged.set(key, item);
  }
  return [...merged.values()];
}

/** Compact token counts: 950 → "950", 12_300 → "12.3k", 2_400_000 → "2.4M". */
export function compactNumber(value: number) {
  if (value < 1000) return String(value);
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Plain-text, row-sized preview of markdown: drops syntax, keeps words. */
export const preview = plainPreview;

export type LaterChoice = {
  id: string;
  label: string;
  hint?: string;
  condition: "time" | "run_finished" | "project_open";
  dueAt?: number;
};

/** Standard snooze choices, computed against the local clock. */
export function laterChoices(
  now = Date.now(),
  options: { running?: boolean; project?: { id: string; name: string } } = {},
): LaterChoice[] {
  const date = new Date(now);
  const at = (days: number, hour: number) => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    next.setHours(hour, 0, 0, 0);
    return next.getTime();
  };
  const tonight = at(0, 19);
  const tomorrow = at(1, 9);
  const monday = (() => {
    const next = new Date(date);
    next.setDate(next.getDate() + ((8 - next.getDay()) % 7 || 7));
    next.setHours(9, 0, 0, 0);
    return next.getTime();
  })();
  const choices: LaterChoice[] = [
    { id: "hour", label: "In an hour", condition: "time", dueAt: now + HOUR },
  ];
  if (tonight - now > HOUR)
    choices.push({ id: "tonight", label: "This evening", hint: timeLabel(tonight), condition: "time", dueAt: tonight });
  choices.push({ id: "tomorrow", label: "Tomorrow morning", hint: timeLabel(tomorrow), condition: "time", dueAt: tomorrow });
  if (monday - tomorrow > DAY)
    choices.push({ id: "monday", label: "Next week", hint: dayLabel(monday, now), condition: "time", dueAt: monday });
  if (options.running)
    choices.push({ id: "finished", label: "When the agent finishes", condition: "run_finished" });
  if (options.project)
    choices.push({
      id: "project",
      label: `Next time I open ${options.project.name}`,
      condition: "project_open",
    });
  return choices;
}

/** Local `datetime-local` value for a timestamp. */
export function localInputValue(at: number) {
  const date = new Date(at - new Date(at).getTimezoneOffset() * MINUTE);
  return date.toISOString().slice(0, 16);
}

/** Why a reminder is (or will be) back, in words. */
export function reminderReason(
  item: {
    condition: "time" | "run_finished" | "project_open";
    due_at: number | null;
    surfaced_at: number | null;
    project_name: string | null;
  },
  now = Date.now(),
) {
  const back = item.surfaced_at !== null;
  if (item.condition === "run_finished")
    return back ? "The agent finished" : "When the agent finishes";
  if (item.condition === "project_open")
    return back
      ? `You opened ${item.project_name || "the project"}`
      : `Next time you open ${item.project_name || "the project"}`;
  if (!item.due_at) return "";
  const at = `${dayLabel(item.due_at, now)} at ${timeLabel(item.due_at)}`;
  return back
    ? `Due ${at.replace(/^(Today|Yesterday|Tomorrow)/, (d) => d.toLowerCase())}`
    : at;
}

export type FeedNextAction = {
  kind: "approve" | "answer" | "result" | "draft";
  label: string;
  message_id: string | null;
};
/**
 * The one specific next step a feed card offers, if any: an approval or a
 * question first, then an unsent draft, then a finished result to review.
 * The approval label never claims a decision was made.
 */
export function feedNextAction(
  server: { kind: "approve" | "answer" | "result"; message_id: string | null } | null | undefined,
  draft: string,
): FeedNextAction | null {
  const label = {
    approve: "Approve request",
    answer: "Answer question",
    result: "Review result",
    draft: "Continue draft",
  };
  if (server && server.kind !== "result")
    return { kind: server.kind, label: label[server.kind], message_id: server.message_id };
  if (draft.trim()) return { kind: "draft", label: label.draft, message_id: null };
  if (server) return { kind: "result", label: label.result, message_id: server.message_id };
  return null;
}

export type FeedReplyQuote = {
  agentId: string;
  messageId: string;
  content: string;
  mine?: boolean;
};
/**
 * What a Done card's Reply quotes: the result the card shows, so the reply
 * answers that message rather than whatever the thread said last. Other
 * cards, imported threads and empty messages reply to the thread unquoted.
 */
export function feedReplyQuote(item: {
  done_card_key?: string;
  agent_id: string | null;
  origin: string;
  last_message: { id: string; role: string; content?: string; preview: string } | null;
}): FeedReplyQuote | null {
  const message = item.last_message;
  if (!item.done_card_key || !item.agent_id || item.origin.endsWith("-import") || !message)
    return null;
  if (!["assistant", "user"].includes(message.role)) return null;
  const content = message.content ?? message.preview;
  if (!content.trim()) return null;
  return {
    agentId: item.agent_id,
    messageId: message.id,
    content,
    ...(message.role === "user" ? { mine: true } : {}),
  };
}

/** Context for an editable follow-up on a captured Git diff. */
export type ChangeContext = {
  projectName?: string;
  runStartedAt?: number[];
};

const runPhrase = (context?: ChangeContext) => {
  const starts = context?.runStartedAt || [];
  if (starts.length === 1)
    return `the run that started ${dayLabel(starts[0]).toLowerCase()} at ${timeLabel(starts[0])}`;
  if (starts.length > 1) return `the ${starts.length} runs in this thread`;
  return "this thread";
};

/**
 * Prompts for follow-up actions on a captured Git diff. The checkout may
 * have changed since capture, so the agent must verify it before acting.
 * Each prompt is an editable draft; nothing here changes files.
 */
export function changePrompts(paths: string[], context?: ChangeContext) {
  const where = [
    context?.projectName && `in the ${context.projectName} project`,
    `from ${runPhrase(context)}`,
  ]
    .filter(Boolean)
    .join(" ");
  const list = paths.map((path) => `- ${path}`).join("\n");
  const verify =
    "First run `git status` and `git diff` in the repository and check the full set of changes, including committed and uncommitted changes. This list comes from a saved Git snapshot; the checkout may have changed since it was captured. Tell me the repository and branch.";
  return {
    commit: `${verify}\nThen commit the changes ${where} with a clear message. Files in the captured Git diff:\n${list}`,
    pr: `${verify}\nThen push the changes ${where} to a new branch and open a pull request. Send me the branch name and the pull request link. Files in the captured Git diff:\n${list}`,
    revert: `${verify}\nThen revert only the edits you made ${where} to these files, keeping any other changes. Files in the captured Git diff:\n${list}`,
  };
}
