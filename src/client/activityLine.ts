import type { ActivityRecord } from "../shared/agent-activities";

/** One line of what an agent is doing, taken from its latest activity. */
export type ActivityLine = { text: string; live: boolean };

type Item = {
  run: string | null;
  sequence: number;
  record: ActivityRecord | { kind: "capabilities" };
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1);

/**
 * The latest step a run reported, in the harness's own words: a tool's title
 * (or its category and first path), a command, an edited file or the plan
 * step in progress. Nothing is invented: a run with no activity has no line.
 * `live` is true while that step is still running.
 */
export function activityLine(items: Item[], run: string): ActivityLine | null {
  const latest = items
    .filter((item) => item.run === run && item.record.kind !== "capabilities")
    .sort((a, b) => b.sequence - a.sequence);
  for (const { record } of latest) {
    const line = lineFor(record as ActivityRecord);
    if (line) return line;
  }
  return null;
}

function lineFor(record: ActivityRecord): ActivityLine | null {
  switch (record.kind) {
    case "tool": {
      const { title, category, locations, status } = record.data;
      const place = locations?.[0] ? basename(locations[0]) : undefined;
      const text =
        title?.trim() ||
        [category?.trim(), place].filter(Boolean).join(" ") ||
        undefined;
      return text
        ? {
            text,
            live: ["proposed", "waiting", "running"].includes(status),
          }
        : null;
    }
    case "output": {
      const command = record.data.command?.trim();
      return command
        ? { text: command, live: record.data.status === "running" }
        : null;
    }
    case "file_change": {
      const path = record.data.files[0]?.path;
      const name = path ? basename(path) : undefined;
      return name ? { text: name, live: false } : null;
    }
    case "plan": {
      const step =
        record.data.steps.find((s) => s.status === "in_progress") ??
        record.data.steps.filter((s) => s.status === "completed").at(-1);
      return step
        ? { text: step.title, live: step.status === "in_progress" }
        : null;
    }
    default:
      return null;
  }
}
