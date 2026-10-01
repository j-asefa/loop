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

/** Day separator label: "Today", "Yesterday", or a short weekday date. */
export function dayLabel(at: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
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
  /** "applied" if any edit was applied, else "failed" or "proposed". */
  state: "applied" | "proposed" | "failed";
};
export type ChangeSummary = {
  files: ChangedFile[];
  /** Line totals of applied edits only. */
  additions: number;
  deletions: number;
  applied: number;
  proposed: number;
  failed: number;
};

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
        : edits.every((edit) => edit.state === "failed")
          ? "failed"
          : "proposed",
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
