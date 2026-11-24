import type { ActivityRecord } from "./agent-activities.js";

/**
 * How the step stands, from the harness's own status: still running, done,
 * failed (or cancelled), or unknown (its outcome is uncertain and it is
 * never replayed, so it must not read as done).
 */
export type ActivityState = "live" | "done" | "failed" | "unknown";

/** One line of what an agent is doing, taken from its latest activity. */
export type ActivityLine = { text: string; state: ActivityState };

type Item = {
  run: string | null;
  sequence: number;
  record: ActivityRecord | { v?: number; kind: "capabilities" };
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1);

/**
 * The latest step a run reported, in the harness's own words: a tool's title
 * (or its category and first path), a command, an edited file or the plan
 * step in progress. Nothing is invented: a run with no activity, or whose
 * newest step names nothing, has no line.
 */
export function activityLine(items: Item[], run: string): ActivityLine | null {
  // A record's sequence is its last write, not when its step started, so a
  // parallel step that just finished can be newer than one still running.
  // What the agent is doing now is the newest step still running; only when
  // none is, the newest step. An older finished step never stands in for it.
  const steps = items
    .filter(
      (item) =>
        item.run === run &&
        STEP_KINDS.includes(item.record.kind) &&
        // Records of another version may have another shape.
        item.record.v === 1,
    )
    .sort((a, b) => b.sequence - a.sequence)
    .map((item) => lineFor(item.record as ActivityRecord));
  const running = steps.find((line) => line?.state === "live");
  return running ?? steps[0] ?? null;
}

const STEP_KINDS: string[] = ["tool", "output", "file_change", "plan"];

const toolState = (status: string): ActivityState =>
  ["proposed", "waiting", "running"].includes(status)
    ? "live"
    : status === "completed"
      ? "done"
      : status === "failed" || status === "cancelled"
        ? "failed"
        : "unknown";

function lineFor(record: ActivityRecord): ActivityLine | null {
  switch (record.kind) {
    case "tool": {
      const { title, category, locations, status } = record.data;
      const place = locations?.[0] ? basename(locations[0]) : undefined;
      const text =
        title?.trim() ||
        [category?.trim(), place].filter(Boolean).join(" ") ||
        undefined;
      return text ? { text, state: toolState(status) } : null;
    }
    case "output": {
      const command = record.data.command?.trim();
      const status = record.data.status;
      return command
        ? {
            text: command,
            state:
              status === "running"
                ? "live"
                : status === "exited" && record.data.exitCode === 0
                  ? "done"
                  : status === "failed" ||
                      (status === "exited" &&
                        (typeof record.data.exitCode === "number" ||
                          !!record.data.signal))
                    ? "failed"
                    : "unknown",
          }
        : null;
    }
    case "file_change": {
      const path = record.data.files[0]?.path;
      const name = path ? basename(path) : undefined;
      const state = record.data.state;
      return name
        ? {
            text: name,
            state:
              state === "proposed"
                ? "live"
                : state === "applied"
                  ? "done"
                  : state === "failed"
                    ? "failed"
                    : "unknown",
          }
        : null;
    }
    case "plan": {
      const step =
        record.data.steps.find((s) => s.status === "in_progress") ??
        record.data.steps
          .filter((s) => s.status === "completed" || s.status === "cancelled")
          .at(-1);
      return step
        ? {
            text: step.title,
            state:
              step.status === "in_progress"
                ? "live"
                : step.status === "completed"
                  ? "done"
                  : "failed",
          }
        : null;
    }
    default:
      return null;
  }
}
