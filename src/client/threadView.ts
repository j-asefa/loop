import { SESSION_KINDS } from "../agent-activities";
import type { ActivityRecord, FileEntry } from "../agent-activities";

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

/** One status vocabulary for inbox rows, thread headers and run cards. */
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

/** One reported edit to a file, with its own outcome. */
export type ChangeEdit = FileEntry & {
  additions: number;
  deletions: number;
  state: string;
};
/**
 * Every reported edit to one path, in order. Only applied edits count as
 * changes; proposed, unconfirmed and failed edits are kept but not counted.
 */
export type ChangedFile = {
  path: string;
  operation: FileEntry["operation"];
  edits: ChangeEdit[];
  additions: number;
  deletions: number;
  /**
   * "applied" if any edit was applied; else "proposed" if any was only
   * proposed; "failed" if every edit failed; otherwise "unavailable": the
   * tool never reported whether its edits were applied.
   */
  state: "applied" | "proposed" | "failed" | "unavailable";
};
export type ChangeSummary = {
  files: ChangedFile[];
  /** Line totals of applied edits only. */
  additions: number;
  deletions: number;
  applied: number;
  proposed: number;
  failed: number;
  unavailable: number;
};

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
 * merged in one place so every view counts the same edits. Only copies of
 * the same record (same run and producer) collapse: a record saved on
 * several messages appears once, as its latest copy, and a live record
 * replaces its recorded copy.
 */
export function mergeActivityRecords(
  recorded: RunActivity[],
  live: RunActivity[],
) {
  const merged = new Map<string, ActivityRecord>();
  for (const item of [...recorded, ...live]) {
    const key = recordKey(item);
    merged.delete(key);
    merged.set(key, item.record);
  }
  return [...merged.values()];
}

function lineCounts(file: FileEntry) {
  if (file.patch != null) {
    let additions = 0,
      deletions = 0;
    for (const line of file.patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return { additions, deletions };
  }
  const count = (text?: string | null) =>
    text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  if (file.operation === "create") return { additions: count(file.after), deletions: 0 };
  if (file.operation === "delete") return { additions: 0, deletions: count(file.before) };
  return { additions: 0, deletions: 0 };
}

/**
 * Groups a run's reported file activity by path. Each activity record is one
 * edit (a record's latest data replaces its earlier data), so successive
 * edits to a path are all kept, in order. This is what the agent's tools
 * reported, not a diff of the working tree. Display only: nothing here
 * applies a change.
 */
export function summarizeChanges(records: ActivityRecord[]): ChangeSummary {
  const byPath = new Map<string, ChangeEdit[]>();
  for (const record of records) {
    if (record.kind !== "file_change") continue;
    for (const file of record.data.files)
      byPath.set(file.path, [
        ...(byPath.get(file.path) || []),
        { ...file, ...lineCounts(file), state: record.data.state },
      ]);
  }
  const files = [...byPath].map(([path, edits]): ChangedFile => {
    const applied = edits.filter((edit) => edit.state === "applied");
    return {
      path,
      operation: (applied.at(-1) || edits.at(-1)!).operation,
      edits,
      additions: applied.reduce((sum, edit) => sum + edit.additions, 0),
      deletions: applied.reduce((sum, edit) => sum + edit.deletions, 0),
      state: applied.length
        ? "applied"
        : edits.some((edit) => edit.state === "proposed")
          ? "proposed"
          : edits.every((edit) => edit.state === "failed")
            ? "failed"
            : "unavailable",
    };
  });
  const count = (state: ChangedFile["state"]) =>
    files.filter((file) => file.state === state).length;
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    applied: count("applied"),
    proposed: count("proposed"),
    failed: count("failed"),
    unavailable: count("unavailable"),
  };
}

/** Compact token counts: 950 → "950", 12_300 → "12.3k", 2_400_000 → "2.4M". */
export function compactNumber(value: number) {
  if (value < 1000) return String(value);
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Plain-text, row-sized preview of markdown: drops syntax, keeps words. */
export function preview(text: string, length = 140) {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > length ? flat.slice(0, length - 1).trimEnd() + "…" : flat;
}

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

/** What Loop knows about where reported changes were made. */
export type ChangeContext = {
  agentName?: string;
  projectName?: string;
  /** When the run (or runs) that reported the edits started. */
  runStartedAt?: number[];
  /** Commands the agent reported running, with their reported outcome. */
  commands: {
    command: string;
    cwd?: string | null;
    status?: string;
    exitCode?: number | null;
  }[];
};

/**
 * A reported command as a person would have typed it: harnesses often wrap
 * commands in a login shell (`/bin/bash -lc '…'`), which only adds noise.
 */
export function displayCommand(command: string) {
  const wrapped = command
    .trim()
    .match(/^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (!wrapped) return command.trim();
  return wrapped[1] === "'"
    ? wrapped[2].replaceAll(`'\\''`, "'")
    : wrapped[2].replace(/\\(["\\$`])/g, "$1");
}

/** Short outcome of a reported command, and whether it went wrong. */
export function commandOutcome(command: ChangeContext["commands"][number]) {
  if (command.status === "running") return { label: "running", failed: false };
  if (command.exitCode === 0) return { label: "exit 0", failed: false };
  if (command.exitCode != null)
    return { label: `exit ${command.exitCode}`, failed: true };
  if (command.status === "failed") return { label: "failed", failed: true };
  return { label: "no exit code", failed: false };
}

const runPhrase = (context?: ChangeContext) => {
  const starts = context?.runStartedAt || [];
  if (starts.length === 1)
    return `the run that started ${dayLabel(starts[0]).toLowerCase()} at ${timeLabel(starts[0])}`;
  if (starts.length > 1) return `the ${starts.length} runs in this thread`;
  return "this thread";
};

/**
 * Prompts for follow-up actions on reported edits. They ask the agent to
 * check the full working tree first, because the list holds only what its
 * tools reported. Each one is an editable draft; nothing here changes files.
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
    "First run `git status` and `git diff` in the repository and check the full set of changes, including any not in this list: it only has the edits your tools reported. Tell me the repository and branch.";
  return {
    commit: `${verify}\nThen commit the changes ${where} with a clear message. Reported applied edits:\n${list}`,
    pr: `${verify}\nThen push the changes ${where} to a new branch and open a pull request. Send me the branch name and the pull request link. Reported applied edits:\n${list}`,
    revert: `${verify}\nThen revert only the edits you made ${where} to these files, keeping any other changes. Reported applied edits:\n${list}`,
  };
}

